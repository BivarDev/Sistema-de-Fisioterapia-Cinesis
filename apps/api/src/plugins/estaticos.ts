/**
 * Serve os frontends compilados.
 *
 * ## Por que a API serve os estáticos
 *
 * A promessa de implantação é `docker compose up`. Um servidor web separado
 * para os dois frontends seria um serviço a mais no Compose, um a mais para
 * configurar e um a mais para dar errado na clínica de um autônomo.
 *
 * Também resolve, de graça, o problema que mais atrapalha nesta arquitetura:
 * servidos da **mesma origem** que a API, o cookie `SameSite=Strict` e a
 * checagem de `Origin` funcionam sem nenhuma exceção.
 *
 * ## Em desenvolvimento não roda
 *
 * O Vite serve os frontends com hot reload e repassa `/api` para cá. Este
 * plugin só entra quando existe `dist` — ou seja, na imagem de produção.
 */

import type { FastifyInstance } from 'fastify';
import estaticos from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raiz do repositório, ancorada neste arquivo (não no diretório de execução). */
function raiz(): string {
  // `plugins` → `src`/`dist` → `api` → `apps` → raiz.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

/** Onde os frontends compilados estao, e o HTML de entrada de cada um. */
export interface Estaticos {
  /** Diretorio da aplicacao profissional, ou `null` se nao foi compilada. */
  web: string | null;
  /** Diretorio do portal do paciente, ou `null`. */
  portal: string | null;
  /**
   * Conteudo do `index.html` de cada app, lido uma vez na inicializacao.
   *
   * Guardamos o HTML em memoria em vez de usar `reply.sendFile` por dois
   * motivos:
   *
   * 1. `sendFile` so existe se o `@fastify/static` for registrado com
   *    `decorateReply: true` — e aqui ha DOIS registros (web e portal), que
   *    nao podem decorar a mesma `reply` sem conflito. Depender disso ja
   *    causou um 500 em toda rota interna recarregada.
   * 2. Sao ~2 KB cada. Ler do disco a cada F5 nao compra nada.
   */
  htmlWeb: string | null;
  htmlPortal: string | null;
  /** `true` quando ha pelo menos um para servir. */
  algum: boolean;
}

/**
 * Descobre quais frontends estao compilados.
 *
 * Separado de `registrarEstaticos` porque o tratador de 404 precisa saber disso
 * **antes** de ser registrado: o Fastify aceita apenas um `setNotFoundHandler`
 * por instancia, entao quem decide o comportamento do 404 tem de ser um so.
 */
export function localizarEstaticos(): Estaticos {
  const web = join(raiz(), 'apps', 'web', 'dist');
  const portal = join(raiz(), 'apps', 'portal', 'dist');

  const temWeb = existsSync(join(web, 'index.html'));
  const temPortal = existsSync(join(portal, 'index.html'));

  return {
    web: temWeb ? web : null,
    portal: temPortal ? portal : null,
    // Lidos aqui, uma vez. Ver a nota em `Estaticos`.
    htmlWeb: temWeb ? readFileSync(join(web, 'index.html'), 'utf8') : null,
    htmlPortal: temPortal ? readFileSync(join(portal, 'index.html'), 'utf8') : null,
    algum: temWeb || temPortal,
  };
}

/**
 * Serve os arquivos compilados.
 *
 * **Registre depois das rotas de API**: o prefixo `/` do estatico capturaria
 * `/api/...` se viesse antes.
 *
 * O tratamento de 404 (que faz a rota de cliente cair no `index.html`) fica em
 * `plugins/erros.ts`, que recebe este mesmo `Estaticos`.
 */
export async function registrarEstaticos(
  app: FastifyInstance,
  onde: Estaticos,
): Promise<void> {
  if (!onde.algum) return;

  // --- Portal do paciente, em /portal ---------------------------------------
  if (onde.portal) {
    await app.register(estaticos, {
      root: onde.portal,
      prefix: '/portal/',
      decorateReply: false,
      // Arquivos com hash no nome podem ser cacheados para sempre; o
      // `index.html` nao, senao uma atualizacao nunca chegaria ao navegador.
      maxAge: '1y',
      immutable: true,
      setHeaders(res, caminho) {
        if (caminho.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
          // O portal mostra dado de saude por link magico. Nenhum buscador
          // deve indexa-lo, e nenhuma copia em cache deve sobreviver ao link.
          res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
        }
      },
    });
  }

  // --- Aplicacao profissional, na raiz --------------------------------------
  if (onde.web) {
    await app.register(estaticos, {
      root: onde.web,
      prefix: '/',
      decorateReply: false,
      maxAge: '1y',
      immutable: true,
      setHeaders(res, caminho) {
        if (caminho.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
  }
}
