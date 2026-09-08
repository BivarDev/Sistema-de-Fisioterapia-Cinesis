# ADR 0010 — Drizzle, não um ORM com mais abstração

**Status:** aceita · **Data:** 2026-09-07

## Contexto

O requisito central de autorização é: *"RBAC por escopo aplicado na query, nunca
em checagem posterior"*.

## Decisão

Drizzle ORM. SQL explícito, com tipos.

## Motivos

- **A cláusula WHERE precisa estar visível no código.** Um ORM que monta a
  consulta por trás de um `findMany({ include })` esconde exatamente a parte que
  precisa estar às claras — e a revisão de código não consegue verificar o que
  não vê.
- **Gatilho, RLS e `REVOKE` continuam sendo SQL.** Com um ORM que gera migração
  automaticamente, essas garantias ficariam num arquivo à parte, fora do fluxo
  normal de mudança de schema. Aqui o DDL escrito à mão é a documentação real do
  armazenamento.
- **Agregação sem N+1.** As telas pedem agregados (adesão média, tendência por
  plano, delta por teste); expressá-los em SQL é direto.

Alternativa considerada: Prisma. Descartada por dois motivos — a versão marcada
como estável no momento da decisão era um *release candidate*, e a camada de
abstração vai na direção oposta ao requisito acima.

## Consequências

- Mais SQL visível no código. É o objetivo, não o efeito colateral.
- `Banco` é um tipo só (`NodePgDatabase`), com conversão na fronteira para o
  PGlite. A união dos dois tipos de driver colapsa a assinatura de métodos
  sobrecarregados como `.returning()`, e o TypeScript passa a exigir zero
  argumentos.
- `isNull(coluna)` e não `eq(coluna, null)`: em SQL, `coluna = NULL` nunca é
  verdadeiro. Escrito aqui porque esse erro aconteceu durante o
  desenvolvimento — a escrita condicional que garante "não selar duas vezes"
  jamais casaria linha nenhuma.
