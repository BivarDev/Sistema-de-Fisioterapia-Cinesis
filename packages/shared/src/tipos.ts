/**
 * Tipos de transporte (DTOs) trocados entre a API e os frontends.
 *
 * Importante: estes tipos descrevem o que **sai** da API, já filtrado por RBAC.
 * Eles não são o modelo de persistência — o banco tem colunas que nunca chegam
 * aqui (hashes, chaves de cifragem, PII bruta). Se um campo sensível aparecer
 * neste arquivo, isso é sinal de que alguma coisa vazou de camada.
 */

import type { Papel } from './papeis.js';

// ---------------------------------------------------------------------------
// Plataforma
// ---------------------------------------------------------------------------

/** Organização = tenant raiz. Todo dado do sistema pendura em uma. */
export interface Organizacao {
  id: string; // UUID v7 — ordenável por tempo, mas não sequencial/adivinhável.
  nome: string;
  tipo: 'autonomo' | 'clinica';
  criadaEm: string; // ISO 8601 UTC.
}

/** Profissional autenticado, do ponto de vista da interface. */
export interface Profissional {
  id: string;
  nome: string;
  email: string;
  /** Registro no conselho. Obrigatório para quem assina prontuário. */
  crefito: string | null;
  papel: Papel;
  organizacaoId: string;
  /** Segundo fator ativo? A interface usa para sugerir a ativação. */
  mfaAtivo: boolean;
}

/** O que o frontend precisa saber sobre a sessão corrente. */
export interface SessaoAtual {
  profissional: Profissional;
  organizacao: Organizacao;
  /** Permissões já resolvidas pelo servidor — a UI só esconde, não decide. */
  permissoes: Record<string, 'total' | 'restrito' | 'negado'>;
  /** Momento em que a sessão expira de forma absoluta, mesmo com uso contínuo. */
  expiraEm: string;
}

// ---------------------------------------------------------------------------
// Clinical Core
// ---------------------------------------------------------------------------

/**
 * Paciente como o profissional o vê.
 *
 * `nome` é `null` quando o papel do ator não tem `paciente:reidentificar` — o
 * servidor não envia o nome e a interface mostra apenas o `codigo`. Isso não é
 * mascaramento no cliente: o dado realmente não sai do backend.
 */
export interface PacienteResumo {
  id: string;
  /** Código pseudonimizado estável, ex.: `PC-4821`. Sempre presente. */
  codigo: string;
  /** Nome real. `null` quando o ator não pode reidentificar. */
  nome: string | null;
  /** Idade em anos. Menos identificante que a data de nascimento completa. */
  idade: number | null;
  /** Situação derivada da série longitudinal do plano ativo. */
  situacao: 'evoluindo' | 'estavel' | 'estagnado' | 'sem_plano';
  /** Taxa de adesão ao HEP nos últimos 30 dias (0–100), ou `null` sem prescrição. */
  adesao: number | null;
  /** EVA da última evolução registrada (0–10). */
  evaAtual: number | null;
  /** EVA da avaliação inicial, para o delta. */
  evaInicial: number | null;
  /** Título do plano de tratamento ativo. */
  planoAtivo: string | null;
  /** Próxima sessão agendada, em ISO 8601. */
  proximaSessao: string | null;
  /** `false` bloqueia qualquer novo registro clínico até o TCLE ser aceito. */
  consentimentoVigente: boolean;
}

/** Status do ciclo de vida de um plano de tratamento (o agregado principal). */
export type StatusPlano = 'ativo' | 'concluido' | 'interrompido';

/** Plano de tratamento = um episódio de cuidado, do começo à alta. */
export interface PlanoTratamento {
  id: string;
  pacienteId: string;
  /** Ex.: "Reabilitação pós-operatória de LCA — joelho direito". */
  titulo: string;
  /** Hipótese diagnóstica cinesiofuncional. */
  diagnostico: string;
  objetivo: string;
  status: StatusPlano;
  /** Fase corrente do tratamento, ex.: "Fase 2 — fortalecimento". */
  fase: string | null;
  iniciadoEm: string;
  encerradoEm: string | null;
  /** Total de sessões previstas no plano (para o "sessão 9 de 12"). */
  sessoesPrevistas: number;
  sessoesRealizadas: number;
  /** Data-alvo da próxima reavaliação. Vencida => aparece em "precisa de atenção". */
  reavaliacaoEm: string | null;
}

/** Tipo de registro na linha do tempo do episódio. */
export type TipoRegistro = 'avaliacao' | 'evolucao' | 'reavaliacao' | 'prescricao';

/**
 * Um registro clínico na linha do tempo.
 *
 * `versao` + `substituiId` são o coração da imutabilidade exigida pela
 * COFFITO 415/2012: corrigir um registro **cria** a v2 e preserva a v1.
 */
