# ADR 0004 — Sessão opaca revogável, não JWT

**Status:** aceita · **Data:** 2026-09-07

## Contexto

Autenticação de profissionais e de pacientes num sistema que trata dado de saúde.

## Decisão

Token opaco aleatório de 256 bits em cookie `HttpOnly`, com estado no servidor
(Redis em produção, memória em desenvolvimento). O servidor guarda o **HMAC** do
token, nunca o token.

## Motivos

- **Revogação imediata.** "Demiti o estagiário" precisa virar "o acesso dele
  morre agora", não "morre quando o token expirar". JWT de vida longa não
  revoga; JWT curto com refresh token reintroduz estado no servidor — que é
  justamente o que o JWT prometia evitar. Então usamos estado direto, sem o
  rodeio.
- **Vazamento do armazenamento não entrega sessão.** Guardar o HMAC significa
  que um dump do Redis é uma lista de hashes: sem a subchave, não há como
  produzir o token que gera aquele hash.
- **Timeout duplo.** Inatividade (30 min) e absoluto (12 h). JWT tem uma
  expiração só; apenas o absoluto limita a janela de uma sessão roubada de quem
  fica o dia inteiro no sistema.

## Consequências

- Toda requisição autenticada faz uma leitura no armazenamento de sessão. É uma
  leitura em memória; irrelevante nesta escala.
- Produção exige Redis, e a configuração recusa subir sem ele — sessão em
  memória não sobrevive a restart nem funciona com dois workers.
- A sessão é rotacionada no login e em toda mudança de privilégio, o que fecha
  fixação de sessão.
