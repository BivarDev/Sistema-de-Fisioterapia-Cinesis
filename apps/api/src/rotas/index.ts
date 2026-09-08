/**
 * Registro de todas as rotas da API.
 *
 * ## Convenções
 *
 * - Todo handler começa validando a entrada com um schema de `@cinesis/shared`.
 *   Nenhum toca `request.body` cru.
 * - Toda rota autenticada declara `preHandler: app.exigirProfissional` (ou
 *   `exigirPaciente`). Rota sem isso é rota pública, e são só três.
 * - Toda operação de escrita roda dentro de `comTenant`, que fixa o tenant e
 *   assume o papel de banco restrito.
 * - Nenhum handler monta status HTTP na mão para erro: lança a subclasse de
 *   `ErroCinesis` e o tratador global cuida.
 */

import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { rotasAuth } from './auth.js';
import { rotasPacientes } from './pacientes.js';
import { rotasPlanos } from './planos.js';
import { rotasAdesao } from './adesao.js';
import { rotasPortal } from './portal.js';
import { rotasPlataforma } from './plataforma.js';

/** Registra o conjunto completo de rotas. */
export async function registrarRotas(app: FastifyInstance, deps: Deps): Promise<void> {
  /**
   * Verificação de saúde.
   *
   * Deliberadamente magra: responde `ok` e o instante, e **nada mais**. Health
   * check que expõe versão, nome de host ou estado de dependências entrega
   * mapa da infraestrutura a quem varre a internet.
   */
  app.get('/api/saude', async () => ({ ok: true, em: new Date().toISOString() }));

  await app.register(rotasAuth(deps));
  await app.register(rotasPacientes(deps));
  await app.register(rotasPlanos(deps));
  await app.register(rotasAdesao(deps));
  await app.register(rotasPortal(deps));
  await app.register(rotasPlataforma(deps));
}
