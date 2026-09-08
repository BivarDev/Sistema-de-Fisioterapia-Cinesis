# Arquitetura do Cinesis

> Documento vivo. Corresponde à seção 9 da especificação v1.1.

---

## 1. Forma: monólito modular

Um deploy, quatro *bounded contexts* como fronteira de **código**, não de
processo.

Os motivos são os da especificação, e continuam valendo: projeto inicial
pequeno, baixo custo operacional exigido pelo público-alvo, domínio ainda em
descoberta, forte necessidade de consistência transacional, equipe de uma
pessoa. Microsserviços só entram se surgir razão concreta — e "escalabilidade
futura" não é razão concreta enquanto a maior instalação prevista tem dez
profissionais.

Consequência prática que aparece no código: a auditoria é gravada **na mesma
transação** da operação auditada. Ou as duas acontecem, ou nenhuma. Com serviços
separados isso exigiria transação distribuída ou consistência eventual — e
"acesso a prontuário sem rastro por alguns segundos" não é um estado aceitável.

---

## 2. Mapa do repositório

```
/apps
  /api        Backend — Fastify, Drizzle, PostgreSQL
  /web        Interface profissional (fisioterapeuta, recepção, estagiário)
  /portal     Portal do paciente — app separado, contexto isolado
/packages
  /shared     Tipos, contratos, schemas de validação, matriz RBAC
  /security   Pseudonimização, cifragem, sessão, MFA, auditoria, redação
  /domain     Regras dos bounded contexts — sem I/O
  /ui         Design system: tokens, tema, modos de animação, componentes
/infra        docker-compose de um comando
/docs         Este documento, o modelo de segurança e os ADRs
/scripts      Orquestração de desenvolvimento
```

Quatro pacotes, não uma dúzia. A especificação previa três; `ui` entrou porque
web e portal compartilham tokens, tema e modo de animação — duplicar isso
garantiria que os dois divergissem na primeira mudança de cor.

---

## 3. Bounded contexts

| Contexto | Onde vive | Entidades |
|---|---|---|
| `clinical_core` | `domain/{imutabilidade,avaliacao,longitudinal}` | PlanoTratamento, Avaliacao, Evolucao, Reavaliacao, ClinicalAssessmentDefinition |
| `adherence` | `domain/{adesao,biblioteca}` | Exercicio, PrescricaoExercicio, RegistroAdesao, PortalPaciente |
| `operations` | serviços da API | SessaoAgenda, SerieRecorrencia, PacoteSessoes |
| `platform` | `security/*`, `domain/{consentimento,eventos}` | Organizacao, Identity, RBAC, Consentimento, AuditoriaEvento |

`operations` não tem módulo próprio no `domain` porque ainda não tem regra
complexa o bastante para justificar um. Criar a pasta antes de existir a regra é
o tipo de estrutura vazia que o princípio 7 da especificação manda evitar.

---

## 4. Camadas, e o que cada uma pode fazer

```
Rota (apps/api/src/rotas)
  ├─ valida a entrada com um schema de @cinesis/shared
  ├─ exige a permissão   → exigirPermissao(req, 'plano:ler')
  ├─ aplica o rate limit → aplicarLimite(...)
  └─ abre a transação    → comTenant(db, orgId, ...)
       ↓
Serviço (apps/api/src/servicos)
  ├─ consulta o banco SEMPRE com o escopo no WHERE
  ├─ chama as regras de domínio (puras)
  └─ grava a auditoria na MESMA transação
       ↓
Domínio (packages/domain)
  └─ decide. Sem I/O, sem relógio do sistema, sem variável de ambiente.
```

A regra de ouro do pacote `domain`: **nenhuma função faz I/O**. Sem banco, sem
rede, sem `new Date()` implícito (o "agora" é sempre parâmetro). É o que permite
testar a regra clínica de forma exaustiva e determinística, e o que garante que
a mesma regra valha vindo da API, de um job ou de um script.

---

## 5. Persistência

**PostgreSQL**, por três coisas que este sistema usa e que um banco mais simples
não daria: Row-Level Security (isolamento de tenant como rede de segurança),
`jsonb` (definições de teste clínico como dado, não como código) e gatilhos
(imutabilidade que sobrevive ao `psql`).

**Drizzle** e não um ORM com mais mágica: o requisito "RBAC por escopo aplicado
na query" pede que a cláusula `WHERE` seja visível e auditável no código. Um ORM
que monta a query por trás de um `findMany({ include })` esconde exatamente a
parte que precisa estar às claras.

### PGlite em desenvolvimento e em teste

O alvo de produção é PostgreSQL num Docker Compose de um comando. Mas o
público-alvo é fisioterapeuta autônomo, e "instale o Docker" já é uma barreira.

