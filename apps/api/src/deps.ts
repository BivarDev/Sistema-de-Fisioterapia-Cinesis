/**
 * Dependências da aplicação, montadas uma vez e injetadas nas rotas.
 *
 * ## Por que injeção explícita e não singleton importado
 *
 * Um `import { db } from './db'` que devolve uma instância global torna todo
 * teste dependente de ordem de execução e impossibilita subir duas instâncias
 * (uma por tenant de teste, por exemplo). Passar as dependências como parâmetro
 * é mais verboso e resolve os dois problemas.
 *
 * Também é o que permite que os testes de integração usem PGlite em memória
 * sem nenhum `vi.mock` — o teste monta as dependências que quiser.
 */

import type { Barramento } from '@cinesis/domain';
import type { Anel, GestorSessao } from '@cinesis/security';
import type { Banco, Conexao } from './db/conexao.js';
import type { Config } from './config.js';

/** O que toda rota tem à disposição. */
export interface Deps {
  /** Banco, sem escopo de tenant. As rotas o passam para `comTenant`. */
  db: Banco;
  /** Conexão completa, para desligamento gracioso e DDL. */
  conexao: Conexao;
  /** Anel de chaves: cifragem de PII, pseudonimização, tokens. */
  anel: Anel;
  /** Gestor de sessões opacas. */
  gestor: GestorSessao;
  /** Barramento de eventos de domínio. */
  eventos: Barramento;
  /** Configuração validada. */
  config: Config;
}
