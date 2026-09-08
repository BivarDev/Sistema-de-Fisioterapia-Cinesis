/**
 * Serviço de adesão: prescrição HEP, portal do paciente e painel de adesão.
 *
 * É a metade do ciclo que acontece **fora da clínica** — o diferencial que a
 * especificação identifica como o real, já que agenda e prontuário são
 * tabela-stakes do mercado.
 *
 * ## O caminho completo
 *
 * ```
 * fisioterapeuta prescreve → link mágico → paciente executa → paciente registra
 *   → sistema consolida → fisioterapeuta acompanha
 * ```
 *
 * Cada seta acima é uma função deste arquivo.
 */

import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import {
  calcularAdesao,
  adesaoPorExercicio,
  exigirPrescritivel,
  resumoParaPaciente,
  type ExercicioGovernavel,
  type RegistroParaCalculo,
} from '@cinesis/domain';
import {
  Escopo,
  EscopoPortal,
  emitirTokenPortal,
  hashDoToken,
  validarToken,
  montarUrlPortal,
  type Anel,
  type RecusaToken,
} from '@cinesis/security';
import { Conflito, NaoEncontrado, type LinhaAdesao, type StatusAdesao } from '@cinesis/shared';
import {
  exercicios,
  pacientes,
  planos,
  prescricaoItens,
  prescricoes,
  registrosAdesao,
  tokensPortal,
} from '../db/schema.js';
import type { Banco } from '../db/conexao.js';
import { novoId } from '../infra/ids.js';
import { catalogoVisivelPara } from './catalogo-visivel.js';
import { auditar } from './auditoria.js';
import { buscarPlano, longitudinalDoPlano } from './prontuario.js';

// ---------------------------------------------------------------------------
// Prescrição
// ---------------------------------------------------------------------------

/** Um item FITT vindo do formulário. */
export interface ItemPrescricao {
  exercicioId: string;
  series: number;
  repeticoes: number;
  carga: string;
  frequenciaSemanal: number;
  progressao: string;
}

/**
 * Cria uma prescrição HEP.
 *
 * A regra de governança é aplicada **item a item, no servidor**: somente
 * exercício `published` com licença declarada pode ser prescrito. Filtrar
 * apenas na listagem do passo 1 deixaria passar quem enviasse o id direto na
 * requisição — que é o ataque óbvio contra uma validação só de interface.
 */
export async function criarPrescricao(
  tx: Banco,
  escopo: Escopo,
  planoId: string,
  itens: ItemPrescricao[],
  metaSemanal: number,
): Promise<{ id: string }> {
  await buscarPlano(tx, escopo, planoId);

  const ids = itens.map((i) => i.exercicioId);

  // O filtro de visibilidade também entra AQUI, não só na listagem: prescrever
  // com o id de um exercício de outra clínica seria ler o conteúdo dela por um
  // caminho lateral. Ver `catalogo-visivel.ts`.
  const catalogo = await tx
    .select()
    .from(exercicios)
    .where(and(inArray(exercicios.id, ids), catalogoVisivelPara(escopo.organizacaoId)));

  const porId = new Map(catalogo.map((e) => [e.id, e]));

  // Desativa a prescrição anterior: o paciente segue um programa por vez, e
  // duas prescrições ativas fariam o cálculo de adesão contar o dobro de dias
  // esperados.
  await tx
    .update(prescricoes)
    .set({ ativa: false })
    .where(
      and(
        eq(prescricoes.organizacaoId, escopo.organizacaoId),
        eq(prescricoes.planoId, planoId),
        eq(prescricoes.ativa, true),
      ),
    );

  const id = novoId();
  await tx.insert(prescricoes).values({
    id,
    organizacaoId: escopo.organizacaoId,
    planoId,
    metaSemanal,
  });

  for (const item of itens) {
    const exercicio = porId.get(item.exercicioId);
    if (!exercicio) throw new NaoEncontrado();

    // Lança 409 com a razão específica (não publicado / sem licença).
    exigirPrescritivel(paraGovernavel(exercicio));

    await tx.insert(prescricaoItens).values({
      id: novoId(),
      organizacaoId: escopo.organizacaoId,
      prescricaoId: id,
      exercicioId: item.exercicioId,
      // Congela a versão prescrita. Editar o catálogo depois não altera o que
      // o paciente já recebeu — mudar retroativamente uma orientação clínica
      // seria alterar uma conduta já prescrita.
      exercicioVersao: exercicio.versao,
      series: item.series,
      repeticoes: item.repeticoes,
      carga: item.carga,
      frequenciaSemanal: item.frequenciaSemanal,
      progressao: item.progressao,
    });
  }

  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.sujeitoId,
    atorPapel: escopo.papel,
    acao: 'PRESCRICAO_CRIADA',
    entidade: 'Prescricao',
    entidadeId: id,
    detalhe: `${itens.length} exercícios, meta de ${metaSemanal} dias/semana.`,
  });

  return { id };
}

