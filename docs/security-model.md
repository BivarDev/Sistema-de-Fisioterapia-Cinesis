# Modelo de segurança do Cinesis

> Documento vivo. Unifica segurança e *threat model* — a especificação v1.1 pede
> três documentos essenciais em vez de onze, e este é um deles.
>
> **Atualize este arquivo junto com o código.** Um modelo de segurança que
> descreve um sistema que não existe mais é pior que nenhum: ele produz confiança
> sem lastro.

---

## 0. O que estamos protegendo, e de quem

O ativo é **prontuário fisioterapêutico** — dado pessoal sensível pela LGPD
(Art. 5º, II e Art. 11). O comprometimento não é uma inconveniência
operacional: é a exposição do histórico de saúde de pessoas que não escolheram
correr esse risco.

Os adversários considerados, do mais provável ao menos:

| Adversário | Cenário realista | Defesa principal |
|---|---|---|
| **Credencial reutilizada** | O fisioterapeuta usa a mesma senha de um site que vazou | Argon2id, política de senha, backoff, MFA opcional |
| **Curiosidade interna** | Recepção ou estagiário abrindo prontuário sem motivo | RBAC por escopo na query, auditoria de leitura |
| **Vizinho de tenant** | Outra clínica na mesma instalação | Filtro na query + RLS no PostgreSQL |
| **Dump de banco** | Backup vazado, snapshot de disco, VPS comprometido | PII cifrada, pseudonimização por HMAC, chave fora do banco |
| **Varredura automatizada** | Enumeração de ids, força bruta de token | 404 em vez de 403, ids UUID v7, rate limit |
| **Administrador de banco** | Alguém apagando o rastro de um acesso indevido | Auditoria append-only + cadeia de hash + âncora externa |
| **XSS em dependência** | Pacote comprometido na árvore do frontend | CSP, cookie `HttpOnly`, CSRF em header |

Quem instala e opera o Cinesis é o **controlador e o operador** dos dados dos
próprios pacientes. Este documento descreve o que o software faz; a
infraestrutura, o backup e a resposta a incidente são responsabilidade de quem
hospeda.

---

## 1. As oito camadas

### 1.1 PII isolada e cifrada em repouso

`paciente_identificacao` (nome, nascimento, CPF, telefone, e-mail) é uma tabela
separada de `pacientes` (código pseudonimizado, idade, responsável). As duas
**nunca fazem junção por padrão**.

A especificação v1.1 pedia a separação. Acrescentamos a **cifragem**: separar
tabela resolve acesso indevido pela aplicação, e não resolve dump de banco —
nesse cenário a tabela de PII estaria lá, em claro, com o nome de todo paciente.

- **AES-256-GCM** (cifra autenticada: detecta adulteração, não só decifra).
- **AAD amarrado ao paciente** (`paciente:<id>`). Sem isso, quem tivesse escrita
  no banco poderia mover o nome cifrado de um paciente para a linha de outro, e
  o GCM aceitaria — o ciphertext é válido, só está no lugar errado.
- **Índice cego** para busca: `HMAC(subchave, valor normalizado)`. Determinístico
  e pesquisável por igualdade, irreversível sem a chave, inútil fora desta
  instalação. Não permite busca parcial, e isso é proposital: busca por prefixo
  sobre dado cifrado exige esquemas que vazam ordem ou frequência.

Código: `packages/security/src/cifragem.ts`.

### 1.2 RBAC por escopo aplicado na query

O filtro de organização (e o de escopo supervisionado, para estagiário) entra na
cláusula `WHERE`. Nunca num `if` depois do `SELECT`.

```ts
// ERRADO — o dado alheio já passou pela memória do processo.
const p = await db.select().from(pacientes).where(eq(pacientes.id, id));
if (p.organizacaoId !== ator.organizacaoId) throw new NaoEncontrado();

// CERTO — o dado de outra organização nunca é lido.
const p = await db.select().from(pacientes)
  .where(and(eq(pacientes.id, id), eq(pacientes.organizacaoId, escopo.organizacaoId)));
```

