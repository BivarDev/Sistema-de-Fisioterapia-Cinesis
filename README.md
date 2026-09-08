# Cinesis

**Sistema de gestão para fisioterapia.** Livre, de código aberto, com o núcleo
clínico completo e gratuito.

> Fisioterapia não é uma sequência de consultas isoladas. É uma linha do tempo
> mensurável.

O Cinesis conecta avaliação, sessões, evolução, exercício domiciliar e adesão do
paciente num ciclo único e comparável — inclusive a metade que acontece **fora
da clínica**, que é onde o mercado brasileiro atende pior.

---

## Subir em três comandos

```bash
npm install
npm run db:seed     # catálogo clínico + clínica de demonstração
npm run dev
```

Pronto. Sem Docker, sem PostgreSQL instalado, sem Redis.

| | |
|---|---|
| Sistema | http://localhost:5173 |
| Portal do paciente | http://localhost:5174 |
| API | http://127.0.0.1:3333 |

**Entre com** `fisio@cinesis.local` · senha `demonstracao-cinesis-2026`.

As contas `recepcao@cinesis.local` e `estagiario@cinesis.local` usam a mesma
senha. Vale entrar com elas: a recepção **não vê** prontuário e o estagiário vê
os pacientes só pelo código pseudonimizado — não porque a interface esconde, mas
porque o nome não sai do banco para esses papéis.

