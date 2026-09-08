import { defineConfig } from 'vitest/config';

// Testes da API sobem um PostgreSQL embutido (PGlite) por arquivo de teste,
// entao rodam mais devagar que os de dominio — mas contra o banco de verdade,
// com RLS e gatilhos ativos. Testar isolamento de tenant com mock nao prova nada.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
