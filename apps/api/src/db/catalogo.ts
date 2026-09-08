/**
 * Catálogo inicial de testes funcionais e exercícios.
 *
 * ## Por que isto é dado e não código
 *
 * Cada teste abaixo é uma linha em `definicoes_teste`. Nada aqui vira `switch`
 * nem `enum`: o motor de `packages/domain/src/avaliacao.ts` interpreta os
 * campos, a fórmula e as faixas de interpretação em tempo de execução.
 * Incorporar o WOMAC, o DASH ou o Lysholm é acrescentar um objeto a esta lista
 * — ou, na instalação do usuário, um `INSERT`.
 *
 * ## Sobre as fontes
 *
 * Toda escala traz `fonte` (referência bibliográfica) e `licenca`. Os dois
 * aparecem impressos na tela de avaliação, ao lado do resultado. Não é
 * decoração: é o que permite ao fisioterapeuta saber de onde veio o número que
 * ele vai assinar, e ao operador saber se pode redistribuir aquele instrumento.
 *
 * As faixas de interpretação seguem os pontos de corte publicados de cada
 * instrumento. Onde o instrumento não define corte oficial, a faixa é marcada
 * como orientativa no próprio texto.
 */

import type { DefinicaoTeste, Exercicio } from '@cinesis/shared';

