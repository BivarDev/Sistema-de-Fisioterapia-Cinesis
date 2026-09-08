/**
 * Trilha de auditoria com cadeia de integridade.
 *
 * ## A lacuna que isto fecha
 *
 * A especificação exige "log de auditoria imutável". Na prática, "imutável"
 * costuma virar apenas "a aplicação não expõe UPDATE nem DELETE" — o que não
 * protege contra quem tem acesso ao banco, que é justamente o cenário em que a
 * auditoria mais importa (administrador mal-intencionado, atacante que já
 * escalou privilégio, ou o próprio operador tentando apagar um acesso indevido).
 *
 * A defesa é **encadear os eventos por hash**, como um livro-razão:
 *
 * ```
 * hash(n) = SHA-256( hash(n-1) || conteúdo canônico do evento n )
 * ```
 *
 * Alterar ou remover o evento *n* quebra o hash de *n+1*, e de todos os
 * seguintes. Reescrever a cadeia inteira exige recalcular tudo — o que é
 * detectável se a ponta da cadeia for publicada periodicamente fora do banco
 * (log externo, e-mail diário ao responsável, armazenamento WORM). O sistema
 * dá a primitiva; a política de publicação da âncora fica com o operador e
 * está documentada em `docs/security-model.md`.
 *
 * ## Além do hash
 *
 * A cadeia é uma das três camadas. As outras são de banco e estão nas
 * migrações: `REVOKE UPDATE, DELETE` da tabela para o papel da aplicação, e
 * um gatilho `BEFORE UPDATE OR DELETE` que lança exceção.
 */

import { createHash } from 'node:crypto';

/** Ações auditáveis. Lista fechada para que a trilha seja consultável. */
export const ACOES_AUDITAVEIS = [
  // --- Leitura de dado sensível ---------------------------------------------
  'LEITURA_PRONTUARIO', // Alguém abriu um registro clínico.
  'LEITURA_AUDITORIA', // Alguém leu a própria trilha (sim, isso também audita).
  'EXPORTACAO_PDF', // Gerou PDF — o dado saiu do sistema.

  // --- Escrita clínica -------------------------------------------------------
  'AVALIACAO_FINALIZADA',
  'EVOLUCAO_CRIADA',
  'EVOLUCAO_FINALIZADA',
  'EVOLUCAO_NOVA_VERSAO', // Correção: a versão anterior permanece.
  'REAVALIACAO_CRIADA',
  'PLANO_CRIADO',
  'PLANO_ENCERRADO',

  // --- Pseudonimização -------------------------------------------------------
  'REIDENTIFICACAO_AUTORIZADA', // Com motivo registrado.
  'REIDENTIFICACAO_NEGADA', // Papel sem permissão tentou.

  // --- Consentimento ---------------------------------------------------------
  'CONSENTIMENTO_REGISTRADO',
  'CONSENTIMENTO_REVOGADO',

  // --- Adesão ----------------------------------------------------------------
  'PRESCRICAO_CRIADA',
  'EXERCICIO_REGISTRADO', // O paciente registrou execução no portal.
  'LINK_PORTAL_EMITIDO',
  'LINK_PORTAL_CONSUMIDO',
  'LINK_PORTAL_RECUSADO', // Expirado, reusado ou inválido.

  // --- Plataforma / segurança ------------------------------------------------
  'LOGIN_SUCESSO',
  'LOGIN_FALHA',
  'LOGIN_BLOQUEADO', // Conta em backoff por excesso de tentativas.
  'MFA_ATIVADO',
  'MFA_DESATIVADO',
  'SESSAO_REVOGADA',
  'SENHA_ALTERADA',
  'PAPEL_ALTERADO',
  'MEMBRO_CONVIDADO',
  'MEMBRO_DESATIVADO',
  'ACESSO_FORA_DE_ESCOPO', // Tentou id de outra organização. Resposta: 404.
  'UPLOAD_RECUSADO', // Arquivo reprovado na validação.
  'MIDIA_ACESSADA', // Acesso a foto/vídeo clínico.
  'EXPORTACAO_LGPD', // Titular pediu seus dados (Art. 18, V).
  'ANONIMIZACAO_LGPD', // Titular pediu eliminação (Art. 18, VI).
] as const;

/** Tipo de uma ação auditável. */
export type AcaoAuditavel = (typeof ACOES_AUDITAVEIS)[number];

/**
 * Um evento pronto para gravar.
 *
 * Nenhum campo aqui pode carregar PII ou dado clínico. `detalhe` existe para
 * contexto operacional ("motivo da reidentificação", "campo alterado"), e é
 * responsabilidade de quem chama passar por `redigir()` antes.
 */
export interface EventoParaGravar {
  organizacaoId: string;
  /** Id do profissional/paciente, ou `null` para ação do próprio sistema. */
  atorId: string | null;
  /** Papel do ator no momento da ação. */
  atorPapel: string;
  acao: AcaoAuditavel;
  /** Tipo da entidade tocada, ex.: `Evolucao`, `Paciente`. */
  entidade: string;
  entidadeId: string;
  /** Contexto adicional já sanitizado. */
  detalhe: string | null;
  /** Instante da ação. Injetável para tornar o teste determinístico. */
  ocorridoEm: Date;
}