/** Converte a linha do banco no tipo que as regras de governança usam. */
function paraGovernavel(linha: typeof exercicios.$inferSelect): ExercicioGovernavel {
  return {
    id: linha.id,
    status: linha.status as ExercicioGovernavel['status'],
    versao: linha.versao,
    autorId: linha.autorId ?? '',
    revisorId: linha.revisorId,
    licenca: linha.licenca,
    temMidia: linha.midiaId !== null,
  };
}

// ---------------------------------------------------------------------------
// Link mágico do portal
// ---------------------------------------------------------------------------

/**
 * Emite um link mágico para o paciente.
 *
 * Garantias, todas verificáveis nos testes:
 * - expira em 15 minutos;
 * - uso único;
 * - reemissão em vez de reuso (emitir de novo revoga os pendentes);
 * - o banco guarda o **HMAC** do token, nunca o token;
 * - o token vai no **path** da URL, não na query.
 *
 * O rate limit de 5/h é aplicado na rota, antes de chegar aqui.
 *
 * @returns A URL completa. **O token em claro existe só neste retorno** — não
 *          é recuperável depois, nem por quem tem o banco.
 */
export async function emitirLinkPortal(
  tx: Banco,
  anel: Anel,
  escopo: Escopo,
  pacienteId: string,
  baseUrlPortal: string,
): Promise<{ url: string; expiraEm: Date }> {
  const [paciente] = await tx
    .select({ id: pacientes.id })
    .from(pacientes)
    .where(
      and(eq(pacientes.id, pacienteId), eq(pacientes.organizacaoId, escopo.organizacaoId)),
    )
    .limit(1);

  if (!paciente) throw new NaoEncontrado();

  // "Reemissão em vez de reuso": os links pendentes morrem agora. Sem isto, um
  // link antigo esquecido numa conversa de WhatsApp continuaria valendo dentro
  // da janela dele.
  await tx
    .update(tokensPortal)
    .set({ revogadoEm: new Date() })
    .where(
      and(
        eq(tokensPortal.organizacaoId, escopo.organizacaoId),
        eq(tokensPortal.pacienteId, pacienteId),
        // `IS NULL` nas duas colunas: só os que ainda estavam válidos.
        isNull(tokensPortal.consumidoEm),
        isNull(tokensPortal.revogadoEm),
      ),
    );

  const token = emitirTokenPortal(anel);

  await tx.insert(tokensPortal).values({
    id: novoId(),
    organizacaoId: escopo.organizacaoId,
    pacienteId,
    tokenHash: token.hash,
    expiraEm: token.expiraEm,
  });

  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.sujeitoId,
    atorPapel: escopo.papel,
    acao: 'LINK_PORTAL_EMITIDO',
    entidade: 'Paciente',
    entidadeId: pacienteId,
    detalhe: 'Validade de 15 min, uso único.',
  });

  return { url: montarUrlPortal(baseUrlPortal, token.emClaro), expiraEm: token.expiraEm };
}

