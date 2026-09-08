/**
 * Cálculo de adesão ao exercício domiciliar (HEP).
 *
 * ## Por que a métrica precisa vir antes da gamificação
 *
 * A especificação é firme nisso: metas e sequência são *"camada secundária —
 * só faz sentido depois que a métrica de adesão em si for confiável"*. Uma
 * sequência de 12 dias calculada sobre uma taxa mal definida é pior que
 * nenhuma sequência: ela dá confiança falsa a uma decisão clínica.
 *
 * ## As decisões de definição, explicitadas
 *
 * 1. **O denominador são os dias com prescrição ativa**, não os dias corridos.
 *    Se o exercício foi prescrito na quarta, segunda e terça não contam contra
 *    o paciente.
 * 2. **"Fez parcialmente" vale meio ponto**, não zero. Zerar quem fez metade
 *    é o mesmo que dizer ao paciente que fazer metade não vale nada — e o
 *    incentivo que isso cria é o de não registrar.
 * 3. **Dia sem registro é dia não feito.** Não preencher não é neutro; a
 *    ausência de dado é a informação clínica ("o paciente parou").
 * 4. **A sequência conta dias com pelo menos um `fez`.** Parcial mantém a
 *    métrica, mas não a sequência — senão "sequência" perde sentido.
 */

import type { StatusAdesao } from '@cinesis/shared';

/** Um registro de execução, do jeito que sai do banco. */
export interface RegistroParaCalculo {
  /** Data no formato `YYYY-MM-DD`, no fuso da clínica. */
  data: string;
  status: StatusAdesao;
  /** Item da prescrição a que o registro se refere. */
  prescricaoItemId: string;
}

/** Peso de cada status no cálculo da taxa. */
const PESO: Record<StatusAdesao, number> = {
  fez: 1,
  parcial: 0.5, // Meio ponto: reconhece o esforço sem inflar a métrica.
  nao_fez: 0,
};

/** Resultado do cálculo de adesão de um paciente. */
export interface ResultadoAdesao {
  /** Percentual 0–100. */
  taxa: number;
  /** Dias consecutivos, contando de trás para frente, com ao menos um `fez`. */
  sequencia: number;
  /** Quantos dias tinham prescrição ativa no período (o denominador). */
  diasEsperados: number;
  /** Quantos dias tiveram algum registro. */
  diasComRegistro: number;
  /** Últimos 7 dias, do mais antigo ao mais recente. */
  ultimos7: (StatusAdesao | 'sem_prescricao')[];
}

/**
 * Converte uma data para `YYYY-MM-DD` em UTC.
 * Comparação de datas por string só funciona se o formato for sempre o mesmo.
 */
