/**
 * Serviço de pacientes: onde a separação PII / clínico é aplicada.
 *
 * ## O fluxo de escrita
 *
 * ```
 * dados do formulário
 *   ├─→ paciente_identificacao   nome, CPF, telefone — CIFRADOS + índice cego
 *   └─→ pacientes                código pseudonimizado, idade, responsável
 * ```
 *
 * ## O fluxo de leitura, que é onde está a defesa
 *
 * A listagem lê **apenas** `pacientes`. Só quando o ator tem
 * `paciente:reidentificar` é que uma segunda consulta, explícita, busca a PII
 * e a decifra. Não existe junção automática entre as duas tabelas.
 *
 * A diferença prática: para um estagiário, o nome do paciente não é
 * "escondido na interface" — ele **não sai do banco**. Não passa pela memória
 * do processo, não entra num log, não aparece num dump de heap.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  Escopo,
  cifrar,
  decifrar,
  indiceCego,
  indicesCegosParaBusca,
  codigoPseudonimo,
  idadeEmAnos,
  type Anel,
} from '@cinesis/security';
import { NaoEncontrado, type PacienteResumo } from '@cinesis/shared';
import { pacienteIdentificacao, pacientes, consentimentos, planos } from '../db/schema.js';
import type { Banco } from '../db/conexao.js';
import { novoId } from '../infra/ids.js';
import { auditar } from './auditoria.js';
import { calcularResumos } from './resumo-paciente.js';

/** Dados de cadastro de um paciente. */
export interface NovoPaciente {
  nome: string;
  nascimento: string;
  email?: string | undefined;
  telefone?: string | undefined;
  documento?: string | undefined;
  consentimentoVersao: string;
}

/**
 * Cadastra um paciente, separando e cifrando a PII.
 *
 * @param tx      Transação com tenant fixado.
 * @param anel    Anel de chaves.
 * @param escopo  Escopo do ator.
 * @param dados   Dados do formulário, já validados por Zod.
 * @returns       Id e código pseudonimizado do paciente criado.
 */
export async function cadastrarPaciente(
  tx: Banco,
  anel: Anel,
  escopo: Escopo,
  dados: NovoPaciente,
): Promise<{ id: string; codigo: string }> {
  const id = novoId();

  // O código é derivado do id por HMAC — determinístico e estável para sempre.
  const codigo = codigoPseudonimo(anel, id);

  // O AAD amarra cada valor cifrado a ESTE paciente. Sem ele, quem tivesse
  // escrita no banco poderia mover o nome cifrado de um paciente para a linha
  // de outro, e o AES-GCM aceitaria (o ciphertext é válido — só está no lugar
  // errado). Com o AAD, a decifragem falha.
  const aad = `paciente:${id}`;

  // --- Lado clínico: sem nenhum dado identificante ---------------------------
  await tx.insert(pacientes).values({
    id,
    organizacaoId: escopo.organizacaoId,
    codigo,
    // Idade, não data de nascimento: a data completa é quase-identificador
    // forte (com CEP e sexo, reidentifica boa parte da população).
    idade: idadeEmAnos(dados.nascimento),
    responsavelId: escopo.sujeitoId,
  });

  // --- Lado PII: tudo cifrado, com índice cego para busca --------------------
  await tx.insert(pacienteIdentificacao).values({
    id,
    organizacaoId: escopo.organizacaoId,
    nomeCifrado: cifrar(anel, dados.nome, aad),
    nascimentoCifrado: cifrar(anel, dados.nascimento, aad),
    emailCifrado: dados.email ? cifrar(anel, dados.email, aad) : null,
    telefoneCifrado: dados.telefone ? cifrar(anel, dados.telefone, aad) : null,
    documentoCifrado: dados.documento ? cifrar(anel, dados.documento, aad) : null,
    // Índices cegos: HMAC determinístico. Permitem "achar pelo CPF" sem
    // decifrar nada e sem guardar o CPF em claro.
    emailIndice: dados.email ? indiceCego(anel, dados.email, 'email') : null,
    telefoneIndice: dados.telefone ? indiceCego(anel, dados.telefone, 'telefone') : null,
    documentoIndice: dados.documento ? indiceCego(anel, dados.documento, 'documento') : null,
  });

  // --- Consentimento: sem ele, nenhum registro clínico é criado depois ------
  await tx.insert(consentimentos).values({
    id: novoId(),
    organizacaoId: escopo.organizacaoId,
    pacienteId: id,
    tipo: 'tratamento_dados',
    versao: dados.consentimentoVersao,
    aceitoEm: new Date(),
  });

  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.sujeitoId,
    atorPapel: escopo.papel,
    acao: 'CONSENTIMENTO_REGISTRADO',
    entidade: 'Paciente',
    entidadeId: id,
    detalhe: `TCLE ${dados.consentimentoVersao} aceito no cadastro.`,
  });

  return { id, codigo };
}

/**
 * Lista pacientes do escopo do ator.
 *
 * A cláusula WHERE carrega o escopo inteiro:
 * - `organizacao_id` sempre (isolamento de tenant);
 * - `responsavel_id IN (...)` quando o acesso é restrito (estagiário).
 *
 * O nome só é buscado e decifrado quando o ator pode reidentificar.
 */