O PGlite roda o **mesmo PostgreSQL 17 compilado para WebAssembly**, dentro do
processo Node: mesmo dialeto, mesmos gatilhos, mesma RLS. `npm run dev` sobe sem
dependência externa nenhuma, e os testes de integração rodam contra um Postgres
de verdade — testar isolamento de tenant com mock não prova nada.

PGlite é de processo único e **não substitui** Postgres em produção. A
configuração recusa subir em produção sem `DATABASE_URL`.

---

## 6. Eventos de domínio

Publish/subscribe **interno ao processo**. Sem fila externa e sem event store,
como a especificação define.

```
PatientRegistered · AssessmentCompleted · EvolutionFinalized · EvolutionVersioned
TreatmentPlanCreated · ExercisePrescribed · ExerciseCompleted · SessionConfirmed
```

Uma decisão que vale destacar: **falha de consumidor não derruba a operação de
domínio**. Se a notificação falhar, a evolução clínica que o fisioterapeuta
acabou de assinar não pode ser perdida.

A exceção é a auditoria, que **não** passa pelo barramento: ela é gravada de
forma síncrona, dentro da transação. Isolar a falha ali seria aceitar acesso a
prontuário sem rastro, que é justamente o que a trilha existe para impedir.

---

## 7. Frontend

React 19 + Vite. Dois apps separados de propósito: a aplicação profissional e o
portal do paciente têm cookie próprio, sessão com timeout distinto e um tipo de
escopo incompatível — não é possível usar uma sessão de portal numa rota
profissional nem por engano de programação, porque o compilador barra.

### Design system

Tokens em `oklch`. O espaço é perceptualmente uniforme: mudar a luminosidade
muda o brilho percebido de forma previsível, sem alterar o matiz. Isso resolve
dois problemas: o tema noturno é a mesma paleta com outras luminosidades (não
uma inversão), e o contraste fica previsível o bastante para escolher pares
acessíveis sem testar um a um.

### Dois modos de animação

Requisito do produto, implementado num pivô só: a variável `--dur` vai a
`0.001ms` em `[data-motion='reduzidas']`, e toda animação e transição do sistema
para junto. `[data-reveal]` vai ao estado final; contadores nascem no valor
final; o fundo 3D **não é carregado** (import dinâmico dentro do efeito).

O padrão não é "completas": é o que o sistema operacional do usuário diz em
`prefers-reduced-motion`. Quem ligou essa preferência fez isso por um motivo,
frequentemente distúrbio vestibular — ignorá-la para mostrar uma animação bonita
é escolher a estética em cima da saúde de quem usa.

### Carregamento

O Three.js (~700 KB) é um chunk separado, baixado só quando a cena vai de fato
existir. Quem escolheu animações reduzidas não paga por ele. O bundle de entrada
fica em ~405 KB (120 KB comprimido).

---

## 8. Fluxo de uma requisição

`POST /api/evolucoes/:id/finalizar`, do socket ao commit:

1. **Rate limit geral** por rede (hook `onRequest`).
2. **Cabeçalhos de segurança** (helmet) e **CORS** com lista fechada.
3. **CSRF** (hook `preHandler` global) — método que altera estado exige o token
   em header e origem conhecida.
4. **Sessão** — cookie → `HMAC` → Redis/memória; confere timeout duplo e vínculo
   de dispositivo; monta o `Escopo`.
5. **RBAC** — `exigirPermissaoTotal(req, 'prontuario:finalizar')`. Estagiário
   recebe **404** aqui.
6. **Transação** — `SET LOCAL ROLE cinesis_app` + `set_config('app.organizacao_id', …, true)`.
7. **Serviço** — busca o registro com o escopo no `WHERE`; a regra de domínio
   decide; o `UPDATE` é condicional (`WHERE finalizado_em IS NULL`).
8. **Auditoria** — `EVOLUCAO_FINALIZADA` encadeada por hash, mesma transação.
9. **Commit.**
10. **Evento** publicado **depois** do commit — um consumidor que dispare
    notificação não pode agir sobre uma transação que ainda pode reverter.
11. **Resposta**, com o erro (se houver) traduzido pelo handler global: nada de
    stack trace, nada de mensagem do Postgres.

---

## 9. Implantação

`docker compose up` sobe API, PostgreSQL e Redis. Um comando e um `.env`.

Se subir exigir mais que isso, o projeto falhou no próprio objetivo: o
público-alvo não tem equipe de infraestrutura.

O que a configuração recusa em produção está em `docs/security-model.md` §2.11.

---

## 10. Decisões registradas

Ver `docs/adr/`. Um arquivo curto por decisão difícil de reverter, criado quando
a decisão é tomada — não todos de antemão.