function chaveData(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Soma dias a uma data, sem mexer no objeto original. */
function somarDias(d: Date, dias: number): Date {
  const nova = new Date(d);
  nova.setUTCDate(nova.getUTCDate() + dias);
  return nova;
}

/**
 * Calcula a adesão de um paciente num período.
 *
 * @param registros     Registros de execução do paciente.
 * @param inicio        Primeiro dia com prescrição ativa.
 * @param fim           Último dia do período (normalmente hoje).
 * @param diasPorSemana Quantos dias por semana a prescrição pede. É isto que
 *                      diferencia "prescrição de 3×/semana" de "diária" — sem
 *                      esse parâmetro, quem faz 3 de 7 dias apareceria com 43%
 *                      de adesão estando 100% aderente.
 */
export function calcularAdesao(
  registros: readonly RegistroParaCalculo[],
  inicio: Date,
  fim: Date,
  diasPorSemana: number,
): ResultadoAdesao {
  // Agrupa por dia, guardando o melhor status do dia. Um paciente com três
  // exercícios que fez dois e pulou um conta como "parcial", não como três
  // eventos independentes — a unidade clínica de adesão é o dia.
  const porDia = new Map<string, StatusAdesao>();

  for (const r of registros) {
    const atual = porDia.get(r.data);
    // Ordem de precedência: fez > parcial > nao_fez.
    if (!atual || PESO[r.status] > PESO[atual]) porDia.set(r.data, r.status);
  }

  // Quantidade de dias corridos no período.
  const diasCorridos =
    Math.floor((fim.getTime() - inicio.getTime()) / 86_400_000) + 1;

  if (diasCorridos <= 0) {
    return { taxa: 0, sequencia: 0, diasEsperados: 0, diasComRegistro: 0, ultimos7: [] };
  }

  // O denominador é proporcional à frequência prescrita, não aos dias corridos.
  // Ex.: 14 dias corridos com prescrição 3×/semana ⇒ 6 dias esperados.
  const diasEsperados = Math.max(1, Math.round((diasCorridos / 7) * diasPorSemana));

  // O numerador soma os pesos, com teto no denominador: quem faz todo dia uma
  // prescrição de 3×/semana chega a 100%, não a 233%.
  let pontos = 0;
  for (const status of porDia.values()) pontos += PESO[status];
  pontos = Math.min(pontos, diasEsperados);

  const taxa = Math.round((pontos / diasEsperados) * 100);

  // --- Sequência: dias consecutivos com `fez`, contando a partir do fim. ----
  let sequencia = 0;
  for (let i = 0; i < diasCorridos; i++) {
    const dia = chaveData(somarDias(fim, -i));
    if (porDia.get(dia) === 'fez') sequencia++;
    else break; // O primeiro dia sem `fez` encerra a contagem.
  }

  // --- Heatmap dos últimos 7 dias, do mais antigo para o mais recente. -----
  const ultimos7: (StatusAdesao | 'sem_prescricao')[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = somarDias(fim, -i);
    if (d < inicio) {
      // Antes da prescrição existir: quadrado tracejado, não "não fez".
      ultimos7.push('sem_prescricao');
    } else {
      ultimos7.push(porDia.get(chaveData(d)) ?? 'nao_fez');
    }
  }

  return {
    taxa: Math.min(100, taxa),
    sequencia,
    diasEsperados,
    diasComRegistro: porDia.size,
    ultimos7,
  };
}

/**
 * Adesão por exercício, para o painel do fisioterapeuta.
 *
 * O insight que a tela carrega: *"exercício com adesão baixa costuma ser
 * problema de prescrição, não de paciente"*. Por isso a agregação é por
 * exercício e atravessa todos os pacientes — um exercício com 42% em quinze
 * pessoas diferentes está mal prescrito ou mal explicado.
 *
 * @param registros Registros de todos os pacientes.
 * @param nomePorItem Nome do exercício por id de item de prescrição.
 */
export function adesaoPorExercicio(
  registros: readonly RegistroParaCalculo[],
  nomePorItem: ReadonlyMap<string, string>,
): { exercicio: string; taxa: number; registros: number }[] {
  const acumulado = new Map<string, { pontos: number; total: number }>();

  for (const r of registros) {
    const nome = nomePorItem.get(r.prescricaoItemId);
    if (!nome) continue;

    const atual = acumulado.get(nome) ?? { pontos: 0, total: 0 };
    atual.pontos += PESO[r.status];
    atual.total += 1;
    acumulado.set(nome, atual);
  }

  return [...acumulado.entries()]
    .map(([exercicio, a]) => ({
      exercicio,
      taxa: a.total === 0 ? 0 : Math.round((a.pontos / a.total) * 100),
      registros: a.total,
    }))
    // Pior primeiro: a tela existe para achar o que está falhando.
    .sort((a, b) => a.taxa - b.taxa);
}

/**
 * A adesão está baixa o suficiente para virar sinal na tela "Hoje"?
 *
 * O corte de 40% vem do critério da tela ("3 pacientes com adesão < 40%").
 * Exposto como função para que o número tenha um lugar único e testável.
 */
export function adesaoPreocupante(taxa: number): boolean {
  return taxa < 40;
}