A versão errada funciona igual nos testes felizes e falha em três lugares: o
dado alheio aparece em dump de memória, em log de query e em APM; o `if` é fácil
de esquecer numa rota nova; e a diferença de tempo entre "não existe" e "existe
mas é de outro" vaza a existência.

Código: `packages/security/src/escopo.ts`, e toda função de repositório.

### 1.3 Fora de escopo responde 404, não 403

Um 403 confirma que o recurso existe. Essa confirmação é o que permite mapear a
base de outra organização por tentativa e erro.

`NaoEncontrado` é lançado tanto para "não existe" quanto para "existe, mas não é
seu". O cliente não distingue os dois casos — a trilha de auditoria, sim
(`ACESSO_FORA_DE_ESCOPO`).

### 1.4 Pseudonimização com HMAC de segredo isolado

O código `PC-4821` é `HMAC(subchave_pseudonimizacao, "paciente:<uuid>")`,
mapeado num alfabeto sem caracteres ambíguos (`I`, `O`, `0`, `1` estão fora,
porque o código é ditado por telefone na clínica).

Por que HMAC e não hash simples: `sha256(uuid)` seria reversível por qualquer um
com a lista de UUIDs — que está no próprio dump.

**Reidentificação é operação governada.** Quatro barreiras, todas obrigatórias:

1. Papel com `paciente:reidentificar` (só fisioterapeuta).
2. Motivo escrito, mínimo de 10 caracteres.
3. Rate limit de 40/h por profissional.
4. `REIDENTIFICACAO_AUTORIZADA` gravado **na mesma transação**.

A tentativa negada também é auditada — numa transação **separada**, porque a
transação que falha faz rollback e levaria a linha de auditoria junto.

### 1.5 Sessão opaca revogável

- Token de 256 bits em cookie `HttpOnly`, `Secure`, `SameSite=Strict`.
- O servidor guarda `HMAC(token)`, **nunca o token**. Vazou o Redis, ninguém
  entra: o atacante teria hashes e não conseguiria produzir o token que os gera.
- **Timeout duplo**: inatividade (30 min) e absoluto (12 h). Só o absoluto limita
  a janela de uma sessão roubada de quem fica o dia todo no sistema.
- **Rotação em mudança de privilégio** e no login — fecha fixação de sessão.
- **Vínculo com o dispositivo** pelo hash do User-Agent. Divergência encerra a
  sessão (não só recusa): se o cookie foi copiado, a sessão do dono legítimo
  também precisa morrer.
- **IP nunca em claro**, em lugar nenhum. Só o prefixo `/24` (ou `/48` em IPv6).
- Portal do paciente: 1 hora de teto, porque o dispositivo pode ser compartilhado.

### 1.6 Prontuário imutável, em três camadas

Exigência da COFFITO 415/2012. Implementada três vezes, de propósito:

| Camada | Onde | O que protege |
|---|---|---|
| Domínio | `packages/domain/src/imutabilidade.ts` | O caminho normal da aplicação |
| Escrita condicional | `UPDATE … WHERE finalizado_em IS NULL` | Corrida entre duas requisições simultâneas |
| Gatilho no PostgreSQL | `apps/api/src/db/ddl.ts` | Script, migração e `psql` |

Correção **cria uma versão nova**; a anterior permanece íntegra, assinada e
visível na linha do tempo. O selo "N registros · 0 sobrescritos" é calculado a
partir do dado real — um número diferente de zero significaria que alguém
contornou o domínio, e vale que apareça na tela.

### 1.7 Link mágico do portal

- Expira em **15 minutos**.
- **Uso único**, com consumo atômico (`UPDATE … WHERE consumido_em IS NULL`).
  Um `SELECT` seguido de `UPDATE` teria uma janela em que duas requisições
  simultâneas abririam duas sessões — exatamente o cenário de token interceptado.