/** Evento com sua posição e hash na cadeia — o que vai para o banco. */
export interface EventoEncadeado extends EventoParaGravar {
  /** Posição na cadeia, sequencial e sem buracos dentro da organização. */
  sequencia: number;
  /** Hash do evento anterior. `GENESIS` no primeiro. */
  hashAnterior: string;
  /** Hash deste evento. Entra como `hashAnterior` do próximo. */
  hash: string;
}

/**
 * Separador de campos na serializacao canonica.
 *
 * U+001F (unit separator) nao aparece em texto digitado, entao um `detalhe`
 * contendo o separador nao consegue forjar a fronteira entre dois campos.
 */
const SEPARADOR = '\u001f';

/** Hash inicial da cadeia de cada organização. */
export const HASH_GENESIS = 'GENESIS';

/**
 * Serializa um evento de forma canônica.
 *
 * "Canônica" = a mesma entrada sempre produz exatamente a mesma string. Sem
 * isso, a verificação da cadeia falharia por diferença de ordem de chave ou de
 * formato de data, e a integridade viraria falso positivo constante.
 *
 * O separador U+001F (unit separator) é usado porque não aparece em texto
 * digitado — impede que um `detalhe` contendo o separador forje um campo.
 */
function canonico(e: EventoParaGravar, sequencia: number, hashAnterior: string): string {
  return [
    hashAnterior,
    String(sequencia),
    e.organizacaoId,
    e.atorId ?? '',
    e.atorPapel,
    e.acao,
    e.entidade,
    e.entidadeId,
    e.detalhe ?? '',
    e.ocorridoEm.toISOString(),
  ].join(SEPARADOR);
}

/**
 * Calcula o hash de um evento a partir do anterior.
 *
 * @param evento       Conteúdo do evento.
 * @param sequencia    Posição na cadeia.
 * @param hashAnterior Hash do evento `sequencia - 1`, ou `HASH_GENESIS`.
 * @returns            Hex de 64 caracteres.
 */
export function calcularHash(
  evento: EventoParaGravar,
  sequencia: number,
  hashAnterior: string,
): string {
  return createHash('sha256').update(canonico(evento, sequencia, hashAnterior), 'utf8').digest('hex');
}

/**
 * Encadeia um evento novo na ponta da cadeia.
 *
 * @param evento     Conteúdo do evento.
 * @param ultimo     Último evento gravado da organização, ou `null` se é o 1º.
 */
export function encadear(
  evento: EventoParaGravar,
  ultimo: Pick<EventoEncadeado, 'sequencia' | 'hash'> | null,
): EventoEncadeado {
  const sequencia = (ultimo?.sequencia ?? 0) + 1;
  const hashAnterior = ultimo?.hash ?? HASH_GENESIS;
  return {
    ...evento,
    sequencia,
    hashAnterior,
    hash: calcularHash(evento, sequencia, hashAnterior),
  };
}

/** O que a verificação da cadeia encontrou. */
export interface ResultadoVerificacao {
  /** `true` quando toda a cadeia confere. */
  integra: boolean;
  /** Quantos eventos foram conferidos. */
  conferidos: number;
  /** Sequência do primeiro evento com problema, ou `null`. */
  quebraEm: number | null;
  /** O que exatamente deu errado. */
  motivo: 'hash_divergente' | 'elo_quebrado' | 'sequencia_com_buraco' | null;
}

/**
 * Verifica a integridade de uma cadeia inteira.
 *
 * Rode periodicamente (job diário) e ofereça na tela de segurança. É a única
 * forma de descobrir adulteração feita **por fora da aplicação**.
 *
 * @param eventos Eventos da organização, ordenados por `sequencia` crescente.
 */
export function verificarCadeia(eventos: EventoEncadeado[]): ResultadoVerificacao {
  let anterior = HASH_GENESIS;
  let esperada = 1;

  for (const e of eventos) {
    // 1. A sequência não pode pular — um buraco significa evento removido.
    if (e.sequencia !== esperada) {
      return { integra: false, conferidos: esperada - 1, quebraEm: e.sequencia, motivo: 'sequencia_com_buraco' };
    }
    // 2. O elo precisa apontar para o hash do anterior.
    if (e.hashAnterior !== anterior) {
      return { integra: false, conferidos: esperada - 1, quebraEm: e.sequencia, motivo: 'elo_quebrado' };
    }
    // 3. O hash precisa bater com o conteúdo — pega alteração de campo.
    if (calcularHash(e, e.sequencia, e.hashAnterior) !== e.hash) {
      return { integra: false, conferidos: esperada - 1, quebraEm: e.sequencia, motivo: 'hash_divergente' };
    }

    anterior = e.hash;
    esperada++;
  }

  return { integra: true, conferidos: eventos.length, quebraEm: null, motivo: null };
}

/**
 * Âncora de integridade publicável.
 *
 * Publique isto fora do banco (e-mail diário ao responsável, arquivo em
 * armazenamento WORM, commit num repositório separado). Sem uma cópia externa
 * da ponta da cadeia, quem tem acesso total ao banco pode reescrever tudo e o
 * hash final continuará consistente consigo mesmo.
 */
export interface Ancora {
  organizacaoId: string;
  sequencia: number;
  hash: string;
  geradaEm: string;
}

/** Monta a âncora a partir do último evento da organização. */
export function gerarAncora(organizacaoId: string, ultimo: EventoEncadeado): Ancora {
  return {
    organizacaoId,
    sequencia: ultimo.sequencia,
    hash: ultimo.hash,
    geradaEm: new Date().toISOString(),
  };
}