/** O que o consumo de um token devolve. */
export type ResultadoConsumo =
  | { ok: true; pacienteId: string; organizacaoId: string }
  | { ok: false; recusa: RecusaToken };

/**
 * Consome um token de link mágico e libera a sessão do portal.
 *
 * O consumo é uma **escrita condicional**: `UPDATE ... WHERE consumido_em IS
 * NULL`. Um `SELECT` seguido de `UPDATE` teria uma janela de corrida em que
 * duas requisições simultâneas com o mesmo token abririam duas sessões — o que
 * derrubaria a garantia de uso único justamente no cenário em que ela importa
 * (token interceptado e usado em paralelo com o paciente legítimo).
 */
export async function consumirTokenPortal(
  tx: Banco,
  anel: Anel,
  tokenEmClaro: string,
  agora = new Date(),
): Promise<ResultadoConsumo> {
  const hash = hashDoToken(anel, tokenEmClaro);

  // A busca é pelo hash — o token em claro nunca é comparado com nada no banco.
  const [linha] = await tx
    .select()
    .from(tokensPortal)
    .where(eq(tokensPortal.tokenHash, hash))
    .limit(1);

  const validacao = validarToken(
    linha ? { expiraEm: linha.expiraEm, consumidoEm: linha.consumidoEm, revogadoEm: linha.revogadoEm } : null,
    agora,
  );

  if (!validacao.ok) {
    // Só audita quando sabemos de qual organização se trata. Token forjado não
    // pertence a tenant nenhum e não tem onde ser registrado — nesse caso o
    // rate limit por rede é a defesa.
    if (linha) {
      await auditar(tx, {
        organizacaoId: linha.organizacaoId,
        atorId: null,
        atorPapel: 'sistema',
        acao: 'LINK_PORTAL_RECUSADO',
        entidade: 'TokenPortal',
        entidadeId: linha.id,
        detalhe: `Recusa: ${validacao.recusa}.`,
      });
    }
    return { ok: false, recusa: validacao.recusa };
  }

  // Marca como consumido, condicionalmente. Se outra requisição venceu a
  // corrida, `returning` volta vazio e recusamos.
  const consumido = await tx
    .update(tokensPortal)
    .set({ consumidoEm: agora })
    .where(and(eq(tokensPortal.id, linha!.id), isNull(tokensPortal.consumidoEm)))
    .returning({ id: tokensPortal.id });

  if (consumido.length === 0) return { ok: false, recusa: 'ja_consumido' };

  await auditar(tx, {
    organizacaoId: linha!.organizacaoId,
    atorId: linha!.pacienteId,
    atorPapel: 'paciente',
    acao: 'LINK_PORTAL_CONSUMIDO',
    entidade: 'TokenPortal',
    entidadeId: linha!.id,
  });

  return { ok: true, pacienteId: linha!.pacienteId, organizacaoId: linha!.organizacaoId };
}

// ---------------------------------------------------------------------------
// Portal do paciente
// ---------------------------------------------------------------------------

/** O que o portal mostra: quatro ações possíveis e nada mais. */
export interface PainelPortal {
  metaSemanal: number;
  /** Exercícios de hoje, com o registro do dia se já houver. */
  exercicios: {
    itemId: string;
    nome: string;
    /** Orientação em linguagem de paciente, não clínica. */
    orientacao: string;
    series: number;
    repeticoes: number;
    carga: string;
    registroHoje: StatusAdesao | null;
  }[];
  /** Quantos dos exercícios de hoje já foram registrados. */
  feitosHoje: number;
  sequencia: number;
  /** Barras do gráfico de progresso, já normalizadas de 0 a 100. */
  progresso: number[];
  /** Resumo em linguagem de paciente, ex.: "Sua dor caiu de 7 para 2". */
  resumo: string;
}

