/**
 * Motor de testes funcionais e escalas clínicas.
 *
 * ## A armadilha que este módulo existe para evitar
 *
 * O handoff é explícito: *"Deixar `ClinicalAssessmentDefinition` como enum no
 * código. Incorporar um teste funcional novo precisa ser configuração, não
 * deploy."*
 *
 * A tentação natural é escrever uma função `calcularOswestry()`, outra
 * `calcularTUG()`, e um `switch` no meio. Isso funciona até o dia em que um
 * fisioterapeuta quer usar o DASH, o Lysholm ou o WOMAC — e aí é preciso
 * programador, build e deploy para uma coisa que é, na essência, uma planilha.
 *
 * ## Como funciona aqui
 *
 * A definição do teste é **dado**: campos, fórmula e faixas de interpretação
 * vêm do banco (`ClinicalAssessmentDefinition`) e são interpretados por este
 * motor. Adicionar o WOMAC é inserir uma linha, não abrir o editor.
 *
 * ## Por que o escore é calculado no servidor
 *
 * Nunca aceitamos o escore vindo do cliente. Se aceitássemos, o cliente
 * poderia escrever qualquer resultado clínico — e o valor sairia num PDF
 * assinado com CREFITO. O cliente manda os valores brutos; o servidor calcula.
 */

import type { DefinicaoTeste, FaixaInterpretacao, CampoTeste } from '@cinesis/shared';
import { DadosInvalidos } from '@cinesis/shared';

/** O que o cálculo devolve. */
export interface ResultadoCalculo {
  /** Escore final, já arredondado conforme a definição. */
  escore: number;
  /** Texto da faixa em que o escore caiu. */
  interpretacao: string;
  /** Tom visual do bloco de interpretação. */
  tom: FaixaInterpretacao['tom'];
  /** Versão da definição usada — procedência, exigida na tela. */
  versaoUsada: string;
}

/**
 * Valida os valores informados contra os campos da definição.
 *
 * Precisa acontecer antes do cálculo por dois motivos: um valor fora de faixa
 * produziria um escore sem sentido clínico, e um campo faltando produziria
 * `NaN` — que viraria `null` no banco e sumiria silenciosamente do gráfico.
 *
 * @throws {DadosInvalidos} 422 com o detalhe por campo.
 */
export function validarValores(
  definicao: DefinicaoTeste,
  valores: Record<string, number>,
): void {
  const problemas: Record<string, string[]> = {};

  for (const campo of definicao.campos) {
    const v = valores[campo.chave];

    if (v === undefined) {
      problemas[campo.chave] = [`${campo.rotulo} é obrigatório.`];
      continue;
    }
    if (!Number.isFinite(v)) {
      problemas[campo.chave] = [`${campo.rotulo} precisa ser um número.`];
      continue;
    }
    if (v < campo.min || v > campo.max) {
      problemas[campo.chave] = [`${campo.rotulo} deve estar entre ${campo.min} e ${campo.max}.`];
    }
  }

  // Campo que não existe na definição é recusado, e não ignorado: aceitar
  // campo desconhecido esconderia erro de digitação da chave (o valor certo
  // iria para o lugar errado e o escore sairia calculado com o campo faltando).
  const conhecidos = new Set(definicao.campos.map((c) => c.chave));
  for (const chave of Object.keys(valores)) {
    if (!conhecidos.has(chave)) {
      problemas[chave] = [`Campo "${chave}" não pertence ao teste ${definicao.nome}.`];
    }
  }

  if (Object.keys(problemas).length > 0) {
    throw new DadosInvalidos(problemas, `Valores inválidos para ${definicao.nome}.`);
  }
}

/**
 * Aplica a fórmula declarativa aos valores.
 *
 * Cada tipo de fórmula cobre um padrão real de escala clínica:
 *
 * - `direto`             — EVA, TUG, Schober: o valor medido já é o resultado.
 * - `soma`               — questionários de pontuação simples.
 * - `soma_ponderada`     — escalas em que itens pesam diferente.
 * - `media`              — média de repetições/lados.
 * - `percentual_do_max`  — Oswestry: soma ÷ máximo possível × 100.
 */
