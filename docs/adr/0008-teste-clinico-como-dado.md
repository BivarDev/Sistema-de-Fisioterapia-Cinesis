# ADR 0008 — Teste funcional como dado, não como código

**Status:** aceita · **Data:** 2026-09-07

## Contexto

O sistema aplica escalas clínicas (EVA, Oswestry, TUG, Schober, DASH,
goniometria) que têm campos, fórmula de cálculo e faixas de interpretação
próprias.

A implementação intuitiva seria uma função por escala e um `switch` no meio.

## Decisão

`ClinicalAssessmentDefinition` é uma linha no banco. Campos, fórmula e faixas de
interpretação são `jsonb`, interpretados em tempo de execução por um motor em
`packages/domain/src/avaliacao.ts`.

## Motivos

- **Incorporar uma escala nova precisa ser configuração, não deploy.** Um
  `switch` significa que usar o WOMAC exige programador, build e implantação —
  para uma coisa que é, na essência, uma planilha.
- **Procedência auditável.** Cada aplicação guarda a versão da definição usada.
  Dois anos depois dá para saber com qual regra aquele escore foi produzido.
- **Fonte e licença por escala.** Aparecem impressas na tela: o fisioterapeuta
  sabe de onde veio o número que vai assinar, e o operador sabe se pode
  redistribuir aquele instrumento.

A especificação lista isto como uma das três armadilhas conhecidas.

## Consequências

- A fórmula é declarativa e cobre cinco formatos (`direto`, `soma`,
  `soma_ponderada`, `media`, `percentual_do_max`). Uma escala com cálculo
  genuinamente exótico exigiria estender o motor — mas o `enum` no código
  exigiria estender o código para **toda** escala.
- O escore é **calculado no servidor**, a partir dos valores brutos. Aceitar o
  escore vindo do cliente seria deixá-lo escrever o resultado clínico que
  quisesse — e o número sai num PDF assinado com CREFITO.
- `maiorEhPior` é campo da definição, e é o que impede o sistema de pintar de
  verde uma piora numa escala invertida como a Oswestry. Há teste dedicado a
  isso: é o tipo de bug que passa despercebido numa demonstração e é grave na
  clínica.
