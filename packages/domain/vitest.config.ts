import { defineConfig } from 'vitest/config';

// Regras de dominio sao puras — rodam em Node, sem banco e sem rede.
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