Em desenvolvimento o banco é o **PGlite**: o próprio PostgreSQL 17 compilado
para WebAssembly, rodando dentro do processo Node. Mesmo dialeto, mesmos
gatilhos, mesma RLS. Em produção, PostgreSQL de verdade — ver
[Implantação](#implantação).

---

## Em produção

```bash
cp .env.example .env
```

Edite o `.env`. Duas coisas são obrigatórias e a aplicação **recusa subir** sem
elas:

```bash
# 1. Gere a chave de cifragem:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 2. Defina as origens (todas https) e a URL pública do portal.
```

Depois:

```bash
docker compose -f infra/docker-compose.yml up -d
```

Sobe API, PostgreSQL e Redis. Coloque um proxy reverso com TLS à frente (Caddy,
nginx, Traefik) — a aplicação não termina TLS, e o cookie `Secure` exige HTTPS
de verdade.

> ### A chave de cifragem
>
> Ela protege a PII dos seus pacientes em repouso e deriva os códigos
> pseudonimizados. **Perdê-la torna a PII irrecuperável.**
>
> Guarde-a com o mesmo cuidado do backup do banco — e em **lugar separado dele**.
> Um backup que inclui a chave é um backup em texto claro.
>
> Para rotacionar: acrescente `CINESIS_KEY_V2` e **mantenha** a `V1`. O sistema
> passa a escrever com a nova e continua lendo o que foi escrito com a antiga.
> Ver [ADR 0006](docs/adr/0006-anel-de-chaves-versionado.md).

---

## O que o sistema faz

### Fase A — núcleo clínico ✅

Organização e papéis · paciente com PII separada e cifrada · plano de tratamento
como agregado principal · avaliação inicial · evolução por sessão · testes
funcionais validados com cálculo e interpretação automáticos · **comparação
longitudinal** · prontuário imutável com versionamento.

### Fase B — HEP e adesão ✅

Biblioteca curada com governança de publicação · prescrição pelo método FITT ·
link mágico para o celular do paciente, sem instalar aplicativo · registro de
execução · painel de adesão por paciente e por exercício.

### Fases C, D e E

Agenda recorrente com lembretes · portal completo e pacotes de sessão · IA
determinística (resumo por template e sinalização de estagnação por regra
estatística — explicitamente **não** IA generativa sobre dado clínico).

---

## O que torna este sistema diferente

### A comparação longitudinal

Barras de escore funcional com a linha de dor sobreposta em eixo invertido. A
barra subindo enquanto a linha desce é o tratamento inteiro numa imagem.

O escore composto **não** é uma escala inventada: é a média das escalas
validadas que o profissional aplicou, normalizadas para 0–100 com 100 sempre no
melhor estado. A interface diz isso.

### Teste clínico é dado, não código

EVA, Oswestry, TUG, Schober, DASH e goniometria vêm do banco — campos, fórmula e
faixas de interpretação inclusive. Incorporar o WOMAC é inserir uma linha, não
abrir o editor.

Cada teste carrega **versão, unidade, fonte bibliográfica e licença**, impressas
na tela ao lado do resultado. O fisioterapeuta sabe de onde veio o número que
vai assinar.

E o escore é calculado no **servidor**: aceitar o escore vindo do navegador
seria deixá-lo escrever o resultado clínico que quisesse — e o número sai num
PDF assinado com CREFITO.

### Segurança que dá para verificar, não só prometer

- **PII cifrada em repouso** (AES-256-GCM), com índice cego para busca. Um dump
  do banco é uma lista de códigos `PC-4821`.
- **RBAC na cláusula WHERE**, nunca num `if` depois do `SELECT`.
- **404 em vez de 403** fora de escopo — um 403 confirmaria que o recurso
  existe.
- **Prontuário imutável em três camadas**: domínio, escrita condicional e
  gatilho no PostgreSQL. Vale até para quem abre o `psql`.
- **Auditoria encadeada por hash**, com verificação de integridade exposta na
  tela e recalculada na hora.
- **Row-Level Security** como rede de segurança, com falha fechada.
- **Log sem PII** por lista de permissão, mais uma regra de ESLint.

Tudo isso é testado. O isolamento entre clínicas é verificado contra um
PostgreSQL real com RLS ativa; a imutabilidade é verificada tentando alterar a
linha **por fora da aplicação**.

O modelo completo, com o que **não** está resolvido, está em
[`docs/security-model.md`](docs/security-model.md).

### Duas opções de animação e modo noturno

Requisito do produto, e não decoração: o padrão de movimento é o que o sistema
operacional do usuário diz em `prefers-reduced-motion`. Quem ligou essa
preferência fez isso por um motivo.

No modo reduzido, a informação é exatamente a mesma — só o caminho até ela é
instantâneo. O fundo 3D da apresentação nem é baixado.

---

## Comandos

```bash
npm run dev        # API + sistema + portal, tudo junto
npm run dev:api    # só a API
npm run db:seed    # catálogo clínico e, fora de produção, a demonstração
npm test           # 230 testes
npm run typecheck
npm run lint
npm run check      # os três acima
npm run build
```

---

## Estrutura

```
apps/
  api/       Fastify · Drizzle · PostgreSQL — monólito modular
  web/       Interface profissional (React + Vite)
  portal/    Portal do paciente — app separado, contexto isolado
packages/
  shared/    Tipos, contratos, schemas de validação, matriz RBAC
  security/  Pseudonimização, cifragem, sessão, MFA, auditoria, redação
  domain/    Regras clínicas — funções puras, sem I/O
  ui/        Design system: tokens oklch, tema, modos de animação
infra/       docker-compose e Dockerfile
docs/        Modelo de domínio, modelo de segurança, arquitetura e ADRs
```

**Stack:** TypeScript estrito · Fastify 5 · Drizzle ORM · PostgreSQL 17 ·
Redis · React 19 · Vite · GSAP · Lenis · Three.js · Vitest.

---

## Testes

**230 testes**, dirigidos por risco e não por percentual de cobertura:

| Suíte | Testes | O que cobre |
|---|---|---|
| `packages/security` | 100 | Cifragem, rotação de chave, pseudonimização, senha, sessão, CSRF, MFA, cadeia de auditoria, link mágico, redação, rate limit, upload, RBAC |
| `packages/domain` | 75 | Imutabilidade, motor de testes clínicos, série longitudinal, adesão, governança da biblioteca, consentimento, eventos |
| `apps/api` | 55 | Integração contra PostgreSQL real: isolamento de tenant, RLS, gatilhos, CSRF, portal, cabeçalhos |

Os quatro critérios de aceitação em Gherkin da especificação estão mapeados para
os testes que os verificam em
[`docs/security-model.md`](docs/security-model.md) §5.

---

## Documentação

| | |
|---|---|
| [`docs/domain-model.md`](docs/domain-model.md) | Entidades, invariantes e cálculos clínicos |
| [`docs/security-model.md`](docs/security-model.md) | Modelo de segurança, *threat model* e o que **não** está resolvido |
| [`docs/architecture.md`](docs/architecture.md) | Forma do sistema, camadas e fluxo de requisição |
| [`docs/adr/`](docs/adr/) | Decisões difíceis de reverter, com o porquê |

Três documentos vivos e ADRs incrementais — não os onze que a revisão externa
sugeriu. O próprio princípio de "complexidade só com razão concreta" vale também
para a documentação.

---

## Contribuir

Antes de abrir um PR, rode `npm run check`.

Duas regras que valem destacar, porque o lint as verifica:

1. **Não logue PII nem dado clínico.** Use o identificador ou o código
   pseudonimizado. Há um redator no logger e uma regra de ESLint.
2. **Leia variáveis de ambiente só em `apps/api/src/config.ts`**, que valida
   tudo na inicialização e derruba o processo se algo estiver errado.

Comentários e nomes em português. O público-alvo é brasileiro, e o código
precisa ser legível por quem vai instalar e manter.

---

## Licença e responsabilidade

**MIT.** Ver [LICENSE](LICENSE).

Este software processa **dados pessoais sensíveis** (dado de saúde, LGPD
Art. 5º, II e Art. 11).

Quem instala e opera esta aplicação é o **controlador e o operador** dos dados
dos próprios pacientes, para todos os efeitos da Lei 13.709/2018. BivarDev não
hospeda, não acessa e não processa nenhum dado inserido em instalações de
terceiros.

O software é fornecido **como está**, sem garantia de adequação a qualquer
finalidade regulatória específica. Backup, resposta a incidente e conformidade
com COFFITO 415/2012, COFFITO 516/2020 e LGPD são responsabilidade de quem
hospeda.

**Telemetria de terceiros: zero.** Analytics, se ativado, é opt-in, agregado e
anônimo.

---

Feito por **BivarDev**.