- **Reemissão em vez de reuso**: emitir um link novo revoga os pendentes.
- **Rate limit de 5/h por paciente** (não por profissional: o limite protege o
  canal do paciente).
- O banco guarda o **HMAC** do token.
- O token vai no **path**, nunca na query — query string vai para access log de
  proxy por padrão. Complementado por `Referrer-Policy: no-referrer`.
- A página do portal troca o token por cookie e limpa a URL com
  `history.replaceState`: o token some do histórico e do botão "voltar".
- Recusa com **mensagem única** para expirado, consumido e inexistente.

### 1.8 Log, métrica e telemetria sem PII

Defesa dupla, porque a especificação pede lint e lint sozinho não basta:

1. **Redator no serializador do logger** (`packages/security/src/redacao.ts`).
   Funciona por **lista de permissão**: campo não classificado é redigido por
   padrão. Erra para o lado de perder informação de depuração, que é o lado
   certo de errar. Cobre também o caso que uma regra sintática nunca pegaria:
   PII entrando dentro de um objeto de erro ou de um corpo repassado.
2. **Regra de ESLint** (`eslint.config.js`). Barra `log.info({ paciente })` em
   tempo de escrita, antes de chegar à revisão.

Telemetria de terceiros: **zero**. Analytics é opt-in, agregado e anônimo.

---

## 2. Camadas acrescentadas além das oito

A especificação v1.1 descreve muito bem a segurança de dados e não menciona a
superfície HTTP nem a segurança de credencial. Estas camadas fecham essa lacuna.

### 2.1 Senha

- **Argon2id**, parâmetros no piso do OWASP (19 MiB, t=2, p=1).
- Política por **comprimento** (12+), não por composição — regra de "1 maiúscula
  e 1 símbolo" empurra o usuário para `Senha@123`.
- Recusa senha que contenha o nome, o e-mail ou o nome da clínica.
- **Tempo de resposta constante**: e-mail inexistente é conferido contra um
  hash-isca de mesmo custo. Sem isso, a diferença de tempo enumera os usuários.
- **Mensagem única** para e-mail inexistente e senha errada.
- **Backoff progressivo**, sem bloqueio permanente: 3 falhas livres, depois 1 s,
  2 s, 4 s… até 5 minutos. Bloquear a conta após N erros deixaria qualquer um
  trancar o fisioterapeuta fora do sistema no meio do expediente.
- **Re-derivação transparente** no login quando o custo do hash ficou abaixo do
  padrão atual — é assim que a base migra sem pedir troca de senha a ninguém.

### 2.2 Segundo fator (TOTP)

Opcional, recomendado para quem pode reidentificar PII. O vetor mais provável de
comprometimento não é uma falha do sistema: é reuso de senha num site que vazou,
e o segundo fator é a única defesa que continua de pé nesse cenário.

TOTP e não SMS: SMS é vulnerável a SIM swap, depende de operadora e custa por
mensagem — relevante para um autônomo num VPS de R$ 20.

O segredo só é gravado **depois** de o usuário provar, com um código válido, que
conseguiu cadastrá-lo. Ativar antes trancaria fora da conta quem errasse o
cadastro. Códigos de recuperação são de uso único e guardados como hash.

### 2.3 CSRF

Cookie é enviado automaticamente pelo navegador em requisição vinda de outro
site. Sem proteção, um formulário hospedado em qualquer lugar, aberto por um
fisioterapeuta logado, cria registro clínico com a sessão dele.

Três camadas: `SameSite=Strict`, token em header ligado à sessão
(double submit), e checagem de `Origin`. A verificação roda num hook **global**
— uma rota nova nasce protegida sem o autor precisar lembrar.

O token CSRF vai no **corpo** da resposta de login, nunca em cookie: em cookie,
o navegador o enviaria junto com o de sessão e o double-submit deixaria de
proteger contra coisa nenhuma. No cliente ele vive **em memória**, não em
`localStorage`, que é legível por qualquer script da página.

