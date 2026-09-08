/**
 * Serviço de prontuário: planos, registros clínicos e testes funcionais.
 *
 * É o núcleo do produto — o que a especificação chama de ciclo
 * *avaliação → evolução → comparação longitudinal*.
 *
 * ## As três invariantes que este arquivo protege
 *
 * 1. **Sem consentimento vigente, nada clínico é criado.** (LGPD Art. 11)
 * 2. **Registro finalizado nunca é alterado.** Correção cria versão nova.
 *    (COFFITO 415/2012)
 * 3. **O escore de teste funcional é calculado no servidor.** O cliente manda
 *    valores brutos; aceitar o escore pronto seria deixar o cliente escrever o
 *    resultado clínico que quisesse — e ele sai num PDF assinado com CREFITO.
 */

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  exigirConsentimento,
  exigirEditavel,
  selar,
  criarNovaVersao,
  calcularTeste,
  montarSerie,
  analisarTendencia,
  compararEscores,
  type Consentimento,
  type RegistroSelavel,
  type AplicacaoParaSerie,
} from '@cinesis/domain';
import { Escopo } from '@cinesis/security';
import {
  Conflito,
  NaoEncontrado,
  type DefinicaoTeste,
  type PontoLongitudinal,
} from '@cinesis/shared';
import {
  aplicacoesTeste,
  consentimentos,
  definicoesTeste,
  organizacoes,
  planos,
  profissionais,
  registros,
} from '../db/schema.js';
import type { Banco } from '../db/conexao.js';
import { codigoRegistro, novoId } from '../infra/ids.js';
import { auditar } from './auditoria.js';

// ---------------------------------------------------------------------------
// Consentimento
// ---------------------------------------------------------------------------

/**
 * Carrega os consentimentos de um paciente e exige o tipo pedido.
 *
 * Chamada obrigatória antes de qualquer escrita clínica. Fica numa função
 * própria para que "esqueci de checar o consentimento" seja visível na revisão
 * — a ausência da linha salta aos olhos.
 *
 * @throws {ConsentimentoAusente} 412.
 */
async function exigirConsentimentoDoPaciente(
  tx: Banco,
  organizacaoId: string,
  pacienteId: string,
  tipo: Consentimento['tipo'],
): Promise<void> {
  // A versão vigente do termo é definida pela organização. Ela é lida do banco
  // (e não recebida por parâmetro) justamente para que publicar um termo novo
  // invalide os aceites anteriores em todo o sistema de uma vez, sem depender
  // de cada chamador passar a versão certa.
  const [org] = await tx
    .select({ tcleVersao: organizacoes.tcleVersao })
    .from(organizacoes)
    .where(eq(organizacoes.id, organizacaoId))
    .limit(1);

  if (!org) throw new NaoEncontrado();

  const linhas = await tx
    .select()
    .from(consentimentos)
    .where(
      and(
        eq(consentimentos.organizacaoId, organizacaoId),
        eq(consentimentos.pacienteId, pacienteId),
      ),
    );

  const registrados: Consentimento[] = linhas.map((l) => ({
    tipo: l.tipo as Consentimento['tipo'],
    versao: l.versao,
    aceitoEm: l.aceitoEm,
    revogadoEm: l.revogadoEm,
  }));

  // Lança `ConsentimentoAusente` (412) se não houver aceite vigente do tipo
  // pedido, na versão vigente do termo.
  exigirConsentimento(registrados, tipo, org.tcleVersao);
}

// ---------------------------------------------------------------------------
// Plano de tratamento — o agregado principal
// ---------------------------------------------------------------------------

/** Dados de criação de um plano. */
export interface NovoPlano {
  pacienteId: string;
  titulo: string;
  diagnostico: string;
  objetivo: string;
  sessoesPrevistas: number;
  reavaliacaoEm?: string | undefined;
}

/** Cria um plano de tratamento (um episódio de cuidado). */
export async function criarPlano(
  tx: Banco,
  escopo: Escopo,
  dados: NovoPlano,
): Promise<{ id: string }> {
  await exigirConsentimentoDoPaciente(
    tx,
    escopo.organizacaoId,
    dados.pacienteId,
    'tratamento_dados',
  );

  const id = novoId();

  await tx.insert(planos).values({
    id,
    organizacaoId: escopo.organizacaoId,
    pacienteId: dados.pacienteId,
    profissionalId: escopo.sujeitoId,
    titulo: dados.titulo,
    diagnostico: dados.diagnostico,
    objetivo: dados.objetivo,
    sessoesPrevistas: dados.sessoesPrevistas,
    reavaliacaoEm: dados.reavaliacaoEm ?? null,
  });

  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.sujeitoId,
    atorPapel: escopo.papel,
    acao: 'PLANO_CRIADO',
    entidade: 'PlanoTratamento',
    entidadeId: id,
  });

  return { id };
}

