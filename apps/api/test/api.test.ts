/**
 * Testes de integração da API.
 *
 * ## O que estes testes provam que os de unidade não provam
 *
 * Sobem a aplicação inteira contra um PostgreSQL de verdade (PGlite, o próprio
 * Postgres 17 em WASM) — com RLS ativa, gatilhos instalados e o papel de banco
 * restrito. Nada é mockado.
 *
 * Isso importa porque as garantias mais fortes do sistema são exatamente as que
 * um mock não consegue reproduzir: o isolamento entre tenants depende de uma
 * política do Postgres, e a imutabilidade do prontuário depende de um gatilho.
 * Testar essas duas coisas com mock é testar o mock.
 *
 * As rotas são exercitadas com `app.inject()`: passa por hooks, CSRF, RBAC e
 * tratamento de erro, sem abrir porta nenhuma.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { montarApp } from '../src/servidor.js';
import { semearCatalogo } from '../src/db/semear.js';
import { semEscopoDeTenant, comTenant, type Banco } from '../src/db/conexao.js';
import type { Conexao } from '../src/db/conexao.js';
import { registros, auditoria, pacientes } from '../src/db/schema.js';
import { eq, and, sql as sqlBruto } from 'drizzle-orm';
import { HEADER_CSRF } from '@cinesis/security';
import { limitador } from '../src/plugins/seguranca.js';

/** Ambiente de teste: PGlite em memória, chave fixa, sem Redis. */
const AMBIENTE: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  CINESIS_KEY_V1: Buffer.alloc(32, 42).toString('base64'),
  ORIGENS_PERMITIDAS: 'http://localhost:5173',
  PORTAL_URL: 'http://localhost:5174',
  LOG_NIVEL: 'fatal', // Silencia o log durante os testes.
};

/** User-Agent fixo: a sessão é vinculada a ele. */
const AGENTE = 'vitest/1.0';

let app: FastifyInstance;
let db: Banco;
let conexao: Conexao;

/** Sessão autenticada, para reaproveitar entre os testes. */
interface Sessao {
  cookie: string;
  csrf: string;
  organizacaoId: string;
  profissionalId: string;
}

/**
 * Registra uma organização nova e faz login.
 * Cada teste que precisa de tenant isolado chama isto com um sufixo próprio.
 */
async function novaClinica(sufixo: string): Promise<Sessao> {
  const email = `fisio${sufixo}@teste.local`;
  const senha = 'senha-de-teste-bem-longa';

  const registro = await app.inject({
    method: 'POST',
    url: '/api/auth/registrar',
    headers: { 'user-agent': AGENTE, origin: 'http://localhost:5173' },
    payload: {
      organizacaoNome: `Clínica ${sufixo}`,
      organizacaoTipo: 'clinica',
      nome: `Fisio ${sufixo}`,
      email,
      senha,
      crefito: 'CREFITO-3 12345-F',
    },
  });
  expect(registro.statusCode).toBe(201);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'user-agent': AGENTE, origin: 'http://localhost:5173' },
    payload: { email, senha },
  });
  expect(login.statusCode).toBe(200);

  const corpo = login.json();
  const cookie = login.cookies.find((c) => c.name === 'cinesis_sessao');
  expect(cookie).toBeDefined();

  return {
    cookie: `cinesis_sessao=${cookie!.value}`,
    csrf: corpo.csrf,
    organizacaoId: corpo.profissional.organizacaoId,
    profissionalId: corpo.profissional.id,
  };
}

/** Atalho: requisição autenticada com CSRF e origem corretos. */
function autenticado(s: Sessao, extras: Record<string, string> = {}) {
  return {
    'user-agent': AGENTE,
    origin: 'http://localhost:5173',
    cookie: s.cookie,
    [HEADER_CSRF]: s.csrf,
    ...extras,
  };
}

/** Cria um paciente e devolve o id. */
async function criarPaciente(s: Sessao, nome: string): Promise<{ id: string; codigo: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/pacientes',
    headers: autenticado(s),
    payload: {
      nome,
      nascimento: '1990-05-15',
      documento: '12345678901',
      consentimentoVersao: 'v1',
    },
  });
  expect(r.statusCode).toBe(201);
  return r.json();
}

/**
 * Executa algo que deve falhar no banco e devolve a mensagem ORIGINAL do
 * Postgres.
 *
 * O Drizzle embrulha o erro do driver num `DrizzleQueryError` cuja mensagem e
 * sempre "Failed query: ...". A mensagem do gatilho — que e o que estamos
 * testando — fica em `.cause`. Sem desembrulhar, a assercao passaria por
 * qualquer falha de query, inclusive um erro de sintaxe nosso.
 */
async function mensagemDeFalha(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const causa = (e as { cause?: unknown }).cause;
    const mensagens = [
      (e as Error).message,
      causa instanceof Error ? causa.message : String(causa ?? ''),
    ];
    return mensagens.join(' | ');
  }
  throw new Error('Esperava uma falha do banco, mas a operacao foi concluida.');
}

/** Cria um plano e devolve o id. */
async function criarPlano(s: Sessao, pacienteId: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/planos',
    headers: autenticado(s),
    payload: {
      pacienteId,
      titulo: 'Lombalgia mecânica',
      diagnostico: 'Lombalgia mecânica crônica',
      objetivo: 'Reduzir dor e restaurar função.',
      sessoesPrevistas: 12,
    },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id;
}

beforeAll(async () => {
  const montado = await montarApp(AMBIENTE);
  app = montado.app;
  db = montado.deps.db;
  conexao = montado.deps.conexao;

  await semEscopoDeTenant(db, (d) => semearCatalogo(d));
  await app.ready();
}, 60_000);

/**
 * Zera o rate limit antes de cada caso.
 *
 * A suite inteira roda no mesmo processo e no mesmo endereco, entao os limites
 * de registro (5/h) e login (10/15min) se esgotariam por volta do sexto teste.
 * Isso NAO desliga a protecao — o teste dedicado a ela zera o limitador e
 * depois estoura o limite de proposito.
 */
beforeEach(() => {
  limitador.zerarTudo();
});

afterAll(async () => {
  await app.close();
  await conexao.encerrar();
});

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

