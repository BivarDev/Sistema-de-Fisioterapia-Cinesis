/**
 * DDL do banco: tabelas, índices, gatilhos de imutabilidade e Row-Level Security.
 *
 * ## Por que o DDL está aqui, e não só no schema do Drizzle
 *
 * O Drizzle descreve tabelas e índices. Ele **não** descreve gatilho,
 * `REVOKE`, nem política de RLS — que é justamente onde moram as garantias que
 * não podem depender da aplicação estar correta. Um sistema de prontuário
 * precisa que "não dá para editar registro selado" continue verdade mesmo se
 * alguém abrir o `psql` e tentar na mão.
 *
 * ## As três defesas que só o banco pode dar
 *
 * 1. **Gatilho de imutabilidade** — `UPDATE`/`DELETE` em registro finalizado
 *    lança exceção. Vale para a aplicação, para o script de correção às pressas
 *    e para o `psql`.
 * 2. **Auditoria append-only** — mesma ideia, sem exceção nenhuma.
 * 3. **RLS por organização** — mesmo que uma consulta esqueça o
 *    `WHERE organizacao_id = ...`, o Postgres devolve zero linhas de outro
 *    tenant. É rede de segurança, não substituto do filtro na query: o filtro
 *    explícito continua sendo a regra, e o teste cobre os dois.
 *
 * ## Como a RLS sabe qual é o tenant
 *
 * A aplicação executa `SET LOCAL app.organizacao_id = '<uuid>'` no início de
 * cada transação. `LOCAL` é essencial: sem ele, o valor vazaria para a próxima
 * requisição que reusasse a mesma conexão do pool — e um paciente apareceria
 * na tela de outra clínica.
 */

/** Nomes das tabelas que carregam dado de tenant e recebem RLS. */
const TABELAS_COM_TENANT = [
  'profissionais',
  'auditoria',
  'paciente_identificacao',
  'pacientes',
  'consentimentos',
  'planos',
  'registros',
  'aplicacoes_teste',
  'prescricoes',
  'prescricao_itens',
  'registros_adesao',
  'tokens_portal',
  'sessoes',
  'pacotes',
  'midias',
] as const;

/**
 * Criação das tabelas.
 *
 * Escrito à mão em vez de gerado, porque o SQL é a documentação real do
 * armazenamento e porque `drizzle-kit generate` exigiria uma etapa a mais no
 * "sobe com um comando" que o público-alvo precisa.
 */
