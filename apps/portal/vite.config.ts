import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Configuração do Vite para o portal do paciente.
 *
 * ## Por que `base: '/portal/'`
 *
 * Em produção a própria API serve os dois frontends: a aplicação profissional
 * na raiz e o portal em `/portal/`. Sem esta `base`, os assets do portal
 * sairiam como `/assets/index-xxx.js` — o mesmo caminho dos assets da aplicação
 * profissional. Os dois se sobreporiam e o portal carregaria o bundle errado.
 *
 * ## Por que os alias usam expressão regular
 *
 * O alias em objeto casa por prefixo, e `'@cinesis/ui'` engoliria
 * `'@cinesis/ui/estilos.css'`, produzindo um caminho inexistente. A forma de
 * array aceita regex, então a correspondência é exata.
 */

/**
 * Faz o dev server aceitar o link mágico curto.
 *
 * O link enviado ao paciente é `https://<host>/entrar/<token>` — curto, para
 * caber bem numa mensagem de WhatsApp. Em produção a API resolve isso: ela
 * serve o `index.html` do portal para qualquer caminho `/entrar/`.
 *
 * O dev server do Vite não sabe disso: com `base: '/portal/'`, ele responde
 * "did you mean /portal/entrar/…?" e o link quebra em desenvolvimento.
 *
 * Este plugin reescreve o caminho antes do Vite ver. O resultado é que o mesmo
 * link funciona em dev e em produção, sem o desenvolvedor precisar decorar dois
 * formatos — e sem encompridar a URL que o paciente recebe.
 */
function linkMagicoEmDesenvolvimento(): Plugin {
  return {
    name: 'cinesis-link-magico-dev',
    // `apply: 'serve'` limita ao dev server: em produção quem roteia é a API.
    apply: 'serve',
    configureServer(servidor) {
      servidor.middlewares.use((req, _res, proximo) => {
        if (req.url?.startsWith('/entrar/')) {
          req.url = `/portal${req.url}`;
        }
        proximo();
      });
    },
  };
}

export default defineConfig({
  base: '/portal/',

  plugins: [react(), linkMagicoEmDesenvolvimento()],

  resolve: {
    alias: [
      {
        // Precisa vir antes do alias do pacote e ser exato.
        find: /^@cinesis\/ui\/estilos\.css$/,
        replacement: fileURLToPath(
          new URL('../../packages/ui/src/estilos/tokens.css', import.meta.url),
        ),
      },
      {
        find: /^@cinesis\/ui$/,
        replacement: fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
      },
      {
        find: /^@cinesis\/shared$/,
        replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
    ],
  },

  server: {
    port: 5174,
    // O navegador chama `/api/...` na mesma origem e o Vite repassa para a API.
    // Assim o cookie de sessão (SameSite=Strict) funciona em desenvolvimento
    // exatamente como funcionará em produção atrás de um proxy reverso.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3333', changeOrigin: true },
    },
  },

  build: {
    // Mapas de origem em produção ajudam a depurar um erro relatado pelo
    // usuário. Não expõem nada que o bundle já não exponha.
    sourcemap: true,
  },
});
