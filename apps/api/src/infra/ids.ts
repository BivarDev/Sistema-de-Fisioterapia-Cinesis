/**
 * Geração de identificadores.
 *
 * ## Por que UUID v7 e não v4 nem serial
 *
 * - **`serial` está fora de questão.** Id sequencial em rota pública convida
 *   enumeração (o clássico "trocar `/pacientes/41` por `/pacientes/42`"), e o
 *   maior id vaza o tamanho da base para qualquer um que crie um registro.
 *
 * - **UUID v4 resolve o sigilo e cria um problema de banco.** Como é aleatório,
 *   linhas inseridas em sequência caem em páginas espalhadas do índice
 *   B-tree — o que fragmenta o índice e degrada a escrita conforme a tabela
 *   cresce.
 *
 * - **UUID v7 resolve os dois.** Os 48 bits iniciais são o timestamp em
 *   milissegundos, então ids gerados em sequência ficam próximos no índice
 *   (inserção quase sempre na mesma página, como num `serial`). Os 74 bits
 *   restantes são aleatórios, o que mantém o id imprevisível.
 *
 * O que o v7 revela e o v4 não: **o instante da criação**. Para este sistema
 * isso é aceitável — a data de criação já está na coluna `criado_em` ao lado.
 */

import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Gera um UUID v7.
 *
 * Layout (RFC 9562):
 * ```
 * ┌────────────────────────┬──────┬──────────────────────────────┐
 * │ 48 bits: timestamp ms  │ ver  │ 74 bits: aleatório + variante │
 * └────────────────────────┴──────┴──────────────────────────────┘
 * ```
 *
 * @param agora Instante base (injetável para teste).
 */
export function novoId(agora = Date.now()): string {
  // 16 bytes aleatórios; os 6 primeiros serão sobrescritos pelo timestamp.
  const bytes = randomBytes(16);

  // 48 bits de timestamp, big-endian, nos bytes 0–5.
  bytes.writeUIntBE(agora, 0, 6);

  // Byte 6: 4 bits altos = versão (7), 4 bits baixos permanecem aleatórios.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;

  // Byte 8: 2 bits altos = variante RFC 4122 (binário 10).
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Gera um UUID v4 (totalmente aleatório).
 *
 * Use quando o id **não pode** revelar o instante de criação — por exemplo,
 * um identificador que vá para fora do sistema. Dentro do sistema, prefira
 * `novoId`.
 */
export function novoIdAleatorio(): string {
  return randomUUID();
}

/**
 * Extrai o instante de criação de um UUID v7.
 * Útil em diagnóstico e em ordenação sem coluna extra.
 *
 * @returns `Date` da criação, ou `null` se não for um v7 válido.
 */
export function instanteDoId(id: string): Date | null {
  const hex = id.replace(/-/g, '');
  if (hex.length !== 32) return null;

  // Confere a versão antes de interpretar: um v4 tem timestamp sem sentido.
  if (hex[12] !== '7') return null;

  const ms = parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Gera um código legível de registro clínico, ex.: `E-2292`.
 *
 * Aparece na assinatura, no PDF e na trilha de auditoria — precisa ser curto e
 * ditável por telefone. A unicidade real vem do índice único
 * `(organizacao_id, codigo)`; colisão faz o insert falhar e o chamador tentar
 * de novo, o que é raro o bastante para não valer uma sequência dedicada.
 *
 * @param tipo `avaliacao`, `evolucao` ou `reavaliacao`.
 */
export function codigoRegistro(tipo: 'avaliacao' | 'evolucao' | 'reavaliacao'): string {
  const prefixo = { avaliacao: 'A', evolucao: 'E', reavaliacao: 'R' }[tipo];
  // 4 dígitos: 10.000 combinações por tipo por organização.
  const numero = 1000 + Math.floor(Math.random() * 9000);
  return `${prefixo}-${numero}`;
}
