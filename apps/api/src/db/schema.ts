/**
 * Schema do banco — Drizzle ORM sobre PostgreSQL.
 *
 * ## Convenções que valem para todas as tabelas
 *
 * 1. **Chave primária é UUID**, gerada pela aplicação. Nunca `serial`: id
 *    sequencial em rota pública convida enumeração, e o tamanho da base vaza
 *    pelo maior id.
 * 2. **Toda tabela com dado de tenant tem `organizacao_id`**, e ele entra em
 *    todo índice e em toda política de RLS. Sem exceção — a exceção é como o
 *    isolamento vaza.
 * 3. **Timestamps em `timestamptz`**, sempre. `timestamp` sem fuso é o bug que
 *    aparece no horário de verão e some depois.
 * 4. **PII mora em `paciente_identificacao`**, cifrada, e nunca é lida por
 *    junção automática. Ver `docs/security-model.md`.
 *
 * ## Por que Drizzle e não um ORM com mais mágica
 *
 * O requisito "RBAC por escopo aplicado na query" pede que a cláusula WHERE
 * seja visível e auditável no código. ORM que monta a query por trás de um
 * `findMany({ include })` esconde exatamente a parte que precisa estar às
 * claras. Aqui a query é praticamente SQL, com tipos.
 */

import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  date,
  index,
  uniqueIndex,
  real,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** Organização = tenant raiz. Clínica ou profissional autônomo. */
