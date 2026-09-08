/**
 * Autenticação e autorização por requisição.
 *
 * ## Onde a segurança do sistema é realmente decidida
 *
 * Este arquivo transforma um cookie num `Escopo` — o objeto que carrega
 * "quem é, de qual organização, com qual papel". Daí em diante, **toda**
 * consulta a banco recebe esse escopo e o aplica na cláusula WHERE.
 *
 * Três decisões que valem destaque:
 *
 * 1. **`exigirPermissao` lança 404, não 403.** Requisito da especificação:
 *    fora de escopo não confirma existência.
 * 2. **CSRF é verificado antes da rota**, para todo método que altera estado.
 *    Uma rota nova nasce protegida sem o autor precisar lembrar.
 * 3. **Profissional e paciente têm cookies e escopos de tipos diferentes.**
 *    Não é possível usar uma sessão de portal numa rota profissional nem por
 *    engano de programação — o TypeScript barra.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { NaoAutenticado, NaoEncontrado, type Permissao } from '@cinesis/shared';
import {
  Escopo,
  EscopoPortal,
  GestorSessao,
  verificarCsrf,
  HEADER_CSRF,
  type DadosSessao,
} from '@cinesis/security';
import { COOKIE_PORTAL, COOKIE_SESSAO } from './seguranca.js';
import type { Config } from '../config.js';

/**
 * Campos que a autenticação anexa à requisição.
 *
 * Declarados no módulo do Fastify para que `req.escopo` seja tipado em toda
 * rota, sem `as` espalhado pelo código.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** Escopo do profissional. Presente após `exigirProfissional`. */
    escopo?: Escopo;
    /** Escopo do paciente. Presente após `exigirPaciente`. */
    escopoPortal?: EscopoPortal;
    /** Dados brutos da sessão, para operações que precisam do CSRF. */
    sessao?: DadosSessao;
    /** Token da sessão, para rotação e logout. */
    tokenSessao?: string;
  }
}

/** Dependências que o plugin precisa. */
export interface DepsAutenticacao {
  gestor: GestorSessao;
  config: Config;
  /** Busca os supervisores de um profissional — define o escopo do estagiário. */
  buscarSupervisores: (profissionalId: string) => Promise<string[]>;
}

/**
 * Registra os decoradores e hooks de autenticação.
 */