export interface RegistroClinico {
  id: string;
  planoId: string;
  tipo: TipoRegistro;
  /** Código legível, ex.: `E-2292`. Usado na assinatura e na auditoria. */
  codigo: string;
  titulo: string;
  resumo: string;
  /** Data do atendimento (não a data de digitação). */
  ocorridoEm: string;
  /** `true` = selado e imutável. Toda edição a partir daqui gera nova versão. */
  finalizado: boolean;
  finalizadoEm: string | null;
  /** Número da versão. A v1 nunca é apagada. */
  versao: number;
  /** Id do registro que esta versão substitui, se houver. */
  substituiId: string | null;
  /** Nome + CREFITO de quem assinou. `null` enquanto é rascunho. */
  assinatura: string | null;
  /** EVA registrada nesta sessão (0–10). */
  eva: number | null;
}

/** Um ponto da série longitudinal usada no gráfico de comparação. */
export interface PontoLongitudinal {
  /** Rótulo do eixo X, ex.: "S1", "S2". */
  rotulo: string;
  data: string;
  /** Escore funcional composto (0–100). Sobe = melhora. */
  escore: number;
  /** Dor EVA (0–10). Desce = melhora. */
  eva: number;
}

// ---------------------------------------------------------------------------
// Testes funcionais (ClinicalAssessmentDefinition)
// ---------------------------------------------------------------------------

/**
 * Definição de um teste/escala clínica.
 *
 * A armadilha que este tipo existe para evitar: transformar teste funcional em
 * `enum` no código. Incorporar um teste novo tem que ser **configuração**
 * (uma linha no banco), não deploy. Por isso fórmula e regras de interpretação
 * são dados declarativos, não funções TypeScript.
 */
export interface DefinicaoTeste {
  id: string;
  /** Chave estável, ex.: `oswestry`. Usada nas aplicações do teste. */
  chave: string;
  nome: string;
  /** Versão da definição, ex.: `v2.1a-BR`. Aplicações guardam qual versão usaram. */
  versao: string;
  categoria: 'dor' | 'funcao' | 'amplitude' | 'mobilidade' | 'forca' | 'equilibrio';
  /** Unidade do resultado, ex.: `%`, `cm`, `graus`, `s`, `0–10`. */
  unidade: string;
  /** Referência bibliográfica da escala. Vai impressa na tela. */
  fonte: string;
  /** Licença de uso da escala. Sem licença declarada, o teste não é publicável. */
  licenca: string;
  /** Campos que o profissional preenche ao aplicar o teste. */
  campos: CampoTeste[];
  /** Como o escore é calculado a partir dos campos. */
  formula: FormulaTeste;
  /** Faixas de interpretação, avaliadas na ordem em que aparecem. */
  interpretacoes: FaixaInterpretacao[];
  /** `true` = escore maior é pior (ex.: Oswestry, EVA). Muda a cor do delta. */
  maiorEhPior: boolean;
}

/** Um campo de entrada de um teste. */
export interface CampoTeste {
  chave: string;
  rotulo: string;
  tipo: 'numero' | 'escala' | 'booleano';
  /** Valor mínimo aceito (inclusive). */
  min: number;
  /** Valor máximo aceito (inclusive). */
  max: number;
  /** Peso do campo na fórmula `soma_ponderada`. Padrão 1. */
  peso?: number;
}

/**
 * Fórmula de cálculo, declarativa.
 *
 * - `soma`             — soma simples dos campos.
 * - `soma_ponderada`   — soma multiplicando cada campo pelo seu `peso`.
 * - `media`            — média aritmética dos campos.
 * - `percentual_do_max`— soma dividida pelo máximo possível × 100 (Oswestry).
 * - `direto`           — usa o valor do primeiro campo, sem transformar (EVA, TUG).
 */
export interface FormulaTeste {
  tipo: 'soma' | 'soma_ponderada' | 'media' | 'percentual_do_max' | 'direto';
  /** Multiplicador aplicado ao resultado. Padrão 1. */
  fator?: number;
  /** Casas decimais no resultado final. Padrão 0. */
  casas?: number;
}

/** Uma faixa de interpretação do escore. */
export interface FaixaInterpretacao {
  /** Limite inferior, inclusive. */
  de: number;
  /** Limite superior, inclusive. */
  ate: number;
  /** Texto que aparece para o profissional. */
  texto: string;
  /** Tom visual do bloco de interpretação. */
  tom: 'bom' | 'atencao' | 'ruim' | 'neutro';
}