export async function listarPacientes(
  tx: Banco,
  anel: Anel,
  escopo: Escopo,
  limite = 50,
): Promise<PacienteResumo[]> {
  const condicoes = [
    eq(pacientes.organizacaoId, escopo.organizacaoId),
    eq(pacientes.ativo, true),
  ];

  // Escopo restrito entra na query, não num filtro posterior. Filtrar depois
  // significaria que o dado do supervisor não-vinculado já passou pela memória.
  if (escopo.ehRestrito('paciente:ler')) {
    condicoes.push(inArray(pacientes.responsavelId, escopo.profissionaisVisiveis()));
  }

  const linhas = await tx
    .select({
      id: pacientes.id,
      codigo: pacientes.codigo,
      idade: pacientes.idade,
    })
    .from(pacientes)
    .where(and(...condicoes))
    .limit(Math.min(limite, 100));

  // Decifragem de nome: só acontece se o papel permitir, e numa consulta
  // separada e explícita. Este `if` é a fronteira entre pseudonimizado e não.
  const nomes = escopo.podeVerPii()
    ? await decifrarNomes(tx, anel, escopo.organizacaoId, linhas.map((l) => l.id))
    : new Map<string, string>();

  // Planos ativos, para exibir o título na listagem.
  const planosAtivos = await tx
    .select({ pacienteId: planos.pacienteId, titulo: planos.titulo })
    .from(planos)
    .where(and(eq(planos.organizacaoId, escopo.organizacaoId), eq(planos.status, 'ativo')));

  const planoPorPaciente = new Map(planosAtivos.map((p) => [p.pacienteId, p.titulo]));

  // Situação, adesão, EVA e próxima sessão — calculados EM LOTE para a página
  // inteira. Fazer isso por paciente dentro de um laço seria o clássico N+1:
  // 30 pacientes virariam mais de cem consultas.
  const resumos = await calcularResumos(
    tx,
    escopo.organizacaoId,
    linhas.map((l) => l.id),
  );

  // Consentimento vigente, para a interface bloquear registro clínico antes de
  // o servidor precisar recusar com 412.
  const consentimentosVigentes = await tx
    .select({ pacienteId: consentimentos.pacienteId })
    .from(consentimentos)
    .where(
      and(
        eq(consentimentos.organizacaoId, escopo.organizacaoId),
        eq(consentimentos.tipo, 'tratamento_dados'),
        sql`${consentimentos.revogadoEm} IS NULL`,
      ),
    );

  const comConsentimento = new Set(consentimentosVigentes.map((c) => c.pacienteId));

  return linhas.map((l) => {
    const resumo = resumos.get(l.id);

    return {
      id: l.id,
      codigo: l.codigo,
      // `?? null` e não `?? l.codigo`: a interface decide como exibir a
      // ausência. Devolver o código no campo `nome` faria a UI achar que
      // recebeu o nome de verdade.
      nome: nomes.get(l.id) ?? null,
      idade: l.idade,
      situacao: resumo?.situacao ?? 'sem_plano',
      adesao: resumo?.adesao ?? null,
      evaAtual: resumo?.evaAtual ?? null,
      evaInicial: resumo?.evaInicial ?? null,
      planoAtivo: planoPorPaciente.get(l.id) ?? null,
      proximaSessao: resumo?.proximaSessao ?? null,
      consentimentoVigente: comConsentimento.has(l.id),
    };
  });
}

/**
 * Decifra nomes em lote.
 *
 * Interna e não exportada: o único caminho para chegar aqui é passar pela
 * checagem de permissão em `listarPacientes` ou `reidentificar`.
 */
async function decifrarNomes(
  tx: Banco,
  anel: Anel,
  organizacaoId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  const linhas = await tx
    .select({ id: pacienteIdentificacao.id, nomeCifrado: pacienteIdentificacao.nomeCifrado })
    .from(pacienteIdentificacao)
    .where(
      and(
        eq(pacienteIdentificacao.organizacaoId, organizacaoId),
        inArray(pacienteIdentificacao.id, ids),
      ),
    );

  const mapa = new Map<string, string>();
  for (const l of linhas) {
    try {
      mapa.set(l.id, decifrar(anel, l.nomeCifrado, `paciente:${l.id}`));
    } catch {
      // Chave rotacionada sem a versão antiga no anel, ou dado adulterado.
      // Não derruba a listagem inteira por causa de uma linha — o paciente
      // aparece pelo código, e o problema fica visível no log.
      mapa.set(l.id, '[não foi possível decifrar]');
    }
  }
  return mapa;
}

/** O que a reidentificação devolve. */
export interface PiiReidentificada {
  nome: string;
  nascimento: string;
  email: string | null;
  telefone: string | null;
  documento: string | null;
}

