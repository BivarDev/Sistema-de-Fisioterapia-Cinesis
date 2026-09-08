# ADR 0006 — Anel de chaves versionado

**Status:** aceita · **Data:** 2026-09-07

## Contexto

A especificação pede "HMAC de segredo isolado" para a pseudonimização, e não diz
o que acontece quando esse segredo precisa ser trocado.

Sem versionamento, rotacionar a chave invalidaria todos os códigos `PC-XXXX` já
emitidos e tornaria ilegível toda a PII cifrada. Na prática: ninguém rotacionaria
nunca — e uma chave que nunca é trocada é uma chave exposta para sempre depois do
primeiro vazamento.

## Decisão

As chaves-mestras vêm do ambiente como `CINESIS_KEY_V1`, `CINESIS_KEY_V2`, …
A maior versão escreve; todas leem. Todo valor derivado carrega a versão que o
produziu (`c1$2$iv$tag$ct` na cifragem, `v1:<hex>` no índice cego).

Da chave-mestra derivamos uma subchave por finalidade via HKDF: pseudonimização,
índice cego, cifragem de PII, token de portal e sessão.

## Motivos

- Rotacionar passa a ser **acrescentar** uma variável, não migrar tudo de uma
  vez. Enquanto a reescrita não termina, a leitura continua funcionando.
- Subchave por finalidade: comprometer um uso não compromete os outros. Uma
  subchave de pseudonimização vazada não decifra PII.
- A busca gera o índice cego de **todas** as versões do anel
  (`WHERE indice = ANY(...)`), então continua funcionando durante a rotação.

## Consequências

- Descartar uma chave antiga cedo demais torna ilegível o dado que ainda a usa.
  O anel lança um erro explícito nesse caso, citando qual variável restaurar.
- A aplicação **falha na inicialização** se não houver chave em produção. Gerar
  uma chave aleatória em runtime seria pior: ela sumiria no restart e levaria
  toda a PII cifrada junto.
- Em desenvolvimento sem `.env`, o sistema sobe com uma chave efêmera e avisa em
  voz alta no log. É o que permite ver a tela em trinta segundos sem configurar
  nada — e o aviso é o que impede alguém de achar que isso serve em produção.

## Como rotacionar

```bash
# 1. Gere a chave nova.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 2. Acrescente ao .env, MANTENDO a anterior.
CINESIS_KEY_V1=<a que já existia>
CINESIS_KEY_V2=<a nova>

# 3. Reinicie. A partir daqui, escreve com a V2 e lê as duas.
# 4. Rode a reescrita em segundo plano (a fazer: job de recifragem).
# 5. Só remova a V1 quando `precisaRecifrar` não achar mais nada.
```