/**
 * Monta o painel do portal.
 *
 * Todo acesso parte do `pacienteId` **da sessão**, nunca de um id vindo da URL.
 * É o que garante o critério de aceitação: *"vê apenas dados do seu próprio
 * contexto e não tem acesso a prontuário de outros pacientes"*.
 */
export async function painelDoPortal(
  tx: Banco,
  escopo: EscopoPortal,
  hoje = new Date(),
): Promise<PainelPortal> {
  const dataHoje = hoje.toISOString().slice(0, 10);

  // Plano ativo do próprio paciente. `pacienteId` vem da sessão.
  const [plano] = await tx
    .select({ id: planos.id })
    .from(planos)
    .where(
      and(
        eq(planos.organizacaoId, escopo.organizacaoId),
        eq(planos.pacienteId, escopo.pacienteId),
        eq(planos.status, 'ativo'),
      ),
    )
    .orderBy(desc(planos.iniciadoEm))
    .limit(1);

  if (!plano) {
    return {
      metaSemanal: 0,
      exercicios: [],
      feitosHoje: 0,
      sequencia: 0,
      progresso: [],
      resumo: 'Você ainda não tem um programa ativo. Fale com sua clínica.',
    };
  }

  const [prescricao] = await tx
    .select()
    .from(prescricoes)
    .where(
      and(
        eq(prescricoes.organizacaoId, escopo.organizacaoId),
        eq(prescricoes.planoId, plano.id),
        eq(prescricoes.ativa, true),
      ),
    )
    .limit(1);

  const itens = prescricao
    ? await tx
        .select({
          itemId: prescricaoItens.id,
          nome: exercicios.nome,
          orientacao: exercicios.orientacao,
          series: prescricaoItens.series,
          repeticoes: prescricaoItens.repeticoes,
          carga: prescricaoItens.carga,
        })
        .from(prescricaoItens)
        .innerJoin(exercicios, eq(exercicios.id, prescricaoItens.exercicioId))
        .where(eq(prescricaoItens.prescricaoId, prescricao.id))
    : [];

  // Registros de hoje, para marcar os botões já clicados.
  const deHoje = await tx
    .select({ itemId: registrosAdesao.prescricaoItemId, status: registrosAdesao.status })
    .from(registrosAdesao)
    .where(
      and(
        eq(registrosAdesao.organizacaoId, escopo.organizacaoId),
        eq(registrosAdesao.pacienteId, escopo.pacienteId),
        eq(registrosAdesao.data, dataHoje),
      ),
    );

  const statusHoje = new Map(deHoje.map((r) => [r.itemId, r.status as StatusAdesao]));

  // Últimos 30 dias, para a sequência.
  const corte = new Date(hoje.getTime() - 30 * 86_400_000);
  const historico = await tx
    .select({
      data: registrosAdesao.data,
      status: registrosAdesao.status,
      prescricaoItemId: registrosAdesao.prescricaoItemId,
    })
    .from(registrosAdesao)
    .where(
      and(
        eq(registrosAdesao.organizacaoId, escopo.organizacaoId),
        eq(registrosAdesao.pacienteId, escopo.pacienteId),
        gte(registrosAdesao.data, corte.toISOString().slice(0, 10)),
      ),
    );

  const calculo = calcularAdesao(
    historico as RegistroParaCalculo[],
    prescricao?.criadaEm ?? corte,
    hoje,
    prescricao?.metaSemanal ?? 3,
  );

  // A série longitudinal é reaproveitada, mas o paciente vê só as barras e uma
  // frase — nada de escore, EVA ou jargão clínico.
  const longitudinal = await serieDoPacienteNoPortal(tx, escopo, plano.id);

  return {
    metaSemanal: prescricao?.metaSemanal ?? 0,
    exercicios: itens.map((i) => ({
      ...i,
      registroHoje: statusHoje.get(i.itemId) ?? null,
    })),
    feitosHoje: deHoje.filter((r) => r.status === 'fez').length,
    sequencia: calculo.sequencia,
    progresso: longitudinal.serie.map((p) => p.escore),
    resumo: resumoParaPaciente(longitudinal.serie),
  };
}

