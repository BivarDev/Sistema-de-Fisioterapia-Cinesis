/**
 * Conexão com o banco: PostgreSQL de verdade ou PGlite embutido.
 *
 * ## Por que dois drivers
 *
 * O alvo de produção é PostgreSQL num Docker Compose de um comando. Mas o
 * público-alvo é fisioterapeuta autônomo, e "instale o Docker" já é uma
 * barreira. O PGlite roda o **mesmo PostgreSQL 17 compilado para WebAssembly**,
 * dentro do processo Node, sem instalar nada — mesmo dialeto SQL, mesmos
 * gatilhos, mesma RLS.
 *
 * Consequências práticas:
 * - `npm run dev` sobe sem dependência externa nenhuma.
 * - Os testes rodam contra Postgres de verdade, com RLS e gatilhos ativos.
 *   Testar isolamento de tenant com mock não prova nada.
 * - Produção usa `DATABASE_URL` e o driver nativo, sem mudar uma linha de query.
 *
 * PGlite é de processo único e não substitui Postgres em produção com mais de
 * um usuário simultâneo. A escolha é explícita e está registrada em
 * `docs/adr/0002-pglite-para-desenvolvimento.md`.
 */

import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { ddlCompleto, PAPEL_APLICACAO } from './ddl.js';

/**
 * Tipo do banco, independente do driver.
 *
 * Deliberadamente NAO e a uniao `NodePgDatabase | PgliteDatabase`. Os dois
 * tipos sao estruturalmente equivalentes para tudo que o projeto usa, mas a
 * uniao colapsa a assinatura de metodos sobrecarregados como `.returning()` —
 * o TypeScript passa a exigir zero argumentos. Como as duas implementacoes
 * expoem o mesmo dialeto (PGlite e o proprio PostgreSQL compilado para WASM),
 * adotamos um tipo so e convertemos na fronteira, em `conectar`.
 */
export type Banco = NodePgDatabase<typeof schema>;

/**
 * Caminho padrão do banco embutido, ancorado na RAIZ DO REPOSITÓRIO.
 *
 * Um caminho relativo simples (`./.data/cinesis`) depende do diretório de
 * execução — e no monorepo isso varia: `npm run db:seed` na raiz executa com
 * cwd em `apps/api`, enquanto um script rodado à mão executa na raiz. O
 * resultado seria **dois bancos diferentes** conforme o comando, com o servidor
 * lendo um e o seed escrevendo no outro, sem nenhum erro visível.
 *
 * `import.meta.url` aponta para este arquivo, então subir quatro níveis
 * (`db` → `src` → `api` → `apps`) chega sempre na mesma raiz.
 */
function caminhoPadraoPGlite(): string {
  const esteArquivo = fileURLToPath(import.meta.url);
  const raiz = resolve(dirname(esteArquivo), '..', '..', '..', '..');
  return join(raiz, '.data', 'cinesis');
}

/** O que `conectar` devolve. */
export interface Conexao {
  db: Banco;
  /** Qual driver está em uso. Aparece no log de inicialização. */
  driver: 'postgres' | 'pglite';
  /**
   * Executa SQL bruto com **vários comandos** de uma vez.
   *
   * Existe porque `db.execute()` usa o protocolo de statement preparado, que
   * aceita um comando por chamada — mandar o DDL inteiro por lá falha com
   * "cannot insert multiple commands into a prepared statement". Este atalho
   * usa o protocolo simples do driver.
   *
   * **Nunca passe entrada de usuário aqui.** É protocolo sem parâmetros: toda
   * interpolação vira SQL literal. O único uso legítimo é DDL fixo do projeto.
   */
  executarBruto: (sqlBruto: string) => Promise<void>;
  /** Encerra a conexão. Chamado no desligamento gracioso. */
  encerrar: () => Promise<void>;
}

/**
 * Abre a conexão com o banco.
 *
 * @param databaseUrl URL do PostgreSQL. Ausente ⇒ usa PGlite.
 * @param caminhoLocal Diretório do PGlite. `memory://` para teste.
 */
