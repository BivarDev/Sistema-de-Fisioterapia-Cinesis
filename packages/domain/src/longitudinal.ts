/**
 * Comparação longitudinal — a tese central do produto.
 *
 * Segundo a especificação, é aqui que o Cinesis prova o que promete:
 * *"transformar o tratamento fisioterapêutico em uma linha do tempo
 * mensurável"*. O gráfico de barras de escore com a linha de EVA sobreposta,
 * na tela de Plano de tratamento, é a saída deste módulo.
 *
 * ## O que é o "escore funcional composto"
 *
 * Um número de 0 a 100 que resume o estado funcional do paciente naquela
 * sessão. Ele não é uma escala validada — é uma **agregação transparente** das
 * escalas validadas que o profissional aplicou, e o sistema diz isso na
 * interface. A alternativa (inventar um índice próprio e apresentá-lo como
 * medida clínica) seria irresponsável.
 *
 * Regra de composição, documentada e auditável:
 *
 * 1. Cada teste aplicado é normalizado para 0–100, onde **100 é sempre o
 *    melhor estado** (escalas em que maior é pior são invertidas).
 * 2. O escore da sessão é a média dos testes normalizados daquela sessão.
 * 3. Sessão sem teste aplicado não entra na série — não inventamos ponto.
 */

import type { DefinicaoTeste, PontoLongitudinal } from '@cinesis/shared';

/** Uma aplicação de teste, do jeito que sai do banco. */
export interface AplicacaoParaSerie {
  /** Chave da definição usada. */
  definicaoChave: string;
  /** Escore calculado. */
  escore: number;
  /** Data da aplicação. */
  data: Date;
  /** Id do registro clínico a que pertence. Agrupa a sessão. */
  registroId: string;
}

/**
 * Normaliza um escore para a escala 0–100, com 100 = melhor.
 *
 * @param definicao Definição do teste — traz faixa e direção.
 * @param escore    Escore bruto.
 * @returns         Valor 0–100, ou `null` se a definição não tiver faixa
 *                  utilizável (teste de tempo aberto, por exemplo).
 */
export function normalizar(definicao: DefinicaoTeste, escore: number): number | null {
  // A faixa vem das interpretações cadastradas: o menor `de` e o maior `ate`
  // delimitam o intervalo clinicamente válido do instrumento.
  if (definicao.interpretacoes.length === 0) return null;

  const minimo = Math.min(...definicao.interpretacoes.map((f) => f.de));
  const maximo = Math.max(...definicao.interpretacoes.map((f) => f.ate));

  // Faixa degenerada (min === max) não permite normalizar.
  if (maximo <= minimo) return null;

  // Prende o escore na faixa antes de normalizar. Um valor fora dela (medição
  // atípica) produziria escore negativo ou acima de 100 e distorceria a média.
  const preso = Math.min(maximo, Math.max(minimo, escore));
  const proporcao = (preso - minimo) / (maximo - minimo);

  // Inverte quando escore alto é ruim, para que 100 signifique sempre "melhor".
  const orientado = definicao.maiorEhPior ? 1 - proporcao : proporcao;

  return Math.round(orientado * 100);
}

/**
 * Monta a série longitudinal de um plano de tratamento.
 *
 * @param aplicacoes Todas as aplicações de teste do plano.
 * @param definicoes Definições indexadas por chave.
 * @param evaPorRegistro EVA registrada em cada registro clínico.
 * @returns          Pontos ordenados por data, prontos para o gráfico.
 */
export function montarSerie(
  aplicacoes: readonly AplicacaoParaSerie[],
  definicoes: ReadonlyMap<string, DefinicaoTeste>,
  evaPorRegistro: ReadonlyMap<string, number>,
): PontoLongitudinal[] {
  // Agrupa as aplicações por registro clínico — um registro = uma sessão =
  // um ponto no gráfico.
  const porRegistro = new Map<string, { data: Date; normalizados: number[] }>();

  for (const ap of aplicacoes) {
    const definicao = definicoes.get(ap.definicaoChave);
    if (!definicao) continue; // Definição removida do catálogo: ignora o ponto.

    const n = normalizar(definicao, ap.escore);
    if (n === null) continue;

    const grupo = porRegistro.get(ap.registroId) ?? { data: ap.data, normalizados: [] };
    grupo.normalizados.push(n);
    // Mantém a data mais antiga do grupo como data da sessão.
    if (ap.data < grupo.data) grupo.data = ap.data;
    porRegistro.set(ap.registroId, grupo);
  }

  const pontos = [...porRegistro.entries()]
    .map(([registroId, g]) => ({
      registroId,
      data: g.data,
      // Média dos testes normalizados da sessão.
      escore: Math.round(g.normalizados.reduce((a, b) => a + b, 0) / g.normalizados.length),
      eva: evaPorRegistro.get(registroId) ?? 0,
    }))
    .sort((a, b) => a.data.getTime() - b.data.getTime());

  // O rótulo do eixo X só faz sentido depois da ordenação — "S1" precisa ser a
  // primeira sessão cronologicamente, não a primeira que saiu do banco.
  return pontos.map((p, i) => ({
    rotulo: `S${i + 1}`,
    data: p.data.toISOString(),
    escore: p.escore,
    eva: p.eva,
  }));
}

