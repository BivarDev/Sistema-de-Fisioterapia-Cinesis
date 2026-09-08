/**
 * Segundo fator (TOTP) e códigos de recuperação.
 *
 * ## Por que MFA num sistema de fisioterapia
 *
 * O ativo aqui é prontuário — dado pessoal sensível (LGPD Art. 11). A conta do
 * fisioterapeuta dá acesso ao histórico clínico da clínica inteira, e o vetor
 * mais provável de comprometimento não é uma falha do sistema: é reuso de senha
 * do titular num site que vazou. Segundo fator é a única defesa que continua de
 * pé nesse cenário.
 *
 * Fica **opcional por padrão** e é obrigatório para quem tem
 * `paciente:reidentificar` — o público-alvo tem baixa familiaridade técnica e
 * exigir MFA de todo mundo no primeiro acesso mataria a adoção. O sistema
 * insiste, mas quem decide é o operador.
 *
 * ## Escolha: TOTP (RFC 6238), não SMS
 *
 * SMS é vulnerável a SIM swap e depende de operadora. TOTP funciona offline,
 * em qualquer app autenticador, e não custa nada por mensagem — relevante para
 * um autônomo que instala o sistema num VPS de R$ 20.
 */

import { randomBytes, createHash } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { codigosIguais } from './senhas.js';

/** Janela de tolerância, em períodos de 30 s, para frente e para trás. */
const JANELA = 1; // ±30 s. Cobre relógio dessincronizado sem alargar demais.

/** Quantos códigos de recuperação são gerados na ativação. */
const QUANTIDADE_RECUPERACAO = 8;

/** O que a ativação de MFA devolve para exibir uma única vez ao usuário. */
export interface SegredoMfa {
  /** Segredo em base32, para digitação manual no app autenticador. */
  segredoBase32: string;
  /** URI `otpauth://` para virar QR Code no frontend. */
  uri: string;
  /** Códigos de recuperação em claro. **Só existem aqui, uma vez.** */
  codigosRecuperacao: string[];
  /** Hashes dos códigos, para gravar no banco. */
  hashesRecuperacao: string[];
}

/**
 * Gera um segredo TOTP novo mais os códigos de recuperação.
 *
 * O segredo devolvido ainda **não** deve ativar o MFA: guarde-o pendente e só
 * marque como ativo depois que o usuário provar, com `conferirTotp`, que
 * conseguiu cadastrá-lo. Ativar antes da prova tranca o usuário fora da conta
 * quando ele erra o cadastro.
 *
 * @param emissor Nome que aparece no app autenticador (ex.: "Cinesis").
 * @param conta   Identificação da conta (o e-mail do profissional).
 */
export function gerarSegredoMfa(emissor: string, conta: string): SegredoMfa {
  // 20 bytes = 160 bits, o tamanho recomendado pela RFC 4226 para HMAC-SHA1.
  const secret = new Secret({ size: 20 });

  const totp = new TOTP({
    issuer: emissor,
    label: conta,
    algorithm: 'SHA1', // O que 100% dos apps autenticadores suportam.
    digits: 6,
    period: 30,
    secret,
  });

  const codigosRecuperacao = Array.from({ length: QUANTIDADE_RECUPERACAO }, () =>
    // 5 bytes → 8 caracteres base32. Curto o bastante para anotar no papel,
    // longo o bastante (40 bits) para não ser adivinhado dentro do rate limit.
    randomBytes(5).toString('hex').toUpperCase().replace(/(.{4})/, '$1-'),
  );

  return {
    segredoBase32: secret.base32,
    uri: totp.toString(),
    codigosRecuperacao,
    hashesRecuperacao: codigosRecuperacao.map(hashRecuperacao),
  };
}

/**
 * Confere um código TOTP de 6 dígitos.
 *
 * @param segredoBase32 Segredo guardado (cifrado no banco — ver `cifragem.ts`).
 * @param codigo        Os 6 dígitos digitados.
 * @returns             `true` se o código é válido na janela corrente.
 */
export function conferirTotp(segredoBase32: string, codigo: string): boolean {
  // Formato errado nem chega a consultar o segredo — economiza trabalho e
  // evita que entrada arbitrária alcance a biblioteca.
  if (!/^\d{6}$/.test(codigo)) return false;

  try {
    const totp = new TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(segredoBase32),
    });
    // `validate` devolve o delta de períodos, ou `null` se não bater.
    return totp.validate({ token: codigo, window: JANELA }) !== null;
  } catch {
    // Segredo corrompido. Trata como inválido em vez de derrubar o login.
    return false;
  }
}

/**
 * Hash de um código de recuperação, para guardar no banco.
 *
 * SHA-256 puro basta aqui (diferente de senha): o código tem 40 bits de
 * entropia aleatória, então não existe ataque de dicionário a montar. O que
 * limita a força bruta é o rate limit do endpoint, não o custo do hash.
 */
export function hashRecuperacao(codigo: string): string {
  return createHash('sha256').update(codigo.toUpperCase().replace(/-/g, ''), 'utf8').digest('hex');
}

/**
 * Confere um código de recuperação contra a lista de hashes ainda válidos.
 *
 * @param hashesValidos Hashes dos códigos que ainda não foram usados.
 * @param codigo        Código digitado.
 * @returns             O hash consumido (para você removê-lo da lista), ou
 *                      `null` se não bateu. **Código de recuperação é de uso
 *                      único** — se não remover, ele vira uma senha permanente.
 */
export function conferirRecuperacao(hashesValidos: string[], codigo: string): string | null {
  const alvo = hashRecuperacao(codigo);
  // Percorre a lista inteira mesmo depois de achar, para não vazar por tempo
  // a posição do código na lista.
  let encontrado: string | null = null;
  for (const h of hashesValidos) {
    if (codigosIguais(h, alvo)) encontrado = h;
  }
  return encontrado;
}

/**
 * MFA é obrigatório para este papel?
 *
 * Regra do projeto: quem pode reidentificar PII precisa de segundo fator. É a
 * operação de maior impacto do sistema — ela desfaz a pseudonimização.
 */
export function mfaObrigatorio(papel: string): boolean {
  return papel === 'fisioterapeuta';
}