### 2.4 Cabeçalhos HTTP

CSP com `default-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`,
`form-action 'none'`. HSTS em produção. `Referrer-Policy: no-referrer` —
é o que protege o token do link mágico. `X-Content-Type-Options: nosniff`.
Sem `X-Powered-By`.

CORS com **lista fechada** de origens. `origin: true` com `credentials: true`
seria equivalente a liberar qualquer site a chamar a API com o cookie da vítima.

### 2.5 Rate limit

A especificação pedia só no link mágico. Acrescentados: login (por rede e por
conta), consumo de link, reidentificação, exportação de PDF, upload, registro no
portal, e um teto geral por rede.

Por rede `/24`, não por IP exato: atacante com botnet troca de IP dentro da mesma
rede, e o requisito "IP nunca em claro" já pedia o prefixo.

### 2.6 Integridade da auditoria

`hash(n) = SHA-256(hash(n-1) ‖ conteúdo canônico do evento n)`.

Alterar ou remover o evento *n* quebra o hash de *n+1* e de todos os seguintes.

A verificação é exposta em `GET /api/auditoria/integridade` e na tela de
Segurança — recalculada na hora, não um selo estático.

**Limite honesto, e importante:** quem tem acesso total ao banco pode reescrever
a cadeia inteira, e o hash final continuará consistente consigo mesmo. A defesa
é publicar a **âncora** (sequência + hash da ponta) fora do banco: e-mail diário
ao responsável, armazenamento imutável, ou um repositório separado. O sistema dá
a primitiva e mostra a âncora na tela; a política de publicação é do operador.

Além da cadeia, duas camadas de banco: `REVOKE UPDATE, DELETE` para o papel da
aplicação, e um gatilho `BEFORE UPDATE OR DELETE` que lança exceção sem condição
nenhuma. Ambas testadas em `apps/api/test/api.test.ts`.

### 2.7 Row-Level Security

Rede de segurança para o caso de uma consulta esquecer o filtro de tenant. As
requisições rodam sob o papel `cinesis_app`, que **não é dono** das tabelas — a
RLS é ignorada para superusuário e, sem `FORCE`, para o dono.

`current_setting('app.organizacao_id', true)` devolve `NULL` quando não foi
definida, e a política nega tudo nesse caso: **falha fechada**. Uma consulta que
esqueceu de fixar o tenant devolve zero linhas, não o banco inteiro.

`SET LOCAL` (não `SET`) é o que amarra o valor à transação. Sem `LOCAL`, ele
ficaria na conexão do pool e a requisição seguinte, de outra clínica, herdaria o
tenant errado. Há uma regra de ESLint que barra `SET` sem `LOCAL`.

### 2.8 Rotação de chave

A especificação pedia "HMAC de segredo isolado" e não dizia o que acontece
quando esse segredo precisa ser trocado. Sem versionamento, rotacionar
invalidaria todo código pseudonimizado emitido e tornaria ilegível toda a PII —
ou seja, na prática ninguém rotacionaria nunca.

Cada valor derivado carrega a versão da chave (`c1$2$…`, `v1:<hex>`). A chave
atual escreve; as antigas continuam disponíveis para leitura. Rotacionar é
**acrescentar** `CINESIS_KEY_V2` e manter a `V1`.

Da chave-mestra derivamos uma subchave por finalidade via HKDF: comprometer um
uso não compromete os outros.

### 2.9 Upload de mídia

Confiar no `Content-Type` ou na extensão é confiar em texto que o atacante
escolhe. O tipo real vem da **assinatura binária**.

- Lista de permissão fechada. **SVG está fora**: é XML e pode carregar
  `<script>`, o que faz de um "upload de imagem" um XSS armazenado servido do
  nosso próprio domínio.
- O nome do arquivo é **descartado**, não sanitizado. Sanitizar nome é um jogo
  de gato e rato (`..`, ADS do NTFS, homóglifo unicode); não usar o nome do
  cliente encerra o jogo.