export const organizacoes = pgTable('organizacoes', {
  id: text('id').primaryKey(),
  nome: text('nome').notNull(),
  /** `autonomo` ou `clinica`. Muda apenas rótulos, não regra de acesso. */
  tipo: text('tipo').notNull(),
  /** Versão vigente do TCLE nesta organização. Aceite antigo não cobre o novo. */
  tcleVersao: text('tcle_versao').notNull().default('v1'),
  /** Analytics é opt-in e desligado por padrão — requisito da especificação. */
  telemetriaOptIn: boolean('telemetria_opt_in').notNull().default(false),
  criadaEm: timestamp('criada_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Profissional vinculado a uma organização. */
export const profissionais = pgTable(
  'profissionais',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id')
      .notNull()
      .references(() => organizacoes.id, { onDelete: 'restrict' }),
    nome: text('nome').notNull(),
    /** Normalizado em minúsculas antes de gravar — ver `zEmail`. */
    email: text('email').notNull(),
    /** Hash Argon2id. A senha em claro nunca toca o banco. */
    senhaHash: text('senha_hash').notNull(),
    /** Registro no conselho. Obrigatório para assinar prontuário. */
    crefito: text('crefito'),
    /** Um dos valores de `PAPEIS`. Validado na aplicação, não por enum do banco:
     *  mudar enum do Postgres exige migração; mudar a lista da aplicação, não. */
    papel: text('papel').notNull(),
    /** Para estagiário: de quem herda o escopo supervisionado. */
    supervisorId: text('supervisor_id'),
    /** Segredo TOTP, **cifrado** com a chave de PII. `null` = MFA desligado. */
    mfaSegredoCifrado: text('mfa_segredo_cifrado'),
    /** Hashes dos códigos de recuperação ainda não consumidos. */
    mfaRecuperacao: jsonb('mfa_recuperacao').$type<string[]>().notNull().default([]),
    /** Falhas consecutivas de login. Alimenta o backoff progressivo. */
    falhasLogin: integer('falhas_login').notNull().default(0),
    ultimaFalhaEm: timestamp('ultima_falha_em', { withTimezone: true }),
    /** Desativar em vez de apagar: a auditoria referencia este id para sempre. */
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // E-mail único por organização, não globalmente: a mesma pessoa pode
    // trabalhar em duas clínicas que rodam a mesma instalação.
    uniqueIndex('prof_email_org_idx').on(t.organizacaoId, t.email),
    index('prof_org_idx').on(t.organizacaoId),
  ],
);

/**
 * Trilha de auditoria.
 *
 * **Append-only.** A aplicação não expõe UPDATE nem DELETE, e a migração
 * instala um gatilho que lança exceção nas duas operações. A coluna `hash`
 * encadeia os eventos — ver `packages/security/src/auditoria.ts`.
 */
export const auditoria = pgTable(
  'auditoria',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    /** Posição na cadeia, sequencial e sem buracos dentro da organização. */
    sequencia: integer('sequencia').notNull(),
    /** `null` para ação do próprio sistema (job, regra automática). */
    atorId: text('ator_id'),
    atorPapel: text('ator_papel').notNull(),
    acao: text('acao').notNull(),
    entidade: text('entidade').notNull(),
    entidadeId: text('entidade_id').notNull(),
    /** Contexto já sanitizado. Nunca PII, nunca texto clínico. */
    detalhe: text('detalhe'),
    hashAnterior: text('hash_anterior').notNull(),
    hash: text('hash').notNull(),
    ocorridoEm: timestamp('ocorrido_em', { withTimezone: true }).notNull(),
  },
  (t) => [
    // A unicidade da sequência por organização é o que impede inserir um evento
    // "no meio" da cadeia sem que a verificação perceba.
    uniqueIndex('audit_seq_idx').on(t.organizacaoId, t.sequencia),
    index('audit_entidade_idx').on(t.organizacaoId, t.entidade, t.entidadeId),
    index('audit_tempo_idx').on(t.organizacaoId, t.ocorridoEm),
  ],
);

// ---------------------------------------------------------------------------
// Clinical Core — identificação separada do clínico
// ---------------------------------------------------------------------------

/**
 * PII do paciente. **Tabela isolada e cifrada.**
 *
 * Regra: esta tabela nunca entra numa junção por padrão. Ler daqui é uma
 * operação explícita, exige `paciente:reidentificar` e grava
 * `REIDENTIFICACAO_AUTORIZADA` na auditoria.
 *
 * Todos os campos sensíveis guardam o formato `c1$versao$iv$tag$ciphertext`.
 * O `*_indice` correspondente é o índice cego (HMAC), que permite buscar por
 * igualdade sem decifrar.
 */
export const pacienteIdentificacao = pgTable(
  'paciente_identificacao',
  {
    /** Mesmo id do `paciente_clinico`. A ligação é o id, não uma FK cruzada. */
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    nomeCifrado: text('nome_cifrado').notNull(),
    nascimentoCifrado: text('nascimento_cifrado').notNull(),
    emailCifrado: text('email_cifrado'),
    telefoneCifrado: text('telefone_cifrado'),
    documentoCifrado: text('documento_cifrado'),
    /** Índices cegos, para busca por igualdade sem decifrar. */
    emailIndice: text('email_indice'),
    documentoIndice: text('documento_indice'),
    telefoneIndice: text('telefone_indice'),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pii_email_idx').on(t.organizacaoId, t.emailIndice),
    index('pii_doc_idx').on(t.organizacaoId, t.documentoIndice),
  ],
);

/**
 * Lado clínico do paciente. É esta tabela que as consultas do dia a dia leem.
 *
 * Não tem nome, nem CPF, nem telefone. Só o código pseudonimizado. Um dump
 * desta tabela é uma lista de `PC-4821`, sem forma de voltar às pessoas.
 */
export const pacientes = pgTable(
  'pacientes',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id')
      .notNull()
      .references(() => organizacoes.id, { onDelete: 'restrict' }),
    /** Código estável derivado por HMAC, ex.: `PC-4821`. */
    codigo: text('codigo').notNull(),
    /** Idade em anos, recalculada em job diário. Menos identificante que a data. */
    idade: integer('idade'),
    /** Profissional responsável. Base do escopo restrito do estagiário. */
    responsavelId: text('responsavel_id').references(() => profissionais.id),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pac_codigo_idx').on(t.organizacaoId, t.codigo),
    index('pac_org_idx').on(t.organizacaoId),
    index('pac_resp_idx').on(t.organizacaoId, t.responsavelId),
  ],
);

/** Consentimentos do paciente. Sem consentimento vigente, nada clínico é criado. */
export const consentimentos = pgTable(
  'consentimentos',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    pacienteId: text('paciente_id')
      .notNull()
      .references(() => pacientes.id, { onDelete: 'restrict' }),
    /** `tratamento_dados`, `telessaude` ou `uso_imagem`. */
    tipo: text('tipo').notNull(),
    versao: text('versao').notNull(),
    aceitoEm: timestamp('aceito_em', { withTimezone: true }).notNull(),
    /** Revogado não é apagado — a prova de licitude do período precisa ficar. */
    revogadoEm: timestamp('revogado_em', { withTimezone: true }),
  },
  (t) => [index('cons_pac_idx').on(t.organizacaoId, t.pacienteId)],
);

