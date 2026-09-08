/**
 * Link mágico do portal do paciente.
 *
 * ## Requisitos que a especificação já trazia
 *
 * Expiração curta, uso único, reemissão em vez de reuso, rate limit.
 *
 * ## O que faltava e está resolvido aqui
 *
 * 1. **O token não pode ir na query string.** URL com `?token=` vaza em log de
 *    servidor, em histórico do navegador, no header `Referer` de qualquer
 *    imagem ou link externo da página, e no histórico de um celular
 *    compartilhado. Aqui o token vai no **path** (não é logado por padrão em
 *    proxy bem configurado) e a página o troca por cookie de sessão no primeiro
 *    carregamento, limpando a URL com `history.replaceState`.
 *
 * 2. **O token não pode ser guardado em claro.** O banco guarda
 *    `HMAC(chave_isolada, token)`. Vazou o banco, ninguém entra em portal
 *    nenhum.
 *
 * 3. **Uso único de verdade.** A marcação de consumo é uma escrita condicional
 *    (`UPDATE … WHERE consumido_em IS NULL`), não `SELECT` seguido de `UPDATE`
 *    — senão duas requisições simultâneas consomem o mesmo token.
 *
 * 4. **Vínculo com o paciente.** O token carrega apenas um identificador
 *    aleatório; a ligação com o paciente vive no banco. Um token não revela
 *    para quem ele é, nem permite trocar o alvo.
 */

import { randomBytes } from 'node:crypto';
import { type Anel, hmac } from './chaves.js';

/** Validade do link mágico, em segundos. */
export const VALIDADE_LINK_S = 15 * 60; // 15 minutos, como especificado.

/** Máximo de emissões por paciente por hora. */
export const LIMITE_EMISSAO_HORA = 5;

/** Token emitido, em suas duas formas. */
export interface TokenPortal {
  /** Valor que vai no link enviado ao paciente. **Nunca é guardado.** */
  emClaro: string;
  /** HMAC do token. É isto que vai para a coluna do banco. */
  hash: string;
  /** Instante em que o token deixa de valer. */
  expiraEm: Date;
}

/**
 * Emite um token de link mágico.
 *
 * @param anel  Anel de chaves do processo.
 * @param agora Instante base (injetável para teste).
 */
export function emitirTokenPortal(anel: Anel, agora = new Date()): TokenPortal {
  // 32 bytes = 256 bits. Em base64url dá 43 caracteres — cabe num link de
  // WhatsApp sem quebrar de linha e é inviável de adivinhar.
  const emClaro = randomBytes(32).toString('base64url');

  return {
    emClaro,
    hash: hashDoToken(anel, emClaro),
    expiraEm: new Date(agora.getTime() + VALIDADE_LINK_S * 1000),
  };
}

/**
 * Calcula o hash de um token.
 *
 * Use tanto ao emitir (para gravar) quanto ao validar (para procurar no banco).
 * Procurar pelo hash em vez de comparar linha a linha também evita comparação
 * de string em tempo variável no banco.
 */
export function hashDoToken(anel: Anel, emClaro: string): string {
  return hmac(anel.derivar('token-portal'), emClaro);
}

/** Como um token pode ser recusado. Vira `LINK_PORTAL_RECUSADO` na auditoria. */
export type RecusaToken =
  | 'inexistente' // Não há linha com esse hash. Token forjado ou já limpo.
  | 'expirado' // Passou dos 15 minutos.
  | 'ja_consumido' // Uso único: já foi trocado por sessão.
  | 'revogado'; // A clínica invalidou manualmente.

/** Estado do token vindo do banco, para a checagem pura. */
export interface EstadoToken {
  expiraEm: Date;
  consumidoEm: Date | null;
  revogadoEm: Date | null;
}

/** Resultado da validação. */
export type ResultadoToken = { ok: true } | { ok: false; recusa: RecusaToken };

/**
 * Valida o estado de um token já localizado no banco.
 *
 * Função pura, sem I/O: fácil de testar exaustivamente, que é o que se quer de
 * uma checagem de autenticação. A busca e o consumo atômico ficam no
 * repositório.
 *
 * @param estado Linha do banco, ou `null` se não achou o hash.
 * @param agora  Instante base (injetável).
 */
export function validarToken(estado: EstadoToken | null, agora = new Date()): ResultadoToken {
  if (!estado) return { ok: false, recusa: 'inexistente' };
  if (estado.revogadoEm) return { ok: false, recusa: 'revogado' };
  if (estado.consumidoEm) return { ok: false, recusa: 'ja_consumido' };
  if (estado.expiraEm.getTime() <= agora.getTime()) return { ok: false, recusa: 'expirado' };
  return { ok: true };
}

/**
 * Monta a URL do link mágico.
 *
 * O token vai no **path**, não na query. Detalhe que parece cosmético e não é:
 * a maioria dos proxies e balanceadores registra a query string no access log
 * por padrão, e o path com segmento opaco costuma ser menos exposto. A defesa
 * completa exige, do lado do servidor, `Referrer-Policy: no-referrer` na página
 * do portal — configurado em `apps/api/src/plugins/seguranca.ts`.
 *
 * @param base  Origem pública do portal, ex.: `https://clinica.exemplo.br`.
 * @param token Token em claro, recém-emitido.
 */
export function montarUrlPortal(base: string, token: string): string {
  // `replace` remove barra final duplicada quando a base já termina em `/`.
  return `${base.replace(/\/+$/, '')}/entrar/${token}`;
}

/**
 * Extrai o token de uma URL de portal.
 * Devolve `null` se o formato não for exatamente o esperado — não tenta ser
 * tolerante, porque tolerância aqui é superfície de ataque.
 */
export function extrairTokenDaUrl(url: string): string | null {
  const m = /\/entrar\/([A-Za-z0-9_-]{43})(?:$|[/?#])/.exec(url);
  return m?.[1] ?? null;
}
