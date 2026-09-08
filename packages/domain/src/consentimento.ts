/**
 * Consentimento (TCLE) — porta de entrada de qualquer dado clínico.
 *
 * ## Base legal
 *
 * LGPD Art. 11: dado de saúde é dado pessoal sensível e exige consentimento
 * específico e destacado (ou outra hipótese legal, como tutela da saúde por
 * profissional de saúde — Art. 11, II, "f"). O Cinesis adota consentimento
 * explícito porque é a hipótese que o titular consegue verificar e revogar, e
 * porque o público-alvo é atendimento particular, não serviço público de saúde.
 *
 * COFFITO 516/2020: prescrição remota de exercício conta como acompanhamento à
 * distância e exige consentimento informado próprio, além do registro da
 * conduta fundamentada.
 *
 * ## A regra dura
 *
 * Sem consentimento vigente, **nenhum registro clínico é criado**. Não é aviso
 * na interface: é `412 CONSENTIMENTO_AUSENTE` do servidor. Cadastro
 * administrativo (nome, contato, agendamento) segue permitido — é o que
 * viabiliza registrar o consentimento em si.
 */

import { ConsentimentoAusente } from '@cinesis/shared';

/** Tipos de consentimento coletados. */
export type TipoConsentimento =
  | 'tratamento_dados' // LGPD Art. 11: tratar dado de saúde.
  | 'telessaude' // COFFITO 516/2020: acompanhamento à distância (HEP remoto).
  | 'uso_imagem'; // Foto e vídeo de avaliação — consentimento separado.

/** Um consentimento registrado. */
export interface Consentimento {
  tipo: TipoConsentimento;
  /** Versão do termo aceito, ex.: `v3`. Termo novo exige aceite novo. */
  versao: string;
  aceitoEm: Date;
  /** Preenchido quando o titular revoga (LGPD Art. 8º, §5º). */
  revogadoEm: Date | null;
}

/**
 * Há consentimento vigente deste tipo, na versão exigida?
 *
 * @param consentimentos  Todos os consentimentos do paciente.
 * @param tipo            Tipo exigido pela operação.
 * @param versaoExigida   Versão vigente do termo na organização.
 */
export function temConsentimento(
  consentimentos: readonly Consentimento[],
  tipo: TipoConsentimento,
  versaoExigida: string,
): boolean {
  return consentimentos.some(
    (c) =>
      c.tipo === tipo &&
      c.revogadoEm === null &&
      // Versão diferente da vigente não serve: se a clínica publicou um termo
      // novo, o aceite do termo antigo não cobre o novo tratamento de dados.
      c.versao === versaoExigida,
  );
}

/**
 * Exige consentimento antes de uma operação clínica.
 *
 * @throws {ConsentimentoAusente} 412, com a mensagem que a interface exibe.
 */
export function exigirConsentimento(
  consentimentos: readonly Consentimento[],
  tipo: TipoConsentimento,
  versaoExigida: string,
): void {
  if (!temConsentimento(consentimentos, tipo, versaoExigida)) {
    throw new ConsentimentoAusente(MENSAGEM_POR_TIPO[tipo]);
  }
}

/** Mensagem exibida quando falta cada tipo de consentimento. */
const MENSAGEM_POR_TIPO: Record<TipoConsentimento, string> = {
  tratamento_dados:
    'Registre o consentimento (TCLE) do paciente antes de criar qualquer registro clínico — LGPD Art. 11.',
  telessaude:
    'Prescrição remota exige consentimento de acompanhamento à distância — COFFITO 516/2020.',
  uso_imagem: 'Anexar foto ou vídeo exige consentimento específico de uso de imagem.',
};

/**
 * Revoga um consentimento.
 *
 * O consentimento revogado **não é apagado** — ele ganha `revogadoEm`. Apagar
 * destruiria a prova de que o tratamento foi lícito enquanto durou, o que é o
 * oposto do que a LGPD pede do controlador.
 *
 * Efeito prático da revogação: novos registros clínicos são bloqueados. Os
 * registros já criados **permanecem**, por força da COFFITO 415/2012 (guarda de
 * prontuário) — que é hipótese legal de conservação independente do
 * consentimento (LGPD Art. 16, I: cumprimento de obrigação legal).
 */
export function revogar(consentimento: Consentimento, agora = new Date()): Consentimento {
  return { ...consentimento, revogadoEm: consentimento.revogadoEm ?? agora };
}

/**
 * A operação exige qual tipo de consentimento?
 *
 * Tabela única para que nenhuma rota decida isso sozinha.
 */
export const CONSENTIMENTO_EXIGIDO = {
  criarAvaliacao: 'tratamento_dados',
  criarEvolucao: 'tratamento_dados',
  criarReavaliacao: 'tratamento_dados',
  criarPlano: 'tratamento_dados',
  prescreverHep: 'telessaude',
  anexarMidia: 'uso_imagem',
} as const satisfies Record<string, TipoConsentimento>;