/**
 * Busca um plano dentro do escopo do ator.
 *
 * O filtro de escopo está na cláusula WHERE — não é `SELECT` seguido de `if`.
 * Um plano de outra organização não é lido, nem para ser descartado depois.
 *
 * @throws {NaoEncontrado} Inexistente ou fora do escopo (indistinguíveis).
 */
export async function buscarPlano(tx: Banco, escopo: Escopo, planoId: string) {
  const condicoes = [eq(planos.id, planoId), eq(planos.organizacaoId, escopo.organizacaoId)];

  // Estagiário só enxerga o que ele ou os supervisores dele conduzem.
  if (escopo.ehRestrito('plano:ler')) {
    condicoes.push(inArray(planos.profissionalId, escopo.profissionaisVisiveis()));
  }

  const [plano] = await tx
    .select()
    .from(planos)
    .where(and(...condicoes))
    .limit(1);

  if (!plano) throw new NaoEncontrado();
  return plano;
}

// ---------------------------------------------------------------------------
// Registros clínicos
// ---------------------------------------------------------------------------

/** Uma aplicação de teste vinda do cliente: valores brutos, sem escore. */
export interface EntradaTeste {
  definicaoChave: string;
  valores: Record<string, number>;
}

/** Dados de uma evolução. */
export interface NovaEvolucao {
  ocorridoEm: string;
  eva: number;
  conduta: string;
  resposta: string;
  testes: EntradaTeste[];
}

/**
 * Cria uma evolução como **rascunho**.
 *
 * Nasce editável de propósito: o profissional digita durante o atendimento e
 * assina no fim. Assinar é um ato deliberado, não um efeito colateral de salvar.
 */
export async function criarEvolucao(
  tx: Banco,
  escopo: Escopo,
  planoId: string,
  dados: NovaEvolucao,
): Promise<{ id: string; codigo: string }> {
  const plano = await buscarPlano(tx, escopo, planoId);

  await exigirConsentimentoDoPaciente(
    tx,
    escopo.organizacaoId,
    plano.pacienteId,
    'tratamento_dados',
  );

  const id = novoId();
  const codigo = codigoRegistro('evolucao');

  await tx.insert(registros).values({
    id,
    organizacaoId: escopo.organizacaoId,
    planoId,
    tipo: 'evolucao',
    codigo,
    eva: dados.eva,
    conduta: dados.conduta,
    resposta: dados.resposta,
    ocorridoEm: new Date(dados.ocorridoEm),
  });

  await aplicarTestes(tx, escopo, id, dados.testes);

  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.sujeitoId,
    atorPapel: escopo.papel,
    acao: 'EVOLUCAO_CRIADA',
    entidade: 'Evolucao',
    entidadeId: id,
    detalhe: `Rascunho ${codigo} criado.`,
  });

  return { id, codigo };
}

/**
 * Aplica os testes funcionais de um registro.
 *
 * O escore é **recalculado aqui**, a partir da definição vinda do banco. Nada
 * do que o cliente mandou como resultado é usado.
 */
async function aplicarTestes(
  tx: Banco,
  escopo: Escopo,
  registroId: string,
  testes: EntradaTeste[],
): Promise<void> {
  if (testes.length === 0) return;

  const chaves = testes.map((t) => t.definicaoChave);
  const definicoes = await tx
    .select()
    .from(definicoesTeste)
    .where(and(inArray(definicoesTeste.chave, chaves), eq(definicoesTeste.ativo, true)));

  const porChave = new Map(definicoes.map((d) => [d.chave, paraDefinicao(d)]));

  for (const teste of testes) {
    const definicao = porChave.get(teste.definicaoChave);
    if (!definicao) {
      throw new Conflito(`Teste "${teste.definicaoChave}" não está no catálogo desta instalação.`);
    }

    // `calcularTeste` valida os valores e lança 422 se algum estiver fora de
    // faixa, faltando, ou for um campo que não pertence ao teste.
    const resultado = calcularTeste(definicao, teste.valores);

    await tx.insert(aplicacoesTeste).values({
      id: novoId(),
      organizacaoId: escopo.organizacaoId,
      registroId,
      definicaoChave: definicao.chave,
      // Procedência: dois anos depois dá para saber com qual regra o escore
      // foi produzido, mesmo que a definição tenha mudado desde então.
      definicaoVersao: resultado.versaoUsada,
      valores: teste.valores,
      escore: resultado.escore,
      interpretacao: resultado.interpretacao,
      tom: resultado.tom,
    });
  }
}