/** Plano de tratamento: **o agregado clínico principal**, não o paciente. */
export const planos = pgTable(
  'planos',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    pacienteId: text('paciente_id')
      .notNull()
      .references(() => pacientes.id, { onDelete: 'restrict' }),
    profissionalId: text('profissional_id')
      .notNull()
      .references(() => profissionais.id),
    titulo: text('titulo').notNull(),
    diagnostico: text('diagnostico').notNull(),
    objetivo: text('objetivo').notNull(),
    /** `ativo`, `concluido` ou `interrompido`. */
    status: text('status').notNull().default('ativo'),
    fase: text('fase'),
    sessoesPrevistas: integer('sessoes_previstas').notNull(),
    iniciadoEm: timestamp('iniciado_em', { withTimezone: true }).notNull().defaultNow(),
    encerradoEm: timestamp('encerrado_em', { withTimezone: true }),
    /** Data-alvo da reavaliação. Vencida ⇒ aparece em "precisa de atenção". */
    reavaliacaoEm: date('reavaliacao_em'),
  },
  (t) => [
    index('plano_pac_idx').on(t.organizacaoId, t.pacienteId),
    index('plano_prof_idx').on(t.organizacaoId, t.profissionalId),
    index('plano_status_idx').on(t.organizacaoId, t.status),
  ],
);

/**
 * Registro clínico: avaliação, evolução ou reavaliação.
 *
 * Uma tabela só para os três, porque compartilham exatamente o mesmo ciclo de
 * vida (rascunho → selado → versionado) e as mesmas colunas de assinatura.
 * Três tabelas idênticas com nome diferente seria duplicação sem ganho.
 *
 * **Imutável após `finalizado_em`.** Garantido em três camadas: domínio,
 * repositório (`WHERE finalizado_em IS NULL`) e gatilho no banco.
 */
export const registros = pgTable(
  'registros',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    planoId: text('plano_id')
      .notNull()
      .references(() => planos.id, { onDelete: 'restrict' }),
    /** `avaliacao`, `evolucao` ou `reavaliacao`. */
    tipo: text('tipo').notNull(),
    /** Código legível, ex.: `E-2292`. Aparece na assinatura e na auditoria. */
    codigo: text('codigo').notNull(),
    /** Dor EVA de 0 a 10 registrada na sessão. */
    eva: integer('eva'),
    /** Conduta realizada — texto clínico. */
    conduta: text('conduta').notNull().default(''),
    /** Resposta do paciente e intercorrências. */
    resposta: text('resposta').notNull().default(''),
    /** Data do atendimento, não da digitação. */
    ocorridoEm: timestamp('ocorrido_em', { withTimezone: true }).notNull(),
    /** `null` = rascunho editável. Preenchido = selado e imutável. */
    finalizadoEm: timestamp('finalizado_em', { withTimezone: true }),
    /** Quem assinou. Guardamos o id; o CREFITO é lido de `profissionais`. */
    assinadoPorId: text('assinado_por_id').references(() => profissionais.id),
    versao: integer('versao').notNull().default(1),
    /** Registro que esta versão substitui. A anterior permanece intacta. */
    substituiId: text('substitui_id'),
    /** Justificativa da correção. Visível na linha do tempo. */
    motivoVersao: text('motivo_versao'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reg_plano_idx').on(t.organizacaoId, t.planoId, t.ocorridoEm),
    uniqueIndex('reg_codigo_idx').on(t.organizacaoId, t.codigo),
  ],
);

/**
 * Definição de teste/escala clínica.
 *
 * É **dado**, não código. Incorporar o WOMAC é inserir uma linha aqui.
 * `campos`, `formula` e `interpretacoes` são JSONB interpretados por
 * `packages/domain/src/avaliacao.ts`.
 *
 * `organizacao_id` nulo = definição global do catálogo padrão, visível a todos.
 */
export const definicoesTeste = pgTable(
  'definicoes_teste',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id'),
    chave: text('chave').notNull(),
    nome: text('nome').notNull(),
    versao: text('versao').notNull(),
    categoria: text('categoria').notNull(),
    unidade: text('unidade').notNull(),
    /** Referência bibliográfica. Aparece impressa na tela de avaliação. */
    fonte: text('fonte').notNull(),
    /** Licença de uso da escala. Sem ela, o teste não é publicável. */
    licenca: text('licenca').notNull(),
    /** `true` quando escore maior significa pior — muda a cor do delta. */
    maiorEhPior: boolean('maior_eh_pior').notNull(),
    campos: jsonb('campos').notNull(),
    formula: jsonb('formula').notNull(),
    interpretacoes: jsonb('interpretacoes').notNull(),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [uniqueIndex('def_chave_versao_idx').on(t.chave, t.versao)],
);

