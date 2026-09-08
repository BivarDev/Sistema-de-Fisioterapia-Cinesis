# Modelo de domínio do Cinesis

> Documento vivo. Corresponde às seções 4 e 6 da especificação v1.1.

---

## 1. A tese, e o que ela implica no modelo

> Transformar o tratamento fisioterapêutico numa linha do tempo mensurável,
> conectando avaliação, sessões, evolução, exercício domiciliar e adesão.

```
AVALIAÇÃO → PLANO DE TRATAMENTO → SESSÕES → EVOLUÇÃO → EXERCÍCIO DOMICILIAR
→ ADESÃO DO PACIENTE → NOVOS DADOS → REAVALIAÇÃO → COMPARAÇÃO LONGITUDINAL
→ AJUSTE DO TRATAMENTO
```

Toda decisão de escopo é testada contra esse ciclo. Funcionalidade
administrativa que não o reforça é candidata a fase posterior.

---

## 2. O agregado principal é o episódio, não a pessoa

```
Organização (tenant)
  └── Profissional
        └── Paciente
              └── PlanoTratamento          ← agregado clínico principal
                    ├── Avaliação inicial
                    ├── Evoluções (por sessão)
                    ├── Reavaliações
                    ├── Prescrições HEP
                    │     └── Registros de adesão
                    └── Histórico de versões
```

Ver `docs/adr/0007-plano-como-agregado-principal.md` para o porquê.

---

## 3. Entidades

### Platform

| Entidade | Campos-chave | Observação |
|---|---|---|
| `Organizacao` | nome, tipo, `tcle_versao` | Tenant raiz. A versão do TCLE vive aqui: publicar um termo novo invalida os aceites anteriores em todo o sistema de uma vez. |
| `Profissional` | nome, e-mail, `senha_hash`, CREFITO, papel, `supervisor_id`, MFA | E-mail é único **por organização**, não globalmente: a mesma pessoa pode trabalhar em duas clínicas na mesma instalação. |
| `AuditoriaEvento` | sequência, ator, ação, entidade, `hash_anterior`, `hash` | Append-only. A sequência é única por organização — é isso que impede inserir um evento "no meio" da cadeia. |

### Clinical Core

| Entidade | Campos-chave | Observação |
|---|---|---|
| `PacienteIdentificacao` | nome, nascimento, CPF, telefone — **cifrados** + índices cegos | Tabela isolada. Nunca entra em junção por padrão. |
| `PacienteClinico` (`pacientes`) | código pseudonimizado, idade, responsável | Sem nada identificante. Um dump desta tabela é uma lista de `PC-4821`. |
| `Consentimento` | tipo, versão, `aceito_em`, `revogado_em` | Revogado não é apagado: a prova de licitude do período precisa ficar. |
| `PlanoTratamento` | título, diagnóstico, objetivo, status, fase, sessões previstas, `reavaliacao_em` | O agregado principal. |
| `Registro` | tipo, código, EVA, conduta, resposta, `finalizado_em`, versão, `substitui_id`, `motivo_versao` | Uma tabela para avaliação, evolução e reavaliação: mesmo ciclo de vida, mesmas colunas de assinatura. |
| `DefinicaoTeste` | chave, versão, unidade, fonte, licença, `maior_eh_pior`, campos, fórmula, interpretações | **Dado, não código.** Ver ADR 0008. |
| `AplicacaoTeste` | definição + versão, valores brutos, escore, interpretação | O escore é recalculável a partir dos valores brutos. |

### Adherence

| Entidade | Campos-chave | Observação |
|---|---|---|
| `Exercicio` | nome, orientação, status, versão, autor, revisor, licença | `licenca IS NULL` bloqueia a publicação. |
| `Prescricao` | plano, `meta_semanal`, ativa | Uma ativa por plano. Duas fariam o cálculo de adesão contar o dobro de dias esperados. |
| `PrescricaoItem` | exercício + **versão**, séries, reps, carga, frequência, progressão | A versão é congelada. Ver ADR 0009. |
| `RegistroAdesao` | item, data, status, observação | Único por `(item, data)`: reenviar corrige em vez de duplicar. |
| `TokenPortal` | `token_hash`, `expira_em`, `consumido_em`, `revogado_em` | Guarda o HMAC, nunca o token. |

