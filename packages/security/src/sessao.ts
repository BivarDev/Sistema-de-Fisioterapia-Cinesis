/**
 * Sessão opaca revogável.
 *
 * ## Por que não JWT
 *
 * Um JWT de vida longa não pode ser revogado: enquanto não expirar, ele vale.
 * Em sistema com dado clínico isso é inaceitável — "demiti o estagiário" tem
 * que virar "o acesso dele morre agora", não "o acesso dele morre em 7 dias".
 * A alternativa (JWT curto + refresh token) reintroduz estado no servidor, que
 * é justamente o que o JWT prometia evitar. Então usamos estado direto.
 *
 * ## Como funciona
 *
 * O cliente recebe um token aleatório de 256 bits em cookie `HttpOnly`. O
 * servidor guarda `HMAC(token)` como chave — **nunca o token em claro**. Assim,
 * um vazamento do Redis não entrega sessões utilizáveis: o atacante teria os
 * hashes, e sem a subchave não consegue produzir o token que gera aquele hash.
 *
 * ## Três defesas que a especificação não detalhava
 *
 * 1. **Timeout duplo** — inatividade (30 min) e absoluto (12 h). Só o absoluto
 *    limita a janela de uma sessão roubada de quem fica o dia todo no sistema.
 * 2. **Rotação em mudança de privilégio** — trocar de papel emite token novo e
 *    invalida o antigo, fechando fixação de sessão.
 * 3. **Vínculo com o agente** — o hash do User-Agent é guardado; divergência
 *    encerra a sessão. Não é infalível (o atacante pode copiar o header), mas
 *    derruba o roubo oportunista de cookie.
 */

import { randomBytes, createHash } from 'node:crypto';
import { type Anel, hmac } from './chaves.js';
import type { Papel } from '@cinesis/shared';

/** Tempo máximo sem atividade antes da sessão morrer, em segundos. */
export const TIMEOUT_INATIVIDADE_S = 30 * 60; // 30 minutos.

/** Tempo máximo de vida da sessão, mesmo com uso contínuo, em segundos. */
export const TIMEOUT_ABSOLUTO_S = 12 * 60 * 60; // 12 horas.

/** Sessão do portal do paciente: janela mais curta, dispositivo compartilhado. */
export const TIMEOUT_PORTAL_S = 60 * 60; // 1 hora.

/** Conteúdo de uma sessão. Não guarda PII — só identificadores. */
export interface DadosSessao {
  /** Id do profissional OU do paciente, conforme o tipo. */
  sujeitoId: string;
  /** Organização (tenant) da sessão. Toda consulta filtra por ele. */
  organizacaoId: string;
  /** Papel efetivo. Muda => a sessão é rotacionada. */
  papel: Papel;
  /** `profissional` usa a API principal; `paciente` só o portal. */
  tipo: 'profissional' | 'paciente';
  /** Epoch (ms) de criação. Base do timeout absoluto. */
  criadaEm: number;
  /** Epoch (ms) do último uso. Base do timeout de inatividade. */
  usadaEm: number;
  /** SHA-256 do User-Agent, truncado. Nunca o header cru (pode conter dados). */
  agenteHash: string;
  /**
   * Token CSRF ligado à sessão. O cliente devolve em header a cada escrita.
   * Ver `csrf.ts` — cookie sozinho não protege contra CSRF em requisição
   * cross-site que o navegador envia automaticamente.
   */
  csrf: string;
}

/**
 * Contrato do armazenamento de sessão.
 *
 * Existe para que Redis (produção) e memória (dev/teste) sejam intercambiáveis
 * sem `if (ambiente === 'test')` espalhado pelo código.
 */
export interface ArmazenamentoSessao {
  /** Grava a sessão com TTL em segundos. */
  gravar(chave: string, dados: DadosSessao, ttlSegundos: number): Promise<void>;
  /** Lê a sessão, ou `null` se não existir/expirou. */
  ler(chave: string): Promise<DadosSessao | null>;
  /** Remove uma sessão (logout ou revogação). */
  remover(chave: string): Promise<void>;
  /** Remove TODAS as sessões de um sujeito (troca de senha, demissão). */
  removerDoSujeito(sujeitoId: string): Promise<number>;
  /** Lista as sessões ativas de um sujeito, para a tela de segurança. */
  listarDoSujeito(sujeitoId: string): Promise<{ chave: string; dados: DadosSessao }[]>;
}