/** Aplicação de um teste dentro de um registro clínico. */
export const aplicacoesTeste = pgTable(
  'aplicacoes_teste',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    registroId: text('registro_id')
      .notNull()
      .references(() => registros.id, { onDelete: 'restrict' }),
    definicaoChave: text('definicao_chave').notNull(),
    /** Versão da definição usada no cálculo — procedência auditável. */
    definicaoVersao: text('definicao_versao').notNull(),
    /** Valores brutos informados. O escore é recalculável a partir daqui. */
    valores: jsonb('valores').$type<Record<string, number>>().notNull(),
    /** Escore calculado **pelo servidor**. Nunca aceito do cliente. */
    escore: real('escore').notNull(),
    interpretacao: text('interpretacao').notNull(),
    tom: text('tom').notNull(),
    aplicadoEm: timestamp('aplicado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('apl_registro_idx').on(t.organizacaoId, t.registroId)],
);

// ---------------------------------------------------------------------------
// Adherence
// ---------------------------------------------------------------------------

/** Exercício do catálogo. `organizacao_id` nulo = catálogo global curado. */
export const exercicios = pgTable(
  'exercicios',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id'),
    nome: text('nome').notNull(),
    categoria: text('categoria').notNull(),
    regiao: text('regiao').notNull(),
    /** Orientação em linguagem de paciente. Vai direto para o portal. */
    orientacao: text('orientacao').notNull(),
    /** `draft`, `in_review` ou `published`. */
    status: text('status').notNull().default('draft'),
    versao: integer('versao').notNull().default(1),
    autorId: text('autor_id'),
    revisorId: text('revisor_id'),
    /** `null` **bloqueia** a publicação. Regra dura de governança. */
    licenca: text('licenca'),
    midiaId: text('midia_id'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ex_status_idx').on(t.status)],
);

/** Prescrição HEP vinculada a um plano. */
export const prescricoes = pgTable(
  'prescricoes',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    planoId: text('plano_id')
      .notNull()
      .references(() => planos.id, { onDelete: 'restrict' }),
    /** Dias por semana esperados. É o denominador do cálculo de adesão. */
    metaSemanal: integer('meta_semanal').notNull().default(3),
    ativa: boolean('ativa').notNull().default(true),
    criadaEm: timestamp('criada_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('presc_plano_idx').on(t.organizacaoId, t.planoId)],
);

/** Item FITT de uma prescrição. */
export const prescricaoItens = pgTable(
  'prescricao_itens',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    prescricaoId: text('prescricao_id')
      .notNull()
      .references(() => prescricoes.id, { onDelete: 'cascade' }),
    exercicioId: text('exercicio_id')
      .notNull()
      .references(() => exercicios.id),
    /** Versão do exercício prescrita. Editar o catálogo não altera isto —
     *  é o que impede mudar retroativamente uma conduta já prescrita. */
    exercicioVersao: integer('exercicio_versao').notNull(),
    series: integer('series').notNull(),
    repeticoes: integer('repeticoes').notNull(),
    carga: text('carga').notNull().default(''),
    frequenciaSemanal: integer('frequencia_semanal').notNull(),
    /** Regra de progressão declarada, não texto livre solto. */
    progressao: text('progressao').notNull().default(''),
  },
  (t) => [index('presc_item_idx').on(t.organizacaoId, t.prescricaoId)],
);

/** Registro de execução feito pelo paciente no portal. */
export const registrosAdesao = pgTable(
  'registros_adesao',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    pacienteId: text('paciente_id')
      .notNull()
      .references(() => pacientes.id, { onDelete: 'restrict' }),
    prescricaoItemId: text('prescricao_item_id')
      .notNull()
      .references(() => prescricaoItens.id, { onDelete: 'cascade' }),
    /** Data a que o registro se refere, `YYYY-MM-DD`. */
    data: date('data').notNull(),
    /** `fez`, `parcial` ou `nao_fez`. */
    status: text('status').notNull(),
    observacao: text('observacao'),
    registradoEm: timestamp('registrado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Um registro por item por dia. Reenviar sobrescreve em vez de duplicar —
    // sem isso, o paciente que clica duas vezes infla a própria adesão.
    uniqueIndex('adesao_unica_idx').on(t.prescricaoItemId, t.data),
    index('adesao_pac_idx').on(t.organizacaoId, t.pacienteId, t.data),
  ],
);

/**
 * Token de link mágico do portal.
 *
 * Guarda o **HMAC** do token, nunca o token. `consumido_em` implementa o uso
 * único, e o consumo é uma escrita condicional (`WHERE consumido_em IS NULL`)
 * para que duas requisições simultâneas não consumam o mesmo token.
 */
export const tokensPortal = pgTable(
  'tokens_portal',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    pacienteId: text('paciente_id')
      .notNull()
      .references(() => pacientes.id, { onDelete: 'cascade' }),
    /** HMAC do token. Vazou o banco, ninguém entra em portal nenhum. */
    tokenHash: text('token_hash').notNull(),
    expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
    consumidoEm: timestamp('consumido_em', { withTimezone: true }),
    revogadoEm: timestamp('revogado_em', { withTimezone: true }),
    emitidoEm: timestamp('emitido_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('token_hash_idx').on(t.tokenHash),
    index('token_pac_idx').on(t.pacienteId, t.emitidoEm),
  ],
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Sessão na agenda. */
export const sessoes = pgTable(
  'sessoes',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    pacienteId: text('paciente_id')
      .notNull()
      .references(() => pacientes.id, { onDelete: 'restrict' }),
    planoId: text('plano_id').references(() => planos.id),
    profissionalId: text('profissional_id')
      .notNull()
      .references(() => profissionais.id),
    inicioEm: timestamp('inicio_em', { withTimezone: true }).notNull(),
    duracaoMin: integer('duracao_min').notNull().default(50),
    /** `agendada`, `confirmada`, `realizada`, `falta_justificada`, `no_show`, `cancelada`. */
    status: text('status').notNull().default('agendada'),
    /** Série de recorrência que gerou esta sessão, se houver. */
    serieId: text('serie_id'),
    /** Motivo da falta. É o que separa `falta_justificada` de `no_show`. */
    motivo: text('motivo'),
  },
  (t) => [
    index('sessao_agenda_idx').on(t.organizacaoId, t.inicioEm),
    index('sessao_pac_idx').on(t.organizacaoId, t.pacienteId),
  ],
);

/** Pacote de sessões com saldo. */
export const pacotes = pgTable(
  'pacotes',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    pacienteId: text('paciente_id')
      .notNull()
      .references(() => pacientes.id, { onDelete: 'restrict' }),
    totalSessoes: integer('total_sessoes').notNull(),
    usadas: integer('usadas').notNull().default(0),
    /** Valor em centavos. Nunca `float` para dinheiro — arredondamento binário
     *  transforma R$ 0,10 três vezes em R$ 0,30000000000000004. */
    valorCentavos: integer('valor_centavos').notNull(),
    pagoCentavos: integer('pago_centavos').notNull().default(0),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pacote_pac_idx').on(t.organizacaoId, t.pacienteId)],
);

/** Mídia clínica (foto de avaliação, vídeo de movimento). */
export const midias = pgTable(
  'midias',
  {
    id: text('id').primaryKey(),
    organizacaoId: text('organizacao_id').notNull(),
    /** A que registro clínico pertence. `null` para mídia de exercício. */
    registroId: text('registro_id'),
    /** MIME canônico definido por nós, a partir da assinatura binária. */
    mime: text('mime').notNull(),
    tamanhoBytes: integer('tamanho_bytes').notNull(),
    /** Caminho relativo no armazenamento privado. Nunca servido estaticamente. */
    caminho: text('caminho').notNull(),
    enviadoPorId: text('enviado_por_id'),
    criadaEm: timestamp('criada_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('midia_reg_idx').on(t.organizacaoId, t.registroId)],
);

/** Todas as tabelas, para operações genéricas (aplicar schema, limpar em teste). */
export const tabelas = {
  organizacoes,
  profissionais,
  auditoria,
  pacienteIdentificacao,
  pacientes,
  consentimentos,
  planos,
  registros,
  definicoesTeste,
  aplicacoesTeste,
  exercicios,
  prescricoes,
  prescricaoItens,
  registrosAdesao,
  tokensPortal,
  sessoes,
  pacotes,
  midias,
};