export const DDL_TABELAS = /* sql */ `
CREATE TABLE IF NOT EXISTS organizacoes (
  id                TEXT PRIMARY KEY,
  nome              TEXT NOT NULL,
  tipo              TEXT NOT NULL CHECK (tipo IN ('autonomo','clinica')),
  tcle_versao       TEXT NOT NULL DEFAULT 'v1',
  telemetria_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  criada_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profissionais (
  id                  TEXT PRIMARY KEY,
  organizacao_id      TEXT NOT NULL REFERENCES organizacoes(id) ON DELETE RESTRICT,
  nome                TEXT NOT NULL,
  email               TEXT NOT NULL,
  senha_hash          TEXT NOT NULL,
  crefito             TEXT,
  papel               TEXT NOT NULL CHECK (papel IN ('fisioterapeuta','recepcao','estagiario','paciente')),
  supervisor_id       TEXT,
  mfa_segredo_cifrado TEXT,
  mfa_recuperacao     JSONB NOT NULL DEFAULT '[]'::jsonb,
  falhas_login        INTEGER NOT NULL DEFAULT 0,
  ultima_falha_em     TIMESTAMPTZ,
  ativo               BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS prof_email_org_idx ON profissionais (organizacao_id, email);
CREATE INDEX IF NOT EXISTS prof_org_idx ON profissionais (organizacao_id);

CREATE TABLE IF NOT EXISTS auditoria (
  id             TEXT PRIMARY KEY,
  organizacao_id TEXT NOT NULL,
  sequencia      INTEGER NOT NULL,
  ator_id        TEXT,
  ator_papel     TEXT NOT NULL,
  acao           TEXT NOT NULL,
  entidade       TEXT NOT NULL,
  entidade_id    TEXT NOT NULL,
  detalhe        TEXT,
  hash_anterior  TEXT NOT NULL,
  hash           TEXT NOT NULL,
  ocorrido_em    TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_seq_idx ON auditoria (organizacao_id, sequencia);
CREATE INDEX IF NOT EXISTS audit_entidade_idx ON auditoria (organizacao_id, entidade, entidade_id);
CREATE INDEX IF NOT EXISTS audit_tempo_idx ON auditoria (organizacao_id, ocorrido_em);

CREATE TABLE IF NOT EXISTS paciente_identificacao (
  id                  TEXT PRIMARY KEY,
  organizacao_id      TEXT NOT NULL,
  nome_cifrado        TEXT NOT NULL,
  nascimento_cifrado  TEXT NOT NULL,
  email_cifrado       TEXT,
  telefone_cifrado    TEXT,
  documento_cifrado   TEXT,
  email_indice        TEXT,
  documento_indice    TEXT,
  telefone_indice     TEXT,
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pii_email_idx ON paciente_identificacao (organizacao_id, email_indice);
CREATE INDEX IF NOT EXISTS pii_doc_idx ON paciente_identificacao (organizacao_id, documento_indice);

CREATE TABLE IF NOT EXISTS pacientes (
  id             TEXT PRIMARY KEY,
  organizacao_id TEXT NOT NULL REFERENCES organizacoes(id) ON DELETE RESTRICT,
  codigo         TEXT NOT NULL,
  idade          INTEGER,
  responsavel_id TEXT REFERENCES profissionais(id),
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pac_codigo_idx ON pacientes (organizacao_id, codigo);
CREATE INDEX IF NOT EXISTS pac_org_idx ON pacientes (organizacao_id);
CREATE INDEX IF NOT EXISTS pac_resp_idx ON pacientes (organizacao_id, responsavel_id);

CREATE TABLE IF NOT EXISTS consentimentos (
  id             TEXT PRIMARY KEY,
  organizacao_id TEXT NOT NULL,
  paciente_id    TEXT NOT NULL REFERENCES pacientes(id) ON DELETE RESTRICT,
  tipo           TEXT NOT NULL CHECK (tipo IN ('tratamento_dados','telessaude','uso_imagem')),
  versao         TEXT NOT NULL,
  aceito_em      TIMESTAMPTZ NOT NULL,
  revogado_em    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS cons_pac_idx ON consentimentos (organizacao_id, paciente_id);

CREATE TABLE IF NOT EXISTS planos (
  id                TEXT PRIMARY KEY,
  organizacao_id    TEXT NOT NULL,
  paciente_id       TEXT NOT NULL REFERENCES pacientes(id) ON DELETE RESTRICT,
  profissional_id   TEXT NOT NULL REFERENCES profissionais(id),
  titulo            TEXT NOT NULL,
  diagnostico       TEXT NOT NULL,
  objetivo          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','concluido','interrompido')),
  fase              TEXT,
  sessoes_previstas INTEGER NOT NULL,
  iniciado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  encerrado_em      TIMESTAMPTZ,
  reavaliacao_em    DATE
);
CREATE INDEX IF NOT EXISTS plano_pac_idx ON planos (organizacao_id, paciente_id);
CREATE INDEX IF NOT EXISTS plano_prof_idx ON planos (organizacao_id, profissional_id);
CREATE INDEX IF NOT EXISTS plano_status_idx ON planos (organizacao_id, status);

CREATE TABLE IF NOT EXISTS registros (
  id               TEXT PRIMARY KEY,
  organizacao_id   TEXT NOT NULL,
  plano_id         TEXT NOT NULL REFERENCES planos(id) ON DELETE RESTRICT,
  tipo             TEXT NOT NULL CHECK (tipo IN ('avaliacao','evolucao','reavaliacao')),
  codigo           TEXT NOT NULL,
  eva              INTEGER CHECK (eva IS NULL OR (eva >= 0 AND eva <= 10)),
  conduta          TEXT NOT NULL DEFAULT '',
  resposta         TEXT NOT NULL DEFAULT '',
  ocorrido_em      TIMESTAMPTZ NOT NULL,
  finalizado_em    TIMESTAMPTZ,
  assinado_por_id  TEXT REFERENCES profissionais(id),
  versao           INTEGER NOT NULL DEFAULT 1,
  substitui_id     TEXT,
  motivo_versao    TEXT,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reg_plano_idx ON registros (organizacao_id, plano_id, ocorrido_em);
CREATE UNIQUE INDEX IF NOT EXISTS reg_codigo_idx ON registros (organizacao_id, codigo);

CREATE TABLE IF NOT EXISTS definicoes_teste (
  id              TEXT PRIMARY KEY,
  organizacao_id  TEXT,
  chave           TEXT NOT NULL,
  nome            TEXT NOT NULL,
  versao          TEXT NOT NULL,
  categoria       TEXT NOT NULL,
  unidade         TEXT NOT NULL,
  fonte           TEXT NOT NULL,
  licenca         TEXT NOT NULL,
  maior_eh_pior   BOOLEAN NOT NULL,
  campos          JSONB NOT NULL,
  formula         JSONB NOT NULL,
  interpretacoes  JSONB NOT NULL,
  ativo           BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS def_chave_versao_idx ON definicoes_teste (chave, versao);

CREATE TABLE IF NOT EXISTS aplicacoes_teste (
  id                TEXT PRIMARY KEY,
  organizacao_id    TEXT NOT NULL,
  registro_id       TEXT NOT NULL REFERENCES registros(id) ON DELETE RESTRICT,
  definicao_chave   TEXT NOT NULL,
  definicao_versao  TEXT NOT NULL,
  valores           JSONB NOT NULL,
  escore            REAL NOT NULL,
  interpretacao     TEXT NOT NULL,
  tom               TEXT NOT NULL,
  aplicado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apl_registro_idx ON aplicacoes_teste (organizacao_id, registro_id);

CREATE TABLE IF NOT EXISTS exercicios (
  id             TEXT PRIMARY KEY,
  organizacao_id TEXT,
  nome           TEXT NOT NULL,
  categoria      TEXT NOT NULL,
  regiao         TEXT NOT NULL,
  orientacao     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','published')),
  versao         INTEGER NOT NULL DEFAULT 1,
  autor_id       TEXT,
  revisor_id     TEXT,
  licenca        TEXT,
  midia_id       TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ex_status_idx ON exercicios (status);

CREATE TABLE IF NOT EXISTS prescricoes (
  id             TEXT PRIMARY KEY,
  organizacao_id TEXT NOT NULL,
  plano_id       TEXT NOT NULL REFERENCES planos(id) ON DELETE RESTRICT,
  meta_semanal   INTEGER NOT NULL DEFAULT 3,
  ativa          BOOLEAN NOT NULL DEFAULT TRUE,
  criada_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS presc_plano_idx ON prescricoes (organizacao_id, plano_id);

CREATE TABLE IF NOT EXISTS prescricao_itens (
  id                 TEXT PRIMARY KEY,
  organizacao_id     TEXT NOT NULL,
  prescricao_id      TEXT NOT NULL REFERENCES prescricoes(id) ON DELETE CASCADE,
  exercicio_id       TEXT NOT NULL REFERENCES exercicios(id),
  exercicio_versao   INTEGER NOT NULL,
  series             INTEGER NOT NULL,
  repeticoes         INTEGER NOT NULL,
  carga              TEXT NOT NULL DEFAULT '',
  frequencia_semanal INTEGER NOT NULL,
  progressao         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS presc_item_idx ON prescricao_itens (organizacao_id, prescricao_id);

CREATE TABLE IF NOT EXISTS registros_adesao (
  id                 TEXT PRIMARY KEY,
  organizacao_id     TEXT NOT NULL,
  paciente_id        TEXT NOT NULL REFERENCES pacientes(id) ON DELETE RESTRICT,
  prescricao_item_id TEXT NOT NULL REFERENCES prescricao_itens(id) ON DELETE CASCADE,
  data               DATE NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('fez','parcial','nao_fez')),
  observacao         TEXT,
  registrado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS adesao_unica_idx ON registros_adesao (prescricao_item_id, data);
CREATE INDEX IF NOT EXISTS adesao_pac_idx ON registros_adesao (organizacao_id, paciente_id, data);

CREATE TABLE IF NOT EXISTS tokens_portal (
  id             TEXT PRIMARY KEY,
  organizacao_id TEXT NOT NULL,
  paciente_id    TEXT NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL,
  expira_em      TIMESTAMPTZ NOT NULL,
  consumido_em   TIMESTAMPTZ,
  revogado_em    TIMESTAMPTZ,
  emitido_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS token_hash_idx ON tokens_portal (token_hash);
CREATE INDEX IF NOT EXISTS token_pac_idx ON tokens_portal (paciente_id, emitido_em);

CREATE TABLE IF NOT EXISTS sessoes (
  id              TEXT PRIMARY KEY,
  organizacao_id  TEXT NOT NULL,
  paciente_id     TEXT NOT NULL REFERENCES pacientes(id) ON DELETE RESTRICT,
  plano_id        TEXT REFERENCES planos(id),
  profissional_id TEXT NOT NULL REFERENCES profissionais(id),
  inicio_em       TIMESTAMPTZ NOT NULL,
  duracao_min     INTEGER NOT NULL DEFAULT 50,
  status          TEXT NOT NULL DEFAULT 'agendada'
                  CHECK (status IN ('agendada','confirmada','realizada','falta_justificada','no_show','cancelada')),
  serie_id        TEXT,
  motivo          TEXT
);
CREATE INDEX IF NOT EXISTS sessao_agenda_idx ON sessoes (organizacao_id, inicio_em);
CREATE INDEX IF NOT EXISTS sessao_pac_idx ON sessoes (organizacao_id, paciente_id);

CREATE TABLE IF NOT EXISTS pacotes (
  id              TEXT PRIMARY KEY,
  organizacao_id  TEXT NOT NULL,
  paciente_id     TEXT NOT NULL REFERENCES pacientes(id) ON DELETE RESTRICT,
  total_sessoes   INTEGER NOT NULL,
  usadas          INTEGER NOT NULL DEFAULT 0,
  valor_centavos  INTEGER NOT NULL,
  pago_centavos   INTEGER NOT NULL DEFAULT 0,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pacote_pac_idx ON pacotes (organizacao_id, paciente_id);

CREATE TABLE IF NOT EXISTS midias (
  id              TEXT PRIMARY KEY,
  organizacao_id  TEXT NOT NULL,
  registro_id     TEXT,
  mime            TEXT NOT NULL,
  tamanho_bytes   INTEGER NOT NULL,
  caminho         TEXT NOT NULL,
  enviado_por_id  TEXT,
  criada_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS midia_reg_idx ON midias (organizacao_id, registro_id);
`;

