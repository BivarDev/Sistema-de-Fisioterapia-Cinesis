/**
 * Ponto de entrada do pacote `@cinesis/shared`.
 *
 * Tudo que API, web e portal precisam ter em comum passa por aqui. Se um tipo
 * é usado por apenas um app, ele NÃO pertence a este pacote — mantê-lo local
 * evita que o "compartilhado" vire depósito.
 */

export * from './papeis.js';
export * from './erros.js';
export * from './tipos.js';
export * from './validacao.js';
