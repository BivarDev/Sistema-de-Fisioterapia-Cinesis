/**
 * Escopo de consulta — o coração do RBAC do Cinesis.
 *
 * ## A regra que este arquivo existe para tornar difícil de violar
 *
 * "RBAC por escopo aplicado **na query**, nunca em checagem posterior."
 *
 * A diferença entre as duas coisas, na prática:
 *
 * ```ts
 * // ERRADO — busca tudo e filtra depois.
 * const p = await db.select().from(pacientes).where(eq(pacientes.id, id));
 * if (p.organizacaoId !== ator.organizacaoId) throw new NaoEncontrado();
 * ```
 *
 * ```ts
 * // CERTO — o escopo entra no WHERE; o dado de outra org nunca é lido.
 * const p = await db.select().from(pacientes)
 *   .where(and(eq(pacientes.id, id), ...escopo.condicoes(pacientes)));
 * ```
 *
 * A versão errada funciona igual nos testes felizes e falha em três lugares:
 * o dado alheio passa pela memória do processo (aparece em dump, em log de
 * query, em APM), o `if` é fácil de esquecer numa rota nova, e a diferença de
 * tempo entre "não existe" e "existe mas é de outro" vaza a existência.
 *
 * ## Como usar
 *
 * Nenhuma consulta a tabela com dado de tenant é montada sem chamar
 * `Escopo.condicoes()`. O teste `test/escopo.test.ts` e a revisão de código
 * cobrem isso; o tipo `Escopo` sendo obrigatório nas funções de repositório
 * torna o esquecimento visível.
 */

import { nivelDe, type Papel, type Permissao } from '@cinesis/shared';

/**
 * O escopo de um ator: quem ele é e até onde ele enxerga.
 *
 * Construído uma vez por requisição, a partir da sessão, e passado adiante
 * para toda função de repositório.
 */
export class Escopo {
  constructor(
    /** Id do profissional (ou do paciente, no portal). */
    readonly sujeitoId: string,
    /** Organização da sessão. Todo dado é filtrado por ela, sem exceção. */
    readonly organizacaoId: string,
    /** Papel efetivo na organização. */
    readonly papel: Papel,
    /**
     * Ids de profissionais cujo dado este ator pode ver além do próprio.
     *
     * Para estagiário, contém o(s) supervisor(es). Para fisioterapeuta e
     * recepção fica vazio, porque o acesso deles já é `total` na organização.
     */
    readonly supervisoresIds: readonly string[] = [],
  ) {}

  /**
   * O ator tem acesso `total` a esta permissão?
   * Diferente de `pode`: aqui o `restrito` conta como `false`.
   */
  temTotal(permissao: Permissao): boolean {
    return nivelDe(this.papel, permissao) === 'total';
  }

  /** O ator tem algum acesso (total ou restrito) a esta permissão? */
  pode(permissao: Permissao): boolean {
    return nivelDe(this.papel, permissao) !== 'negado';
  }

  /**
   * O acesso é restrito ao escopo supervisionado?
   * Quando `true`, a consulta precisa filtrar também por profissional.
   */
  ehRestrito(permissao: Permissao): boolean {
    return nivelDe(this.papel, permissao) === 'restrito';
  }

  /**
   * Lista de ids de profissional que a consulta deve aceitar, quando o acesso
   * é restrito.
   *
   * Inclui o próprio ator: o estagiário vê o que ele mesmo registrou, mais o
   * que os supervisores dele registraram.
   */
  profissionaisVisiveis(): string[] {
    return [this.sujeitoId, ...this.supervisoresIds];
  }

  /**
   * O ator pode reidentificar PII?
   *
   * Ponto único de decisão. Chamado pela camada de apresentação para decidir
   * se o nome do paciente sequer é decifrado — se `false`, o valor não é lido
   * do banco, não passa pela memória e não pode vazar por um log esquecido.
   */
  podeVerPii(): boolean {
    return this.temTotal('paciente:reidentificar');
  }
}

/**
 * Escopo de um paciente no portal.
 *
 * Deliberadamente uma classe separada, e não um `Escopo` com
 * `papel: 'paciente'`. O motivo é evitar que um erro de digitação num
 * repositório profissional aceite um escopo de paciente: os tipos não são
 * compatíveis, então o compilador barra.
 */
export class EscopoPortal {
  constructor(
    /** Id do paciente autenticado pelo link mágico. */
    readonly pacienteId: string,
    /** Organização a que o paciente pertence. */
    readonly organizacaoId: string,
  ) {}

  /**
   * O portal só enxerga um plano se ele for do próprio paciente.
   *
   * Não existe "listar planos" no portal — todo acesso parte do `pacienteId`
   * da sessão, nunca de um id vindo da URL. É o que garante o critério de
   * aceitação "vê apenas dados do seu próprio contexto".
   */
  ehDoProprioPaciente(pacienteIdDoRecurso: string): boolean {
    return pacienteIdDoRecurso === this.pacienteId;
  }
}
