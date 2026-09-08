/**
 * Enriquecimento da listagem de pacientes.
 *
 * ## O problema que este arquivo resolve
 *
 * A tela de Pacientes precisa responder, num varrimento: quem está evoluindo,
 * quem está estagnado, quem tem adesão baixa, qual a dor atual comparada à
 * inicial. Sem isso, os filtros da tela ("Evoluindo", "Baixa adesão",
 * "Estagnado") não filtram nada e a tabela vira uma lista de nomes.
 *
 * ## Por que é um módulo separado, e não parte de `listarPacientes`
 *
 * São quatro agregações independentes (série longitudinal, adesão, EVA,
 * próxima sessão) que precisam ser feitas **em lote**, para a lista inteira.
 * Fazê-las por paciente dentro de um laço seria o clássico N+1: 30 pacientes
 * virariam 120 consultas.
 *
 * Cada função aqui recebe a lista de ids e devolve um `Map`. A listagem só
 * junta os mapas no fim.
 */

import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { analisarTendencia, calcularAdesao, montarSerie } from '@cinesis/domain';
import type { AplicacaoParaSerie, RegistroParaCalculo } from '@cinesis/domain';
import type { DefinicaoTeste, PacienteResumo, StatusAdesao } from '@cinesis/shared';
import {
  aplicacoesTeste,
  definicoesTeste,
  planos,
  prescricoes,
  registros,
  registrosAdesao,
  sessoes,
} from '../db/schema.js';
import type { Banco } from '../db/conexao.js';

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

/** O que o enriquecimento produz para cada paciente. */
export interface ResumoCalculado {
  situacao: PacienteResumo['situacao'];
  adesao: number | null;
  evaAtual: number | null;
  evaInicial: number | null;
  proximaSessao: string | null;
}

/**
 * Calcula situação, adesão, EVA e próxima sessão para uma lista de pacientes.
 *
 * @param tx            Transação com tenant fixado.
 * @param organizacaoId Tenant.
 * @param pacienteIds   Ids dos pacientes da página corrente.
 * @param agora         Instante base (injetável para teste).
 * @returns             Mapa `pacienteId` → resumo.
 */
