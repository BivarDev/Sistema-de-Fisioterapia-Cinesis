# ADR 0002 — PGlite em desenvolvimento e em teste

**Status:** aceita · **Data:** 2026-09-07

## Contexto

O alvo de produção é PostgreSQL. Duas situações pediam algo mais leve:

1. **Primeiro contato.** Quem clona o repositório precisa ver a tela funcionando
   sem instalar Docker. O público-alvo do produto também é o público de quem
   pode querer contribuir.
2. **Testes de integração.** As garantias mais fortes do sistema — isolamento de
   tenant por RLS e imutabilidade por gatilho — não podem ser testadas com mock.
   Testar RLS com mock é testar o mock.

## Decisão

Usar `@electric-sql/pglite` (PostgreSQL 17 compilado para WebAssembly, rodando
dentro do processo Node) em desenvolvimento e em teste. PostgreSQL nativo em
produção, via `DATABASE_URL`.

O mesmo código de consulta serve os dois: mesmo dialeto SQL, mesmos gatilhos,
mesma RLS.

## Motivos

- `npm run dev` e `npm test` funcionam sem dependência externa nenhuma.
- Os testes exercitam RLS, gatilhos e `SET LOCAL ROLE` de verdade.
- Alternativas descartadas: SQLite (dialeto diferente, sem RLS, sem gatilho
  equivalente) e Testcontainers (exige Docker, que era justamente o atrito).

## Consequências

- PGlite é de processo único. A configuração **recusa subir em produção** sem
  `DATABASE_URL`.
- O caminho do banco embutido é ancorado na raiz do repositório, não no
  diretório de execução: um caminho relativo produziria bancos diferentes
  conforme o comando, com o servidor lendo um e o seed escrevendo em outro — sem
  erro visível. (Este bug aconteceu de verdade durante o desenvolvimento.)
- A suíte de integração leva alguns segundos a mais que uma com mock. É o preço
  de testar o que importa.
