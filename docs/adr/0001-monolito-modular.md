# ADR 0001 — Monólito modular, não microsserviços

**Status:** aceita · **Data:** 2026-09-07

## Contexto

O sistema tem quatro *bounded contexts* bem delimitados (`clinical_core`,
`adherence`, `operations`, `platform`). A separação em serviços é tentadora
justamente porque as fronteiras já estão claras.

## Decisão

Um deploy só. A modularidade é de fronteira de código (pacotes e módulos), não
de processo.

## Motivos

- **Consistência transacional é requisito, não conveniência.** A auditoria é
  gravada na mesma transação da operação auditada. Com serviços separados isso
  exigiria transação distribuída ou consistência eventual — e "acesso a
  prontuário sem rastro por alguns segundos" não é um estado aceitável num
  sistema cuja trilha é exigência regulatória.
- **O público-alvo não tem equipe de infraestrutura.** A meta de implantação é
  `docker compose up`. Cada serviço a mais é uma coisa a mais que pode estar
  fora do ar na clínica de um autônomo.
- **O domínio ainda está em descoberta.** Fronteira de serviço é cara de mover;
  fronteira de módulo é um `git mv`.
- **Equipe de uma pessoa.** O custo operacional de microsserviços é pago em
  tempo de quem opera — que aqui é a mesma pessoa que desenvolve.

## Consequências

- Escalar significa, por ora, uma máquina maior. Aceitável: a maior instalação
  prevista tem dez profissionais.
- A disciplina de fronteira passa a depender de revisão, não do compilador. Os
  pacotes `domain` e `security` não importam nada da API, o que devolve parte
  dessa garantia.
- Se surgir necessidade concreta de escalar um contexto separadamente, os
  módulos estão desenhados para sair inteiros.
