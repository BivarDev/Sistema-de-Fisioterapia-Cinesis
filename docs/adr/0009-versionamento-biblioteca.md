# ADR 0009 — Versionamento da biblioteca de exercícios

**Status:** aceita · **Data:** 2026-09-07

## Contexto

A especificação registra como pergunta em aberto: *"como versionar mudança sem
invalidar prescrição ativa"*.

Um fisioterapeuta prescreve "Ponte glútea" com a orientação vigente. Três
semanas depois alguém edita o texto do exercício. O que o paciente vê?

## Decisão

A prescrição guarda a **versão** do exercício que usou
(`prescricao_itens.exercicio_versao`). Editar um exercício publicado cria a
versão seguinte, que recomeça o fluxo `draft → in_review → published`. A versão
anterior permanece legível para quem já a recebeu.

## Motivos

- Mudar o texto retroativamente seria, na prática, **alterar uma conduta clínica
  já prescrita** — sem o profissional saber e sem deixar rastro.
- O fluxo de revisão precisa recomeçar: a revisão anterior aprovou o texto
  anterior, não o novo.

## Consequências

- O catálogo acumula versões. Aceitável: são dezenas de itens, não milhares.
- Publicar exige **licença declarada** e **revisor diferente do autor**. Sem
  licença, o item existe como rascunho e nunca é publicado — a biblioteca é
  conteúdo redistribuído por um projeto de código aberto, e item sem licença
  conhecida é passivo para todo mundo que instalar.
- A regra é aplicada no **servidor**, item a item, na criação da prescrição.
  Filtrar apenas na listagem do passo 1 deixaria passar quem enviasse o id de um
  rascunho direto na requisição — que é o ataque óbvio contra validação só de
  interface. Há teste dedicado a esse caso.

## O que continua em aberto

Das quatro perguntas da especificação sobre a biblioteca, esta ADR responde
uma. As outras três estão na tela de Biblioteca, declaradas como pendências:
quem pode publicar quando houver contribuição externa, onde a mídia é armazenada
em instalação com múltiplos nós, e como a veracidade da licença é verificada.