### Operations

`SessaoAgenda` (com `serie_id` para recorrência e `motivo` que separa falta
justificada de no-show), `PacoteSessoes` (valor em **centavos**, nunca `float` —
arredondamento binário transforma R$ 0,10 três vezes em R$ 0,30000000000000004)
e `Midia`.

---

## 4. Invariantes

Cada uma é aplicada em mais de uma camada. As três que valem destacar:

### Sem consentimento vigente, nada clínico é criado

LGPD Art. 11. A checagem lê a versão vigente **da organização** e exige aceite
não revogado nessa versão. Cadastro administrativo segue permitido — é o que
viabiliza registrar o consentimento em si.

Resposta: `412 CONSENTIMENTO_AUSENTE`.

### Registro finalizado é imutável

COFFITO 415/2012. Três camadas: domínio, escrita condicional
(`WHERE finalizado_em IS NULL`, que vence a corrida entre requisições
simultâneas) e gatilho no PostgreSQL (que vale para script, migração e `psql`).

Correção cria a versão seguinte, com o motivo obrigatório. A anterior permanece.

### Só exercício publicado e licenciado pode ser prescrito

Aplicada item a item, no servidor, na criação da prescrição — não só no filtro
da listagem.

---

## 5. Cálculos clínicos

Todos vivem em `packages/domain` e são funções puras.

### Escore funcional composto

Não é uma escala validada, e a interface diz isso. É uma **agregação
transparente** das escalas validadas que o profissional aplicou:

1. Cada teste é normalizado para 0–100, com **100 sempre no melhor estado**
   (escalas em que maior é pior são invertidas).
2. O escore da sessão é a média dos testes normalizados daquela sessão.
3. Sessão sem teste aplicado não entra na série — não inventamos ponto.

A alternativa (criar um índice próprio e apresentá-lo como medida clínica) seria
irresponsável.

### Tendência

Regra estatística simples, com o critério público na própria tela. Sobre as
últimas 3 sessões:

- **evoluindo** — escore subiu ≥ 5 **ou** EVA caiu ≥ 2
- **estagnado** — escore variou < 3 **e** EVA variou < 1, em 3+ sessões
- **estável** — os demais casos com dados suficientes

Estagnação exige a janela cheia: dois pontos parados não são tendência.

### Adesão

Quatro decisões de definição, todas discutíveis e todas explícitas:

1. **O denominador é a frequência prescrita**, não os dias corridos. Quem faz 3
   de 3 dias prescritos tem 100%, não 43%.
2. **"Fez parcialmente" vale meio ponto**, não zero. Zerar quem fez metade
   ensina o paciente a não registrar.
3. **Dia sem registro é dia não feito.** A ausência de dado é a informação
   clínica ("o paciente parou").
4. **A unidade é o dia**, não o exercício. Um paciente com três exercícios que
   fez dois conta como um dia parcial, não como três eventos.

A sequência conta dias consecutivos com pelo menos um `fez` — parcial mantém a
taxa, mas não a sequência, senão "sequência" perde sentido.

---

## 6. Eventos de domínio

```
PatientRegistered · AssessmentCompleted · AssessmentFinalized
TreatmentPlanCreated · TreatmentPlanChanged · TreatmentPlanClosed
EvolutionFinalized · EvolutionVersioned · ReassessmentCreated · ReassessmentDue
ExercisePrescribed · ExerciseCompleted · AdherenceDropped
SessionScheduled · SessionConfirmed · PatientAbsent · ConsentRecorded
```

Publish/subscribe interno ao processo. Falha de consumidor **não** derruba a
operação de domínio — a exceção é a auditoria, que é gravada de forma síncrona,
na mesma transação. Ver `docs/architecture.md` §6.

---

## 7. Fora do escopo da v1

TISS e faturamento de convênio · gateway de pagamento embutido · roteirização de
multiatendimento · gestão de turmas · marketing embutido · app nativo ·
biblioteca massiva de exercícios · IA generativa sobre dado clínico · automação
de WhatsApp além do lembrete básico.

Metade do valor da especificação está nesta lista.