export function registrarAutenticacao(app: FastifyInstance, deps: DepsAutenticacao): void {
  const { gestor, config } = deps;

  /**
   * Hook global de CSRF.
   *
   * Roda antes de qualquer handler, em toda requisição que altera estado.
   * Rodar aqui e não em cada rota é deliberado: proteção que depende de o autor
   * de cada rota lembrar de aplicá-la é proteção que uma hora falta.
   */
  app.addHook('preHandler', async (req, reply) => {
    // Rotas de autenticação de entrada não têm sessão ainda — não há token CSRF
    // para conferir. Elas são protegidas por rate limit e origem.
    const isento =
      req.url.startsWith('/api/auth/login') ||
      req.url.startsWith('/api/auth/registrar') ||
      req.url.startsWith('/api/portal/entrar') ||
      req.url === '/api/saude';

    if (isento) return;

    // Sem sessão, não há o que proteger contra CSRF: o handler vai devolver 401.
    const token = req.cookies[COOKIE_SESSAO] ?? req.cookies[COOKIE_PORTAL];
    if (!token) return;

    const resultado = await gestor.validar(token, req.headers['user-agent'] ?? '');
    if (!resultado.ok) return; // O handler cuida do 401.

    const r = verificarCsrf(
      req.method,
      req.headers[HEADER_CSRF] as string | undefined,
      resultado.dados.csrf,
      // `Origin` é o header canônico; `Referer` cobre navegadores que omitem o
      // primeiro em alguns tipos de navegação.
      (req.headers.origin as string | undefined) ?? (req.headers.referer as string | undefined),
      config.origens,
    );

    if (!r.ok) {
      req.log.warn({ falha: r.falha, rota: req.url }, 'requisição barrada pela checagem CSRF');
      // 403 aqui é correto e não contradiz a regra do 404: não estamos negando
      // acesso a um recurso, estamos recusando uma requisição malformada do
      // ponto de vista de origem. Nada é revelado sobre o recurso.
      await reply.status(403).send({
        codigo: 'NAO_AUTENTICADO',
        mensagem: 'Requisição bloqueada por verificação de origem. Recarregue a página.',
        correlationId: req.id,
      });
    }
  });

  /**
   * Exige sessão de profissional válida.
   *
   * Use como `preHandler` de toda rota da API profissional.
   */
  app.decorate(
    'exigirProfissional',
    async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const token = req.cookies[COOKIE_SESSAO];
      if (!token) throw new NaoAutenticado();

      const r = await gestor.validar(token, req.headers['user-agent'] ?? '');
      if (!r.ok) {
        // O motivo vai para o log (é métrica de segurança), mas não para o
        // cliente: "sessão expirada por inatividade" e "agente divergente" são
        // informações diferentes para um atacante.
        req.log.info({ motivo: r.motivo }, 'sessão recusada');
        throw new NaoAutenticado();
      }

      // Uma sessão de paciente nunca vale na API profissional, mesmo que o
      // cookie seja colado no nome certo.
      if (r.dados.tipo !== 'profissional') throw new NaoAutenticado();

      const supervisores =
        r.dados.papel === 'estagiario' ? await deps.buscarSupervisores(r.dados.sujeitoId) : [];

      req.escopo = new Escopo(
        r.dados.sujeitoId,
        r.dados.organizacaoId,
        r.dados.papel,
        supervisores,
      );
      req.sessao = r.dados;
      req.tokenSessao = token;
    },
  );

  /**
   * Exige sessão de paciente válida (portal).
   */
  app.decorate('exigirPaciente', async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = req.cookies[COOKIE_PORTAL];
    if (!token) throw new NaoAutenticado();

    const r = await gestor.validar(token, req.headers['user-agent'] ?? '');
    if (!r.ok) throw new NaoAutenticado();
    if (r.dados.tipo !== 'paciente') throw new NaoAutenticado();

    req.escopoPortal = new EscopoPortal(r.dados.sujeitoId, r.dados.organizacaoId);
    req.sessao = r.dados;
    req.tokenSessao = token;
  });
}

/**
 * Exige uma permissão do escopo corrente.
 *
 * **Responde 404, não 403.** É a camada 3 do modelo de segurança: um 403
 * confirmaria que o recurso existe, e essa confirmação é o que permite mapear
 * a base de outra organização por tentativa e erro.
 *
 * @param req       Requisição já autenticada.
 * @param permissao Permissão exigida.
 * @returns         O escopo, já estreitado de tipo.
 * @throws {NaoAutenticado} Sem sessão.
 * @throws {NaoEncontrado}  Sessão válida, papel sem a permissão.
 */
export function exigirPermissao(req: FastifyRequest, permissao: Permissao): Escopo {
  const escopo = req.escopo;
  if (!escopo) throw new NaoAutenticado();

  if (!escopo.pode(permissao)) {
    // Registra a tentativa: papel tentando o que não pode é sinal, não ruído.
    // A gravação na trilha de auditoria acontece no serviço, que tem o banco.
    req.log.warn({ papel: escopo.papel, permissao }, 'acesso negado por RBAC');
    throw new NaoEncontrado();
  }

  return escopo;
}

/** Igual a `exigirPermissao`, mas exige acesso `total` (não aceita `restrito`). */
export function exigirPermissaoTotal(req: FastifyRequest, permissao: Permissao): Escopo {
  const escopo = exigirPermissao(req, permissao);
  if (!escopo.temTotal(permissao)) {
    req.log.warn({ papel: escopo.papel, permissao }, 'acesso restrito insuficiente');
    throw new NaoEncontrado();
  }
  return escopo;
}

/** Exige escopo de portal. */
export function exigirPortal(req: FastifyRequest): EscopoPortal {
  const escopo = req.escopoPortal;
  if (!escopo) throw new NaoAutenticado();
  return escopo;
}

/** Tipos dos decoradores, para que `app.exigirProfissional` seja reconhecido. */
declare module 'fastify' {
  interface FastifyInstance {
    exigirProfissional: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    exigirPaciente: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