- **EXIF removido** de JPEG. Foto de celular carrega coordenada GPS — num
  atendimento domiciliar, isso é o endereço do paciente. A miniatura embutida
  também é removida: ela sobrevive ao recorte da imagem principal.
- Servido só por rota autenticada, com `Content-Disposition: attachment`,
  `nosniff` e CSP `sandbox`. Nunca de diretório estático.
- Acesso gravado como `MIDIA_ACESSADA`.

Pendência declarada: vídeo não tem EXIF removido — exigiria remultiplexação com
ffmpeg.

### 2.10 Identificadores

UUID v7. Não `serial` (id sequencial convida enumeração e o maior id vaza o
tamanho da base), não v4 (aleatório fragmenta o índice B-tree). O v7 revela o
instante de criação — aceitável, já que a data está na coluna ao lado.

### 2.11 Configuração que falha na subida

`apps/api/src/config.ts` valida tudo e **derruba o processo** antes da primeira
requisição. Em produção, recusa: chave ausente ou igual à do `.env.example`,
`DATABASE_URL` ou `REDIS_URL` faltando, origem com `*`, origem não-https,
`NODE_TLS_REJECT_UNAUTHORIZED=0`, e `LOG_NIVEL` debug/trace.

O padrão contrário (`process.env.X ?? 'padrao'` espalhado) produz o pior cenário:
o sistema sobe, atende, e só se descobre semanas depois que estava cifrando
prontuário com a chave de exemplo.

---

## 3. Checklist de *threat modeling*

Cada item da especificação, com a resposta e onde ela está.

| Ameaça | Resposta | Onde |
|---|---|---|
| Acesso entre tenants | Filtro na query + RLS + 404 | `escopo.ts`, `ddl.ts` |
| IDOR / BOLA | UUID v7 + escopo na query + 404 | `ids.ts`, repositórios |
| Vazamento por log | Redação por lista de permissão + lint | `redacao.ts`, `eslint.config.js` |
| Vazamento por PDF | Rate limit + `EXPORTACAO_PDF` auditado | `limites.ts` |
| Abuso do link mágico | 15 min, uso único atômico, 5/h, HMAC, path | `tokens.ts`, `adesao.ts` |
| Sessão roubada | Timeout duplo, vínculo de agente, revogação | `sessao.ts` |
| Upload malicioso | Assinatura binária, sem SVG, sem nome do cliente | `upload.ts` |
| Acesso a mídia clínica | Rota autenticada, `attachment`, auditado | `upload.ts` |
| Permissão excessiva | Matriz exaustiva; TypeScript exige preencher | `papeis.ts` |
| Manipulação de registro | Domínio + escrita condicional + gatilho | `imutabilidade.ts`, `ddl.ts` |
| Exclusão de histórico | `REVOKE DELETE` + gatilho + cadeia de hash | `ddl.ts`, `auditoria.ts` |
| Exposição de backup | PII cifrada; chave fora do banco | `cifragem.ts` |
| Segredo mal armazenado | Anel do ambiente; falha na subida se faltar | `chaves.ts`, `config.ts` |
| Força bruta de senha | Argon2id + backoff + rate limit duplo | `senhas.ts`, `limites.ts` |
| Enumeração de conta | Hash-isca + mensagem única | `autenticacao.ts` |
| CSRF | SameSite + token em header + Origin | `csrf.ts` |
| XSS | CSP, cookie `HttpOnly`, CSRF em memória | `seguranca.ts` |
| Clickjacking | `frame-ancestors 'none'` | `seguranca.ts` |
| Adulteração da auditoria | Privilégio + gatilho + cadeia + âncora | `ddl.ts`, `auditoria.ts` |
| DoS por corpo grande | Teto de 1 MiB, timeout, paginação limitada | `seguranca.ts`, `validacao.ts` |
| Mass assignment | `.strict()` em todo schema Zod | `validacao.ts` |