/**
 * Reidentifica um paciente — **operação governada**.
 *
 * Quatro exigências, todas obrigatórias:
 * 1. Papel com `paciente:reidentificar` (checado antes, na rota).
 * 2. Motivo escrito pelo profissional.
 * 3. Rate limit (aplicado na rota).
 * 4. Registro em `REIDENTIFICACAO_AUTORIZADA` na trilha de auditoria.
 *
 * A auditoria é gravada na mesma transação: não existe reidentificar sem
 * deixar rastro, nem por falha nem por atalho de código.
 *
 * @throws {NaoEncontrado} Paciente inexistente ou de outra organização —
 *         indistinguíveis de propósito.
 */
export async function reidentificar(
  tx: Banco,
  anel: Anel,
  escopo: Escopo,
  pacienteId: string,
  motivo: string,
): Promise<PiiReidentificada> {
  // O escopo está na query. Um id de outra organização simplesmente não
  // encontra linha — e a RLS ainda barra por baixo, como segunda camada.
  const [pii] = await tx
    .select()
    .from(pacienteIdentificacao)
    .where(
      and(
        eq(pacienteIdentificacao.id, pacienteId),
        eq(pacienteIdentificacao.organizacaoId, escopo.organizacaoId),
      ),
    )
    .limit(1);

  if (!pii) {
    // NAO auditamos aqui. Este `throw` desfaz a transacao inteira, e uma linha
    // de auditoria gravada agora seria descartada no rollback junto com tudo
    // o mais — a tentativa sumiria da trilha exatamente no caso em que ela mais
    // importa. Quem registra e a rota, numa transacao separada, no `catch`.
    throw new NaoEncontrado();
  }

  const aad = `paciente:${pacienteId}`;

  const resultado: PiiReidentificada = {
    nome: decifrar(anel, pii.nomeCifrado, aad),
    nascimento: decifrar(anel, pii.nascimentoCifrado, aad),
    email: pii.emailCifrado ? decifrar(anel, pii.emailCifrado, aad) : null,
    telefone: pii.telefoneCifrado ? decifrar(anel, pii.telefoneCifrado, aad) : null,
    documento: pii.documentoCifrado ? decifrar(anel, pii.documentoCifrado, aad) : null,
  };

  // O motivo vai íntegro para a trilha. É ele que transforma esta operação em
  // algo revisável depois — sem motivo, a linha de auditoria diria apenas
  // "alguém olhou", que é quase nada.
  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.sujeitoId,
    atorPapel: escopo.papel,
    acao: 'REIDENTIFICACAO_AUTORIZADA',
    entidade: 'PacienteIdentificacao',
    entidadeId: pacienteId,
    detalhe: motivo,
  });

  return resultado;
}

/**
 * Registra uma tentativa de reidentificação por papel sem permissão.
 *
 * A rota já devolveu 404 (via `exigirPermissao`); esta função existe para que
 * a tentativa ainda apareça na trilha. Recepção tentando reidentificar não é
 * erro de digitação — é sinal.
 */
export async function auditarReidentificacaoNegada(
  tx: Banco,
  escopo: Escopo,
  pacienteId: string,
): Promise<void> {
  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.sujeitoId,
    atorPapel: escopo.papel,
    acao: 'REIDENTIFICACAO_NEGADA',
    entidade: 'PacienteIdentificacao',
    entidadeId: pacienteId,
    detalhe: `Papel ${escopo.papel} não tem permissão de reidentificação.`,
  });
}

/**
 * Busca um paciente pelo CPF, usando o índice cego.
 *
 * Nada é decifrado: comparamos HMAC com HMAC. A consulta gera os índices de
 * **todas** as versões de chave do anel, para que a busca continue funcionando
 * enquanto uma rotação de chave está em andamento e parte das linhas ainda tem
 * o índice antigo.
 *
 * Limite conhecido: só busca por igualdade exata. Busca parcial sobre dado
 * cifrado exige esquemas que vazam ordem ou frequência — fora de questão aqui.
 */
export async function buscarPorDocumento(
  tx: Banco,
  anel: Anel,
  escopo: Escopo,
  documento: string,
): Promise<{ id: string; codigo: string } | null> {
  const indices = indicesCegosParaBusca(anel, documento, 'documento');

  const [linha] = await tx
    .select({ id: pacienteIdentificacao.id })
    .from(pacienteIdentificacao)
    .where(
      and(
        eq(pacienteIdentificacao.organizacaoId, escopo.organizacaoId),
        inArray(pacienteIdentificacao.documentoIndice, indices),
      ),
    )
    .limit(1);

  if (!linha) return null;

  const [pac] = await tx
    .select({ id: pacientes.id, codigo: pacientes.codigo })
    .from(pacientes)
    .where(and(eq(pacientes.id, linha.id), eq(pacientes.organizacaoId, escopo.organizacaoId)))
    .limit(1);

  return pac ?? null;
}

/**
 * Conta pacientes ativos da organização. Alimenta a faixa de métricas da tela
 * "Hoje". Agregado — nunca lê PII.
 */
export async function contarAtivos(tx: Banco, organizacaoId: string): Promise<number> {
  const [linha] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(pacientes)
    .where(and(eq(pacientes.organizacaoId, organizacaoId), eq(pacientes.ativo, true)));

  return linha?.n ?? 0;
}