/** Definições de teste do catálogo padrão. */
export const CATALOGO_TESTES: Omit<DefinicaoTeste, 'id'>[] = [
  {
    chave: 'eva',
    nome: 'Escala Visual Analógica de Dor (EVA)',
    versao: 'v1',
    categoria: 'dor',
    unidade: '0–10',
    fonte: 'Huskisson EC. Measurement of pain. Lancet, 1974.',
    licenca: 'Domínio público',
    // Dor maior = pior. Inverte a direção do delta e da cor na interface.
    maiorEhPior: true,
    campos: [{ chave: 'dor', rotulo: 'Intensidade da dor', tipo: 'escala', min: 0, max: 10 }],
    formula: { tipo: 'direto' },
    interpretacoes: [
      { de: 0, ate: 0, texto: 'Sem dor', tom: 'bom' },
      { de: 1, ate: 3, texto: 'Dor leve', tom: 'bom' },
      { de: 4, ate: 6, texto: 'Dor moderada', tom: 'atencao' },
      { de: 7, ate: 9, texto: 'Dor intensa', tom: 'ruim' },
      { de: 10, ate: 10, texto: 'Pior dor imaginável', tom: 'ruim' },
    ],
  },
  {
    chave: 'oswestry',
    nome: 'Índice de Incapacidade de Oswestry (ODI)',
    versao: 'v2.1a-BR',
    categoria: 'funcao',
    unidade: '%',
    fonte: 'Vigatto R, Alexandre NMC, Correa Filho HR. Spine, 2007 (validação brasileira).',
    licenca: 'Uso clínico e acadêmico livre',
    maiorEhPior: true,
    // 10 seções, 0 a 5 cada. O escore é a soma dividida pelo máximo (50) × 100.
    campos: [
      { chave: 's1', rotulo: 'Intensidade da dor', tipo: 'escala', min: 0, max: 5 },
      { chave: 's2', rotulo: 'Cuidados pessoais', tipo: 'escala', min: 0, max: 5 },
      { chave: 's3', rotulo: 'Levantar peso', tipo: 'escala', min: 0, max: 5 },
      { chave: 's4', rotulo: 'Caminhar', tipo: 'escala', min: 0, max: 5 },
      { chave: 's5', rotulo: 'Sentar', tipo: 'escala', min: 0, max: 5 },
      { chave: 's6', rotulo: 'Ficar em pé', tipo: 'escala', min: 0, max: 5 },
      { chave: 's7', rotulo: 'Dormir', tipo: 'escala', min: 0, max: 5 },
      { chave: 's8', rotulo: 'Vida sexual', tipo: 'escala', min: 0, max: 5 },
      { chave: 's9', rotulo: 'Vida social', tipo: 'escala', min: 0, max: 5 },
      { chave: 's10', rotulo: 'Viajar', tipo: 'escala', min: 0, max: 5 },
    ],
    formula: { tipo: 'percentual_do_max', casas: 0 },
    interpretacoes: [
      { de: 0, ate: 20, texto: 'Incapacidade mínima', tom: 'bom' },
      { de: 21, ate: 40, texto: 'Incapacidade moderada', tom: 'atencao' },
      { de: 41, ate: 60, texto: 'Incapacidade severa', tom: 'ruim' },
      { de: 61, ate: 80, texto: 'Incapacidade grave', tom: 'ruim' },
      { de: 81, ate: 100, texto: 'Incapacidade máxima ou exagero de sintomas', tom: 'ruim' },
    ],
  },
  {
    chave: 'schober',
    nome: 'Teste de Schober modificado',
    versao: 'v1',
    categoria: 'amplitude',
    unidade: 'cm',
    fonte: 'Macrae IF, Wright V. Ann Rheum Dis, 1969.',
    licenca: 'Domínio público',
    // Mais centímetros de excursão = mais mobilidade lombar = melhor.
    maiorEhPior: false,
    campos: [
      { chave: 'excursao', rotulo: 'Excursão em flexão', tipo: 'numero', min: 0, max: 15 },
    ],
    formula: { tipo: 'direto', casas: 1 },
    interpretacoes: [
      { de: 0, ate: 3.9, texto: 'Mobilidade lombar bastante reduzida', tom: 'ruim' },
      { de: 4, ate: 4.9, texto: 'Mobilidade lombar reduzida', tom: 'atencao' },
      { de: 5, ate: 15, texto: 'Mobilidade lombar preservada', tom: 'bom' },
    ],
  },
  {
    chave: 'tug',
    nome: 'Timed Up and Go (TUG)',
    versao: 'v1',
    categoria: 'mobilidade',
    unidade: 's',
    fonte: 'Podsiadlo D, Richardson S. J Am Geriatr Soc, 1991.',
    licenca: 'Domínio público',
    // Mais segundos para completar = pior mobilidade.
    maiorEhPior: true,
    campos: [{ chave: 'tempo', rotulo: 'Tempo para completar', tipo: 'numero', min: 0, max: 120 }],
    formula: { tipo: 'direto', casas: 1 },
    interpretacoes: [
      { de: 0, ate: 9.9, texto: 'Mobilidade normal', tom: 'bom' },
      { de: 10, ate: 13.9, texto: 'Mobilidade adequada, baixo risco de queda', tom: 'bom' },
      { de: 14, ate: 19.9, texto: 'Risco aumentado de queda', tom: 'atencao' },
      { de: 20, ate: 120, texto: 'Alto risco de queda — investigar', tom: 'ruim' },
    ],
  },
  {
    chave: 'adm_flexao_joelho',
    nome: 'ADM — flexão de joelho (goniometria)',
    versao: 'v1',
    categoria: 'amplitude',
    unidade: 'graus',
    fonte: 'AAOS — Joint Motion: Method of Measuring and Recording.',
    licenca: 'Domínio público',
    maiorEhPior: false,
    campos: [{ chave: 'graus', rotulo: 'Graus de flexão', tipo: 'numero', min: 0, max: 150 }],
    formula: { tipo: 'direto', casas: 0 },
    interpretacoes: [
      { de: 0, ate: 89, texto: 'Amplitude limitada — restringe atividades diárias', tom: 'ruim' },
      { de: 90, ate: 119, texto: 'Amplitude funcional parcial', tom: 'atencao' },
      { de: 120, ate: 150, texto: 'Amplitude preservada', tom: 'bom' },
    ],
  },
  {
    chave: 'dash',
    nome: 'DASH — Disabilities of the Arm, Shoulder and Hand',
    versao: 'v1-BR',
    categoria: 'funcao',
    unidade: '%',
    fonte: 'Orfale AG et al. Braz J Med Biol Res, 2005 (validação brasileira).',
    licenca: 'Uso clínico e acadêmico livre',
    maiorEhPior: true,
    // Versão reduzida de 11 itens (QuickDASH), 1 a 5 cada.
    campos: Array.from({ length: 11 }, (_, i) => ({
      chave: `q${i + 1}`,
      rotulo: `Item ${i + 1}`,
      tipo: 'escala' as const,
      min: 1,
      max: 5,
    })),
    formula: { tipo: 'percentual_do_max', casas: 0 },
    interpretacoes: [
      { de: 0, ate: 25, texto: 'Incapacidade leve do membro superior', tom: 'bom' },
      { de: 26, ate: 50, texto: 'Incapacidade moderada', tom: 'atencao' },
      { de: 51, ate: 100, texto: 'Incapacidade acentuada', tom: 'ruim' },
    ],
  },
];

