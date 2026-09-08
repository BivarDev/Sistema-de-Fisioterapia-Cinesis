# ADR 0007 — PlanoTratamento como agregado principal, não Paciente

**Status:** aceita · **Data:** 2026-09-07

## Contexto

A modelagem intuitiva colocaria `Paciente` no centro: paciente tem avaliações,
tem evoluções, tem prescrições.

## Decisão

O agregado clínico principal é o `PlanoTratamento` — um **episódio de cuidado**.
Paciente é apenas a pessoa a quem os episódios pertencem.

## Motivos

- **É como a realidade clínica funciona.** Um paciente pode ter lombalgia em
  2026 e pós-operatório de LCA em 2028. São dois tratamentos, com avaliação
  inicial própria, linha do tempo própria e desfecho próprio. Pendurar tudo no
  paciente misturaria as duas séries no mesmo gráfico.
- **Evita o objeto que acumula responsabilidade.** `Paciente` com todos os
  relacionamentos vira, em pouco tempo, a entidade que tudo importa e nada
  descreve.
- **A comparação longitudinal precisa de um recorte.** "Como o paciente evoluiu"
  não tem resposta; "como este episódio evoluiu" tem.

A especificação lista essa escolha como uma das três armadilhas conhecidas:
refatorar isso depois é caro.

## Consequências

- Toda consulta clínica parte do plano, não do paciente.
- A tela de Pacientes precisa resolver "qual é o plano ativo" antes de mostrar
  situação, adesão e EVA — resolvido em lote, em `resumo-paciente.ts`, para não
  cair em N+1.
- Um paciente sem plano ativo aparece com situação `sem_plano`, não com campos
  vazios sem explicação.