/**
 * Gatilhos de imutabilidade.
 *
 * Estes são a razão de o DDL existir separado do Drizzle. Sem eles,
 * "prontuário imutável" é uma promessa da camada de aplicação — e qualquer
 * caminho que não passe por ela (script, migração, `psql`) a quebra sem aviso.
 */
export const DDL_GATILHOS = /* sql */ `
-- ---------------------------------------------------------------------------
-- Prontuário imutável (COFFITO 415/2012)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cinesis_registro_imutavel() RETURNS TRIGGER AS $$
BEGIN
  -- Só barra o que já foi selado. Rascunho continua editável.
  IF OLD.finalizado_em IS NOT NULL THEN
    RAISE EXCEPTION
      'Registro clínico % está finalizado e é imutável (COFFITO 415/2012). Crie uma nova versão.',
      OLD.codigo
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_registro_imutavel ON registros;
CREATE TRIGGER trg_registro_imutavel
  BEFORE UPDATE OR DELETE ON registros
  FOR EACH ROW EXECUTE FUNCTION cinesis_registro_imutavel();

-- ---------------------------------------------------------------------------
-- Auditoria append-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cinesis_auditoria_append_only() RETURNS TRIGGER AS $$
BEGIN
  -- Sem condição nenhuma: a trilha de auditoria não se altera nem se apaga.
  -- É o que dá sentido à cadeia de hash — se a linha pudesse mudar, o hash
  -- poderia ser recalculado junto.
  RAISE EXCEPTION 'A trilha de auditoria é append-only: % não é permitido.', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auditoria_append_only ON auditoria;
CREATE TRIGGER trg_auditoria_append_only
  BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION cinesis_auditoria_append_only();

-- ---------------------------------------------------------------------------
-- Aplicações de teste seguem a imutabilidade do registro-pai
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cinesis_aplicacao_imutavel() RETURNS TRIGGER AS $$
DECLARE
  selado TIMESTAMPTZ;
BEGIN
  -- Sem isto, alterar o escore de um teste dentro de um registro já assinado
  -- mudaria o número exibido no gráfico sem tocar na tabela registros.
  SELECT finalizado_em INTO selado FROM registros WHERE id = OLD.registro_id;
  IF selado IS NOT NULL THEN
    RAISE EXCEPTION 'O registro clínico está finalizado; os testes aplicados são imutáveis.'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_aplicacao_imutavel ON aplicacoes_teste;
CREATE TRIGGER trg_aplicacao_imutavel
  BEFORE UPDATE OR DELETE ON aplicacoes_teste
  FOR EACH ROW EXECUTE FUNCTION cinesis_aplicacao_imutavel();

-- ---------------------------------------------------------------------------
-- Token de portal é de uso único e não "desconsome"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cinesis_token_uso_unico() RETURNS TRIGGER AS $$
BEGIN
  -- Zerar consumido_em transformaria um token usado em token válido de novo.
  IF OLD.consumido_em IS NOT NULL AND NEW.consumido_em IS NULL THEN
    RAISE EXCEPTION 'Token de portal já consumido não pode ser reativado. Emita um novo.'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_token_uso_unico ON tokens_portal;
CREATE TRIGGER trg_token_uso_unico
  BEFORE UPDATE ON tokens_portal
  FOR EACH ROW EXECUTE FUNCTION cinesis_token_uso_unico();
`;