/** Converte a linha do banco no tipo de domínio. */
function paraDefinicao(linha: typeof definicoesTeste.$inferSelect): DefinicaoTeste {
  return {
    id: linha.id,
    chave: linha.chave,
    nome: linha.nome,
    versao: linha.versao,
    categoria: linha.categoria as DefinicaoTeste['categoria'],
    unidade: linha.unidade,
    fonte: linha.fonte,
    licenca: linha.licenca,
    maiorEhPior: linha.maiorEhPior,
    campos: linha.campos as DefinicaoTeste['campos'],
    formula: linha.formula as DefinicaoTeste['formula'],
    interpretacoes: linha.interpretacoes as DefinicaoTeste['interpretacoes'],
  };
}

/**
 * Finaliza e assina um registro — a partir daqui ele é imutável.
 *
 * O `UPDATE` tem `finalizado_em IS NULL` na cláusula WHERE. Isso não é
 * redundância com a checagem de domínio: é o que impede que duas requisições
 * simultâneas selem o mesmo registro com assinaturas diferentes. Se a linha já
 * foi selada entre a leitura e a escrita, o UPDATE afeta zero linhas.
 */
export async function finalizarRegistro(
  tx: Banco,
  escopo: Escopo,
  registroId: string,
): Promise<void> {
  const registro = await buscarRegistro(tx, escopo, registroId);

  // Camada 1: a regra de domínio. Lança 409 com a mensagem que cita a COFFITO.
  exigirEditavel(paraSelavel(registro));

  const [prof] = await tx
    .select({ crefito: profissionais.crefito })
    .from(profissionais)
    .where(
      and(
        eq(profissionais.id, escopo.sujeitoId),
        eq(profissionais.organizacaoId, escopo.organizacaoId),
      ),
    )
    .limit(1);

  const agora = new Date();
  selar(paraSelavel(registro), {
    profissionalId: escopo.sujeitoId,
    crefito: prof?.crefito ?? null,
    agora,
  });

  // Camada 2: a escrita condicional. Vence a corrida entre requisições.
  const resultado = await tx
    .update(registros)
    .set({ finalizadoEm: agora, assinadoPorId: escopo.sujeitoId })
    .where(
      and(
        eq(registros.id, registroId),
        eq(registros.organizacaoId, escopo.organizacaoId),
        // `isNull`, nao `eq(..., null)`: em SQL, `coluna = NULL` nunca e
        // verdadeiro (NULL nao e igual a nada, nem a si mesmo). Com `eq` este
        // UPDATE jamais casaria linha nenhuma e finalizar sempre falharia.
        isNull(registros.finalizadoEm),
      ),
    )
    .returning({ id: registros.id });

  if (resultado.length === 0) {
    throw new Conflito('Este registro já foi finalizado por outra ação.');
  }

  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.sujeitoId,
    atorPapel: escopo.papel,
    acao: 'EVOLUCAO_FINALIZADA',
    entidade: 'Evolucao',
    entidadeId: registroId,
    detalhe: `${registro.codigo} selado e assinado.`,
  });
}

/**
 * Cria a versão seguinte de um registro selado.
 *
 * O registro anterior **não é tocado** — nem conteúdo, nem assinatura, nem
 * data. É isso que produz o "v1 preservada" da linha do tempo e o selo
 * "N registros · 0 sobrescritos".
 */
export async function criarVersao(
  tx: Banco,
  escopo: Escopo,
  registroId: string,
  dados: NovaEvolucao & { motivo: string },
): Promise<{ id: string; codigo: string }> {
  const original = await buscarRegistro(tx, escopo, registroId);

  // A regra de domínio decide se a operação é válida e monta a próxima versão.
  const novo = criarNovaVersao(paraSelavel(original), {
    novoId: novoId(),
    motivo: dados.motivo,
  });

  const codigo = codigoRegistro('evolucao');

  await tx.insert(registros).values({
    id: novo.id,
    organizacaoId: escopo.organizacaoId,
    planoId: original.planoId,
    tipo: original.tipo,
    codigo,
    eva: dados.eva,
    conduta: dados.conduta,
    resposta: dados.resposta,
    ocorridoEm: new Date(dados.ocorridoEm),
    versao: novo.versao,
    substituiId: novo.substituiId,
    motivoVersao: dados.motivo,
  });

  await aplicarTestes(tx, escopo, novo.id, dados.testes);

  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.sujeitoId,
    atorPapel: escopo.papel,
    acao: 'EVOLUCAO_NOVA_VERSAO',
    entidade: 'Evolucao',
    entidadeId: novo.id,
    detalhe: `v${novo.versao} de ${original.codigo}. Motivo: ${dados.motivo}`,
  });

  return { id: novo.id, codigo };
}