/** Classificação da trajetória do paciente. Alimenta "quem precisa de atenção". */
export type Tendencia = 'evoluindo' | 'estavel' | 'estagnado' | 'sem_dados';

/** Resultado da análise de tendência, com procedência. */
export interface AnaliseTendencia {
  tendencia: Tendencia;
  /** Variação do escore entre o primeiro e o último ponto. */
  variacaoEscore: number;
  /** Variação da EVA (negativa = dor diminuiu = bom). */
  variacaoEva: number;
  /** Quantas sessões entraram na análise. */
  sessoes: number;
  /** Explicação em linguagem clínica, para exibir junto do indicador. */
  explicacao: string;
}

/**
 * Analisa a tendência de um plano por regra estatística simples.
 *
 * **Isto não é IA e não decide nada.** É a "sinalização de possível estagnação
 * via regra estatística simples" que a especificação prevê para a Fase E, com
 * duas garantias: o critério é público (está escrito abaixo e aparece na tela)
 * e o resultado é sempre um sinal para o profissional avaliar, nunca uma
 * conduta.
 *
 * Critério, sobre as últimas `janela` sessões:
 * - **evoluindo** — escore subiu ≥ 5 pontos OU EVA caiu ≥ 2 pontos.
 * - **estagnado** — escore variou < 3 pontos E EVA variou < 1, em 3+ sessões.
 * - **estável**   — qualquer outro caso com dados suficientes.
 *
 * @param serie  Série longitudinal do plano.
 * @param janela Quantas sessões finais considerar. Padrão 3, como no critério
 *               "2 planos sem evolução mensurável em 3 sessões" da tela Hoje.
 */
export function analisarTendencia(
  serie: readonly PontoLongitudinal[],
  janela = 3,
): AnaliseTendencia {
  if (serie.length < 2) {
    return {
      tendencia: 'sem_dados',
      variacaoEscore: 0,
      variacaoEva: 0,
      sessoes: serie.length,
      explicacao: 'São necessárias ao menos duas sessões com teste aplicado.',
    };
  }

  const recorte = serie.slice(-janela);
  const primeiro = recorte[0] as PontoLongitudinal;
  const ultimo = recorte[recorte.length - 1] as PontoLongitudinal;

  const variacaoEscore = ultimo.escore - primeiro.escore;
  const variacaoEva = ultimo.eva - primeiro.eva;

  // Melhora clara: função subiu de forma relevante ou a dor cedeu.
  if (variacaoEscore >= 5 || variacaoEva <= -2) {
    return {
      tendencia: 'evoluindo',
      variacaoEscore,
      variacaoEva,
      sessoes: recorte.length,
      explicacao: `Escore funcional ${variacaoEscore >= 0 ? '+' : ''}${variacaoEscore} e EVA ${variacaoEva} nas últimas ${recorte.length} sessões.`,
    };
  }

  // Estagnação exige janela cheia: dois pontos parados não são tendência.
  if (recorte.length >= 3 && Math.abs(variacaoEscore) < 3 && Math.abs(variacaoEva) < 1) {
    return {
      tendencia: 'estagnado',
      variacaoEscore,
      variacaoEva,
      sessoes: recorte.length,
      explicacao: `Sem evolução mensurável em ${recorte.length} sessões — considere reavaliar o plano.`,
    };
  }

  return {
    tendencia: 'estavel',
    variacaoEscore,
    variacaoEva,
    sessoes: recorte.length,
    explicacao: `Variação pequena nas últimas ${recorte.length} sessões.`,
  };
}

/**
 * Gera o resumo em **linguagem de paciente** exibido no portal.
 *
 * Requisito da tela 12: *"em linguagem de paciente, não clínica"*. Nada de
 * "escore funcional composto" ou "delta de EVA" — o paciente lê "Sua dor caiu
 * de 7 para 2 desde o início."
 *
 * @param serie Série longitudinal do plano.
 */
export function resumoParaPaciente(serie: readonly PontoLongitudinal[]): string {
  if (serie.length < 2) {
    return 'Ainda estamos reunindo dados do seu tratamento. Continue com os exercícios.';
  }

  const primeiro = serie[0] as PontoLongitudinal;
  const ultimo = serie[serie.length - 1] as PontoLongitudinal;

  const quedaDor = primeiro.eva - ultimo.eva;
  const ganhoFuncao = ultimo.escore - primeiro.escore;

  if (quedaDor >= 2) {
    return `Sua dor caiu de ${primeiro.eva} para ${ultimo.eva} desde o início.`;
  }
  if (ganhoFuncao >= 5) {
    return 'Seus movimentos melhoraram desde a primeira avaliação. Continue assim.';
  }
  if (quedaDor <= -2) {
    return 'Sua dor aumentou nas últimas sessões. Comente isso na próxima consulta.';
  }
  return 'Seu quadro está estável. Manter a rotina de exercícios é o que faz a diferença agora.';
}