/** O resultado de aplicar um teste a um paciente numa data. */
export interface AplicacaoTeste {
  id: string;
  registroId: string;
  definicaoChave: string;
  /** Versão da definição usada no cálculo — auditoria de procedência. */
  definicaoVersao: string;
  /** Valores brutos informados, por chave de campo. */
  valores: Record<string, number>;
  /** Escore calculado pelo servidor (nunca pelo cliente). */
  escore: number;
  /** Texto da faixa em que o escore caiu. */
  interpretacao: string;
  tom: FaixaInterpretacao['tom'];
  /** Diferença para a aplicação anterior do mesmo teste no mesmo plano. */
  delta: number | null;
  aplicadoEm: string;
}

// ---------------------------------------------------------------------------
// Adherence
// ---------------------------------------------------------------------------

/** Estados de publicação de um exercício da biblioteca. */
export type StatusExercicio = 'draft' | 'in_review' | 'published';

/** Um exercício do catálogo. */
export interface Exercicio {
  id: string;
  nome: string;
  categoria: string;
  regiao: string;
  /** Orientação escrita em linguagem de paciente, não clínica. */
  orientacao: string;
  status: StatusExercicio;
  versao: number;
  autor: string;
  revisor: string | null;
  /** Licença do conteúdo. `null` **bloqueia** a publicação. */
  licenca: string | null;
  /** URL do vídeo demonstrativo, ou `null` enquanto não há mídia. */
  midiaUrl: string | null;
}

/** Parâmetros FITT de uma prescrição. */
export interface PrescricaoItem {
  id: string;
  exercicioId: string;
  exercicioNome: string;
  series: number;
  repeticoes: number;
  /** Carga textual, ex.: "faixa vermelha", "peso corporal". */
  carga: string;
  /** Vezes por semana. */
  frequenciaSemanal: number;
  /** Regra de progressão declarada, não texto livre solto. */
  progressao: string;
}

/** Uma prescrição de exercício domiciliar (HEP) ativa. */
export interface Prescricao {
  id: string;
  planoId: string;
  itens: PrescricaoItem[];
  criadaEm: string;
  ativa: boolean;
  /** Meta de dias com execução por semana. */
  metaSemanal: number;
}

/** Como o paciente registrou a execução de um exercício num dia. */
export type StatusAdesao = 'fez' | 'parcial' | 'nao_fez';

/** Registro de execução feito pelo paciente no portal. */
export interface RegistroAdesao {
  id: string;
  prescricaoItemId: string;
  /** Data (sem hora) a que o registro se refere, `YYYY-MM-DD`. */
  data: string;
  status: StatusAdesao;
  /** Observação curta do paciente, opcional. */
  observacao: string | null;
}

/** Linha do painel de adesão do fisioterapeuta. */
export interface LinhaAdesao {
  pacienteId: string;
  codigo: string;
  nome: string | null;
  /** Percentual 0–100 no período consultado. */
  taxa: number;
  metaSemanal: number;
  /** Dias consecutivos com pelo menos um registro `fez`. */
  sequencia: number;
  /** Últimos 7 dias, do mais antigo para o mais recente. */
  ultimos7: (StatusAdesao | 'sem_prescricao')[];
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Estados possíveis de uma sessão agendada. */
export type StatusSessao =
  | 'agendada'
  | 'confirmada'
  | 'realizada'
  | 'falta_justificada'
  | 'no_show'
  | 'cancelada';

/** Uma sessão na agenda. */
export interface SessaoAgenda {
  id: string;
  planoId: string | null;
  pacienteId: string;
  pacienteCodigo: string;
  pacienteNome: string | null;
  profissionalId: string;
  inicioEm: string;
  duracaoMin: number;
  status: StatusSessao;
  /** `true` quando foi gerada por uma série de recorrência. */
  recorrente: boolean;
  /** Motivo registrado no reagendamento/falta. Diferencia falta de no-show. */
  motivo: string | null;
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------

/** Um evento imutável da trilha de auditoria. */
export interface EventoAuditoria {
  id: string;
  /** Posição na cadeia. Sequencial dentro da organização. */
  sequencia: number;
  ocorridoEm: string;
  /** Quem agiu. `sistema` para eventos automáticos. */
  atorNome: string;
  atorPapel: Papel | 'sistema';
  /** Ação em SCREAMING_SNAKE, ex.: `LEITURA_PRONTUARIO`. */
  acao: string;
  /** Tipo da entidade afetada, ex.: `Evolucao`. */
  entidade: string;
  /** Id da entidade afetada. */
  entidadeId: string;
  /** Contexto adicional já sanitizado — nunca contém PII nem dado clínico. */
  detalhe: string | null;
  /** Elo da cadeia de integridade: hash deste evento encadeado ao anterior. */
  hash: string;
}
