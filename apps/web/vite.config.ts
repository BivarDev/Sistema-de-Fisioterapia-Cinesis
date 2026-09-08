import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Configuração do Vite para a aplicação profissional.
 *
 * ## Por que os alias apontam para o código-fonte
 *
 * `@cinesis/ui` e `@cinesis/shared` resolvem para o `src` dos pacotes, não para
 * um `dist`. Isso dá hot reload atravessando o monorepo inteiro: mexer num
 * token do design system atualiza a tela na hora, sem passo de build no meio.
 *
 * ## Por que a forma de array com regex, e não um objeto
 *
 * O alias em objeto casa por **prefixo**. Com `'@cinesis/ui': '…/src/index.ts'`,
 * o import `@cinesis/ui/estilos.css` vira
 * `…/src/index.ts/estilos.css` — um caminho que não existe, e o build falha
 * com um erro que não diz nada sobre alias.
 *
 * A forma de array aceita expressão regular. Com `/^@cinesis\/ui$/` a
 * correspondência é exata, e a entrada específica do CSS convive com a do
 * pacote sem uma engolir a outra.
 */
export default defineConfig({
  plugins: [react()],
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
    port: 5173,
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