/**
 * Armazenamento em memória.
 *
 * Para desenvolvimento e testes. Em produção com mais de um processo isso
 * quebraria (cada worker teria seu próprio mapa), por isso `criarGestor`
 * recusa este armazenamento quando `NODE_ENV=production`.
 */
export class ArmazenamentoMemoria implements ArmazenamentoSessao {
  /** Mapa chave → { dados, expiraEm }. */
  private readonly mapa = new Map<string, { dados: DadosSessao; expiraEm: number }>();

  async gravar(chave: string, dados: DadosSessao, ttlSegundos: number): Promise<void> {
    this.mapa.set(chave, { dados, expiraEm: Date.now() + ttlSegundos * 1000 });
  }

  async ler(chave: string): Promise<DadosSessao | null> {
    const item = this.mapa.get(chave);
    if (!item) return null;
    // Expiração preguiçosa: só verifica quando alguém lê.
    if (item.expiraEm <= Date.now()) {
      this.mapa.delete(chave);
      return null;
    }
    return item.dados;
  }

  async remover(chave: string): Promise<void> {
    this.mapa.delete(chave);
  }

  async removerDoSujeito(sujeitoId: string): Promise<number> {
    let n = 0;
    for (const [chave, item] of this.mapa) {
      if (item.dados.sujeitoId === sujeitoId) {
        this.mapa.delete(chave);
        n++;
      }
    }
    return n;
  }

  async listarDoSujeito(sujeitoId: string): Promise<{ chave: string; dados: DadosSessao }[]> {
    const agora = Date.now();
    return [...this.mapa.entries()]
      .filter(([, i]) => i.dados.sujeitoId === sujeitoId && i.expiraEm > agora)
      .map(([chave, i]) => ({ chave, dados: i.dados }));
  }
}

/** O que `abrir` e `rotacionar` devolvem. */
export interface SessaoEmitida {
  /** Token que vai no cookie. **Só existe neste instante** — não é recuperável. */
  token: string;
  /** Token CSRF que o cliente deve devolver em header nas escritas. */
  csrf: string;
  /** Epoch (ms) do fim absoluto da sessão. */
  expiraEm: number;
}

/** Motivos pelos quais uma sessão foi recusada. Vira métrica e log. */
export type MotivoRecusa =
  | 'inexistente' // Token não bate com nenhuma sessão (ou já foi revogada).
  | 'expirada_absoluto' // Passou de `TIMEOUT_ABSOLUTO_S` desde a criação.
  | 'expirada_inatividade' // Ficou parada além de `TIMEOUT_INATIVIDADE_S`.
  | 'agente_divergente'; // O User-Agent mudou no meio da sessão.

/** Resultado da validação de um token de sessão. */
export type ResultadoSessao =
  | { ok: true; chave: string; dados: DadosSessao }
  | { ok: false; motivo: MotivoRecusa };

/**
 * Gestor de sessões. Instancie uma vez por processo.
 */
export class GestorSessao {
  constructor(
    private readonly anel: Anel,
    private readonly armazenamento: ArmazenamentoSessao,
  ) {}

  /**
   * Converte o token do cliente na chave usada no armazenamento.
   *
   * É aqui que o token nunca chega ao Redis em claro. A subchave `sessao` vem
   * do anel; sem ela, um dump do Redis é uma lista de hashes inúteis.
   */
  private chaveDe(token: string): string {
    return `sess:${hmac(this.anel.derivar('sessao'), token)}`;
  }

  /** Hash curto do User-Agent, para detectar troca de dispositivo. */
  private static agenteHash(userAgent: string): string {
    // 16 hex = 64 bits: colisão irrelevante para este uso e não reversível
    // ao header original, que pode carregar informação identificante.
    return createHash('sha256').update(userAgent || 'desconhecido').digest('hex').slice(0, 16);
  }

  /**
   * Abre uma sessão nova.
   *
   * @param dados      Sujeito, organização, papel e tipo.
   * @param userAgent  Header `User-Agent` da requisição de login.
   * @returns          Token (para o cookie), token CSRF e o instante de expiração.
   */
  async abrir(
    dados: Omit<DadosSessao, 'criadaEm' | 'usadaEm' | 'agenteHash' | 'csrf'>,
    userAgent: string,
  ): Promise<SessaoEmitida> {
    // 256 bits de entropia. Menos que isso e o token vira alvo de força bruta
    // distribuída; base64url mantém o cookie curto e sem caractere problemático.
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const agora = Date.now();

    const ttl = dados.tipo === 'paciente' ? TIMEOUT_PORTAL_S : TIMEOUT_ABSOLUTO_S;

    const completo: DadosSessao = {
      ...dados,
      criadaEm: agora,
      usadaEm: agora,
      agenteHash: GestorSessao.agenteHash(userAgent),
      csrf,
    };

    await this.armazenamento.gravar(this.chaveDe(token), completo, ttl);
    return { token, csrf, expiraEm: agora + ttl * 1000 };
  }