/** Busca um registro dentro do escopo, com o plano validado junto. */
export async function buscarRegistro(tx: Banco, escopo: Escopo, registroId: string) {
  const [registro] = await tx
    .select()
    .from(registros)
    .where(
      and(eq(registros.id, registroId), eq(registros.organizacaoId, escopo.organizacaoId)),
    )
    .limit(1);

  if (!registro) throw new NaoEncontrado();

  // Confirma o escopo pelo plano — o estagiário não lê registro de plano alheio
  // mesmo tendo o id do registro.
  await buscarPlano(tx, escopo, registro.planoId);

  return registro;
}

/** Converte a linha do banco no tipo que as regras de imutabilidade usam. */
function paraSelavel(linha: typeof registros.$inferSelect): RegistroSelavel {
  return {
    id: linha.id,
    finalizadoEm: linha.finalizadoEm,
    versao: linha.versao,
    substituiId: linha.substituiId,
    assinadoPorId: linha.assinadoPorId,
  };
}

// ---------------------------------------------------------------------------
// Comparação longitudinal — o que prova a tese do produto
// ---------------------------------------------------------------------------

/** O que a tela de plano de tratamento precisa para desenhar o gráfico. */
export interface Longitudinal {
  serie: PontoLongitudinal[];
  tendencia: ReturnType<typeof analisarTendencia>;
  /** Total de registros e quantos foram sobrescritos (sempre 0). */
  integridade: { total: number; sobrescritos: number };
}

/**
 * Monta a comparação longitudinal de um plano.
 *
 * Reúne todas as aplicações de teste do plano, normaliza cada escore para
 * 0–100 (invertendo escalas em que maior é pior) e devolve a série pronta.
 */
export async function longitudinalDoPlano(
  tx: Banco,
  escopo: Escopo,
  planoId: string,
): Promise<Longitudinal> {
  await buscarPlano(tx, escopo, planoId);

  const linhas = await tx
    .select({
      registroId: registros.id,
      eva: registros.eva,
      ocorridoEm: registros.ocorridoEm,
      definicaoChave: aplicacoesTeste.definicaoChave,
      escore: aplicacoesTeste.escore,
      substituiId: registros.substituiId,
    })
    .from(registros)
    .leftJoin(aplicacoesTeste, eq(aplicacoesTeste.registroId, registros.id))
    .where(and(eq(registros.organizacaoId, escopo.organizacaoId), eq(registros.planoId, planoId)))
    .orderBy(asc(registros.ocorridoEm));

  // Ids substituídos: a versão antiga não entra no gráfico (senão a mesma
  // sessão apareceria duas vezes), mas continua na linha do tempo.
  const substituidos = new Set(
    linhas.map((l) => l.substituiId).filter((id): id is string => id !== null),
  );

  const aplicacoes: AplicacaoParaSerie[] = linhas
    .filter((l) => l.definicaoChave !== null && !substituidos.has(l.registroId))
    .map((l) => ({
      definicaoChave: l.definicaoChave as string,
      escore: l.escore as number,
      data: l.ocorridoEm,
      registroId: l.registroId,
    }));

  const chaves = [...new Set(aplicacoes.map((a) => a.definicaoChave))];
  const defs =
    chaves.length > 0
      ? await tx.select().from(definicoesTeste).where(inArray(definicoesTeste.chave, chaves))
      : [];

  const definicoes = new Map(defs.map((d) => [d.chave, paraDefinicao(d)]));

  const evaPorRegistro = new Map(
    linhas.filter((l) => l.eva !== null).map((l) => [l.registroId, l.eva as number]),
  );

  const serie = montarSerie(aplicacoes, definicoes, evaPorRegistro);

  const idsUnicos = new Set(linhas.map((l) => l.registroId));

  return {
    serie,
    tendencia: analisarTendencia(serie),
    integridade: { total: idsUnicos.size, sobrescritos: 0 },
  };
}