/**
 * Nome do papel de banco com que as requisicoes rodam.
 *
 * Deliberadamente **nao** e o dono das tabelas. A RLS e ignorada para
 * superusuario e, sem `FORCE`, tambem para o dono da tabela; rodar as consultas
 * de requisicao sob um papel comum e o que faz as politicas terem efeito real.
 * O dono continua sendo o usuario de conexao, que aplica schema e semeia.
 */
export const PAPEL_APLICACAO = 'cinesis_app';

/**
 * Cria o papel de aplicacao e concede o privilegio minimo.
 *
 * Idempotente: o bloco `DO` verifica antes de criar, e `GRANT` repetido nao e
 * erro. E isso que permite chamar na subida do processo sem uma ferramenta de
 * migracao externa.
 */
export const DDL_PAPEL = /* sql */ `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PAPEL_APLICACAO}') THEN
    -- NOLOGIN: este papel nunca conecta direto. Ele e assumido com SET LOCAL
    -- ROLE por uma conexao ja autenticada, entao nao precisa de senha.
    CREATE ROLE ${PAPEL_APLICACAO} NOLOGIN;
  END IF;
END
$$;

-- O usuario de conexao precisa ser membro para poder assumir o papel.
GRANT ${PAPEL_APLICACAO} TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO ${PAPEL_APLICACAO};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PAPEL_APLICACAO};

-- Tabelas criadas depois desta linha ja nascem com o mesmo privilegio.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${PAPEL_APLICACAO};

-- ---------------------------------------------------------------------------
-- Privilegio minimo: o que a aplicacao NUNCA precisa fazer
-- ---------------------------------------------------------------------------
-- Redundante com os gatilhos, e de proposito. Gatilho pode ser removido por
-- quem tem privilegio de DDL; privilegio revogado exige um GRANT explicito,
-- que e uma acao visivel e auditavel no servidor de banco.
REVOKE UPDATE, DELETE ON auditoria FROM ${PAPEL_APLICACAO};
-- Encerrar tratamento muda o status; nao apaga prontuario.
REVOKE DELETE ON registros FROM ${PAPEL_APLICACAO};
REVOKE DELETE ON aplicacoes_teste FROM ${PAPEL_APLICACAO};
`;