export async function calcularResumos(
  tx: Banco,
  organizacaoId: string,
  pacienteIds: string[],
  agora = new Date(),
): Promise<Map<string, ResumoCalculado>> {
  const vazio = new Map<string, ResumoCalculado>();
  if (pacienteIds.length === 0) return vazio;

  // --- Planos ativos: a ponte entre paciente e todo o resto ------------------
  const ativos = await tx
    .select({ planoId: planos.id, pacienteId: planos.pacienteId })
    .from(planos)
    .where(
      and(
        eq(planos.organizacaoId, organizacaoId),
        eq(planos.status, 'ativo'),
        inArray(planos.pacienteId, pacienteIds),
      ),
    );

  const planoPorPaciente = new Map(ativos.map((a) => [a.pacienteId, a.planoId]));
  const pacientePorPlano = new Map(ativos.map((a) => [a.planoId, a.pacienteId]));
  const planoIds = ativos.map((a) => a.planoId);

  // Todo paciente começa sem plano; os que têm são preenchidos abaixo.
  const resultado = new Map<string, ResumoCalculado>(
    pacienteIds.map((id) => [
      id,
      {
        situacao: planoPorPaciente.has(id) ? 'estavel' : 'sem_plano',
        adesao: null,
        evaAtual: null,
        evaInicial: null,
        proximaSessao: null,
      },
    ]),
  );

  if (planoIds.length === 0) return resultado;

  // --- EVA: primeira e última de cada plano ---------------------------------
  // Uma consulta só, ordenada; o primeiro e o último de cada plano saem do
  // agrupamento em memória. Duas consultas com `DISTINCT ON` seriam mais
  // elegantes em SQL puro e menos legíveis aqui.
  const evas = await tx
    .select({
      planoId: registros.planoId,
      eva: registros.eva,
      ocorridoEm: registros.ocorridoEm,
    })
    .from(registros)
    .where(
      and(
        eq(registros.organizacaoId, organizacaoId),
        inArray(registros.planoId, planoIds),
        // `IS NOT NULL`: registro sem EVA não entra na comparação.
        sql`${registros.eva} IS NOT NULL`,
      ),
    )
    .orderBy(asc(registros.ocorridoEm));

  const evaPorPlano = new Map<string, number[]>();
  for (const e of evas) {
    const lista = evaPorPlano.get(e.planoId) ?? [];
    lista.push(e.eva as number);
    evaPorPlano.set(e.planoId, lista);
  }

  // --- Série longitudinal, para a tendência ---------------------------------
  const aplicacoes = await tx
    .select({
      planoId: registros.planoId,
      registroId: registros.id,
      chave: aplicacoesTeste.definicaoChave,
      escore: aplicacoesTeste.escore,
      ocorridoEm: registros.ocorridoEm,
      eva: registros.eva,
      substituiId: registros.substituiId,
    })
    .from(aplicacoesTeste)
    .innerJoin(registros, eq(registros.id, aplicacoesTeste.registroId))
    .where(
      and(
        eq(aplicacoesTeste.organizacaoId, organizacaoId),
        inArray(registros.planoId, planoIds),
      ),
    )
    .orderBy(asc(registros.ocorridoEm));

  const chaves = [...new Set(aplicacoes.map((a) => a.chave))];
  const definicoes =
    chaves.length > 0
      ? new Map(
          (await tx.select().from(definicoesTeste).where(inArray(definicoesTeste.chave, chaves)))
            .map((d) => [d.chave, paraDefinicao(d)]),
        )
      : new Map<string, DefinicaoTeste>();

  // Versões substituídas não entram na série: senão a mesma sessão contaria
  // duas vezes e distorceria a tendência.
  const substituidos = new Set(
    aplicacoes.map((a) => a.substituiId).filter((id): id is string => id !== null),
  );

  const porPlano = new Map<string, AplicacaoParaSerie[]>();
  const evaPorRegistro = new Map<string, number>();

  for (const a of aplicacoes) {
    if (substituidos.has(a.registroId)) continue;

    const lista = porPlano.get(a.planoId) ?? [];
    lista.push({
      definicaoChave: a.chave,
      escore: a.escore,
      data: a.ocorridoEm,
      registroId: a.registroId,
    });
    porPlano.set(a.planoId, lista);

    if (a.eva !== null) evaPorRegistro.set(a.registroId, a.eva);
  }

  // --- Adesão: registros dos últimos 30 dias --------------------------------
  const inicioJanela = new Date(agora.getTime() - 30 * 86_400_000);

  const prescricoesAtivas = await tx
    .select({
      planoId: prescricoes.planoId,
      metaSemanal: prescricoes.metaSemanal,
      criadaEm: prescricoes.criadaEm,
    })
    .from(prescricoes)
    .where(
      and(
        eq(prescricoes.organizacaoId, organizacaoId),
        eq(prescricoes.ativa, true),
        inArray(prescricoes.planoId, planoIds),
      ),
    );

  const prescricaoPorPlano = new Map(prescricoesAtivas.map((p) => [p.planoId, p]));

  const registrosDeAdesao = await tx
    .select({
      pacienteId: registrosAdesao.pacienteId,
      data: registrosAdesao.data,
      status: registrosAdesao.status,
      prescricaoItemId: registrosAdesao.prescricaoItemId,
    })
    .from(registrosAdesao)
    .where(
      and(
        eq(registrosAdesao.organizacaoId, organizacaoId),
        inArray(registrosAdesao.pacienteId, pacienteIds),
        gte(registrosAdesao.data, inicioJanela.toISOString().slice(0, 10)),
      ),
    );

  const adesaoPorPaciente = new Map<string, RegistroParaCalculo[]>();
  for (const r of registrosDeAdesao) {
    const lista = adesaoPorPaciente.get(r.pacienteId) ?? [];
    lista.push({
      data: r.data,
      status: r.status as StatusAdesao,
      prescricaoItemId: r.prescricaoItemId,
    });
    adesaoPorPaciente.set(r.pacienteId, lista);
  }

  // --- Próxima sessão agendada ----------------------------------------------
  const proximas = await tx
    .select({ pacienteId: sessoes.pacienteId, inicioEm: sessoes.inicioEm })
    .from(sessoes)
    .where(
      and(
        eq(sessoes.organizacaoId, organizacaoId),
        inArray(sessoes.pacienteId, pacienteIds),
        gte(sessoes.inicioEm, agora),
        // Cancelada e no-show não são "próxima sessão".
        inArray(sessoes.status, ['agendada', 'confirmada']),
      ),
    )
    .orderBy(asc(sessoes.inicioEm));

  const proximaPorPaciente = new Map<string, Date>();
  for (const s of proximas) {
    // A consulta vem ordenada, então a primeira ocorrência já é a mais próxima.
    if (!proximaPorPaciente.has(s.pacienteId)) proximaPorPaciente.set(s.pacienteId, s.inicioEm);
  }

  // --- Junta tudo -----------------------------------------------------------
  for (const [planoId, pacienteId] of pacientePorPlano) {
    const resumo = resultado.get(pacienteId);
    if (!resumo) continue;

    // EVA inicial e atual.
    const listaEva = evaPorPlano.get(planoId);
    if (listaEva && listaEva.length > 0) {
      resumo.evaInicial = listaEva[0] as number;
      resumo.evaAtual = listaEva[listaEva.length - 1] as number;
    }

    // Situação, a partir da tendência da série longitudinal.
    const doPlano = porPlano.get(planoId);
    if (doPlano && doPlano.length > 0) {
      const serie = montarSerie(doPlano, definicoes, evaPorRegistro);
      const analise = analisarTendencia(serie);

      resumo.situacao =
        analise.tendencia === 'evoluindo'
          ? 'evoluindo'
          : analise.tendencia === 'estagnado'
            ? 'estagnado'
            : 'estavel';
    }

    // Adesão.
    const prescricao = prescricaoPorPlano.get(planoId);
    if (prescricao) {
      const calculo = calcularAdesao(
        adesaoPorPaciente.get(pacienteId) ?? [],
        // A prescrição pode ser mais nova que a janela — nesse caso o
        // denominador começa nela, para não punir dias sem programa.
        prescricao.criadaEm > inicioJanela ? prescricao.criadaEm : inicioJanela,
        agora,
        prescricao.metaSemanal,
      );
      resumo.adesao = calculo.taxa;
    }

    const proxima = proximaPorPaciente.get(pacienteId);
    if (proxima) resumo.proximaSessao = proxima.toISOString();
  }

  return resultado;
}
