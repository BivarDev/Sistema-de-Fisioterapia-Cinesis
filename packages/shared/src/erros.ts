/**
 * Erros de domínio e o contrato de erro da API.
 *
 * Duas regras que valem para o projeto inteiro:
 *
 * 1. **Fora de escopo responde 404, nunca 403.** Um 403 confirma que o recurso
 *    existe — isso é vazamento de informação entre organizações. Por isso
 *    `NaoEncontrado` é o erro que a camada de autorização lança tanto para
 *    "não existe" quanto para "existe mas não é seu".
 *
 * 2. **A mensagem que vai para o cliente nunca carrega dado clínico nem PII.**
 *    O detalhe fica no log estruturado, correlacionado pelo `correlationId`.
 */

/** Códigos de erro estáveis. O cliente pode ramificar decisão em cima deles. */
export const CODIGOS_ERRO = [
  'NAO_AUTENTICADO', // 401 — sem sessão válida.
  'NAO_ENCONTRADO', // 404 — inexistente OU fora do escopo (indistinguível de propósito).
  'CONFLITO', // 409 — violação de invariante (ex.: editar registro selado).
  'DADOS_INVALIDOS', // 422 — falhou a validação de schema.
  'EXCESSO_REQUISICOES', // 429 — rate limit.
  'CONSENTIMENTO_AUSENTE', // 412 — TCLE não aceito; bloqueia registro clínico.
  'ERRO_INTERNO', // 500 — bug. Nunca detalha nada ao cliente.
] as const;

/** Tipo do código de erro. */
export type CodigoErro = (typeof CODIGOS_ERRO)[number];

/** Formato único de resposta de erro da API. Todo endpoint devolve exatamente isso. */
export interface RespostaErro {
  /** Código estável para o cliente ramificar. */
  codigo: CodigoErro;
  /** Mensagem curta, em português, segura para exibir ao usuário final. */
  mensagem: string;
  /** Identificador da requisição, para casar com o log do servidor no suporte. */
  correlationId: string;
  /** Detalhes de validação por campo. Só preenchido em `DADOS_INVALIDOS`. */
  campos?: Record<string, string[]>;
}

/**
 * Erro base do domínio. Carrega o código e o status HTTP correspondente.
 * Handlers de rota não montam status na mão — apenas lançam a subclasse certa.
 */
export class ErroCinesis extends Error {
  /** Código estável exposto ao cliente. */
  readonly codigo: CodigoErro;
  /** Status HTTP que o handler global de erro vai usar. */
  readonly status: number;
  /** Detalhes de validação por campo (opcional). */
  readonly campos: Record<string, string[]> | undefined;

  constructor(
    codigo: CodigoErro,
    status: number,
    mensagem: string,
    campos?: Record<string, string[]>,
  ) {
    super(mensagem);
    this.name = new.target.name; // Nome real da subclasse aparece no stack trace.
    this.codigo = codigo;
    this.status = status;
    this.campos = campos;
  }
}

/** 401 — não há sessão, ou a sessão foi revogada/expirou. */
export class NaoAutenticado extends ErroCinesis {
  constructor(mensagem = 'Sessão inválida ou expirada.') {
    super('NAO_AUTENTICADO', 401, mensagem);
  }
}

/**
 * 404 — o recurso não existe **ou** está fora do escopo do ator.
 *
 * Use este erro também quando a autorização falhar. É intencional que o cliente
 * não consiga distinguir os dois casos: essa é a defesa contra enumeração de
 * identificadores entre tenants (IDOR/BOLA).
 */
export class NaoEncontrado extends ErroCinesis {
  constructor(mensagem = 'Recurso não encontrado.') {
    super('NAO_ENCONTRADO', 404, mensagem);
  }
}

/** 409 — a operação viola uma invariante do agregado (ex.: prontuário selado). */
export class Conflito extends ErroCinesis {
  constructor(mensagem: string) {
    super('CONFLITO', 409, mensagem);
  }
}

/** 422 — o corpo/query não passou na validação Zod. */
export class DadosInvalidos extends ErroCinesis {
  constructor(campos: Record<string, string[]>, mensagem = 'Dados inválidos.') {
    super('DADOS_INVALIDOS', 422, mensagem, campos);
  }
}

/** 412 — falta consentimento (TCLE) vigente para registrar dado clínico. */
export class ConsentimentoAusente extends ErroCinesis {
  constructor(mensagem = 'É necessário registrar o consentimento (TCLE) antes de qualquer dado clínico.') {
    super('CONSENTIMENTO_AUSENTE', 412, mensagem);
  }
}

/** 429 — o ator estourou o limite de requisições da janela corrente. */
export class ExcessoRequisicoes extends ErroCinesis {
  /** Segundos que o cliente deve esperar antes de tentar de novo. */
  readonly aguardarSegundos: number;

  constructor(aguardarSegundos: number, mensagem = 'Muitas tentativas. Aguarde um instante.') {
    super('EXCESSO_REQUISICOES', 429, mensagem);
    this.aguardarSegundos = aguardarSegundos;
  }
}