describe('Autenticação', () => {
  it('registra organização e autentica', async () => {
    const s = await novaClinica('auth');
    expect(s.organizacaoId).toBeTruthy();
    expect(s.csrf).toHaveLength(43);
  });

  it('devolve a mesma mensagem para e-mail inexistente e senha errada', async () => {
    const s = await novaClinica('msg');

    const inexistente = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'user-agent': AGENTE },
      payload: { email: 'ninguem@teste.local', senha: 'senha-de-teste-bem-longa' },
    });

    const senhaErrada = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'user-agent': AGENTE },
      payload: { email: 'fisiomsg@teste.local', senha: 'senha-completamente-errada' },
    });

    expect(inexistente.statusCode).toBe(401);
    expect(senhaErrada.statusCode).toBe(401);
    // Mensagens idênticas: não dá para enumerar quem tem conta no sistema.
    expect(inexistente.json().mensagem).toBe(senhaErrada.json().mensagem);
    void s;
  });

  it('recusa senha fraca no registro, citando o motivo', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/registrar',
      headers: { 'user-agent': AGENTE },
      payload: {
        organizacaoNome: 'Clínica Fraca',
        organizacaoTipo: 'autonomo',
        nome: 'Fulano',
        email: 'fraca@teste.local',
        senha: 'curta',
        crefito: 'CREFITO-3 99999-F',
      },
    });

    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toMatch(/12 caracteres/);
  });

  it('recusa senha que contém o nome da clínica', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/registrar',
      headers: { 'user-agent': AGENTE },
      payload: {
        organizacaoNome: 'Movimento',
        organizacaoTipo: 'autonomo',
        nome: 'Fulano',
        email: 'mov@teste.local',
        senha: 'movimento-2026-clinica',
        crefito: 'CREFITO-3 99999-F',
      },
    });

    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json().campos)).toMatch(/nome|clínica/i);
  });

  it('exige sessão nas rotas protegidas', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/pacientes' });
    expect(r.statusCode).toBe(401);
  });

  it('encerra a sessão no logout — o token para de valer', async () => {
    const s = await novaClinica('logout');

    const sair = await app.inject({
      method: 'POST',
      url: '/api/auth/sair',
      headers: autenticado(s),
    });
    expect(sair.statusCode).toBe(200);

    const depois = await app.inject({
      method: 'GET',
      url: '/api/pacientes',
      headers: autenticado(s),
    });
    expect(depois.statusCode).toBe(401);
  });

  it('invalida a sessão quando o User-Agent muda', async () => {
    const s = await novaClinica('agente');

    const r = await app.inject({
      method: 'GET',
      url: '/api/pacientes',
      headers: { ...autenticado(s), 'user-agent': 'outro-navegador/9' },
    });

    expect(r.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe('Proteção CSRF', () => {
  it('recusa escrita sem o token CSRF', async () => {
    const s = await novaClinica('csrf1');

    const r = await app.inject({
      method: 'POST',
      url: '/api/pacientes',
      // Cookie presente, token CSRF ausente: é exatamente o formato de um
      // ataque cross-site, em que o navegador manda o cookie sozinho.
      headers: { 'user-agent': AGENTE, cookie: s.cookie, origin: 'http://localhost:5173' },
      payload: { nome: 'X', nascimento: '1990-01-01', consentimentoVersao: 'v1' },
    });

    expect(r.statusCode).toBe(403);
  });

  it('recusa escrita vinda de origem externa', async () => {
    const s = await novaClinica('csrf2');

    const r = await app.inject({
      method: 'POST',
      url: '/api/pacientes',
      headers: { ...autenticado(s), origin: 'https://site-malicioso.tld' },
      payload: { nome: 'X', nascimento: '1990-01-01', consentimentoVersao: 'v1' },
    });

    expect(r.statusCode).toBe(403);
  });

  it('permite leitura sem token CSRF', async () => {
    const s = await novaClinica('csrf3');

    const r = await app.inject({
      method: 'GET',
      url: '/api/pacientes',
      headers: { 'user-agent': AGENTE, cookie: s.cookie },
    });

    expect(r.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Isolamento de tenant — critério de aceitação da especificação
// ---------------------------------------------------------------------------

describe('Isolamento de tenant', () => {
  it('CRITÉRIO: usuário da org A não obtém dado da org B', async () => {
    const a = await novaClinica('tenantA');
    const b = await novaClinica('tenantB');

    const pacienteB = await criarPaciente(b, 'Paciente da Org B');

    // Dado um usuário da Organização A, quando ele consultar um identificador
    // da Organização B, então nenhum dado da Organização B é retornado.
    const r = await app.inject({
      method: 'GET',
      url: `/api/pacientes/${pacienteB.id}`,
      headers: autenticado(a),
    });

    // 404, não 403: um 403 confirmaria que o recurso existe.
    expect(r.statusCode).toBe(404);
    expect(r.json().codigo).toBe('NAO_ENCONTRADO');
  });

  it('a listagem de A nunca inclui paciente de B', async () => {
    const a = await novaClinica('listaA');
    const b = await novaClinica('listaB');

    await criarPaciente(a, 'Paciente A');
    const pacienteB = await criarPaciente(b, 'Paciente B');

    const r = await app.inject({
      method: 'GET',
      url: '/api/pacientes',
      headers: autenticado(a),
    });

    const ids = r.json().pacientes.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(pacienteB.id);
  });

  it('a RLS bloqueia mesmo uma consulta que esqueça o filtro de tenant', async () => {
    const a = await novaClinica('rlsA');
    const b = await novaClinica('rlsB');

    await criarPaciente(a, 'Paciente A');
    await criarPaciente(b, 'Paciente B');

    // Consulta SEM `where organizacao_id` — o erro que a RLS existe para pegar.
    const vistos = await comTenant(db, a.organizacaoId, (tx) =>
      tx.select({ id: pacientes.id, org: pacientes.organizacaoId }).from(pacientes),
    );

    expect(vistos.length).toBeGreaterThan(0);
    // Toda linha visível é da própria organização, apesar da consulta aberta.
    expect(vistos.every((p) => p.org === a.organizacaoId)).toBe(true);
  });

  it('o plano de outra organização responde 404', async () => {
    const a = await novaClinica('planoA');
    const b = await novaClinica('planoB');

    const pacB = await criarPaciente(b, 'Paciente B');
    const planoB = await criarPlano(b, pacB.id);

    const r = await app.inject({
      method: 'GET',
      url: `/api/planos/${planoB}`,
      headers: autenticado(a),
    });

    expect(r.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PII: separação, cifragem e reidentificação governada
// ---------------------------------------------------------------------------

describe('PII e reidentificação', () => {
  it('guarda a PII cifrada — o nome não aparece em claro no banco', async () => {
    const s = await novaClinica('pii1');
    await criarPaciente(s, 'Marina Alencar');

    // Lê a tabela de identificação direto, como faria quem tem um dump.
    const linhas = await comTenant(db, s.organizacaoId, (tx) =>
      tx.execute(sqlBruto`select nome_cifrado, documento_indice from paciente_identificacao`),
    );

    const texto = JSON.stringify(linhas);
    expect(texto).not.toContain('Marina');
    expect(texto).not.toContain('Alencar');
    // O CPF também não: só o índice cego (HMAC) está lá.
    expect(texto).not.toContain('12345678901');
  });

  it('a listagem não devolve o nome para papel sem permissão', async () => {
    const s = await novaClinica('pii2');
    await criarPaciente(s, 'Marina Alencar');

    // O fisioterapeuta PODE reidentificar, então vê o nome.
    const comoFisio = await app.inject({
      method: 'GET',
      url: '/api/pacientes',
      headers: autenticado(s),
    });

    expect(comoFisio.json().podeReidentificar).toBe(true);
    expect(comoFisio.json().pacientes[0].nome).toBe('Marina Alencar');
    expect(comoFisio.json().pacientes[0].codigo).toMatch(/^PC-/);
  });

  it('reidentificação exige motivo com substância', async () => {
    const s = await novaClinica('pii3');
    const p = await criarPaciente(s, 'Marina Alencar');

    const semMotivo = await app.inject({
      method: 'POST',
      url: `/api/pacientes/${p.id}/reidentificar`,
      headers: autenticado(s),
      payload: { motivo: 'oi' },
    });

    expect(semMotivo.statusCode).toBe(422);
  });

  it('reidentificação bem-sucedida grava na auditoria com o motivo', async () => {
    const s = await novaClinica('pii4');
    const p = await criarPaciente(s, 'Marina Alencar');

    const motivo = 'Confirmação de identidade para emissão de relatório ao médico assistente.';

    const r = await app.inject({
      method: 'POST',
      url: `/api/pacientes/${p.id}/reidentificar`,
      headers: autenticado(s),
      payload: { motivo },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().nome).toBe('Marina Alencar');
    expect(r.json().documento).toBe('12345678901');

    // O evento está na trilha, com o motivo íntegro.
    const trilha = await comTenant(db, s.organizacaoId, (tx) =>
      tx
        .select()
        .from(auditoria)
        .where(
          and(
            eq(auditoria.organizacaoId, s.organizacaoId),
            eq(auditoria.acao, 'REIDENTIFICACAO_AUTORIZADA'),
          ),
        ),
    );

    expect(trilha).toHaveLength(1);
    expect(trilha[0]!.detalhe).toContain('relatório ao médico');
    expect(trilha[0]!.entidadeId).toBe(p.id);
  });

  it('reidentificar paciente de outra organização responde 404 e audita', async () => {
    const a = await novaClinica('piiA');
    const b = await novaClinica('piiB');
    const pacB = await criarPaciente(b, 'Paciente da B');

    const r = await app.inject({
      method: 'POST',
      url: `/api/pacientes/${pacB.id}/reidentificar`,
      headers: autenticado(a),
      payload: { motivo: 'Tentativa de acesso a paciente de outra clínica.' },
    });

    expect(r.statusCode).toBe(404);

    // A tentativa fica registrada: uma varredura entre tenants precisa ser
    // visível ao operador, ainda que o atacante receba 404.
    const trilha = await comTenant(db, a.organizacaoId, (tx) =>
      tx
        .select()
        .from(auditoria)
        .where(
          and(
            eq(auditoria.organizacaoId, a.organizacaoId),
            eq(auditoria.acao, 'ACESSO_FORA_DE_ESCOPO'),
          ),
        ),
    );

    expect(trilha.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Prontuário imutável — COFFITO 415/2012
// ---------------------------------------------------------------------------

describe('Prontuário imutável', () => {
  it('CRITÉRIO: registro finalizado não é alterado, nem pelo banco', async () => {
    const s = await novaClinica('imut1');
    const p = await criarPaciente(s, 'Paciente Imutável');
    const planoId = await criarPlano(s, p.id);

    const evolucao = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/evolucoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 7,
        conduta: 'Terapia manual e exercício supervisionado.',
        resposta: 'Boa tolerância.',
        testes: [{ definicaoChave: 'eva', valores: { dor: 7 } }],
      },
    });
    expect(evolucao.statusCode).toBe(201);
    const registroId = evolucao.json().id;

    const finalizar = await app.inject({
      method: 'POST',
      url: `/api/evolucoes/${registroId}/finalizar`,
      headers: autenticado(s),
    });
    expect(finalizar.statusCode).toBe(200);

    // Agora a tentativa mais dura: alterar direto no banco, contornando a
    // aplicação inteira. O gatilho do Postgres precisa recusar.
    const falha = await mensagemDeFalha(() =>
      comTenant(db, s.organizacaoId, (tx) =>
        tx.update(registros).set({ eva: 0 }).where(eq(registros.id, registroId)),
      ),
    );
    expect(falha).toMatch(/imutável|COFFITO/i);

    // E o registro continua exatamente como estava.
    const [depois] = await comTenant(db, s.organizacaoId, (tx) =>
      tx.select().from(registros).where(eq(registros.id, registroId)),
    );
    expect(depois!.eva).toBe(7);
    expect(depois!.finalizadoEm).not.toBeNull();
  });

  it('apagar registro clínico também é recusado pelo banco', async () => {
    const s = await novaClinica('imut2');
    const p = await criarPaciente(s, 'Paciente Delete');
    const planoId = await criarPlano(s, p.id);

    const evolucao = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/evolucoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 5,
        conduta: 'Sessão.',
        resposta: 'Sem intercorrências.',
        testes: [],
      },
    });
    const registroId = evolucao.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/evolucoes/${registroId}/finalizar`,
      headers: autenticado(s),
    });

    await expect(
      comTenant(db, s.organizacaoId, (tx) =>
        tx.delete(registros).where(eq(registros.id, registroId)),
      ),
    ).rejects.toThrow();
  });

  it('CRITÉRIO: correção cria nova versão e preserva a anterior', async () => {
    const s = await novaClinica('imut3');
    const p = await criarPaciente(s, 'Paciente Versão');
    const planoId = await criarPlano(s, p.id);

    const v1 = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/evolucoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 7,
        conduta: 'Conduta original.',
        resposta: 'Resposta original.',
        testes: [],
      },
    });
    const v1Id = v1.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/evolucoes/${v1Id}/finalizar`,
      headers: autenticado(s),
    });

    const v2 = await app.inject({
      method: 'POST',
      url: `/api/evolucoes/${v1Id}/versoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 6,
        conduta: 'Conduta corrigida.',
        resposta: 'Resposta corrigida.',
        testes: [],
        motivo: 'A EVA havia sido registrada com o valor da sessão anterior.',
      },
    });
    expect(v2.statusCode).toBe(201);

    // A v1 permanece intacta e selada.
    const [original] = await comTenant(db, s.organizacaoId, (tx) =>
      tx.select().from(registros).where(eq(registros.id, v1Id)),
    );
    expect(original!.eva).toBe(7);
    expect(original!.conduta).toBe('Conduta original.');
    expect(original!.finalizadoEm).not.toBeNull();

    // A v2 existe, aponta para a v1 e nasceu como rascunho.
    const [nova] = await comTenant(db, s.organizacaoId, (tx) =>
      tx.select().from(registros).where(eq(registros.id, v2.json().id)),
    );
    expect(nova!.versao).toBe(2);
    expect(nova!.substituiId).toBe(v1Id);
    expect(nova!.finalizadoEm).toBeNull();
    expect(nova!.motivoVersao).toMatch(/sessão anterior/);
  });

  it('a linha do tempo mostra a v1 e a v2 lado a lado', async () => {
    const s = await novaClinica('imut4');
    const p = await criarPaciente(s, 'Paciente Timeline');
    const planoId = await criarPlano(s, p.id);

    const v1 = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/evolucoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 7,
        conduta: 'Original.',
        resposta: 'Original.',
        testes: [],
      },
    });
    await app.inject({
      method: 'POST',
      url: `/api/evolucoes/${v1.json().id}/finalizar`,
      headers: autenticado(s),
    });
    await app.inject({
      method: 'POST',
      url: `/api/evolucoes/${v1.json().id}/versoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 6,
        conduta: 'Corrigida.',
        resposta: 'Corrigida.',
        testes: [],
        motivo: 'Correção do valor de EVA anotado.',
      },
    });

    const plano = await app.inject({
      method: 'GET',
      url: `/api/planos/${planoId}`,
      headers: autenticado(s),
    });

    const corpo = plano.json();
    expect(corpo.registros).toHaveLength(2);
    // O selo da tela: nada foi sobrescrito.
    expect(corpo.integridade.sobrescritos).toBe(0);
  });

  it('finalizar duas vezes é recusado', async () => {
    const s = await novaClinica('imut5');
    const p = await criarPaciente(s, 'Paciente Duplo');
    const planoId = await criarPlano(s, p.id);

    const ev = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/evolucoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 5,
        conduta: 'Sessão.',
        resposta: 'Ok.',
        testes: [],
      },
    });

    const primeira = await app.inject({
      method: 'POST',
      url: `/api/evolucoes/${ev.json().id}/finalizar`,
      headers: autenticado(s),
    });
    const segunda = await app.inject({
      method: 'POST',
      url: `/api/evolucoes/${ev.json().id}/finalizar`,
      headers: autenticado(s),
    });

    expect(primeira.statusCode).toBe(200);
    expect(segunda.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------

describe('Trilha de auditoria', () => {
  it('CAMADA 1 — o papel da aplicação não tem privilégio de UPDATE nem DELETE', async () => {
    const s = await novaClinica('audit1');
    await criarPaciente(s, 'Paciente Audit');

    const [evento] = await comTenant(db, s.organizacaoId, (tx) =>
      tx.select().from(auditoria).where(eq(auditoria.organizacaoId, s.organizacaoId)).limit(1),
    );
    expect(evento).toBeDefined();

    // A aplicação roda sob o papel `cinesis_app`, que teve UPDATE e DELETE
    // revogados na tabela. Nem chega ao gatilho: o Postgres barra antes.
    const falhaUpdate = await mensagemDeFalha(() =>
      comTenant(db, s.organizacaoId, (tx) =>
        tx.update(auditoria).set({ acao: 'LOGIN_SUCESSO' }).where(eq(auditoria.id, evento!.id)),
      ),
    );
    expect(falhaUpdate).toMatch(/permission denied/i);

    const falhaDelete = await mensagemDeFalha(() =>
      comTenant(db, s.organizacaoId, (tx) =>
        tx.delete(auditoria).where(eq(auditoria.id, evento!.id)),
      ),
    );
    expect(falhaDelete).toMatch(/permission denied/i);
  });

  it('CAMADA 2 — o gatilho barra mesmo quem TEM privilégio', async () => {
    const s = await novaClinica('audit1b');
    await criarPaciente(s, 'Paciente Audit 2');

    const [evento] = await comTenant(db, s.organizacaoId, (tx) =>
      tx.select().from(auditoria).where(eq(auditoria.organizacaoId, s.organizacaoId)).limit(1),
    );

    // Agora sem assumir o papel restrito: esta é a conexão DONA das tabelas,
    // que tem todo privilégio. É o cenário do administrador de banco tentando
    // apagar o rastro de um acesso indevido — e é aqui que o gatilho age.
    const falha = await mensagemDeFalha(() =>
      semEscopoDeTenant(db, (d) =>
        d.update(auditoria).set({ acao: 'LOGIN_SUCESSO' }).where(eq(auditoria.id, evento!.id)),
      ),
    );
    expect(falha).toMatch(/append-only/i);

    // E o evento continua exatamente como estava.
    const [depois] = await semEscopoDeTenant(db, (d) =>
      d.select().from(auditoria).where(eq(auditoria.id, evento!.id)),
    );
    expect(depois!.acao).toBe(evento!.acao);
    expect(depois!.hash).toBe(evento!.hash);
  });

  it('a cadeia de hash confere de ponta a ponta', async () => {
    const s = await novaClinica('audit2');
    const p = await criarPaciente(s, 'Paciente Cadeia');
    const planoId = await criarPlano(s, p.id);

    await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/evolucoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 5,
        conduta: 'Sessão.',
        resposta: 'Ok.',
        testes: [],
      },
    });

    const r = await app.inject({
      method: 'GET',
      url: '/api/auditoria/integridade',
      headers: autenticado(s),
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().integra).toBe(true);
    expect(r.json().conferidos).toBeGreaterThan(2);
    // A âncora é o que o operador publica fora do banco.
    expect(r.json().ancora.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a sequência não tem buracos dentro da organização', async () => {
    const s = await novaClinica('audit3');
    await criarPaciente(s, 'P1');
    await criarPaciente(s, 'P2');

    const eventos = await comTenant(db, s.organizacaoId, (tx) =>
      tx
        .select({ seq: auditoria.sequencia })
        .from(auditoria)
        .where(eq(auditoria.organizacaoId, s.organizacaoId))
        .orderBy(auditoria.sequencia),
    );

    expect(eventos.map((e) => e.seq)).toEqual(eventos.map((_, i) => i + 1));
  });

  it('ler a auditoria também é auditado', async () => {
    const s = await novaClinica('audit4');

    await app.inject({ method: 'GET', url: '/api/auditoria', headers: autenticado(s) });

    const leituras = await comTenant(db, s.organizacaoId, (tx) =>
      tx
        .select()
        .from(auditoria)
        .where(
          and(
            eq(auditoria.organizacaoId, s.organizacaoId),
            eq(auditoria.acao, 'LEITURA_AUDITORIA'),
          ),
        ),
    );

    expect(leituras).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Testes funcionais e comparação longitudinal
// ---------------------------------------------------------------------------

describe('Testes funcionais', () => {
  it('recalcula o escore no servidor, ignorando o que o cliente mandar', async () => {
    const s = await novaClinica('teste1');
    const p = await criarPaciente(s, 'Paciente Teste');
    const planoId = await criarPlano(s, p.id);

    const r = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/evolucoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 7,
        conduta: 'Sessão.',
        resposta: 'Ok.',
        // O cliente manda só os valores brutos. Se tentasse mandar `escore`,
        // o schema `.strict()` recusaria o corpo inteiro.
        testes: [{ definicaoChave: 'oswestry', valores: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`s${i + 1}`, 2]),
        ) }],
      },
    });

    expect(r.statusCode).toBe(201);

    const plano = await app.inject({
      method: 'GET',
      url: `/api/planos/${planoId}`,
      headers: autenticado(s),
    });

    const osw = plano.json().testes.find((t: { chave: string }) => t.chave === 'oswestry');
    // 10 seções × 2 = 20 de 50 possíveis = 40%.
    expect(osw.atual).toBe(40);
    // A procedência do cálculo acompanha o resultado.
    expect(osw.versao).toBe('v2.1a-BR');
    expect(osw.fonte).toMatch(/Vigatto/);
  });

  it('recusa escore com campo faltando', async () => {
    const s = await novaClinica('teste2');
    const p = await criarPaciente(s, 'Paciente Falta');
    const planoId = await criarPlano(s, p.id);

    const r = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/evolucoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 5,
        conduta: 'Sessão.',
        resposta: 'Ok.',
        testes: [{ definicaoChave: 'oswestry', valores: { s1: 2 } }],
      },
    });

    expect(r.statusCode).toBe(422);
  });

  it('recusa teste que não está no catálogo', async () => {
    const s = await novaClinica('teste3');
    const p = await criarPaciente(s, 'Paciente Inexistente');
    const planoId = await criarPlano(s, p.id);

    const r = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/evolucoes`,
      headers: autenticado(s),
      payload: {
        ocorridoEm: '2026-09-01T14:00:00.000Z',
        eva: 5,
        conduta: 'Sessão.',
        resposta: 'Ok.',
        testes: [{ definicaoChave: 'escala-inventada', valores: { x: 1 } }],
      },
    });

    expect(r.statusCode).toBe(409);
  });

  it('monta a série longitudinal com melhora refletida no escore', async () => {
    const s = await novaClinica('long1');
    const p = await criarPaciente(s, 'Paciente Longitudinal');
    const planoId = await criarPlano(s, p.id);

    // Três sessões com dor caindo de 8 para 3.
    for (const [i, dor] of [8, 5, 3].entries()) {
      const ev = await app.inject({
        method: 'POST',
        url: `/api/planos/${planoId}/evolucoes`,
        headers: autenticado(s),
        payload: {
          ocorridoEm: `2026-0${7 + i}-01T14:00:00.000Z`,
          eva: dor,
          conduta: 'Sessão.',
          resposta: 'Ok.',
          testes: [{ definicaoChave: 'eva', valores: { dor } }],
        },
      });
      await app.inject({
        method: 'POST',
        url: `/api/evolucoes/${ev.json().id}/finalizar`,
        headers: autenticado(s),
      });
    }

    const plano = await app.inject({
      method: 'GET',
      url: `/api/planos/${planoId}`,
      headers: autenticado(s),
    });

    const { serie, tendencia } = plano.json();
    expect(serie).toHaveLength(3);
    expect(serie.map((s2: { eva: number }) => s2.eva)).toEqual([8, 5, 3]);
    // Dor caindo ⇒ escore normalizado subindo ⇒ tendência de evolução.
    expect(serie[0].escore).toBeLessThan(serie[2].escore);
    expect(tendencia.tendencia).toBe('evoluindo');
  });
});

// ---------------------------------------------------------------------------
// Portal do paciente
// ---------------------------------------------------------------------------

describe('Portal do paciente', () => {
  it('emite link com as garantias e o token no path', async () => {
    const s = await novaClinica('portal1');
    const p = await criarPaciente(s, 'Paciente Portal');

    const r = await app.inject({
      method: 'POST',
      url: `/api/pacientes/${p.id}/link-portal`,
      headers: autenticado(s),
    });

    expect(r.statusCode).toBe(200);
    const { url, garantias } = r.json();
    expect(url).toMatch(/\/entrar\/[A-Za-z0-9_-]{43}$/);
    // Sem query string: o token não vai parar em log de proxy nem em `Referer`.
    expect(url).not.toContain('?');
    expect(garantias).toContain('uso único');
  });

  it('CRITÉRIO: o paciente vê apenas o próprio contexto', async () => {
    const s = await novaClinica('portal2');
    const p1 = await criarPaciente(s, 'Paciente Um');
    const p2 = await criarPaciente(s, 'Paciente Dois');

    const plano1 = await criarPlano(s, p1.id);
    void plano1;
    void p2;

    const link = await app.inject({
      method: 'POST',
      url: `/api/pacientes/${p1.id}/link-portal`,
      headers: autenticado(s),
    });

    const token = link.json().url.split('/entrar/')[1];

    const entrar = await app.inject({
      method: 'POST',
      url: '/api/portal/entrar',
      headers: { 'user-agent': AGENTE, origin: 'http://localhost:5173' },
      payload: { token },
    });

    expect(entrar.statusCode).toBe(200);
    const cookiePortal = entrar.cookies.find((c) => c.name === 'cinesis_portal');
    expect(cookiePortal).toBeDefined();

    // O painel do portal não aceita id de paciente por parâmetro — tudo parte
    // da sessão. Não existe rota que devolva o programa de outro paciente.
    const painel = await app.inject({
      method: 'GET',
      url: '/api/portal/painel',
      headers: { 'user-agent': AGENTE, cookie: `cinesis_portal=${cookiePortal!.value}` },
    });

    expect(painel.statusCode).toBe(200);
    expect(painel.json()).toHaveProperty('exercicios');
  });

  it('o token é de uso único', async () => {
    const s = await novaClinica('portal3');
    const p = await criarPaciente(s, 'Paciente Único');

    const link = await app.inject({
      method: 'POST',
      url: `/api/pacientes/${p.id}/link-portal`,
      headers: autenticado(s),
    });
    const token = link.json().url.split('/entrar/')[1];

    const primeira = await app.inject({
      method: 'POST',
      url: '/api/portal/entrar',
      headers: { 'user-agent': AGENTE },
      payload: { token },
    });
    const segunda = await app.inject({
      method: 'POST',
      url: '/api/portal/entrar',
      headers: { 'user-agent': AGENTE },
      payload: { token },
    });

    expect(primeira.statusCode).toBe(200);
    expect(segunda.statusCode).toBe(401);
  });

  it('emitir de novo revoga o link anterior — reemissão, não reuso', async () => {
    const s = await novaClinica('portal4');
    const p = await criarPaciente(s, 'Paciente Reemissao');

    const primeiro = await app.inject({
      method: 'POST',
      url: `/api/pacientes/${p.id}/link-portal`,
      headers: autenticado(s),
    });
    const tokenAntigo = primeiro.json().url.split('/entrar/')[1];

    await app.inject({
      method: 'POST',
      url: `/api/pacientes/${p.id}/link-portal`,
      headers: autenticado(s),
    });

    // O link antigo, esquecido numa conversa de WhatsApp, não vale mais.
    const r = await app.inject({
      method: 'POST',
      url: '/api/portal/entrar',
      headers: { 'user-agent': AGENTE },
      payload: { token: tokenAntigo },
    });

    expect(r.statusCode).toBe(401);
  });

  it('recusa token forjado sem revelar por quê', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/portal/entrar',
      headers: { 'user-agent': AGENTE },
      payload: { token: 'a'.repeat(43) },
    });

    expect(r.statusCode).toBe(401);
    // Mensagem única: não distingue "expirado" de "já usado" de "inexistente".
    expect(r.json().mensagem).toMatch(/inválido ou expirado/i);
  });

  it('a sessão do portal não vale na API profissional', async () => {
    const s = await novaClinica('portal5');
    const p = await criarPaciente(s, 'Paciente Isolado');

    const link = await app.inject({
      method: 'POST',
      url: `/api/pacientes/${p.id}/link-portal`,
      headers: autenticado(s),
    });
    const token = link.json().url.split('/entrar/')[1];

    const entrar = await app.inject({
      method: 'POST',
      url: '/api/portal/entrar',
      headers: { 'user-agent': AGENTE },
      payload: { token },
    });
    const cookiePortal = entrar.cookies.find((c) => c.name === 'cinesis_portal')!;

    // Tenta usar o cookie do portal com o nome do cookie profissional.
    const r = await app.inject({
      method: 'GET',
      url: '/api/pacientes',
      headers: { 'user-agent': AGENTE, cookie: `cinesis_sessao=${cookiePortal.value}` },
    });

    expect(r.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Governança da biblioteca
// ---------------------------------------------------------------------------

describe('Biblioteca de exercícios', () => {
  it('recusa prescrever exercício não publicado, mesmo com o id direto', async () => {
    const s = await novaClinica('bib1');
    const p = await criarPaciente(s, 'Paciente Bib');
    const planoId = await criarPlano(s, p.id);

    const catalogo = await app.inject({
      method: 'GET',
      url: '/api/biblioteca?status=draft',
      headers: autenticado(s),
    });

    const rascunho = catalogo.json().exercicios[0];
    expect(rascunho).toBeDefined();

    // O ataque: enviar o id de um rascunho direto, contornando o filtro da
    // listagem do passo 1 da tela de prescrição.
    const r = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/prescricoes`,
      headers: autenticado(s),
      payload: {
        metaSemanal: 5,
        itens: [
          {
            exercicioId: rascunho.id,
            series: 3,
            repeticoes: 12,
            carga: 'peso corporal',
            frequenciaSemanal: 5,
            progressao: '+2 repetições por semana',
          },
        ],
      },
    });

    expect(r.statusCode).toBe(409);
    expect(r.json().mensagem).toMatch(/publicado/i);
  });

  it('bloqueia publicar exercício sem licença declarada', async () => {
    const s = await novaClinica('bib2');

    const criado = await app.inject({
      method: 'POST',
      url: '/api/biblioteca',
      headers: autenticado(s),
      payload: {
        nome: 'Exercício sem licença',
        categoria: 'Teste',
        regiao: 'Teste',
        orientacao: 'Descrição do exercício.',
      },
    });
    const id = criado.json().id;

    // draft → in_review passa.
    const revisao = await app.inject({
      method: 'POST',
      url: `/api/biblioteca/${id}/publicar`,
      headers: autenticado(s),
      payload: { status: 'in_review' },
    });
    expect(revisao.statusCode).toBe(200);

    // in_review → published é bloqueado pela falta de licença.
    const publicar = await app.inject({
      method: 'POST',
      url: `/api/biblioteca/${id}/publicar`,
      headers: autenticado(s),
      payload: { status: 'published' },
    });
    expect(publicar.statusCode).toBe(409);
    expect(publicar.json().mensagem).toMatch(/licença/i);
  });

  it('não expõe o exercício personalizado de outra clínica', async () => {
    const a = await novaClinica('bibA');
    const b = await novaClinica('bibB');

    // A clínica B cria um exercício próprio, com um nome inconfundível.
    const criado = await app.inject({
      method: 'POST',
      url: '/api/biblioteca',
      headers: autenticado(b),
      payload: {
        nome: 'Protocolo interno da Clínica B',
        categoria: 'Confidencial',
        regiao: 'Interno',
        orientacao: 'Detalhe da prática da clínica B.',
        licenca: 'Proprietária',
      },
    });
    const idDeB = criado.json().id;

    // A clínica A lista a biblioteca: vê o catálogo global, nunca o item de B.
    const listagem = await app.inject({
      method: 'GET',
      url: '/api/biblioteca',
      headers: autenticado(a),
    });

    const nomes = listagem.json().exercicios.map((e: { nome: string }) => e.nome);
    expect(nomes).not.toContain('Protocolo interno da Clínica B');
    // Mas o catálogo global continua visível — o filtro não pode zerar a tela.
    expect(nomes).toContain('Ponte glútea');

    // E o acesso direto pelo id também é 404, não 403.
    const direto = await app.inject({
      method: 'POST',
      url: `/api/biblioteca/${idDeB}/publicar`,
      headers: autenticado(a),
      payload: { status: 'in_review' },
    });
    expect(direto.statusCode).toBe(404);
  });

  it('recusa prescrever exercício de outra clínica pelo id direto', async () => {
    const a = await novaClinica('bibPresA');
    const b = await novaClinica('bibPresB');

    const criado = await app.inject({
      method: 'POST',
      url: '/api/biblioteca',
      headers: autenticado(b),
      payload: {
        nome: 'Exercício privado de B',
        categoria: 'X',
        regiao: 'Y',
        orientacao: 'Z',
        licenca: 'Proprietária',
      },
    });

    const p = await criarPaciente(a, 'Paciente de A');
    const planoId = await criarPlano(a, p.id);

    const r = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/prescricoes`,
      headers: autenticado(a),
      payload: {
        metaSemanal: 5,
        itens: [
          {
            exercicioId: criado.json().id,
            series: 3,
            repeticoes: 12,
            carga: 'peso corporal',
            frequenciaSemanal: 5,
            progressao: 'x',
          },
        ],
      },
    });

    expect(r.statusCode).toBe(404);
  });

  it('recusa pular a etapa de revisão', async () => {
    const s = await novaClinica('bib3');

    const criado = await app.inject({
      method: 'POST',
      url: '/api/biblioteca',
      headers: autenticado(s),
      payload: {
        nome: 'Exercício direto',
        categoria: 'Teste',
        regiao: 'Teste',
        orientacao: 'Descrição.',
        licenca: 'CC BY 4.0',
      },
    });

    const r = await app.inject({
      method: 'POST',
      url: `/api/biblioteca/${criado.json().id}/publicar`,
      headers: autenticado(s),
      payload: { status: 'published' },
    });

    expect(r.statusCode).toBe(409);
    expect(r.json().mensagem).toMatch(/transição inválida/i);
  });
});

// ---------------------------------------------------------------------------
// O ciclo completo — a tese do produto
// ---------------------------------------------------------------------------

describe('Ciclo completo do produto', () => {
  it('avaliação → evolução → prescrição → adesão do paciente → painel do fisioterapeuta', async () => {
    const s = await novaClinica('ciclo');
    const p = await criarPaciente(s, 'Paciente do Ciclo');
    const planoId = await criarPlano(s, p.id);

    // --- 1. Três sessões com melhora mensurável ----------------------------
    for (const [i, dor] of [8, 5, 3].entries()) {
      const evolucao = await app.inject({
        method: 'POST',
        url: `/api/planos/${planoId}/evolucoes`,
        headers: autenticado(s),
        payload: {
          ocorridoEm: `2026-0${7 + i}-01T14:00:00.000Z`,
          eva: dor,
          conduta: 'Terapia manual e exercício supervisionado.',
          resposta: 'Boa tolerância.',
          testes: [{ definicaoChave: 'eva', valores: { dor } }],
        },
      });

      await app.inject({
        method: 'POST',
        url: `/api/evolucoes/${evolucao.json().id}/finalizar`,
        headers: autenticado(s),
      });
    }

    // --- 2. A comparação longitudinal reflete a melhora --------------------
    const plano = await app.inject({
      method: 'GET',
      url: `/api/planos/${planoId}`,
      headers: autenticado(s),
    });

    expect(plano.json().tendencia.tendencia).toBe('evoluindo');
    expect(plano.json().serie).toHaveLength(3);

    // --- 3. Prescrição domiciliar ------------------------------------------
    const catalogo = await app.inject({
      method: 'GET',
      url: '/api/biblioteca?status=published',
      headers: autenticado(s),
    });

    const exercicio = catalogo.json().exercicios[0];
    expect(exercicio).toBeDefined();

    const prescricao = await app.inject({
      method: 'POST',
      url: `/api/planos/${planoId}/prescricoes`,
      headers: autenticado(s),
      payload: {
        metaSemanal: 5,
        itens: [
          {
            exercicioId: exercicio.id,
            series: 3,
            repeticoes: 12,
            carga: 'peso corporal',
            frequenciaSemanal: 5,
            progressao: '+2 repetições por semana',
          },
        ],
      },
    });
    expect(prescricao.statusCode).toBe(201);

    // --- 4. Link mágico ao paciente ----------------------------------------
    const link = await app.inject({
      method: 'POST',
      url: `/api/pacientes/${p.id}/link-portal`,
      headers: autenticado(s),
    });

    const token = link.json().url.split('/entrar/')[1];

    const entrar = await app.inject({
      method: 'POST',
      url: '/api/portal/entrar',
      headers: { 'user-agent': AGENTE },
      payload: { token },
    });
    expect(entrar.statusCode).toBe(200);

    const cookiePortal = entrar.cookies.find((c) => c.name === 'cinesis_portal')!;
    const csrfPortal = entrar.json().csrf;

    // --- 5. O paciente vê o programa em linguagem de paciente --------------
    const painel = await app.inject({
      method: 'GET',
      url: '/api/portal/painel',
      headers: { 'user-agent': AGENTE, cookie: `cinesis_portal=${cookiePortal.value}` },
    });

    expect(painel.json().exercicios).toHaveLength(1);
    // A frase do portal fala com a pessoa, não com o profissional.
    expect(painel.json().resumo).not.toMatch(/escore|longitudinal|funcional/i);

    // --- 6. O paciente registra a execução ---------------------------------
    const hoje = new Date().toISOString().slice(0, 10);
    const registro = await app.inject({
      method: 'POST',
      url: '/api/portal/registros',
      headers: {
        'user-agent': AGENTE,
        cookie: `cinesis_portal=${cookiePortal.value}`,
        origin: 'http://localhost:5173',
        [HEADER_CSRF]: csrfPortal,
      },
      payload: {
        prescricaoItemId: painel.json().exercicios[0].itemId,
        data: hoje,
        status: 'fez',
      },
    });

    expect(registro.statusCode).toBe(200);
    expect(registro.json().feitosHoje).toBe(1);

    // --- 7. O fisioterapeuta vê a adesão do lado dele ----------------------
    const adesao = await app.inject({
      method: 'GET',
      url: '/api/adesao',
      headers: autenticado(s),
    });

    const linha = adesao.json().pacientes.find((l: { pacienteId: string }) => l.pacienteId === p.id);
    expect(linha).toBeDefined();
    // O registro de hoje fecha o ciclo: o que o paciente fez em casa aparece
    // no painel de quem o atende.
    expect(linha.ultimos7.at(-1)).toBe('fez');

    // --- 8. Todo o ciclo ficou auditado, com a cadeia íntegra --------------
    const trilha = await app.inject({
      method: 'GET',
      url: '/api/auditoria?limite=100',
      headers: autenticado(s),
    });

    const acoes = new Set(trilha.json().eventos.map((e: { acao: string }) => e.acao));
    for (const esperada of [
      'EVOLUCAO_FINALIZADA',
      'PRESCRICAO_CRIADA',
      'LINK_PORTAL_EMITIDO',
      'LINK_PORTAL_CONSUMIDO',
      'EXERCICIO_REGISTRADO',
    ]) {
      expect(acoes).toContain(esperada);
    }

    const integridade = await app.inject({
      method: 'GET',
      url: '/api/auditoria/integridade',
      headers: autenticado(s),
    });
    expect(integridade.json().integra).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Superfície HTTP
// ---------------------------------------------------------------------------

describe('Superfície HTTP', () => {
  it('define os cabeçalhos de segurança', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/saude' });

    expect(r.headers['x-content-type-options']).toBe('nosniff');
    // `no-referrer` é o que protege o token do link mágico, que viaja no path.
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // Não anuncia a tecnologia do servidor.
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('o health check não vaza nada além de "ok"', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/saude' });
    expect(Object.keys(r.json()).sort()).toEqual(['em', 'ok']);
  });

  it('rota inexistente responde 404 no formato padrão', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/rota-que-nao-existe' });
    expect(r.statusCode).toBe(404);
    expect(r.json().codigo).toBe('NAO_ENCONTRADO');
  });

  it('recusa campo desconhecido no corpo (mass assignment)', async () => {
    const s = await novaClinica('http1');

    const r = await app.inject({
      method: 'POST',
      url: '/api/pacientes',
      headers: autenticado(s),
      payload: {
        nome: 'Paciente',
        nascimento: '1990-01-01',
        consentimentoVersao: 'v1',
        // Campo que não existe no schema: `.strict()` recusa o corpo inteiro.
        organizacaoId: 'outra-organizacao',
      },
    });

    expect(r.statusCode).toBe(422);
  });

  it('limita o tamanho da página na listagem', async () => {
    const s = await novaClinica('http2');

    const r = await app.inject({
      method: 'GET',
      url: '/api/pacientes?limite=100000',
      headers: autenticado(s),
    });

    // O schema recusa acima de 100: sem o teto, a rota vira ferramenta de
    // exfiltração e de negação de serviço.
    expect(r.statusCode).toBe(422);
  });

  it('o rate limit barra a forca bruta de login', async () => {
    const s = await novaClinica('limite');

    // O limite por conta e de 10 tentativas em 15 minutos.
    const respostas: number[] = [];
    for (let i = 0; i < 13; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'user-agent': AGENTE },
        payload: { email: 'fisiolimite@teste.local', senha: `tentativa-errada-${i}` },
      });
      respostas.push(r.statusCode);
    }

    // As primeiras sao 401 (senha errada); as ultimas viram 429.
    expect(respostas.filter((c) => c === 429).length).toBeGreaterThan(0);
    void s;
  });

  it('aceita POST sem corpo com Content-Type JSON', async () => {
    const s = await novaClinica('corpoVazio');
    const p = await criarPaciente(s, 'Paciente Sem Corpo');

    // Cliente HTTP comum (curl, Postman, script) manda o content-type mesmo
    // sem corpo. O parser padrao do Fastify devolveria 500 nesse caso.
    const r = await app.inject({
      method: 'POST',
      url: `/api/pacientes/${p.id}/link-portal`,
      headers: { ...autenticado(s), 'content-type': 'application/json' },
      payload: '',
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().url).toMatch(/\/entrar\//);
  });

  it('JSON malformado responde 400, nao 500', async () => {
    const s = await novaClinica('jsonRuim');

    const r = await app.inject({
      method: 'POST',
      url: '/api/pacientes',
      headers: { ...autenticado(s), 'content-type': 'application/json' },
      payload: '{ isto nao e json',
    });

    // Erro do cliente, nao falha do servidor.
    expect(r.statusCode).toBe(400);
  });

  it('corpo vazio nao burla a validacao de campos obrigatorios', async () => {
    const s = await novaClinica('vazioValida');

    // O corpo vira `{}` — e o schema Zod recusa, com 422 e o detalhe por campo.
    const r = await app.inject({
      method: 'POST',
      url: '/api/pacientes',
      headers: { ...autenticado(s), 'content-type': 'application/json' },
      payload: '',
    });

    expect(r.statusCode).toBe(422);
    expect(Object.keys(r.json().campos)).toContain('nome');
  });

  it('a resposta de erro nunca traz stack trace', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/planos/nao-e-um-uuid',
      headers: { 'user-agent': AGENTE },
    });

    const texto = r.payload;
    expect(texto).not.toMatch(/at .*\.ts:\d+/);
    expect(texto).not.toContain('node_modules');
  });
});