/**
 * Série longitudinal para o portal.
 *
 * Um `Escopo` profissional é montado internamente só para reaproveitar a
 * consulta — mas com o papel `paciente`, que não tem nenhuma permissão de
 * prontuário. O paciente vê o gráfico da própria evolução, não o prontuário.
 */
async function serieDoPacienteNoPortal(tx: Banco, escopo: EscopoPortal, planoId: string) {
  const comoLeitor = new Escopo(escopo.pacienteId, escopo.organizacaoId, 'fisioterapeuta');
  return longitudinalDoPlano(tx, comoLeitor, planoId);
}

/**
 * Registra a execução de um exercício pelo paciente.
 *
 * O `onConflictDoUpdate` implementa "reenviar corrige em vez de duplicar".
 * Sem ele, o paciente que clicasse duas vezes inflaria a própria taxa de
 * adesão — e a métrica que o fisioterapeuta usa para decidir conduta ficaria
 * errada para cima, que é o pior lado do erro.
 */
export async function registrarAdesao(
  tx: Banco,
  escopo: EscopoPortal,
  itemId: string,
  data: string,
  status: StatusAdesao,
  observacao: string | null,
): Promise<void> {
  // Confirma que o item pertence a uma prescrição de um plano do PRÓPRIO
  // paciente. Sem esta checagem, um paciente poderia registrar execução no
  // programa de outro só trocando o id.
  const [item] = await tx
    .select({ id: prescricaoItens.id, pacienteId: planos.pacienteId })
    .from(prescricaoItens)
    .innerJoin(prescricoes, eq(prescricoes.id, prescricaoItens.prescricaoId))
    .innerJoin(planos, eq(planos.id, prescricoes.planoId))
    .where(
      and(
        eq(prescricaoItens.id, itemId),
        eq(prescricaoItens.organizacaoId, escopo.organizacaoId),
      ),
    )
    .limit(1);

  if (!item || !escopo.ehDoProprioPaciente(item.pacienteId)) throw new NaoEncontrado();

  // Registro futuro não faz sentido e permitiria inflar a sequência.
  if (data > new Date().toISOString().slice(0, 10)) {
    throw new Conflito('Não é possível registrar execução em data futura.');
  }

  await tx
    .insert(registrosAdesao)
    .values({
      id: novoId(),
      organizacaoId: escopo.organizacaoId,
      pacienteId: escopo.pacienteId,
      prescricaoItemId: itemId,
      data,
      status,
      observacao,
    })
    .onConflictDoUpdate({
      target: [registrosAdesao.prescricaoItemId, registrosAdesao.data],
      set: { status, observacao, registradoEm: new Date() },
    });

  await auditar(tx, {
    organizacaoId: escopo.organizacaoId,
    atorId: escopo.pacienteId,
    atorPapel: 'paciente',
    acao: 'EXERCICIO_REGISTRADO',
    entidade: 'RegistroAdesao',
    entidadeId: itemId,
    detalhe: `${status} em ${data}.`,
  });
}

// ---------------------------------------------------------------------------
// Painel do fisioterapeuta
// ---------------------------------------------------------------------------

/**
 * Monta o painel de adesão da organização.
 *
 * @param dias Janela de análise. 30 dias é o padrão do painel.
 */