function aplicarFormula(definicao: DefinicaoTeste, valores: Record<string, number>): number {
  const campos = definicao.campos;
  /** Valor de um campo, já garantido presente por `validarValores`. */
  const val = (c: CampoTeste): number => valores[c.chave] as number;

  let bruto: number;

  switch (definicao.formula.tipo) {
    case 'direto':
      // Usa o primeiro campo. Escalas de item único (EVA, TUG) caem aqui.
      bruto = campos.length > 0 ? val(campos[0] as CampoTeste) : 0;
      break;

    case 'soma':
      bruto = campos.reduce((acc, c) => acc + val(c), 0);
      break;

    case 'soma_ponderada':
      bruto = campos.reduce((acc, c) => acc + val(c) * (c.peso ?? 1), 0);
      break;

    case 'media':
      bruto = campos.length === 0 ? 0 : campos.reduce((acc, c) => acc + val(c), 0) / campos.length;
      break;

    case 'percentual_do_max': {
      const soma = campos.reduce((acc, c) => acc + val(c), 0);
      const maximo = campos.reduce((acc, c) => acc + c.max, 0);
      // Guarda contra divisão por zero numa definição mal cadastrada.
      bruto = maximo === 0 ? 0 : (soma / maximo) * 100;
      break;
    }
  }

  const comFator = bruto * (definicao.formula.fator ?? 1);
  const casas = definicao.formula.casas ?? 0;

  // Arredondamento explícito: sem ele, 33.33333333 vai para o banco e o
  // gráfico exibe casas decimais que não existem clinicamente.
  const potencia = 10 ** casas;
  return Math.round(comFator * potencia) / potencia;
}

/**
 * Encontra a faixa de interpretação de um escore.
 *
 * As faixas são avaliadas na ordem em que aparecem na definição — a primeira
 * que contiver o escore vence. Isso permite cadastrar faixas sobrepostas com
 * precedência intencional, sem precisar de regra extra.
 */
function interpretar(definicao: DefinicaoTeste, escore: number): FaixaInterpretacao {
  const faixa = definicao.interpretacoes.find((f) => escore >= f.de && escore <= f.ate);

  // Escore fora de todas as faixas significa definição incompleta. Devolvemos
  // um resultado neutro em vez de lançar: o valor medido é clinicamente válido
  // e não pode ser perdido só porque falta uma linha de interpretação.
  return faixa ?? { de: escore, ate: escore, texto: 'Sem interpretação cadastrada.', tom: 'neutro' };
}

/**
 * Calcula um teste funcional por completo: valida, calcula e interpreta.
 *
 * @param definicao Definição vinda do banco.
 * @param valores   Valores brutos informados pelo profissional.
 */
export function calcularTeste(
  definicao: DefinicaoTeste,
  valores: Record<string, number>,
): ResultadoCalculo {
  validarValores(definicao, valores);

  const escore = aplicarFormula(definicao, valores);
  const faixa = interpretar(definicao, escore);

  return {
    escore,
    interpretacao: faixa.texto,
    tom: faixa.tom,
    // Guardar a versão é o que permite auditar, dois anos depois, com qual
    // regra aquele escore foi produzido.
    versaoUsada: definicao.versao,
  };
}

/** Como um escore mudou entre duas aplicações do mesmo teste. */
export interface Delta {
  /** Diferença bruta: atual − anterior. */
  valor: number;
  /** Se essa diferença representa melhora, piora ou estabilidade. */
  direcao: 'melhora' | 'piora' | 'estavel';
  /** Variação percentual sobre o valor anterior. `null` se o anterior era 0. */
  percentual: number | null;
}

/**
 * Compara duas aplicações do mesmo teste.
 *
 * O detalhe que importa: em algumas escalas, **escore maior é pior** (Oswestry,
 * EVA); em outras, maior é melhor (força, amplitude). Sem `maiorEhPior` na
 * definição, o sistema pintaria de verde uma piora de dor. É exatamente o tipo
 * de erro que passa despercebido numa demonstração e é grave na clínica.
 *
 * @param definicao Definição do teste (traz `maiorEhPior`).
 * @param atual     Escore da aplicação mais recente.
 * @param anterior  Escore da aplicação anterior, ou `null` se é a primeira.
 */
export function compararEscores(
  definicao: DefinicaoTeste,
  atual: number,
  anterior: number | null,
): Delta | null {
  if (anterior === null) return null;

  const valor = Number((atual - anterior).toFixed(2));

  // Faixa morta de 0.01 evita marcar ruído de arredondamento como evolução.
  let direcao: Delta['direcao'] = 'estavel';
  if (Math.abs(valor) >= 0.01) {
    const subiu = valor > 0;
    direcao = subiu === definicao.maiorEhPior ? 'piora' : 'melhora';
  }

  const percentual =
    anterior === 0 ? null : Number((((atual - anterior) / Math.abs(anterior)) * 100).toFixed(1));

  return { valor, direcao, percentual };
}