export async function conectar(
  databaseUrl: string | undefined,
  caminhoLocal = caminhoPadraoPGlite(),
): Promise<Conexao> {
  if (databaseUrl) {
    const pool = new Pool({
      connectionString: databaseUrl,
      // Teto de conexões: sem ele, um pico de requisições abre conexão até o
      // Postgres recusar, e o sistema inteiro cai em vez de ficar lento.
      max: 10,
      // Fecha conexão ociosa: libera recurso do servidor entre picos.
      idleTimeoutMillis: 30_000,
      // Falha rápido se o banco não responde, em vez de pendurar a requisição.
      connectionTimeoutMillis: 5_000,
    });

    return {
      db: drizzlePg(pool, { schema }),
      driver: 'postgres',
      // `pool.query` sem parâmetros usa o protocolo simples, que aceita um
      // script com vários comandos.
      executarBruto: async (sqlBruto) => {
        await pool.query(sqlBruto);
      },
      encerrar: () => pool.end(),
    };
  }

  // O PGlite nao cria o diretorio-pai sozinho. Sem isto, a primeira execucao
  // falha com ENOENT — que e a pior primeira impressao possivel para quem
  // acabou de clonar o repositorio.
  if (!caminhoLocal.startsWith('memory://')) {
    await mkdir(dirname(caminhoLocal), { recursive: true });
  }

  const cliente = new PGlite(caminhoLocal);
  await cliente.waitReady;

  return {
    // Conversao na fronteira: ver a nota em `Banco`. E o unico ponto do
    // projeto em que os dois drivers se encontram.
    db: drizzlePglite(cliente, { schema }) as unknown as Banco,
    driver: 'pglite',
    // `exec` é a API do PGlite para script com vários comandos.
    executarBruto: async (sqlBruto) => {
      await cliente.exec(sqlBruto);
    },
    encerrar: () => cliente.close(),
  };
}

/**
 * Cria tabelas e gatilhos se ainda não existirem.
 *
 * Idempotente: todo `CREATE` é `IF NOT EXISTS` e todo gatilho é
 * `DROP ... IF EXISTS` seguido de `CREATE`. Rodar duas vezes não quebra nada,
 * o que é o que permite chamar isto na subida do processo sem uma ferramenta
 * de migração separada.
 *
 * **Limite honesto:** isto cria o schema, não migra dado entre versões. Quando
 * o projeto ganhar a primeira mudança destrutiva de schema, entra `drizzle-kit`
 * com migrações versionadas. Está registrado em
 * `docs/adr/0003-schema-idempotente-antes-de-migracoes.md`.
 */
export async function aplicarSchema(conexao: Conexao): Promise<void> {
  // DDL fixo do próprio projeto, sem interpolação de entrada externa —
  // nenhum valor de usuário chega aqui. Ver o aviso em `executarBruto`.
  await conexao.executarBruto(ddlCompleto());
}

/**
 * Executa uma função dentro de uma transação com o tenant fixado.
 *
 * Este é o ponto em que a RLS ganha efeito. `SET LOCAL` amarra a variável à
 * transação: ela some no commit ou rollback. Usar `SET` (sem `LOCAL`) seria um
 * bug grave e silencioso — o valor ficaria na conexão do pool e a próxima
 * requisição, de outra clínica, herdaria o tenant errado.
 *
 * @param db            Banco.
 * @param organizacaoId Tenant da requisição.
 * @param fn            O que executar dentro do escopo.
 */
export async function comTenant<T>(
  db: Banco,
  organizacaoId: string,
  fn: (tx: Banco) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // 1. Assume o papel da aplicação. Sem isto, o usuário de conexão (dono das
    //    tabelas, frequentemente superusuário) **ignora a RLS** e o isolamento
    //    vira decoração. `LOCAL` faz o papel voltar ao original no commit.
    await tx.execute(sql.raw(`SET LOCAL ROLE ${PAPEL_APLICACAO}`));

    // 2. Fixa o tenant da transação. `set_config(..., true)` é a forma
    //    parametrizável de `SET LOCAL` — o `true` significa "local à
    //    transação". Usar `SET` sem `LOCAL` seria um bug grave e silencioso:
    //    o valor ficaria na conexão do pool e a requisição seguinte, de outra
    //    clínica, herdaria o tenant errado.
    await tx.execute(sql`SELECT set_config('app.organizacao_id', ${organizacaoId}, true)`);

    return fn(tx);
  });
}

/**
 * Executa fora do escopo de tenant, com os privilégios do usuário de conexão.
 *
 * Necessário em exatamente três lugares: aplicar o schema, semear dados e
 * autenticar (o login precisa achar o profissional **antes** de saber a qual
 * organização ele pertence). Nunca numa rota de dado clínico. Se você precisar
 * disto num handler de prontuário, o desenho está errado — o caminho é
 * `comTenant`.
 *
 * O nome é longo e desconfortável de propósito: ele deve chamar atenção na
 * revisão de código.
 */
export async function semEscopoDeTenant<T>(db: Banco, fn: (db: Banco) => Promise<T>): Promise<T> {
  return fn(db);
}
