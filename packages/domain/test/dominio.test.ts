/**
 * Testes das regras de domínio.
 *
 * Cobrem os critérios de aceitação em Gherkin da especificação (seção 8.2):
 * prontuário imutável, adesão, e as regras clínicas que produzem número exibido
 * ao profissional — cálculo errado aqui vira decisão clínica errada, e é a
 * categoria de bug que nenhum teste de integração pega.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  // Imutabilidade
  estaSelado,
  exigirEditavel,
  selar,
  criarNovaVersao,
  cadeiaDeVersoes,
  contarIntegridade,
  type RegistroSelavel,
  // Avaliação
  calcularTeste,
  validarValores,
  compararEscores,
  // Longitudinal
  normalizar,
  montarSerie,
  analisarTendencia,
  resumoParaPaciente,
  type AplicacaoParaSerie,
  // Adesão
  calcularAdesao,
  adesaoPorExercicio,
  adesaoPreocupante,
  type RegistroParaCalculo,
  // Biblioteca
  validarTransicao,
  podeSerPrescrito,
  exigirPrescritivel,
  novaVersaoExercicio,
  type ExercicioGovernavel,
  // Consentimento
  temConsentimento,
  exigirConsentimento,
  revogar,
  type Consentimento,
  // Eventos
  Barramento,
  evento,
} from '../src/index.js';
import type { DefinicaoTeste, PontoLongitudinal } from '@cinesis/shared';
import { ErroCinesis } from '@cinesis/shared';

/**
 * Executa uma funcao que deve lancar `ErroCinesis` e devolve o erro tipado.
 *
 * Existe porque `toThrow(/regex/)` so olha a mensagem de topo — e a informacao
 * util (qual campo falhou e por que) esta em `.campos`. Asserir sobre a
 * mensagem generica passaria mesmo se o detalhe por campo sumisse.
 */
function capturar(fn: () => unknown): ErroCinesis {
  try {
    fn();
  } catch (e) {
    if (e instanceof ErroCinesis) return e;
    throw e;
  }
  throw new Error('Esperava um ErroCinesis, mas nada foi lancado.');
}

// ---------------------------------------------------------------------------
// Imutabilidade do prontuário — COFFITO 415/2012
// ---------------------------------------------------------------------------

describe('Prontuário imutável', () => {
  /** Um rascunho recém-criado. */
  const rascunho: RegistroSelavel = {
    id: 'ev-1',
    finalizadoEm: null,
    versao: 1,
    substituiId: null,
    assinadoPorId: null,
  };

  const assinatura = {
    profissionalId: 'prof-1',
    crefito: 'CREFITO-3 12345-F',
    agora: new Date('2026-09-07T14:00:00Z'),
  };

  it('rascunho é editável', () => {
    expect(estaSelado(rascunho)).toBe(false);
    expect(() => exigirEditavel(rascunho)).not.toThrow();
  });

  it('CRITÉRIO: registro finalizado permanece intacto ao tentar editar', () => {
    // Dado um prontuário finalizado…
    const selado = selar(rascunho, assinatura);

    // Quando um usuário tentar editar o registro…
    expect(() => exigirEditavel(selado)).toThrow(/imutável/i);

    // Então o registro original permanece intacto.
    expect(selado.finalizadoEm).toEqual(assinatura.agora);
    expect(selado.versao).toBe(1);
    expect(selado.assinadoPorId).toBe('prof-1');
  });

  it('selar não muta o objeto de entrada', () => {
    const selado = selar(rascunho, assinatura);
    expect(rascunho.finalizadoEm).toBeNull(); // O original segue rascunho.
    expect(selado).not.toBe(rascunho);
  });

  it('recusa assinar sem CREFITO', () => {
    expect(() => selar(rascunho, { ...assinatura, crefito: null })).toThrow(/CREFITO/i);
  });

  it('recusa selar duas vezes', () => {
    const selado = selar(rascunho, assinatura);
    // Clique duplo não pode sobrescrever a assinatura original.
    expect(() => selar(selado, { ...assinatura, profissionalId: 'outro' })).toThrow(/já foi finalizado/i);
  });

  it('CRITÉRIO: alteração permitida cria nova versão preservando a anterior', () => {
    const v1 = selar(rascunho, assinatura);
    const v2 = criarNovaVersao(v1, { novoId: 'ev-2', motivo: 'Correção do valor de ADM registrado.' });

    // A v2 nasce como rascunho, apontando para a v1.
    expect(v2.versao).toBe(2);
    expect(v2.substituiId).toBe('ev-1');
    expect(v2.finalizadoEm).toBeNull();
    expect(v2.assinadoPorId).toBeNull();

    // E a v1 continua exatamente como estava.
    expect(v1.finalizadoEm).toEqual(assinatura.agora);
    expect(v1.assinadoPorId).toBe('prof-1');
  });

  it('recusa nova versão de rascunho', () => {
    expect(() => criarNovaVersao(rascunho, { novoId: 'x', motivo: 'motivo suficiente' })).toThrow(
      /ainda é um rascunho/i,
    );
  });

  it('exige motivo com substância na correção', () => {
    const v1 = selar(rascunho, assinatura);
    expect(() => criarNovaVersao(v1, { novoId: 'ev-2', motivo: 'erro' })).toThrow(/motivo/i);
    expect(() => criarNovaVersao(v1, { novoId: 'ev-2', motivo: '          ' })).toThrow(/motivo/i);
  });

  it('reconstrói a cadeia de versões em ordem', () => {
    const v1 = selar(rascunho, assinatura);
    const v2 = selar(criarNovaVersao(v1, { novoId: 'ev-2', motivo: 'Correção do valor.' }), assinatura);
    const v3 = criarNovaVersao(v2, { novoId: 'ev-3', motivo: 'Segunda correção necessária.' });

    const cadeia = cadeiaDeVersoes([v3, v1, v2], 'ev-3');
    expect(cadeia.map((r) => r.id)).toEqual(['ev-1', 'ev-2', 'ev-3']);
  });

  it('não trava com referência circular em dado corrompido', () => {
    const a: RegistroSelavel = { id: 'a', finalizadoEm: null, versao: 1, substituiId: 'b', assinadoPorId: null };
    const b: RegistroSelavel = { id: 'b', finalizadoEm: null, versao: 1, substituiId: 'a', assinadoPorId: null };
    expect(() => cadeiaDeVersoes([a, b], 'a')).not.toThrow();
  });

  it('conta zero sobrescritos numa cadeia normal', () => {
    const v1 = selar(rascunho, assinatura);
    const v2 = selar(criarNovaVersao(v1, { novoId: 'ev-2', motivo: 'Correção do valor.' }), assinatura);

    expect(contarIntegridade([v1, v2])).toEqual({ total: 2, sobrescritos: 0 });
  });
});

