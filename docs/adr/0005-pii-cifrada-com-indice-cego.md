# ADR 0005 — PII cifrada em repouso, com índice cego

**Status:** aceita · **Data:** 2026-09-07

## Contexto

A especificação v1.1 pede `PacienteIdentificacao` em tabela separada de
`PacienteClinico`. Isso resolve acesso indevido **pela aplicação**.

Não resolve dump de banco, backup vazado nem snapshot de disco — nesses
cenários, a tabela de PII está lá em texto claro, com o nome e o CPF de todo
paciente da clínica. Separar tabela sem cifrar é meia proteção.

## Decisão

Cifrar os campos de PII com **AES-256-GCM**, usando uma subchave derivada do
anel de chaves do ambiente e o id do paciente como AAD.

Para manter a busca por CPF e por e-mail, guardar também um **índice cego**:
`HMAC(subchave_blind_index, campo|valor_normalizado)`.

## Motivos

- GCM é cifra autenticada: detecta adulteração do ciphertext, não só decifra.
- O AAD amarra o valor ao paciente. Sem ele, quem tivesse escrita no banco
  poderia mover o nome cifrado de um paciente para a linha de outro — o
  ciphertext continuaria válido, só estaria no lugar errado, e o GCM aceitaria.
- O índice cego é determinístico (logo, pesquisável por igualdade), irreversível
  sem a chave, e inútil fora desta instalação.

## Consequências

- **Não há busca parcial** sobre PII. Busca por prefixo ou "contém" sobre dado
  cifrado exige esquemas que vazam ordem ou frequência — fora de questão aqui.
- **Perder a chave torna a PII irrecuperável.** Está dito em letras grandes no
  `.env.example` e no README: a chave precisa de backup, em lugar separado do
  backup do banco.
- A rotação de chave precisa de versionamento — ver ADR 0006.
- Limite honesto: quem tem o índice cego **e** a chave pode confirmar a presença
  de um CPF por força bruta. Sem a chave, não. Por isso a subchave de índice
  cego é derivada separadamente da de cifragem, e ambas moram fora do banco.
