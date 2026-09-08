/**
 * Testes da fundação de segurança.
 *
 * Prioridade de cobertura, conforme a especificação (seção 8.3): autorização,
 * isolamento de tenant, imutabilidade, auditoria, consentimento, cálculo
 * clínico, adesão, autenticação do portal, upload/mídia.
 *
 * Este arquivo cobre a parte que não depende de banco. O que exige persistência
 * está em `apps/api/test/`.
 */

import { describe, it, expect } from 'vitest';
import {
  Anel,
  cifrar,
  decifrar,
  precisaRecifrar,
  indiceCego,
  indicesCegosParaBusca,
  codigoPseudonimo,
  idadeEmAnos,
  nomeExibivel,
  derivarSenha,
  conferirSenha,
  verificarPolitica,
  precisaReforcar,
  GestorSessao,
  ArmazenamentoMemoria,
  TIMEOUT_INATIVIDADE_S,
  TIMEOUT_ABSOLUTO_S,
  verificarCsrf,
  gerarSegredoMfa,
  conferirTotp,
  conferirRecuperacao,
  encadear,
  verificarCadeia,
  HASH_GENESIS,
  type EventoParaGravar,
  type EventoEncadeado,
  emitirTokenPortal,
  hashDoToken,
  validarToken,
  extrairTokenDaUrl,
  montarUrlPortal,
  redigir,
  redigirTexto,
  mascararIp,
  Limitador,
  LIMITES,
  esperaDoBackoff,
  registrarFalha,
  validarUpload,
  removerExif,
  detectarTipo,
  Escopo,
  EscopoPortal,
  iguaisEmTempoConstante,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Anel de chaves e rotação
// ---------------------------------------------------------------------------

describe('Anel de chaves', () => {
  it('recusa subir sem nenhuma chave configurada', () => {
    expect(() => Anel.doAmbiente({})).toThrow(/vazio/i);
  });

  it('recusa chave curta demais', () => {
    const curta = Buffer.alloc(16).toString('base64'); // 16 bytes < 32.
    expect(() => Anel.doAmbiente({ CINESIS_KEY_V1: curta })).toThrow(/mínimo/i);
  });

  it('usa a maior versão para escrever e mantém as antigas para ler', () => {
    const anel = Anel.paraTeste(3);
    expect(anel.versaoAtual).toBe(3);
    expect(anel.versoes()).toEqual([3, 2, 1]);
    // Derivar uma versão antiga continua funcionando.
    expect(anel.derivar('cifragem-pii', 1)).toHaveLength(32);
  });

  it('deriva subchaves diferentes por finalidade', () => {
    const anel = Anel.paraTeste();
    // Se estas fossem iguais, vazar a chave de pseudonimização entregaria a de PII.
    expect(anel.derivar('pseudonimizacao').equals(anel.derivar('cifragem-pii'))).toBe(false);
    expect(anel.derivar('sessao').equals(anel.derivar('token-portal'))).toBe(false);
  });

  it('deriva a mesma subchave de forma estável', () => {
    const anel = Anel.paraTeste();
    expect(anel.derivar('sessao').equals(anel.derivar('sessao'))).toBe(true);
  });

  it('falha ao ler dado cifrado com uma versão que saiu do anel', () => {
    const anel = Anel.paraTeste();
    expect(() => anel.derivar('cifragem-pii', 99)).toThrow(/não está no anel/i);
  });
});

describe('Comparação em tempo constante', () => {
  it('reconhece iguais e diferentes', () => {
    expect(iguaisEmTempoConstante('abc123', 'abc123')).toBe(true);
    expect(iguaisEmTempoConstante('abc123', 'abc124')).toBe(false);
  });

  it('não estoura com comprimentos diferentes', () => {
    expect(iguaisEmTempoConstante('a', 'abcdef')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cifragem de PII
// ---------------------------------------------------------------------------

describe('Cifragem de PII', () => {
  const anel = Anel.paraTeste();
  const aad = 'paciente:11111111-1111-4111-8111-111111111111';

  it('faz ida e volta preservando o valor', () => {
    const cifrado = cifrar(anel, 'Marina Alencar', aad);
    expect(cifrado).not.toContain('Marina');
    expect(decifrar(anel, cifrado, aad)).toBe('Marina Alencar');
  });

  it('produz ciphertext diferente a cada cifragem do mesmo valor', () => {
    // IV aleatório: sem isso, um observador do banco veria que dois pacientes
    // têm o mesmo nome só comparando as colunas.
    const a = cifrar(anel, 'João Silva', aad);
    const b = cifrar(anel, 'João Silva', aad);
    expect(a).not.toBe(b);
  });

  it('recusa decifrar com contexto (AAD) diferente', () => {
    // É isto que impede mover o nome cifrado do paciente A para a linha do B.
    const cifrado = cifrar(anel, 'Marina Alencar', 'paciente:A');
    expect(() => decifrar(anel, cifrado, 'paciente:B')).toThrow();
  });

  it('detecta adulteração do ciphertext', () => {
    const cifrado = cifrar(anel, 'Marina Alencar', aad);
    const partes = cifrado.split('$');
    // Vira um bit do ciphertext.
    const corrompido = Buffer.from(partes[4]!, 'base64url');
    corrompido[0] ^= 0x01;
    partes[4] = corrompido.toString('base64url');
    expect(() => decifrar(anel, partes.join('$'), aad)).toThrow();
  });

  it('recusa formato inválido', () => {
    expect(() => decifrar(anel, 'lixo', aad)).toThrow(/formato/i);
  });

  it('lê dado da versão antiga depois de rotacionar', () => {
    // Chaves fixas para que "antes" e "depois" compartilhem a v1.
    const chaveV1 = Buffer.alloc(32, 3).toString('base64');
    const chaveV2 = Buffer.alloc(32, 7).toString('base64');

    const antes = Anel.doAmbiente({ CINESIS_KEY_V1: chaveV1 });
    const cifradoV1 = cifrar(antes, 'Paciente Antigo', aad);

    // Rotação: a v1 permanece no anel (leitura), a v2 assume a escrita.
    const depois = Anel.doAmbiente({ CINESIS_KEY_V1: chaveV1, CINESIS_KEY_V2: chaveV2 });

    expect(depois.versaoAtual).toBe(2);
    expect(decifrar(depois, cifradoV1, aad)).toBe('Paciente Antigo');
    expect(precisaRecifrar(depois, cifradoV1)).toBe(true);

    const cifradoV2 = cifrar(depois, 'Paciente Novo', aad);
    expect(precisaRecifrar(depois, cifradoV2)).toBe(false);
  });
});

describe('Índice cego', () => {
  const anel = Anel.paraTeste();

  it('é determinístico para o mesmo valor', () => {
    expect(indiceCego(anel, '12345678900', 'cpf')).toBe(indiceCego(anel, '12345678900', 'cpf'));
  });

  it('normaliza pontuação, caixa e acento', () => {
    expect(indiceCego(anel, '123.456.789-00', 'cpf')).toBe(indiceCego(anel, '12345678900', 'cpf'));
    expect(indiceCego(anel, ' Ana@X.COM ', 'email')).toBe(indiceCego(anel, 'ana@x.com', 'email'));
    expect(indiceCego(anel, 'José', 'nome')).toBe(indiceCego(anel, 'jose', 'nome'));
  });

  it('separa domínios por campo', () => {
    // O mesmo número como CPF e como telefone não pode colidir.
    expect(indiceCego(anel, '12345678900', 'cpf')).not.toBe(
      indiceCego(anel, '12345678900', 'telefone'),
    );
  });

  it('não revela o valor original', () => {
    const idx = indiceCego(anel, '12345678900', 'cpf');
    expect(idx).not.toContain('12345678900');
    expect(idx).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it('gera índices de todas as versões para busca durante a rotação', () => {
    const multi = Anel.paraTeste(2);
    const indices = indicesCegosParaBusca(multi, '12345678900', 'cpf');
    expect(indices).toHaveLength(2);
    expect(indices.some((i) => i.startsWith('v1:'))).toBe(true);
    expect(indices.some((i) => i.startsWith('v2:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pseudonimização
// ---------------------------------------------------------------------------

describe('Pseudonimização', () => {
  const anel = Anel.paraTeste();
  const id = '11111111-1111-4111-8111-111111111111';

  it('gera código estável no formato esperado', () => {
    const c1 = codigoPseudonimo(anel, id);
    const c2 = codigoPseudonimo(anel, id);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^PC-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  });

  it('evita caracteres ambíguos no código', () => {
    // Testa muitos ids para garantir que o alfabeto nunca produz I, O, 0 ou 1.
    for (let i = 0; i < 300; i++) {
      const codigo = codigoPseudonimo(anel, `${id}-${i}`);
      expect(codigo.slice(3)).not.toMatch(/[IO01]/);
    }
  });

  it('gera códigos diferentes para pacientes diferentes', () => {
    const codigos = new Set(
      Array.from({ length: 200 }, (_, i) => codigoPseudonimo(anel, `paciente-${i}`)),
    );
    // Com 32^4 ≈ 1M combinações, 200 amostras sem colisão é o esperado.
    expect(codigos.size).toBe(200);
  });

  it('produz códigos diferentes em instalações com chaves diferentes', () => {
    // Chave distinta ⇒ código distinto. Impede correlacionar o mesmo paciente
    // entre duas clínicas que rodem o Cinesis.
    expect(codigoPseudonimo(Anel.paraTeste(), id)).not.toBe(
      codigoPseudonimo(Anel.paraTeste(), id),
    );
  });

  it('esconde o nome de quem não pode reidentificar', () => {
    expect(nomeExibivel(false, 'Marina Alencar', 'PC-4821')).toBe('PC-4821');
    expect(nomeExibivel(true, 'Marina Alencar', 'PC-4821')).toBe('Marina Alencar');
    // Sem nome carregado, cai no código mesmo com permissão.
    expect(nomeExibivel(true, null, 'PC-4821')).toBe('PC-4821');
  });

  it('calcula idade sem expor a data de nascimento', () => {
    const ref = new Date('2026-09-07T12:00:00Z');
    expect(idadeEmAnos('1990-09-07', ref)).toBe(36);
    expect(idadeEmAnos('1990-09-08', ref)).toBe(35); // Aniversário amanhã.
    expect(idadeEmAnos('1990-09-06', ref)).toBe(36);
    expect(idadeEmAnos('data-ruim', ref)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Senhas
// ---------------------------------------------------------------------------

describe('Senhas', () => {
  it('deriva com Argon2id e confere', async () => {
    const h = await derivarSenha('minha-senha-bem-longa');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await conferirSenha(h, 'minha-senha-bem-longa')).toBe(true);
    expect(await conferirSenha(h, 'minha-senha-bem-longo')).toBe(false);
  });

  it('usa parâmetros no piso recomendado pelo OWASP', async () => {
    const h = await derivarSenha('senha-para-checar-custo');
    const m = /\$m=(\d+),t=(\d+),p=(\d+)/.exec(h)!;
    expect(Number(m[1])).toBeGreaterThanOrEqual(19_456);
    expect(Number(m[2])).toBeGreaterThanOrEqual(2);
    expect(precisaReforcar(h)).toBe(false);
  });

  it('devolve false em vez de lançar com hash corrompido', async () => {
    expect(await conferirSenha('nao-e-um-hash', 'qualquer')).toBe(false);
  });

  it('marca hash de custo antigo para reforço', () => {
    expect(precisaReforcar('$argon2id$v=19$m=4096,t=1,p=1$abc$def')).toBe(true);
    expect(precisaReforcar('$2b$10$bcryptlegado')).toBe(true);
  });

  it('aplica a política de senha', () => {
    expect(verificarPolitica('curta').ok).toBe(false);
    expect(verificarPolitica('aaaaaaaaaaaaaa').ok).toBe(false); // Caractere repetido.
    expect(verificarPolitica('senha123456').ok).toBe(false); // Lista de proibidas.
    expect(verificarPolitica('clinica do vale 2026').ok).toBe(true);
  });

  it('recusa senha que contém o próprio identificador', () => {
    const r = verificarPolitica('helena-marques-2026', ['helena', 'helena@exemplo.br']);
    expect(r.ok).toBe(false);
    expect(r.motivos.join(' ')).toMatch(/nome|e-mail|clínica/i);
  });

  it('ignora pistas curtas demais para não gerar falso positivo', () => {
    // "ana" tem 3 letras e apareceria em milhares de senhas legítimas.
    expect(verificarPolitica('planalto central 9', ['ana']).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------

describe('Sessão opaca', () => {
  const anel = Anel.paraTeste();
  const AGENTE = 'Mozilla/5.0 (Windows NT 10.0)';

  function novoGestor() {
    return new GestorSessao(anel, new ArmazenamentoMemoria());
  }

  const base = {
    sujeitoId: 'prof-1',
    organizacaoId: 'org-1',
    papel: 'fisioterapeuta' as const,
    tipo: 'profissional' as const,
  };

  it('abre e valida uma sessão', async () => {
    const g = novoGestor();
    const { token, csrf } = await g.abrir(base, AGENTE);
    expect(token).toHaveLength(43); // 32 bytes em base64url.
    expect(csrf).toHaveLength(43);

    const r = await g.validar(token, AGENTE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dados.papel).toBe('fisioterapeuta');
  });

  it('nunca guarda o token em claro no armazenamento', async () => {
    const arm = new ArmazenamentoMemoria();
    const g = new GestorSessao(anel, arm);
    const { token } = await g.abrir(base, AGENTE);

    const chaves = (await arm.listarDoSujeito('prof-1')).map((s) => s.chave);
    expect(chaves).toHaveLength(1);
    // A chave é `sess:<hmac>` — o token não aparece nela.
    expect(chaves[0]).not.toContain(token);
    expect(chaves[0]).toMatch(/^sess:[0-9a-f]{64}$/);
  });

  it('recusa token desconhecido', async () => {
    const g = novoGestor();
    const r = await g.validar('token-que-nao-existe-aaaaaaaaaaaaaaaaaaaaaa', AGENTE);
    expect(r).toEqual({ ok: false, motivo: 'inexistente' });
  });

  it('encerra a sessão quando o User-Agent muda', async () => {
    const g = novoGestor();
    const { token } = await g.abrir(base, AGENTE);

    const r = await g.validar(token, 'curl/8.0');
    expect(r).toEqual({ ok: false, motivo: 'agente_divergente' });

    // A sessão morreu de vez — nem o dono legítimo a reaproveita.
    expect(await g.validar(token, AGENTE)).toEqual({ ok: false, motivo: 'inexistente' });
  });

  it('rotaciona o token ao mudar de papel', async () => {
    const g = novoGestor();
    const { token } = await g.abrir(base, AGENTE);

    const nova = await g.rotacionar(token, { papel: 'recepcao' }, AGENTE);
    expect(nova).not.toBeNull();
    expect(nova!.token).not.toBe(token);

    // O token antigo não vale mais — fecha fixação de sessão.
    expect(await g.validar(token, AGENTE)).toEqual({ ok: false, motivo: 'inexistente' });

    const r = await g.validar(nova!.token, AGENTE);
    expect(r.ok && r.dados.papel).toBe('recepcao');
  });

  it('revoga todas as sessões de um sujeito', async () => {
    const g = novoGestor();
    const a = await g.abrir(base, AGENTE);
    const b = await g.abrir(base, AGENTE);

    expect(await g.encerrarTodas('prof-1')).toBe(2);
    expect((await g.validar(a.token, AGENTE)).ok).toBe(false);
    expect((await g.validar(b.token, AGENTE)).ok).toBe(false);
  });

  it('define timeout absoluto menor para o portal do paciente', async () => {
    const g = novoGestor();
    const prof = await g.abrir(base, AGENTE);
    const pac = await g.abrir({ ...base, sujeitoId: 'pac-1', papel: 'paciente', tipo: 'paciente' }, AGENTE);

    // A sessão do paciente expira bem antes — dispositivo compartilhado.
    expect(pac.expiraEm).toBeLessThan(prof.expiraEm);
  });

  it('mantém os timeouts nos valores documentados', () => {
    expect(TIMEOUT_INATIVIDADE_S).toBe(30 * 60);
    expect(TIMEOUT_ABSOLUTO_S).toBe(12 * 60 * 60);
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe('CSRF', () => {
  const ORIGENS = ['https://clinica.exemplo.br'];

  it('libera métodos que não alteram estado', () => {
    expect(verificarCsrf('GET', undefined, 'tk', 'https://malicioso.tld', ORIGENS).ok).toBe(true);
  });

  it('exige token nas escritas', () => {
    const r = verificarCsrf('POST', undefined, 'tk', 'https://clinica.exemplo.br', ORIGENS);
    expect(r).toEqual({ ok: false, falha: 'token_ausente' });
  });

  it('recusa token divergente', () => {
    const r = verificarCsrf('POST', 'outro', 'tk', 'https://clinica.exemplo.br', ORIGENS);
    expect(r).toEqual({ ok: false, falha: 'token_divergente' });
  });

  it('recusa origem externa mesmo com token correto', () => {
    // Cenário do ataque: o site do atacante não conhece o token, mas se
    // conhecesse (por XSS num subdomínio), a checagem de origem ainda barra.
    const r = verificarCsrf('POST', 'tk', 'tk', 'https://malicioso.tld', ORIGENS);
    expect(r).toEqual({ ok: false, falha: 'origem_invalida' });
  });

  it('distingue esquema e porta na origem', () => {
    expect(verificarCsrf('POST', 'tk', 'tk', 'http://clinica.exemplo.br', ORIGENS).ok).toBe(false);
    expect(verificarCsrf('POST', 'tk', 'tk', 'https://clinica.exemplo.br:8443', ORIGENS).ok).toBe(false);
  });

  it('aceita requisição legítima', () => {
    expect(verificarCsrf('POST', 'tk', 'tk', 'https://clinica.exemplo.br', ORIGENS).ok).toBe(true);
  });

  it('aceita origem ausente (cliente não-navegador) apoiado no token', () => {
    expect(verificarCsrf('POST', 'tk', 'tk', undefined, ORIGENS).ok).toBe(true);
    expect(verificarCsrf('POST', 'errado', 'tk', undefined, ORIGENS).ok).toBe(false);
  });

  it('trata origem malformada como inválida', () => {
    expect(verificarCsrf('POST', 'tk', 'tk', 'nao-e-url', ORIGENS).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MFA
// ---------------------------------------------------------------------------

describe('Segundo fator', () => {
  it('gera segredo, URI e códigos de recuperação', () => {
    const s = gerarSegredoMfa('Cinesis', 'helena@exemplo.br');
    expect(s.segredoBase32.length).toBeGreaterThanOrEqual(32);
    expect(s.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(s.codigosRecuperacao).toHaveLength(8);
    expect(s.hashesRecuperacao).toHaveLength(8);
    // Os hashes não revelam os códigos.
    expect(s.hashesRecuperacao[0]).not.toContain(s.codigosRecuperacao[0]!.slice(0, 4));
  });

  it('recusa código TOTP fora do formato sem consultar o segredo', () => {
    const s = gerarSegredoMfa('Cinesis', 'a@b.c');
    expect(conferirTotp(s.segredoBase32, '12345')).toBe(false);
    expect(conferirTotp(s.segredoBase32, 'abcdef')).toBe(false);
    expect(conferirTotp(s.segredoBase32, '')).toBe(false);
  });

  it('recusa código errado', () => {
    const s = gerarSegredoMfa('Cinesis', 'a@b.c');
    expect(conferirTotp(s.segredoBase32, '000000')).toBe(false);
  });

  it('não lança com segredo corrompido', () => {
    expect(conferirTotp('nao-e-base32-valido!!!', '123456')).toBe(false);
  });

  it('consome código de recuperação de uso único', () => {
    const s = gerarSegredoMfa('Cinesis', 'a@b.c');
    const codigo = s.codigosRecuperacao[0]!;

    const consumido = conferirRecuperacao(s.hashesRecuperacao, codigo);
    expect(consumido).toBe(s.hashesRecuperacao[0]);

    // Depois de removido da lista, o mesmo código não vale mais.
    const restantes = s.hashesRecuperacao.filter((h) => h !== consumido);
    expect(conferirRecuperacao(restantes, codigo)).toBeNull();
  });

  it('recusa código de recuperação inventado', () => {
    const s = gerarSegredoMfa('Cinesis', 'a@b.c');
    expect(conferirRecuperacao(s.hashesRecuperacao, 'ABCD-1234')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auditoria encadeada
// ---------------------------------------------------------------------------

describe('Cadeia de auditoria', () => {
  function evento(n: number): EventoParaGravar {
    return {
      organizacaoId: 'org-1',
      atorId: 'prof-1',
      atorPapel: 'fisioterapeuta',
      acao: 'LEITURA_PRONTUARIO',
      entidade: 'Evolucao',
      entidadeId: `ev-${n}`,
      detalhe: null,
      ocorridoEm: new Date(Date.UTC(2026, 8, 7, 10, n)),
    };
  }

  /** Monta uma cadeia de `n` eventos, corretamente encadeada. */
  function cadeia(n: number): EventoEncadeado[] {
    const eventos: EventoEncadeado[] = [];
    let ultimo: EventoEncadeado | null = null;
    for (let i = 1; i <= n; i++) {
      ultimo = encadear(evento(i), ultimo);
      eventos.push(ultimo);
    }
    return eventos;
  }

  it('começa no gênesis e numera a partir de 1', () => {
    const primeiro = encadear(evento(1), null);
    expect(primeiro.sequencia).toBe(1);
    expect(primeiro.hashAnterior).toBe(HASH_GENESIS);
    expect(primeiro.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('valida uma cadeia íntegra', () => {
    const r = verificarCadeia(cadeia(50));
    expect(r).toEqual({ integra: true, conferidos: 50, quebraEm: null, motivo: null });
  });

  it('detecta alteração de conteúdo de um evento', () => {
    const c = cadeia(10);
    // Um administrador tenta apagar o rastro de um acesso indevido.
    c[4] = { ...c[4]!, acao: 'LOGIN_SUCESSO' };

    const r = verificarCadeia(c);
    expect(r.integra).toBe(false);
    expect(r.quebraEm).toBe(5);
    expect(r.motivo).toBe('hash_divergente');
  });

  it('detecta remoção de um evento', () => {
    const c = cadeia(10);
    c.splice(4, 1); // Remove o 5º.

    const r = verificarCadeia(c);
    expect(r.integra).toBe(false);
    expect(r.motivo).toBe('sequencia_com_buraco');
  });

  it('detecta elo reescrito', () => {
    const c = cadeia(10);
    c[6] = { ...c[6]!, hashAnterior: 'a'.repeat(64) };

    const r = verificarCadeia(c);
    expect(r.integra).toBe(false);
    expect(r.quebraEm).toBe(7);
    expect(r.motivo).toBe('elo_quebrado');
  });

  it('não deixa o campo detalhe forjar a fronteira entre campos', () => {
    // Tentativa de colisão: colocar o separador dentro do detalhe para
    // "empurrar" conteúdo para o campo seguinte.
    const a = encadear({ ...evento(1), detalhe: 'x\u001f2026-09-07T10:01:00.000Z' }, null);
    const b = encadear({ ...evento(1), detalhe: 'x' }, null);
    expect(a.hash).not.toBe(b.hash);
  });

  it('gera hashes diferentes para organizações diferentes', () => {
    const a = encadear(evento(1), null);
    const b = encadear({ ...evento(1), organizacaoId: 'org-2' }, null);
    expect(a.hash).not.toBe(b.hash);
  });
});

// ---------------------------------------------------------------------------
// Link mágico do portal
// ---------------------------------------------------------------------------

describe('Link mágico do portal', () => {
  const anel = Anel.paraTeste();

  it('emite token com 256 bits e expiração de 15 minutos', () => {
    const agora = new Date('2026-09-07T10:00:00Z');
    const t = emitirTokenPortal(anel, agora);

    expect(t.emClaro).toHaveLength(43);
    expect(t.expiraEm.getTime() - agora.getTime()).toBe(15 * 60 * 1000);
    // O que vai ao banco é o HMAC, não o token.
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hash).not.toContain(t.emClaro);
  });

  it('recalcula o mesmo hash para o mesmo token', () => {
    const t = emitirTokenPortal(anel);
    expect(hashDoToken(anel, t.emClaro)).toBe(t.hash);
  });

  it('emite tokens diferentes a cada chamada', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => emitirTokenPortal(anel).emClaro));
    expect(tokens.size).toBe(100);
  });

  it('recusa token inexistente, expirado, consumido ou revogado', () => {
    const agora = new Date('2026-09-07T10:20:00Z');
    const base = { expiraEm: new Date('2026-09-07T10:30:00Z'), consumidoEm: null, revogadoEm: null };

    expect(validarToken(null, agora)).toEqual({ ok: false, recusa: 'inexistente' });
    expect(validarToken({ ...base, expiraEm: new Date('2026-09-07T10:10:00Z') }, agora)).toEqual({
      ok: false,
      recusa: 'expirado',
    });
    expect(validarToken({ ...base, consumidoEm: new Date() }, agora)).toEqual({
      ok: false,
      recusa: 'ja_consumido',
    });
    expect(validarToken({ ...base, revogadoEm: new Date() }, agora)).toEqual({
      ok: false,
      recusa: 'revogado',
    });
    expect(validarToken(base, agora)).toEqual({ ok: true });
  });

  it('recusa exatamente no instante da expiração', () => {
    const t = new Date('2026-09-07T10:15:00Z');
    expect(validarToken({ expiraEm: t, consumidoEm: null, revogadoEm: null }, t).ok).toBe(false);
  });

  it('coloca o token no path, nunca na query', () => {
    const url = montarUrlPortal('https://clinica.exemplo.br', 'a'.repeat(43));
    expect(url).toBe(`https://clinica.exemplo.br/entrar/${'a'.repeat(43)}`);
    expect(url).not.toContain('?');
  });

  it('normaliza barra final da base', () => {
    expect(montarUrlPortal('https://x.br///', 'b'.repeat(43))).toBe(
      `https://x.br/entrar/${'b'.repeat(43)}`,
    );
  });

  it('extrai o token só no formato exato', () => {
    const tk = 'c'.repeat(43);
    expect(extrairTokenDaUrl(`https://x.br/entrar/${tk}`)).toBe(tk);
    expect(extrairTokenDaUrl(`https://x.br/entrar/${tk}?a=1`)).toBe(tk);
    expect(extrairTokenDaUrl('https://x.br/entrar/curto')).toBeNull();
    expect(extrairTokenDaUrl(`https://x.br/outra/${tk}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Redação de log
// ---------------------------------------------------------------------------

describe('Redação de log', () => {
  it('redige campo desconhecido por padrão', () => {
    // Lista de permissão: o campo novo que ninguém classificou não vaza.
    const r = redigir({ campoNovoQualquer: 'Marina Alencar' }) as Record<string, unknown>;
    expect(r.campoNovoQualquer).toBe('[redigido]');
  });

  it('preserva identificadores opacos e metadados técnicos', () => {
    const r = redigir({
      pacienteId: 'uuid-1',
      codigo: 'PC-4821',
      acao: 'LEITURA_PRONTUARIO',
      statusCode: 200,
      duracaoMs: 12,
    }) as Record<string, unknown>;

    expect(r).toEqual({
      pacienteId: 'uuid-1',
      codigo: 'PC-4821',
      acao: 'LEITURA_PRONTUARIO',
      statusCode: 200,
      duracaoMs: 12,
    });
  });

  it('apaga segredos por completo', () => {
    const r = redigir({
      senha: 'x',
      password: 'x',
      token: 'x',
      authorization: 'Bearer x',
      cookie: 'sess=x',
      csrf: 'x',
      apiKey: 'x',
      totp: '123456',
    }) as Record<string, unknown>;

    for (const v of Object.values(r)) expect(v).toBe('[redigido]');
  });

  it('mascara IP — nunca em claro, como exige a especificação', () => {
    expect(mascararIp('203.0.113.42')).toBe('203.0.113.0/24');
    expect(mascararIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1::/48');
    expect(mascararIp('')).toBe('[redigido]');

    const r = redigir({ ip: '203.0.113.42' }) as Record<string, unknown>;
    expect(r.ip).toBe('203.0.113.0/24');
  });

  it('mascara e-mail preservando só o domínio', () => {
    const r = redigir({ email: 'marina@clinica.com.br' }) as Record<string, unknown>;
    expect(r.email).toBe('[redigido]@clinica.com.br');
  });

  it('não copia propriedades extras de um erro customizado', () => {
    const erro = Object.assign(new Error('falhou'), { paciente: { nome: 'Marina' } });
    const r = redigir(erro) as Record<string, unknown>;
    expect(r.mensagem).toBe('falhou');
    expect(r.paciente).toBeUndefined();
  });

  it('sobrevive a referência circular', () => {
    const a: Record<string, unknown> = { id: '1' };
    a.self = a;
    expect(() => redigir(a)).not.toThrow();
    expect((redigir(a) as Record<string, unknown>).self).toBe('[circular]');
  });

  it('limita profundidade e tamanho de array', () => {
    let fundo: Record<string, unknown> = { id: 'fim' };
    for (let i = 0; i < 10; i++) fundo = { id: String(i), dentro: fundo };
    expect(JSON.stringify(redigir(fundo))).toContain('profundo demais');

    const grande = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
    const saida = redigir(grande) as unknown[];
    expect(saida).toHaveLength(21); // 20 itens + o marcador de omissão.
    expect(saida[20]).toBe('[+80 itens omitidos]');
  });

  it('varre PII de texto livre', () => {
    expect(redigirTexto('cpf 123.456.789-00 do paciente')).toBe('cpf [cpf] do paciente');
    expect(redigirTexto('contato marina@x.com.br')).toBe('contato [email]');
    expect(redigirTexto('ligar (11) 98765-4321')).toBe('ligar [telefone]');
  });
});

// ---------------------------------------------------------------------------
// Limites e backoff
// ---------------------------------------------------------------------------

describe('Limitação de taxa', () => {
  it('permite até o máximo e depois bloqueia', () => {
    const l = new Limitador();
    const cfg = { maximo: 3, janelaSegundos: 60 };

    for (let i = 0; i < 3; i++) expect(l.consumir('k', cfg, 1000).permitido).toBe(true);

    const bloqueado = l.consumir('k', cfg, 1000);
    expect(bloqueado.permitido).toBe(false);
    expect(bloqueado.aguardarSegundos).toBe(60);
  });

  it('desliza a janela em vez de zerar em blocos', () => {
    const l = new Limitador();
    const cfg = { maximo: 2, janelaSegundos: 10 };

    l.consumir('k', cfg, 0);
    l.consumir('k', cfg, 5_000);
    expect(l.consumir('k', cfg, 9_000).permitido).toBe(false);
    // Em t=11 s a primeira marca saiu da janela: abre uma vaga (só uma).
    expect(l.consumir('k', cfg, 11_000).permitido).toBe(true);
    expect(l.consumir('k', cfg, 11_000).permitido).toBe(false);
  });

  it('isola limites por chave', () => {
    const l = new Limitador();
    const cfg = { maximo: 1, janelaSegundos: 60 };
    expect(l.consumir('a', cfg, 0).permitido).toBe(true);
    expect(l.consumir('b', cfg, 0).permitido).toBe(true);
  });

  it('libera a chave após login bem-sucedido', () => {
    const l = new Limitador();
    const cfg = { maximo: 1, janelaSegundos: 60 };
    l.consumir('k', cfg, 0);
    l.liberar('k');
    expect(l.consumir('k', cfg, 0).permitido).toBe(true);
  });

  it('mantém o limite de 5/h do link mágico exigido na especificação', () => {
    expect(LIMITES.linkPortal).toEqual({ maximo: 5, janelaSegundos: 3600 });
  });
});

describe('Backoff progressivo', () => {
  it('tolera as primeiras falhas sem espera', () => {
    let e = null as Parameters<typeof esperaDoBackoff>[0];
    for (let i = 0; i < 3; i++) {
      e = registrarFalha(e, 1000);
      expect(esperaDoBackoff(e, 1000)).toBe(0);
    }
  });

  it('dobra a espera a cada falha depois das livres', () => {
    let e = registrarFalha(null, 0);
    for (let i = 0; i < 3; i++) e = registrarFalha(e, 0); // 4 falhas.
    expect(esperaDoBackoff(e, 0)).toBe(1);

    e = registrarFalha(e, 0); // 5.
    expect(esperaDoBackoff(e, 0)).toBe(2);

    e = registrarFalha(e, 0); // 6.
    expect(esperaDoBackoff(e, 0)).toBe(4);
  });

  it('respeita o teto de 5 minutos, sem bloqueio permanente', () => {
    let e = null as Parameters<typeof esperaDoBackoff>[0];
    for (let i = 0; i < 100; i++) e = registrarFalha(e, 0);
    // Teto: um atacante não tranca a conta do fisioterapeuta para sempre.
    expect(esperaDoBackoff(e, 0)).toBe(300);
  });

  it('zera a espera com a passagem do tempo', () => {
    let e = null as Parameters<typeof esperaDoBackoff>[0];
    for (let i = 0; i < 6; i++) e = registrarFalha(e, 0);
    expect(esperaDoBackoff(e, 0)).toBe(4);
    expect(esperaDoBackoff(e, 10_000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

describe('Upload de mídia', () => {
  /** Monta um JPEG mínimo com um segmento EXIF (APP1) e um SOS. */
  function jpegComExif(): Buffer {
    const soi = Buffer.from([0xff, 0xd8]);
    const exifConteudo = Buffer.from('Exif\0\0GPS 23.5 S 46.6 W', 'latin1');
    const app1 = Buffer.concat([
      Buffer.from([0xff, 0xe1]),
      (() => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(exifConteudo.length + 2);
        return b;
      })(),
      exifConteudo,
    ]);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0x00, 0x11, 0x22]);
    return Buffer.concat([soi, app1, sos]);
  }

  it('identifica o tipo pela assinatura, não pela extensão', () => {
    expect(detectarTipo(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg');
    expect(detectarTipo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mime).toBe(
      'image/png',
    );
    expect(detectarTipo(Buffer.from('nao e imagem nenhuma'))).toBeNull();
  });

  it('recusa executável disfarçado de imagem', () => {
    // `MZ` = cabeçalho de PE/EXE do Windows, com Content-Type mentindo.
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
    expect(validarUpload(exe, 'image/jpeg')).toEqual({ ok: false, recusa: 'tipo_nao_permitido' });
  });

  it('recusa SVG — é XML e pode carregar script', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
    expect(validarUpload(svg, 'image/svg+xml').ok).toBe(false);
  });

  it('recusa arquivo vazio', () => {
    expect(validarUpload(Buffer.alloc(0), 'image/jpeg')).toEqual({
      ok: false,
      recusa: 'arquivo_vazio',
    });
  });

  it('recusa quando o tipo declarado diverge do real', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(validarUpload(png, 'video/mp4')).toEqual({ ok: false, recusa: 'assinatura_divergente' });
  });

  it('aceita imagem legítima', () => {
    const r = validarUpload(jpegComExif(), 'image/jpeg');
    expect(r).toEqual({ ok: true, mime: 'image/jpeg', extensao: 'jpg', ehImagem: true });
  });

  it('remove EXIF — que num atendimento domiciliar carrega o endereço', () => {
    const original = jpegComExif();
    expect(original.includes(Buffer.from('GPS'))).toBe(true);

    const limpo = removerExif(original);
    expect(limpo.includes(Buffer.from('GPS'))).toBe(false);
    // Continua sendo um JPEG válido (SOI preservado).
    expect(limpo[0]).toBe(0xff);
    expect(limpo[1]).toBe(0xd8);
    expect(limpo.length).toBeLessThan(original.length);
  });

  it('devolve o original quando não é JPEG', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    expect(removerExif(png).equals(png)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Escopo / RBAC
// ---------------------------------------------------------------------------

describe('Escopo e RBAC', () => {
  const fisio = new Escopo('p1', 'org-1', 'fisioterapeuta');
  const recep = new Escopo('p2', 'org-1', 'recepcao');
  const estag = new Escopo('p3', 'org-1', 'estagiario', ['p1']);

  it('fisioterapeuta tem acesso total ao prontuário', () => {
    expect(fisio.temTotal('prontuario:ler')).toBe(true);
    expect(fisio.podeVerPii()).toBe(true);
  });

  it('recepção não lê prontuário, mas opera agenda e financeiro', () => {
    expect(recep.pode('prontuario:ler')).toBe(false);
    expect(recep.temTotal('agenda:escrever')).toBe(true);
    expect(recep.temTotal('financeiro:ler')).toBe(true);
    // E não pode desfazer a pseudonimização.
    expect(recep.podeVerPii()).toBe(false);
  });

  it('estagiário lê no escopo supervisionado e nunca assina', () => {
    expect(estag.ehRestrito('prontuario:ler')).toBe(true);
    expect(estag.pode('prontuario:finalizar')).toBe(false);
    expect(estag.podeVerPii()).toBe(false);
    // Enxerga o próprio trabalho mais o do supervisor.
    expect(estag.profissionaisVisiveis()).toEqual(['p3', 'p1']);
  });

  it('estagiário pode propor exercício mas não publicar', () => {
    expect(estag.pode('biblioteca:escrever')).toBe(true);
    expect(estag.pode('biblioteca:publicar')).toBe(false);
  });

  it('portal enxerga apenas o próprio paciente', () => {
    const portal = new EscopoPortal('pac-1', 'org-1');
    expect(portal.ehDoProprioPaciente('pac-1')).toBe(true);
    expect(portal.ehDoProprioPaciente('pac-2')).toBe(false);
  });
});
