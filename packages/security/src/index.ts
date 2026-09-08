/**
 * `@cinesis/security` — a fundação de segurança do sistema.
 *
 * Este pacote não depende de framework web, de banco nem de Redis: é lógica
 * pura e testável. Isso é deliberado. Segurança acoplada ao Fastify vira
 * segurança que ninguém consegue testar isoladamente, e o que não se testa
 * isoladamente não se confia.
 *
 * A ordem abaixo segue as oito camadas do modelo de segurança:
 *
 * | Camada                          | Módulo                |
 * |---------------------------------|-----------------------|
 * | 1. PII isolada e cifrada        | `cifragem`            |
 * | 2. RBAC por escopo na query     | `escopo`              |
 * | 3. 404 fora de escopo           | `@cinesis/shared/erros` |
 * | 4. Pseudonimização por HMAC     | `pseudonimizacao`, `chaves` |
 * | 5. Sessão opaca revogável       | `sessao`, `csrf`      |
 * | 6. Prontuário imutável          | `@cinesis/domain`     |
 * | 7. Link mágico do portal        | `tokens`              |
 * | 8. Log sem PII                  | `redacao`             |
 *
 * Camadas adicionais deste projeto, além das oito da especificação:
 * senha (`senhas`), segundo fator (`mfa`), integridade da auditoria
 * (`auditoria`), limitação de taxa (`limites`) e upload (`upload`).
 */

export * from './chaves.js';
export * from './cifragem.js';
export * from './pseudonimizacao.js';
export * from './senhas.js';
export * from './sessao.js';
export * from './csrf.js';
export * from './mfa.js';
export * from './auditoria.js';
export * from './tokens.js';
export * from './redacao.js';
export * from './limites.js';
export * from './upload.js';
export * from './escopo.js';
