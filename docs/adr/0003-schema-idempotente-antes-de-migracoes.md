# ADR 0003 — Schema idempotente antes de migrações versionadas

**Status:** aceita · **Data:** 2026-09-07

## Contexto

O projeto está na Fase A/B. O schema ainda muda com frequência e não existe
nenhuma instalação em produção com dado a preservar.

## Decisão

O DDL é aplicado de forma idempotente na subida do processo: `CREATE ... IF NOT
EXISTS` para tudo, `DROP ... IF EXISTS` antes de cada gatilho e política.

Sem ferramenta de migração versionada por enquanto.

## Motivos

- Uma etapa a menos no "sobe com um comando".
- O DDL escrito à mão é a documentação real do armazenamento. Gatilhos, `REVOKE`
  e políticas de RLS não aparecem no schema do Drizzle — e são justamente as
  garantias que não podem depender de a aplicação estar correta.
- Migração versionada com zero instalações em produção é cerimônia sem função.

## Consequências

- **Isto cria o schema; não migra dado entre versões.** Está dito no comentário
  da função e aqui.
- A primeira mudança destrutiva de schema, com alguém em produção, dispara a
  entrada do `drizzle-kit` com migrações versionadas. Este ADR será substituído
  quando isso acontecer.