  /**
   * Valida um token e renova a janela de inatividade.
   *
   * Toda requisição autenticada passa por aqui. Devolve o motivo da recusa em
   * vez de só `null` porque a diferença importa para o log e para a métrica de
   * segurança — "muitas sessões recusadas por agente divergente" é sinal de
   * roubo de cookie, "muitas por inatividade" é só gente saindo para o almoço.
   *
   * @param token      Valor do cookie.
   * @param userAgent  Header da requisição atual.
   */
  async validar(token: string, userAgent: string): Promise<ResultadoSessao> {
    const chave = this.chaveDe(token);
    const dados = await this.armazenamento.ler(chave);

    if (!dados) return { ok: false, motivo: 'inexistente' };

    const agora = Date.now();
    const limiteAbsoluto = dados.tipo === 'paciente' ? TIMEOUT_PORTAL_S : TIMEOUT_ABSOLUTO_S;

    // 1. Timeout absoluto — vale mesmo com uso contínuo.
    if (agora - dados.criadaEm > limiteAbsoluto * 1000) {
      await this.armazenamento.remover(chave);
      return { ok: false, motivo: 'expirada_absoluto' };
    }

    // 2. Timeout de inatividade.
    if (agora - dados.usadaEm > TIMEOUT_INATIVIDADE_S * 1000) {
      await this.armazenamento.remover(chave);
      return { ok: false, motivo: 'expirada_inatividade' };
    }

    // 3. Vínculo com o dispositivo.
    if (dados.agenteHash !== GestorSessao.agenteHash(userAgent)) {
      // Encerra em vez de só recusar: se o cookie foi copiado, a sessão do
      // dono legítimo também precisa morrer para forçar novo login.
      await this.armazenamento.remover(chave);
      return { ok: false, motivo: 'agente_divergente' };
    }

    // Renova a janela de inatividade, preservando `criadaEm`.
    const restante = Math.ceil((dados.criadaEm + limiteAbsoluto * 1000 - agora) / 1000);
    await this.armazenamento.gravar(chave, { ...dados, usadaEm: agora }, restante);

    return { ok: true, chave, dados: { ...dados, usadaEm: agora } };
  }

  /**
   * Rotaciona a sessão: emite token novo e mata o antigo.
   *
   * Chame sempre que o privilégio mudar (troca de papel, elevação após MFA) e
   * logo após o login. Sem rotação, um atacante que planta um token conhecido
   * antes do login continua com ele válido depois — fixação de sessão.
   */
  async rotacionar(
    tokenAntigo: string,
    novosDados: Partial<Pick<DadosSessao, 'papel' | 'organizacaoId'>>,
    userAgent: string,
  ): Promise<SessaoEmitida | null> {
    const chaveAntiga = this.chaveDe(tokenAntigo);
    const atual = await this.armazenamento.ler(chaveAntiga);
    if (!atual) return null;

    await this.armazenamento.remover(chaveAntiga);

    return this.abrir(
      {
        sujeitoId: atual.sujeitoId,
        organizacaoId: novosDados.organizacaoId ?? atual.organizacaoId,
        papel: novosDados.papel ?? atual.papel,
        tipo: atual.tipo,
      },
      userAgent,
    );
  }

  /** Encerra uma sessão específica (logout). */
  async encerrar(token: string): Promise<void> {
    await this.armazenamento.remover(this.chaveDe(token));
  }

  /**
   * Encerra uma sessão pela chave, sem ter o token.
   * É o que a tela "Sessões ativas" usa no botão *Revogar*.
   */
  async revogarPorChave(chave: string): Promise<void> {
    await this.armazenamento.remover(chave);
  }

  /**
   * Encerra todas as sessões de um sujeito.
   * Obrigatório em: troca de senha, desativação de conta, mudança de papel.
   */
  async encerrarTodas(sujeitoId: string): Promise<number> {
    return this.armazenamento.removerDoSujeito(sujeitoId);
  }

  /** Sessões ativas do sujeito, para exibir na tela de segurança. */
  async listar(sujeitoId: string): Promise<{ chave: string; dados: DadosSessao }[]> {
    return this.armazenamento.listarDoSujeito(sujeitoId);
  }
}