/**
 * Linha do tempo do episódio: todos os registros, incluindo versões antigas.
 *
 * Ao contrário do gráfico, aqui a v1 **aparece** — é justamente o que torna a
 * correção visível em vez de silenciosa.
 */
export async function linhaDoTempo(tx: Banco, escopo: Escopo, planoId: string) {
  await buscarPlano(tx, escopo, planoId);

  const linhas = await tx
    .select({
      id: registros.id,
      tipo: registros.tipo,
      codigo: registros.codigo,
      eva: registros.eva,
      conduta: registros.conduta,
      ocorridoEm: registros.ocorridoEm,
      finalizadoEm: registros.finalizadoEm,
      versao: registros.versao,
      substituiId: registros.substituiId,
      motivoVersao: registros.motivoVersao,
      assinadoPorNome: profissionais.nome,
      assinadoPorCrefito: profissionais.crefito,
    })
    .from(registros)
    .leftJoin(profissionais, eq(profissionais.id, registros.assinadoPorId))
    .where(and(eq(registros.organizacaoId, escopo.organizacaoId), eq(registros.planoId, planoId)))
    .orderBy(desc(registros.ocorridoEm));

  // Registro de leitura de prontuário: exigência da especificação. Ler também
  // é um evento auditável — é assim que se detecta curiosidade indevida.
  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.sujeitoId,
    atorPapel: escopo.papel,
    acao: 'LEITURA_PRONTUARIO',
    entidade: 'PlanoTratamento',
    entidadeId: planoId,
    detalhe: `${linhas.length} registros lidos.`,
  });

  return linhas;
}

/**
 * Compara a aplicação mais recente de cada teste com a **linha de base** e com
 * a sessão anterior.
 *
 * ## Por que dois deltas, e por que o principal é o da linha de base
 *
 * A comparação com a sessão anterior responde "a última conduta funcionou?" —
 * pergunta legítima, mas ruidosa: entre duas sessões seguidas a variação
 * costuma ser pequena, e a tela acabava exibindo "0 · estável" para um paciente
 * que saiu de EVA 7 para EVA 2 ao longo do tratamento.
 *
 * A comparação com a primeira aplicação responde "o tratamento está
 * funcionando?" — que é a tese do produto e o que o gráfico logo acima já
 * mostra. Esse é o número em destaque.
 *
 * O delta da sessão anterior continua disponível, em segundo plano.
 */
export async function deltasDoPlano(tx: Banco, escopo: Escopo, planoId: string) {
  await buscarPlano(tx, escopo, planoId);

  const linhas = await tx
    .select({
      chave: aplicacoesTeste.definicaoChave,
      escore: aplicacoesTeste.escore,
      aplicadoEm: aplicacoesTeste.aplicadoEm,
    })
    .from(aplicacoesTeste)
    .innerJoin(registros, eq(registros.id, aplicacoesTeste.registroId))
    .where(
      and(eq(aplicacoesTeste.organizacaoId, escopo.organizacaoId), eq(registros.planoId, planoId)),
    )
    .orderBy(asc(aplicacoesTeste.aplicadoEm));

  const porChave = new Map<string, number[]>();
  for (const l of linhas) {
    const lista = porChave.get(l.chave) ?? [];
    lista.push(l.escore);
    porChave.set(l.chave, lista);
  }

  const chaves = [...porChave.keys()];
  const defs =
    chaves.length > 0
      ? await tx.select().from(definicoesTeste).where(inArray(definicoesTeste.chave, chaves))
      : [];

  return defs.map((d) => {
    const escores = porChave.get(d.chave) ?? [];
    const atual = escores.at(-1) ?? 0;

    // Linha de base: a PRIMEIRA aplicação deste teste no plano.
    const base = escores.length >= 2 ? (escores[0] as number) : null;
    // Sessão anterior: a penúltima.
    const anterior = escores.length >= 2 ? (escores.at(-2) as number) : null;

    const definicao = paraDefinicao(d);

    return {
      chave: d.chave,
      nome: d.nome,
      versao: d.versao,
      unidade: d.unidade,
      fonte: d.fonte,
      licenca: d.licenca,
      atual,
      inicial: base,
      // `compararEscores` respeita `maiorEhPior` — é o que impede pintar de
      // verde uma piora numa escala invertida como a Oswestry.
      delta: compararEscores(definicao, atual, base),
      deltaSessaoAnterior: compararEscores(definicao, atual, anterior),
      aplicacoes: escores.length,
    };
  });
}