/**
 * Catálogo inicial de exercícios.
 *
 * Pequeno e curado, como a especificação decide: reproduzir uma biblioteca
 * comercial de 12 mil itens não é meta de dia 1. O que importa aqui é que o
 * fluxo de governança exista desde o começo — e a lista inclui, de propósito,
 * um item em revisão e um rascunho **sem licença**, para que o comportamento
 * de bloqueio seja visível na instalação nova.
 */
export const CATALOGO_EXERCICIOS: (Omit<Exercicio, 'id' | 'midiaUrl'> & {
  revisor: string | null;
})[] = [
  {
    nome: 'Ponte glútea',
    categoria: 'Fortalecimento',
    regiao: 'Quadril e lombar',
    orientacao:
      'Deite de barriga para cima, joelhos dobrados e pés no chão. Levante o quadril até o corpo ficar reto dos joelhos aos ombros. Segure 3 segundos e desça devagar.',
    status: 'published',
    versao: 1,
    autor: 'Equipe Cinesis',
    revisor: 'Revisão clínica Cinesis',
    licenca: 'CC BY-SA 4.0',
  },
  {
    nome: 'Cat-camel (gato-camelo)',
    categoria: 'Mobilidade',
    regiao: 'Coluna',
    orientacao:
      'Fique de quatro apoios. Arredonde as costas para cima, olhando para o umbigo, e depois deixe a barriga descer devagar. Faça o movimento lento, sem forçar.',
    status: 'published',
    versao: 1,
    autor: 'Equipe Cinesis',
    revisor: 'Revisão clínica Cinesis',
    licenca: 'CC BY-SA 4.0',
  },
  {
    nome: 'Dead bug',
    categoria: 'Estabilização',
    regiao: 'Core',
    orientacao:
      'Deite de barriga para cima com braços e pernas apontando para o teto. Estenda um braço e a perna oposta devagar, mantendo a lombar encostada no chão. Volte e troque.',
    status: 'published',
    versao: 1,
    autor: 'Equipe Cinesis',
    revisor: 'Revisão clínica Cinesis',
    licenca: 'CC BY-SA 4.0',
  },
  {
    nome: 'Rotação externa de ombro com faixa elástica',
    categoria: 'Fortalecimento',
    regiao: 'Ombro',
    orientacao:
      'Cotovelo colado no corpo, dobrado a 90 graus. Puxe a faixa para fora, girando o antebraço. Volte devagar. O ombro não deve subir.',
    status: 'published',
    versao: 1,
    autor: 'Equipe Cinesis',
    revisor: 'Revisão clínica Cinesis',
    licenca: 'CC BY 4.0',
  },
  {
    nome: 'Caminhada em ritmo confortável',
    categoria: 'Condicionamento',
    regiao: 'Geral',
    orientacao:
      'Caminhe num ritmo em que ainda consiga conversar. Se sentir dor que aumenta durante a caminhada, pare e avise na próxima sessão.',
    status: 'published',
    versao: 1,
    autor: 'Equipe Cinesis',
    revisor: 'Revisão clínica Cinesis',
    licenca: 'CC BY 4.0',
  },
  {
    nome: 'Agachamento parcial com apoio',
    categoria: 'Fortalecimento',
    regiao: 'Joelho',
    orientacao:
      'Em pé, apoiado numa cadeira, dobre os joelhos até onde não doer. Mantenha os joelhos alinhados com os pés e volte devagar.',
    // Em revisão: aparece na aba "Em revisão" e NÃO pode ser prescrito.
    status: 'in_review',
    versao: 1,
    autor: 'Equipe Cinesis',
    revisor: null,
    licenca: 'CC BY-SA 4.0',
  },
  {
    nome: 'Alongamento de isquiotibiais em pé',
    categoria: 'Flexibilidade',
    regiao: 'Coxa',
    orientacao:
      'Coloque o calcanhar num degrau baixo, perna esticada. Incline o tronco para a frente mantendo as costas retas até sentir o alongamento atrás da coxa.',
    status: 'in_review',
    versao: 1,
    autor: 'Equipe Cinesis',
    revisor: null,
    licenca: 'CC BY 4.0',
  },
  {
    nome: 'Prancha frontal',
    categoria: 'Estabilização',
    regiao: 'Core',
    orientacao: 'Apoie antebraços e pontas dos pés, mantendo o corpo em linha reta.',
    status: 'draft',
    versao: 1,
    autor: 'Equipe Cinesis',
    revisor: null,
    // Deliberadamente sem licença: a interface mostra
    // "licença: pendente — bloqueia publicação", e o servidor recusa publicar.
    licenca: null,
  },
];