---

## 4. O que **não** está resolvido

Declarado por honestidade. Um modelo de segurança que só lista vitórias é
propaganda.

1. **Prazo de guarda do prontuário.** A COFFITO 415/2012 exige retenção; o prazo
   exato precisa ser confirmado no texto oficial antes de virar política no
   sistema. Está marcado como pendência na tela de Configurações. Escolher um
   número plausível e exibi-lo como certo seria pior.
2. **EXIF de vídeo.** Só imagem é limpa.
3. **Antivírus no upload.** Há um ponto de extensão, sem integração.
4. **Rate limit em vários processos.** O limitador em memória é por processo. Em
   produção com mais de um worker, use a implementação em Redis.
5. **Publicação automática da âncora de auditoria.** O sistema gera e exibe; o
   envio para fora do banco é do operador.
6. **Verificação de licença da biblioteca.** O campo é declarado pelo autor e
   bloqueia a publicação; a veracidade continua sendo verificação humana.
7. **Notificação de incidente à ANPD.** O sistema dá a trilha; o processo de
   resposta é do operador.
8. **Direitos do titular (LGPD Art. 18).** As ações estão no catálogo de
   auditoria (`EXPORTACAO_LGPD`, `ANONIMIZACAO_LGPD`); os endpoints ficam para a
   Fase D. A eliminação esbarra na retenção obrigatória do prontuário — que é
   hipótese legal de conservação (Art. 16, I) e precisa ser tratada como
   anonimização parcial, não exclusão.

---

## 5. Critérios de aceitação verificados

Os quatro critérios em Gherkin da especificação, e onde cada um é testado.

```gherkin
Prontuário imutável
  Dado um prontuário finalizado
  Quando um usuário tentar editar o registro
  Então o registro original permanece intacto
  E uma nova versão é criada quando a alteração é permitida
  E o responsável e o timestamp são registrados
  E o evento aparece na auditoria
```
→ `apps/api/test/api.test.ts` › *CRITÉRIO: registro finalizado não é alterado,
nem pelo banco* · `packages/domain/test/dominio.test.ts` › *Prontuário imutável*

```gherkin
Isolamento de tenant
  Dado um usuário da Organização A
  Quando ele consultar um identificador da Organização B
  Então nenhum dado da Organização B é retornado
```
→ `api.test.ts` › *CRITÉRIO: usuário da org A não obtém dado da org B* e
*a RLS bloqueia mesmo uma consulta que esqueça o filtro de tenant*

```gherkin
Adesão
  Dado um exercício prescrito para a semana
  Quando o paciente registra a execução
  Então o evento é associado à prescrição correta
  E o indicador de adesão é atualizado
  E o fisioterapeuta consegue visualizar o resultado
```
→ `dominio.test.ts` › *CRITÉRIO: registro do paciente atualiza o indicador*

```gherkin
Portal
  Dado um paciente com prescrição ativa
  Quando acessa o portal
  Então vê apenas dados do seu próprio contexto
  E não tem acesso a prontuário de outros pacientes
```
→ `api.test.ts` › *CRITÉRIO: o paciente vê apenas o próprio contexto* e
*a sessão do portal não vale na API profissional*

---

## 6. Prioridade de cobertura de teste

Conforme a especificação (seção 8.3), a cobertura é dirigida por risco, não por
percentual: autorização · isolamento entre tenants · imutabilidade e
versionamento · auditoria · consentimento · cálculos clínicos · adesão ·
autenticação do portal · upload e acesso a mídia · fluxos críticos.

**224 testes** hoje: 100 na fundação de segurança, 75 no domínio clínico, 49 de
integração contra um PostgreSQL real com RLS e gatilhos ativos.

Testar isolamento de tenant com mock é testar o mock — por isso os testes de
integração sobem PGlite (o próprio PostgreSQL 17 em WebAssembly) em vez de
simular o banco.