export async function painelDeAdesao(
  tx: Banco,
  escopo: Escopo,
  nomePorPaciente: ReadonlyMap<string, string>,
  dias = 30,
  hoje = new Date(),
): Promise<LinhaAdesao[]> {
  const inicio = new Date(hoje.getTime() - dias * 86_400_000);

  const condicoes = [
    eq(planos.organizacaoId, escopo.organizacaoId),
    eq(planos.status, 'ativo'),
  ];

  // Escopo restrito na query, como sempre.
  if (escopo.ehRestrito('hep:ler')) {
    condicoes.push(inArray(planos.profissionalId, escopo.profissionaisVisiveis()));
  }

  const ativos = await tx
    .select({
      pacienteId: planos.pacienteId,
      codigo: pacientes.codigo,
      metaSemanal: prescricoes.metaSemanal,
      prescricaoCriadaEm: prescricoes.criadaEm,
    })
    .from(planos)
    .innerJoin(pacientes, eq(pacientes.id, planos.pacienteId))
    .innerJoin(
      prescricoes,
      and(eq(prescricoes.planoId, planos.id), eq(prescricoes.ativa, true)),
    )
    .where(and(...condicoes));

  if (ativos.length === 0) return [];

  const registros = await tx
    .select({
      pacienteId: registrosAdesao.pacienteId,
      data: registrosAdesao.data,
      status: registrosAdesao.status,
      prescricaoItemId: registrosAdesao.prescricaoItemId,
    })
    .from(registrosAdesao)
    .where(
      and(
        eq(registrosAdesao.organizacaoId, escopo.organizacaoId),
        gte(registrosAdesao.data, inicio.toISOString().slice(0, 10)),
        inArray(
          registrosAdesao.pacienteId,
          ativos.map((a) => a.pacienteId),
        ),
      ),
    );

  const porPaciente = new Map<string, RegistroParaCalculo[]>();
  for (const r of registros) {
    const lista = porPaciente.get(r.pacienteId) ?? [];
    lista.push({ data: r.data, status: r.status as StatusAdesao, prescricaoItemId: r.prescricaoItemId });
    porPaciente.set(r.pacienteId, lista);
  }

  return ativos.map((a) => {
    const calculo = calcularAdesao(
      porPaciente.get(a.pacienteId) ?? [],
      // A prescrição pode ser mais nova que a janela; nesse caso o denominador
      // conta só a partir dela — não punimos o paciente por dias em que não
      // havia programa.
      a.prescricaoCriadaEm > inicio ? a.prescricaoCriadaEm : inicio,
      hoje,
      a.metaSemanal,
    );

    return {
      pacienteId: a.pacienteId,
      codigo: a.codigo,
      // `null` quando o ator não pode reidentificar — o nome nem foi buscado.
      nome: nomePorPaciente.get(a.pacienteId) ?? null,
      taxa: calculo.taxa,
      metaSemanal: a.metaSemanal,
      sequencia: calculo.sequencia,
      ultimos7: calculo.ultimos7,
    };
  });
}

/**
 * Adesão agregada por exercício, atravessando todos os pacientes.
 *
 * O insight embutido na tela: *"exercício com adesão baixa costuma ser problema
 * de prescrição, não de paciente"*. Um exercício com 42% em quinze pessoas
 * diferentes está mal prescrito ou mal explicado.
 */
export async function adesaoPorExercicioDaOrganizacao(tx: Banco, escopo: Escopo, dias = 30) {
  const inicio = new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);

  const linhas = await tx
    .select({
      data: registrosAdesao.data,
      status: registrosAdesao.status,
      prescricaoItemId: registrosAdesao.prescricaoItemId,
      nome: exercicios.nome,
    })
    .from(registrosAdesao)
    .innerJoin(prescricaoItens, eq(prescricaoItens.id, registrosAdesao.prescricaoItemId))
    .innerJoin(exercicios, eq(exercicios.id, prescricaoItens.exercicioId))
    .where(
      and(
        eq(registrosAdesao.organizacaoId, escopo.organizacaoId),
        gte(registrosAdesao.data, inicio),
      ),
    );

  const nomePorItem = new Map(linhas.map((l) => [l.prescricaoItemId, l.nome]));

  return adesaoPorExercicio(
    linhas.map((l) => ({
      data: l.data,
      status: l.status as StatusAdesao,
      prescricaoItemId: l.prescricaoItemId,
    })),
    nomePorItem,
  );
}