// ---------------------------------------------------------------------------
// Testes funcionais — ClinicalAssessmentDefinition como dado
// ---------------------------------------------------------------------------

describe('Motor de testes funcionais', () => {
  /** Oswestry: 10 seções de 0 a 5, resultado em percentual, maior é pior. */
  const oswestry: DefinicaoTeste = {
    id: 'd1',
    chave: 'oswestry',
    nome: 'Índice de Incapacidade de Oswestry',
    versao: 'v2.1a-BR',
    categoria: 'funcao',
    unidade: '%',
    fonte: 'Vigatto et al. 2007',
    licenca: 'Uso clínico livre',
    maiorEhPior: true,
    campos: Array.from({ length: 10 }, (_, i) => ({
      chave: `s${i + 1}`,
      rotulo: `Seção ${i + 1}`,
      tipo: 'escala' as const,
      min: 0,
      max: 5,
    })),
    formula: { tipo: 'percentual_do_max', casas: 0 },
    interpretacoes: [
      { de: 0, ate: 20, texto: 'Incapacidade mínima', tom: 'bom' },
      { de: 21, ate: 40, texto: 'Incapacidade moderada', tom: 'atencao' },
      { de: 41, ate: 60, texto: 'Incapacidade severa', tom: 'ruim' },
      { de: 61, ate: 100, texto: 'Incapacidade incapacitante', tom: 'ruim' },
    ],
  };

  /** EVA: campo único, valor direto, maior é pior. */
  const eva: DefinicaoTeste = {
    id: 'd2',
    chave: 'eva',
    nome: 'Escala Visual Analógica de Dor',
    versao: 'v1',
    categoria: 'dor',
    unidade: '0–10',
    fonte: 'Huskisson 1974',
    licenca: 'Domínio público',
    maiorEhPior: true,
    campos: [{ chave: 'dor', rotulo: 'Dor', tipo: 'escala', min: 0, max: 10 }],
    formula: { tipo: 'direto' },
    interpretacoes: [
      { de: 0, ate: 0, texto: 'Sem dor', tom: 'bom' },
      { de: 1, ate: 3, texto: 'Dor leve', tom: 'bom' },
      { de: 4, ate: 6, texto: 'Dor moderada', tom: 'atencao' },
      { de: 7, ate: 10, texto: 'Dor intensa', tom: 'ruim' },
    ],
  };

  /** Amplitude de movimento: maior é MELHOR — o caso oposto. */
  const adm: DefinicaoTeste = {
    id: 'd3',
    chave: 'adm_flexao_joelho',
    nome: 'ADM — flexão de joelho',
    versao: 'v1',
    categoria: 'amplitude',
    unidade: 'graus',
    fonte: 'AAOS',
    licenca: 'Domínio público',
    maiorEhPior: false,
    campos: [{ chave: 'graus', rotulo: 'Graus', tipo: 'numero', min: 0, max: 150 }],
    formula: { tipo: 'direto' },
    interpretacoes: [
      { de: 0, ate: 89, texto: 'Amplitude limitada', tom: 'ruim' },
      { de: 90, ate: 119, texto: 'Amplitude funcional parcial', tom: 'atencao' },
      { de: 120, ate: 150, texto: 'Amplitude preservada', tom: 'bom' },
    ],
  };

  it('calcula Oswestry como percentual do máximo', () => {
    // 10 seções × 2 pontos = 20 de 50 possíveis = 40%.
    const valores = Object.fromEntries(oswestry.campos.map((c) => [c.chave, 2]));
    const r = calcularTeste(oswestry, valores);

    expect(r.escore).toBe(40);
    expect(r.interpretacao).toBe('Incapacidade moderada');
    expect(r.tom).toBe('atencao');
    expect(r.versaoUsada).toBe('v2.1a-BR'); // Procedência registrada.
  });

  it('calcula os extremos corretamente', () => {
    const zeros = Object.fromEntries(oswestry.campos.map((c) => [c.chave, 0]));
    expect(calcularTeste(oswestry, zeros).escore).toBe(0);

    const maximos = Object.fromEntries(oswestry.campos.map((c) => [c.chave, 5]));
    expect(calcularTeste(oswestry, maximos).escore).toBe(100);
  });

  it('calcula escala de valor direto', () => {
    expect(calcularTeste(eva, { dor: 7 })).toMatchObject({
      escore: 7,
      interpretacao: 'Dor intensa',
      tom: 'ruim',
    });
  });

  it('recusa valor fora da faixa em vez de calcular escore sem sentido', () => {
    expect(() => calcularTeste(eva, { dor: 11 })).toThrow();
    expect(() => calcularTeste(eva, { dor: -1 })).toThrow();
  });

  it('recusa campo faltando, apontando qual', () => {
    // O detalhe por campo vive em `.campos` — e a interface precisa dele para
    // marcar o input errado, nao apenas mostrar um alerta generico.
    const erro = capturar(() => validarValores(oswestry, { s1: 1 }));
    expect(erro.codigo).toBe('DADOS_INVALIDOS');
    expect(erro.campos?.s2?.join(' ')).toMatch(/obrigatório/i);
  });

  it('recusa campo desconhecido em vez de ignorar', () => {
    // Digitação errada da chave mandaria o valor para o limbo e o escore sairia
    // calculado sem ele — silenciosamente.
    const erro = capturar(() => validarValores(eva, { dor: 5, dorr: 3 }));
    expect(erro.campos?.dorr?.join(' ')).toMatch(/não pertence/i);
  });

  it('recusa NaN e Infinity', () => {
    expect(capturar(() => validarValores(eva, { dor: Number.NaN })).campos?.dor?.join(' ')).toMatch(
      /número/i,
    );
    expect(() => validarValores(eva, { dor: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('não pinta piora de verde em escala invertida', () => {
    // Oswestry subiu: piorou. Este é o bug que passaria despercebido numa demo
    // e seria grave na clínica.
    expect(compararEscores(oswestry, 45, 30)?.direcao).toBe('piora');
    expect(compararEscores(oswestry, 30, 45)?.direcao).toBe('melhora');

    // ADM subiu: melhorou.
    expect(compararEscores(adm, 120, 95)?.direcao).toBe('melhora');
    expect(compararEscores(adm, 95, 120)?.direcao).toBe('piora');
  });

  it('trata variação irrelevante como estável', () => {
    expect(compararEscores(oswestry, 40, 40)?.direcao).toBe('estavel');
  });

  it('não compara quando não há aplicação anterior', () => {
    expect(compararEscores(oswestry, 40, null)).toBeNull();
  });

  it('não divide por zero no percentual', () => {
    expect(compararEscores(eva, 3, 0)?.percentual).toBeNull();
  });

  it('interpreta escore fora das faixas sem quebrar', () => {
    const semFaixaCompleta: DefinicaoTeste = { ...eva, interpretacoes: [{ de: 0, ate: 3, texto: 'Leve', tom: 'bom' }] };
    const r = calcularTeste(semFaixaCompleta, { dor: 9 });
    // O valor medido é válido e não pode ser perdido por definição incompleta.
    expect(r.escore).toBe(9);
    expect(r.tom).toBe('neutro');
  });

  it('incorpora um teste novo sem tocar em código', () => {
    // Prova da tese do módulo: um instrumento inédito, definido só como dado.
    const womac: DefinicaoTeste = {
      id: 'd9',
      chave: 'womac_dor',
      nome: 'WOMAC — subescala de dor',
      versao: 'v1',
      categoria: 'dor',
      unidade: 'pontos',
      fonte: 'Bellamy et al. 1988',
      licenca: 'Uso acadêmico',
      maiorEhPior: true,
      campos: Array.from({ length: 5 }, (_, i) => ({
        chave: `d${i + 1}`,
        rotulo: `Item ${i + 1}`,
        tipo: 'escala' as const,
        min: 0,
        max: 4,
      })),
      formula: { tipo: 'soma' },
      interpretacoes: [
        { de: 0, ate: 5, texto: 'Dor leve', tom: 'bom' },
        { de: 6, ate: 12, texto: 'Dor moderada', tom: 'atencao' },
        { de: 13, ate: 20, texto: 'Dor intensa', tom: 'ruim' },
      ],
    };

    const r = calcularTeste(womac, { d1: 3, d2: 2, d3: 4, d4: 1, d5: 2 });
    expect(r.escore).toBe(12);
    expect(r.interpretacao).toBe('Dor moderada');
  });

  it('aplica peso na soma ponderada e arredonda conforme a definição', () => {
    const ponderado: DefinicaoTeste = {
      ...eva,
      campos: [
        { chave: 'a', rotulo: 'A', tipo: 'numero', min: 0, max: 10, peso: 2 },
        { chave: 'b', rotulo: 'B', tipo: 'numero', min: 0, max: 10, peso: 0.5 },
      ],
      formula: { tipo: 'soma_ponderada', casas: 1 },
      interpretacoes: [{ de: 0, ate: 100, texto: 'ok', tom: 'neutro' }],
    };
    // 3×2 + 5×0.5 = 8.5
    expect(calcularTeste(ponderado, { a: 3, b: 5 }).escore).toBe(8.5);
  });
});

// ---------------------------------------------------------------------------
// Comparação longitudinal — a tese do produto
// ---------------------------------------------------------------------------

describe('Comparação longitudinal', () => {
  const eva: DefinicaoTeste = {
    id: 'd2',
    chave: 'eva',
    nome: 'EVA',
    versao: 'v1',
    categoria: 'dor',
    unidade: '0–10',
    fonte: 'Huskisson 1974',
    licenca: 'Domínio público',
    maiorEhPior: true,
    campos: [{ chave: 'dor', rotulo: 'Dor', tipo: 'escala', min: 0, max: 10 }],
    formula: { tipo: 'direto' },
    interpretacoes: [{ de: 0, ate: 10, texto: 'faixa', tom: 'neutro' }],
  };

  const adm: DefinicaoTeste = { ...eva, chave: 'adm', maiorEhPior: false, interpretacoes: [{ de: 0, ate: 150, texto: 'f', tom: 'neutro' }] };

  it('normaliza invertendo escalas em que maior é pior', () => {
    // EVA 0 (sem dor) = 100 na escala normalizada; EVA 10 = 0.
    expect(normalizar(eva, 0)).toBe(100);
    expect(normalizar(eva, 10)).toBe(0);
    expect(normalizar(eva, 5)).toBe(50);
  });

  it('normaliza sem inverter quando maior é melhor', () => {
    expect(normalizar(adm, 150)).toBe(100);
    expect(normalizar(adm, 0)).toBe(0);
  });

  it('prende valores fora da faixa em vez de distorcer a média', () => {
    expect(normalizar(eva, 99)).toBe(0);
    expect(normalizar(eva, -5)).toBe(100);
  });

  it('devolve null quando a definição não permite normalizar', () => {
    expect(normalizar({ ...eva, interpretacoes: [] }, 5)).toBeNull();
    expect(normalizar({ ...eva, interpretacoes: [{ de: 5, ate: 5, texto: 'x', tom: 'neutro' }] }, 5)).toBeNull();
  });

  it('monta a série ordenada por data com rótulos sequenciais', () => {
    const definicoes = new Map([['eva', eva]]);
    // Deliberadamente fora de ordem, como pode sair do banco.
    const aplicacoes: AplicacaoParaSerie[] = [
      { definicaoChave: 'eva', escore: 4, data: new Date('2026-03-01'), registroId: 'r3' },
      { definicaoChave: 'eva', escore: 7, data: new Date('2026-01-01'), registroId: 'r1' },
      { definicaoChave: 'eva', escore: 6, data: new Date('2026-02-01'), registroId: 'r2' },
    ];
    const evaPorRegistro = new Map([['r1', 7], ['r2', 6], ['r3', 4]]);

    const serie = montarSerie(aplicacoes, definicoes, evaPorRegistro);

    expect(serie.map((p) => p.rotulo)).toEqual(['S1', 'S2', 'S3']);
    expect(serie.map((p) => p.eva)).toEqual([7, 6, 4]);
    // EVA caindo ⇒ escore normalizado subindo.
    expect(serie[0]!.escore).toBeLessThan(serie[2]!.escore);
  });

  it('ignora aplicação de definição que saiu do catálogo', () => {
    const serie = montarSerie(
      [{ definicaoChave: 'inexistente', escore: 5, data: new Date('2026-01-01'), registroId: 'r1' }],
      new Map(),
      new Map(),
    );
    expect(serie).toEqual([]);
  });

  it('faz a média quando a sessão tem vários testes', () => {
    const definicoes = new Map([['eva', eva], ['adm', adm]]);
    const serie = montarSerie(
      [
        { definicaoChave: 'eva', escore: 10, data: new Date('2026-01-01'), registroId: 'r1' }, // → 0
        { definicaoChave: 'adm', escore: 150, data: new Date('2026-01-01'), registroId: 'r1' }, // → 100
      ],
      definicoes,
      new Map([['r1', 10]]),
    );
    expect(serie).toHaveLength(1);
    expect(serie[0]!.escore).toBe(50);
  });

  it('detecta evolução', () => {
    const serie: PontoLongitudinal[] = [
      { rotulo: 'S1', data: '2026-01-01', escore: 38, eva: 7 },
      { rotulo: 'S2', data: '2026-01-08', escore: 55, eva: 5 },
      { rotulo: 'S3', data: '2026-01-15', escore: 63, eva: 4 },
    ];
    const a = analisarTendencia(serie);
    expect(a.tendencia).toBe('evoluindo');
    expect(a.variacaoEscore).toBe(25);
  });

  it('detecta estagnação — o sinal de "precisa de atenção"', () => {
    const serie: PontoLongitudinal[] = [
      { rotulo: 'S1', data: '2026-01-01', escore: 50, eva: 5 },
      { rotulo: 'S2', data: '2026-01-08', escore: 51, eva: 5 },
      { rotulo: 'S3', data: '2026-01-15', escore: 51, eva: 5 },
    ];
    const a = analisarTendencia(serie);
    expect(a.tendencia).toBe('estagnado');
    expect(a.explicacao).toMatch(/reavaliar/i);
  });

  it('não declara estagnação com apenas duas sessões', () => {
    const serie: PontoLongitudinal[] = [
      { rotulo: 'S1', data: '2026-01-01', escore: 50, eva: 5 },
      { rotulo: 'S2', data: '2026-01-08', escore: 50, eva: 5 },
    ];
    // Dois pontos parados não são tendência.
    expect(analisarTendencia(serie).tendencia).toBe('estavel');
  });

  it('exige dados mínimos', () => {
    expect(analisarTendencia([]).tendencia).toBe('sem_dados');
    expect(analisarTendencia([{ rotulo: 'S1', data: '2026-01-01', escore: 50, eva: 5 }]).tendencia).toBe('sem_dados');
  });

  it('considera só a janela recente, não o histórico inteiro', () => {
    // Melhorou muito no começo e travou nas últimas três — o sinal precisa
    // refletir o presente, senão o paciente estagnado some do radar.
    const serie: PontoLongitudinal[] = [
      { rotulo: 'S1', data: '2026-01-01', escore: 10, eva: 9 },
      { rotulo: 'S2', data: '2026-01-08', escore: 60, eva: 4 },
      { rotulo: 'S3', data: '2026-01-15', escore: 61, eva: 4 },
      { rotulo: 'S4', data: '2026-01-22', escore: 61, eva: 4 },
      { rotulo: 'S5', data: '2026-01-29', escore: 62, eva: 4 },
    ];
    expect(analisarTendencia(serie, 3).tendencia).toBe('estagnado');
  });

  it('fala com o paciente em linguagem de paciente', () => {
    const serie: PontoLongitudinal[] = [
      { rotulo: 'S1', data: '2026-01-01', escore: 38, eva: 7 },
      { rotulo: 'S8', data: '2026-03-01', escore: 82, eva: 2 },
    ];
    const texto = resumoParaPaciente(serie);

    expect(texto).toBe('Sua dor caiu de 7 para 2 desde o início.');
    // Nada de jargão clínico na tela do paciente.
    expect(texto).not.toMatch(/escore|EVA|longitudinal|funcional/i);
  });

  it('avisa o paciente quando a dor aumentou, sem alarmar', () => {
    const serie: PontoLongitudinal[] = [
      { rotulo: 'S1', data: '2026-01-01', escore: 60, eva: 3 },
      { rotulo: 'S2', data: '2026-01-08', escore: 58, eva: 6 },
    ];
    expect(resumoParaPaciente(serie)).toMatch(/aumentou.*próxima consulta/i);
  });
});

// ---------------------------------------------------------------------------
// Adesão
// ---------------------------------------------------------------------------

describe('Adesão ao HEP', () => {
  const inicio = new Date('2026-09-01T00:00:00Z');
  const fim = new Date('2026-09-07T00:00:00Z'); // 7 dias.

  /** Monta registros diários a partir de uma lista de status. */
  function diario(...status: RegistroParaCalculo['status'][]): RegistroParaCalculo[] {
    return status.map((s, i) => ({
      data: `2026-09-0${i + 1}`,
      status: s,
      prescricaoItemId: 'item-1',
    }));
  }

  it('CRITÉRIO: registro do paciente atualiza o indicador de adesão', () => {
    const r = calcularAdesao(diario('fez', 'fez', 'fez', 'fez', 'fez', 'fez', 'fez'), inicio, fim, 7);
    expect(r.taxa).toBe(100);
    expect(r.diasComRegistro).toBe(7);
  });

  it('conta "fez parcialmente" como meio ponto, não como zero', () => {
    const r = calcularAdesao(diario('parcial', 'parcial', 'parcial', 'parcial', 'parcial', 'parcial', 'parcial'), inicio, fim, 7);
    expect(r.taxa).toBe(50);
  });

  it('trata dia sem registro como não feito', () => {
    // 3 dias registrados de 7 esperados.
    const r = calcularAdesao(diario('fez', 'fez', 'fez'), inicio, fim, 7);
    expect(r.taxa).toBe(43);
  });

  it('usa a frequência prescrita como denominador, não os dias corridos', () => {
    // Prescrição 3×/semana, paciente fez os 3 dias: 100% de adesão, não 43%.
    const r = calcularAdesao(diario('fez', 'fez', 'fez'), inicio, fim, 3);
    expect(r.taxa).toBe(100);
  });

  it('não passa de 100% quem faz além do prescrito', () => {
    const r = calcularAdesao(diario('fez', 'fez', 'fez', 'fez', 'fez', 'fez', 'fez'), inicio, fim, 3);
    expect(r.taxa).toBe(100);
  });

  it('conta a sequência de trás para frente e quebra no primeiro dia sem "fez"', () => {
    const r = calcularAdesao(diario('fez', 'nao_fez', 'fez', 'fez', 'fez', 'fez', 'fez'), inicio, fim, 7);
    expect(r.sequencia).toBe(5);
  });

  it('não conta "parcial" na sequência', () => {
    const r = calcularAdesao(diario('fez', 'fez', 'fez', 'fez', 'fez', 'fez', 'parcial'), inicio, fim, 7);
    expect(r.sequencia).toBe(0);
  });

  it('usa o melhor status do dia quando há vários exercícios', () => {
    const registros: RegistroParaCalculo[] = [
      { data: '2026-09-07', status: 'nao_fez', prescricaoItemId: 'a' },
      { data: '2026-09-07', status: 'fez', prescricaoItemId: 'b' },
    ];
    expect(calcularAdesao(registros, inicio, fim, 7).ultimos7.at(-1)).toBe('fez');
  });

  it('marca como "sem prescrição" os dias anteriores ao início', () => {
    const inicioTardio = new Date('2026-09-05T00:00:00Z');
    const r = calcularAdesao(diario('fez'), inicioTardio, fim, 7);
    // Dias 1 a 4 estão antes da prescrição existir.
    expect(r.ultimos7.slice(0, 4).every((d) => d === 'sem_prescricao')).toBe(true);
  });

  it('sempre devolve 7 posições no heatmap', () => {
    expect(calcularAdesao([], inicio, fim, 7).ultimos7).toHaveLength(7);
  });

  it('não quebra com período invertido', () => {
    const r = calcularAdesao([], fim, inicio, 7);
    expect(r.taxa).toBe(0);
  });

  it('agrega por exercício e ordena do pior para o melhor', () => {
    const registros: RegistroParaCalculo[] = [
      { data: '2026-09-01', status: 'fez', prescricaoItemId: 'i1' },
      { data: '2026-09-02', status: 'fez', prescricaoItemId: 'i1' },
      { data: '2026-09-01', status: 'nao_fez', prescricaoItemId: 'i2' },
      { data: '2026-09-02', status: 'nao_fez', prescricaoItemId: 'i2' },
    ];
    const nomes = new Map([['i1', 'Ponte glútea'], ['i2', 'Rotação externa']]);

    const r = adesaoPorExercicio(registros, nomes);
    // Pior primeiro: a tela existe para achar o que está falhando.
    expect(r[0]).toEqual({ exercicio: 'Rotação externa', taxa: 0, registros: 2 });
    expect(r[1]).toEqual({ exercicio: 'Ponte glútea', taxa: 100, registros: 2 });
  });

  it('usa 40% como corte do sinal de atenção', () => {
    expect(adesaoPreocupante(39)).toBe(true);
    expect(adesaoPreocupante(40)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Governança da biblioteca
// ---------------------------------------------------------------------------

describe('Biblioteca de exercícios', () => {
  const rascunho: ExercicioGovernavel = {
    id: 'ex-1',
    status: 'draft',
    versao: 1,
    autorId: 'prof-1',
    revisorId: null,
    licenca: 'CC BY-SA 4.0',
    temMidia: true,
  };

  it('segue o fluxo draft → in_review → published', () => {
    expect(() => validarTransicao(rascunho, 'in_review', null)).not.toThrow();
    expect(() =>
      validarTransicao({ ...rascunho, status: 'in_review' }, 'published', 'prof-2'),
    ).not.toThrow();
  });

  it('recusa pular a revisão', () => {
    expect(() => validarTransicao(rascunho, 'published', 'prof-2')).toThrow(/transição inválida/i);
  });

  it('bloqueia publicação sem licença declarada', () => {
    const semLicenca = { ...rascunho, status: 'in_review' as const, licenca: null };
    expect(() => validarTransicao(semLicenca, 'published', 'prof-2')).toThrow(/licença/i);
  });

  it('exige revisor diferente do autor', () => {
    const emRevisao = { ...rascunho, status: 'in_review' as const };
    expect(() => validarTransicao(emRevisao, 'published', 'prof-1')).toThrow(/diferente do autor/i);
    expect(() => validarTransicao(emRevisao, 'published', null)).toThrow(/revisão clínica/i);
  });

  it('permite devolver da revisão para rascunho', () => {
    expect(() => validarTransicao({ ...rascunho, status: 'in_review' }, 'draft', null)).not.toThrow();
  });

  it('só permite prescrever exercício publicado e licenciado', () => {
    expect(podeSerPrescrito(rascunho)).toBe(false);
    expect(podeSerPrescrito({ ...rascunho, status: 'published' })).toBe(true);
    expect(podeSerPrescrito({ ...rascunho, status: 'published', licenca: null })).toBe(false);
  });

  it('recusa prescrição com id de exercício não publicado', () => {
    // O ataque: filtrar só na listagem deixaria passar quem manda o id direto.
    expect(() => exigirPrescritivel(rascunho)).toThrow(/publicado/i);
    expect(() => exigirPrescritivel({ ...rascunho, status: 'published', licenca: null })).toThrow(/licença/i);
  });

  it('nova versão recomeça o fluxo sem invalidar a anterior', () => {
    const publicado = { ...rascunho, status: 'published' as const, revisorId: 'prof-2' };
    const v2 = novaVersaoExercicio(publicado, 'ex-2');

    expect(v2.versao).toBe(2);
    expect(v2.status).toBe('draft');
    expect(v2.revisorId).toBeNull(); // Revisão anterior não cobre o texto novo.
    // O publicado segue publicado — prescrições ativas continuam válidas.
    expect(publicado.status).toBe('published');
  });

  it('recusa versionar o que não está publicado', () => {
    expect(() => novaVersaoExercicio(rascunho, 'ex-2')).toThrow(/já publicado/i);
  });
});

// ---------------------------------------------------------------------------
// Consentimento
// ---------------------------------------------------------------------------

describe('Consentimento (LGPD Art. 11)', () => {
  const tcle: Consentimento = {
    tipo: 'tratamento_dados',
    versao: 'v3',
    aceitoEm: new Date('2026-06-12'),
    revogadoEm: null,
  };

  it('reconhece consentimento vigente', () => {
    expect(temConsentimento([tcle], 'tratamento_dados', 'v3')).toBe(true);
    expect(() => exigirConsentimento([tcle], 'tratamento_dados', 'v3')).not.toThrow();
  });

  it('bloqueia registro clínico sem consentimento', () => {
    expect(() => exigirConsentimento([], 'tratamento_dados', 'v3')).toThrow(/TCLE/i);
  });

  it('não aceita versão antiga do termo', () => {
    // Termo novo publicado ⇒ aceite anterior não cobre o novo tratamento.
    expect(temConsentimento([tcle], 'tratamento_dados', 'v4')).toBe(false);
  });

  it('não aceita consentimento revogado', () => {
    expect(temConsentimento([revogar(tcle)], 'tratamento_dados', 'v3')).toBe(false);
  });

  it('separa consentimento de telessaúde do de tratamento de dados', () => {
    // COFFITO 516/2020: prescrição remota exige aceite próprio.
    expect(() => exigirConsentimento([tcle], 'telessaude', 'v1')).toThrow(/516\/2020|distância/i);
  });

  it('preserva o registro do consentimento ao revogar', () => {
    const r = revogar(tcle, new Date('2026-09-07'));
    expect(r.aceitoEm).toEqual(tcle.aceitoEm); // A prova de licitude permanece.
    expect(r.revogadoEm).toEqual(new Date('2026-09-07'));
  });

  it('revogar duas vezes mantém a data original', () => {
    const primeira = revogar(tcle, new Date('2026-09-07'));
    const segunda = revogar(primeira, new Date('2026-10-01'));
    expect(segunda.revogadoEm).toEqual(new Date('2026-09-07'));
  });
});

// ---------------------------------------------------------------------------
// Eventos de domínio
// ---------------------------------------------------------------------------

describe('Barramento de eventos', () => {
  it('entrega o evento aos consumidores do tipo', async () => {
    const barramento = new Barramento();
    const consumidor = vi.fn();
    barramento.assinar('EvolutionFinalized', consumidor);

    const e = evento('EvolutionFinalized', 'org-1', 'prof-1', { registroId: 'ev-1' });
    await barramento.publicar(e);

    expect(consumidor).toHaveBeenCalledWith(e);
  });

  it('não entrega a consumidores de outro tipo', async () => {
    const barramento = new Barramento();
    const outro = vi.fn();
    barramento.assinar('ExerciseCompleted', outro);

    await barramento.publicar(evento('EvolutionFinalized', 'org-1', null, {}));
    expect(outro).not.toHaveBeenCalled();
  });

  it('entrega a consumidores universais (auditoria, métricas)', async () => {
    const barramento = new Barramento();
    const auditoria = vi.fn();
    barramento.assinarTudo(auditoria);

    await barramento.publicar(evento('PatientRegistered', 'org-1', 'prof-1', {}));
    await barramento.publicar(evento('SessionConfirmed', 'org-1', null, {}));
    expect(auditoria).toHaveBeenCalledTimes(2);
  });

  it('isola falha de consumidor — a operação clínica não pode ser perdida', async () => {
    const falhas: unknown[] = [];
    const barramento = new Barramento((erro) => falhas.push(erro));

    barramento.assinar('EvolutionFinalized', () => {
      throw new Error('serviço de notificação fora do ar');
    });
    const saudavel = vi.fn();
    barramento.assinar('EvolutionFinalized', saudavel);

    // Publicar não lança…
    await expect(barramento.publicar(evento('EvolutionFinalized', 'org-1', null, {}))).resolves.toBeUndefined();
    // …o consumidor saudável rodou mesmo assim…
    expect(saudavel).toHaveBeenCalled();
    // …e a falha foi registrada, não engolida.
    expect(falhas).toHaveLength(1);
  });

  it('cancela a inscrição', async () => {
    const barramento = new Barramento();
    const c = vi.fn();
    const cancelar = barramento.assinar('SessionConfirmed', c);

    cancelar();
    await barramento.publicar(evento('SessionConfirmed', 'org-1', null, {}));
    expect(c).not.toHaveBeenCalled();
  });

  it('aguarda consumidores assíncronos', async () => {
    const barramento = new Barramento();
    let terminou = false;
    barramento.assinar('ExerciseCompleted', async () => {
      await new Promise((r) => setTimeout(r, 10));
      terminou = true;
    });

    await barramento.publicar(evento('ExerciseCompleted', 'org-1', null, {}));
    expect(terminou).toBe(true);
  });

  it('não é singleton global — instâncias não vazam entre testes', () => {
    const a = new Barramento();
    const b = new Barramento();
    a.assinar('PatientRegistered', vi.fn());

    expect(a.contarConsumidores('PatientRegistered')).toBe(1);
    expect(b.contarConsumidores('PatientRegistered')).toBe(0);
  });
});