/**
 * Row-Level Security por organizacao.
 *
 * Rede de seguranca para o caso de uma consulta esquecer o filtro de tenant.
 * **Nao substitui** o filtro explicito — o `WHERE organizacao_id` continua
 * obrigatorio, porque e ele que documenta a intencao no codigo e porque a RLS
 * nao se aplica a superusuario.
 *
 * A aplicacao define o tenant com `set_config('app.organizacao_id', ..., true)`
 * no comeco de cada transacao; o `true` significa "local a transacao".
 * `current_setting(..., true)` devolve NULL quando a variavel nao foi definida,
 * e a politica nega tudo nesse caso — **falha fechada**, que e o padrao certo:
 * uma consulta que esqueceu de fixar o tenant devolve zero linhas em vez de
 * devolver o banco inteiro.
 */
export function ddlRls(): string {
  return TABELAS_COM_TENANT.map(
    (t) => /* sql */ `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${t}_tenant ON ${t};
CREATE POLICY ${t}_tenant ON ${t}
  USING (organizacao_id = current_setting('app.organizacao_id', true))
  WITH CHECK (organizacao_id = current_setting('app.organizacao_id', true));
`,
  ).join('\n');
}

/**
 * DDL completo, na ordem obrigatoria.
 *
 * A ordem importa: gatilhos precisam das tabelas, o `GRANT ON ALL TABLES`
 * precisa das tabelas ja criadas, e as politicas precisam do papel existir.
 */
export function ddlCompleto(): string {
  return [DDL_TABELAS, DDL_GATILHOS, DDL_PAPEL, ddlRls()].join('\n');
}
