/**
 * Executável: cria o schema do banco. `npm run db:push`.
 *
 * Idempotente — pode rodar quantas vezes quiser. Cria tabelas, gatilhos, o
 * papel de aplicação com privilégio mínimo e as políticas de Row-Level
 * Security, tudo com `IF NOT EXISTS` ou `DROP ... IF EXISTS` antes.
 *
 * A aplicação chama isto sozinha na subida, então este script existe para dois
 * casos: preparar um banco antes do primeiro deploy, e conferir o que o DDL faz
 * sem precisar subir o servidor.
 */

import { carregarConfig } from '../config.js';
import { aplicarSchema, conectar } from './conexao.js';

async function principal(): Promise<void> {
  const config = carregarConfig();
  const conexao = await conectar(config.ambiente.DATABASE_URL);

  await aplicarSchema(conexao);

  console.log(
    `Schema aplicado (${conexao.driver}). Tabelas, gatilhos de imutabilidade, ` +
      'papel de aplicação e políticas de RLS estão no lugar.',
  );

  await conexao.encerrar();
}

principal().catch((erro) => {
  console.error('Falha ao aplicar o schema:', erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
