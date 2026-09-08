import { defineConfig } from 'vitest/config';

// Testes do pacote de seguranca rodam em Node puro (usam node:crypto).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
