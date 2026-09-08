/**
 * Plugin de segurança HTTP: cabeçalhos, CORS, CSRF e limite de taxa.
 *
 * ## Lacuna da especificação que este arquivo fecha
 *
 * A especificação descreve muito bem a segurança de dados (pseudonimização,
 * RBAC, auditoria) e não menciona a **superfície HTTP**: cabeçalhos de
 * segurança, CSP, CORS e CSRF. São o tipo de coisa que só se nota quando falta,
 * e num sistema que serve prontuário em navegador elas são a diferença entre
 * "um XSS numa dependência" e "um XSS numa dependência exfiltrou a base".
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { ExcessoRequisicoes, type CodigoErro } from '@cinesis/shared';
import { Limitador, LIMITES, mascararIp, type ConfigLimite } from '@cinesis/security';
import type { Config } from '../config.js';

/** Nome do cookie de sessão do profissional. */
export const COOKIE_SESSAO = 'cinesis_sessao';
/** Nome do cookie de sessão do portal. Separado: contextos não se misturam. */
export const COOKIE_PORTAL = 'cinesis_portal';

/**
 * Registra as proteções de transporte.
 *
 * @param app    Instância Fastify.
 * @param config Configuração validada.
 */
export async function registrarSeguranca(app: FastifyInstance, config: Config): Promise<void> {
  // --- Cookies ---------------------------------------------------------------
  // Sem `secret`: não usamos cookie assinado. O valor do cookie de sessão já é
  // um token aleatório de 256 bits cuja validade é conferida no servidor —
  // assinar por cima não acrescentaria nada e daria falsa sensação de garantia.
  await app.register(cookie);

  // --- Cabeçalhos de segurança ----------------------------------------------
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        // `'none'` como base: tudo que a API precisa servir é declarado
        // explicitamente abaixo. Lista de permissão, nunca de bloqueio.
        defaultSrc: ["'none'"],
        // A API responde JSON; nada dela precisa executar script.
        scriptSrc: ["'none'"],
        // Impede que a API seja embutida em iframe de outro site
        // (clickjacking). Substitui o antigo X-Frame-Options.
        frameAncestors: ["'none'"],
        // Bloqueia <base href> injetado, que redirecionaria URLs relativas.
        baseUri: ["'none'"],
        // Nenhum formulário da API posta para lugar nenhum.
        formAction: ["'none'"],
      },
    },
    // HSTS: só em produção. Em `http://localhost` o cabeçalho travaria o
    // navegador em HTTPS para o host local, atrapalhando outros projetos.
    hsts: config.producao
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    // `no-referrer`: nenhum link a partir da API vaza a URL de origem.
    // Isto é o que protege o token do link mágico, que viaja no path.
    referrerPolicy: { policy: 'no-referrer' },
    // Impede o navegador de "adivinhar" um tipo diferente do declarado.
    noSniff: true,
    // Não anuncia a tecnologia do servidor.
    hidePoweredBy: true,
    // Bloqueia leitura cross-origin do corpo da resposta (Spectre e afins).
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  // --- CORS ------------------------------------------------------------------
  await app.register(cors, {
    // Lista fechada, vinda da configuração. `origin: true` (refletir a origem
    // do requisitante) com `credentials: true` seria equivalente a liberar
    // qualquer site a chamar a API com o cookie da vítima.
    origin: config.origens,
    // Necessário para o cookie de sessão viajar.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-cinesis-csrf'],
    // Cache do preflight: menos uma requisição por rota por 10 minutos.
    maxAge: 600,
  });

  // --- Corpo JSON vazio ------------------------------------------------------
  //
  // Varias rotas de acao nao tem corpo: `/finalizar`, `/link-portal`, `/sair`.
  // O parser padrao do Fastify recusa `Content-Type: application/json` com
  // corpo vazio e devolve 500 — o que quebra qualquer cliente HTTP comum
  // (curl, Postman, um script de integracao) que sempre manda o content-type.
  //
  // O frontend nao cai nisso porque so envia o cabecalho quando ha corpo, mas
  // depender disso seria uma API fragil por acidente.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, corpo, feito) => {
      const texto = (corpo as string).trim();

      // Corpo ausente vira objeto vazio: as rotas sem payload passam, e as
      // que exigem campos continuam falhando na validacao Zod — com 422 e o
      // detalhe por campo, que e a resposta correta.
      if (texto.length === 0) return feito(null, {});

      try {
        feito(null, JSON.parse(texto));
      } catch {
        // JSON malformado e erro do cliente (400), nao falha do servidor.
        feito(Object.assign(new SyntaxError('JSON invalido.'), { statusCode: 400 }), undefined);
      }
    },
  );

  // --- Limites de tamanho e tempo -------------------------------------------
  // Teto de corpo: 1 MiB cobre qualquer formulário clínico com folga. Upload
  // de mídia tem rota própria com teto maior, validada em `upload.ts`.
  app.addHook('onRequest', async (req, reply) => {
    const tamanho = Number(req.headers['content-length'] ?? 0);
    if (tamanho > 1_048_576 && !req.url.startsWith('/api/midias')) {
      await reply.status(413).send({
        codigo: 'DADOS_INVALIDOS' satisfies CodigoErro,
        mensagem: 'Corpo da requisição grande demais.',
        correlationId: req.id,
      });
    }
  });
}

/**
 * Limitador compartilhado do processo.
 *
 * Exportado para que os testes possam zerar entre casos. Em produção com mais
 * de um worker, troque por `LimitadorRedis` (`src/infra/limitador-redis.ts`).
 */
export const limitador = new Limitador();

/**
 * Deriva a chave de rate limit a partir do endereço de rede.
 *
 * Usa o prefixo /24 (ou /48 em IPv6), não o IP exato. Dois motivos:
 * o requisito "IP nunca em claro" da especificação, e o fato de que atacante
 * com botnet troca de IP dentro da mesma rede — limitar por /24 alcança o
 * ataque distribuído que o IP exato deixaria passar.
 */
export function chaveDeRede(req: FastifyRequest): string {
  return mascararIp(req.ip);
}

/**
 * Aplica um limite de taxa a uma requisição.
 *
 * @param chave  Identidade do limite, ex.: `login:conta:<hash>`.
 * @param config Máximo e janela.
 * @param reply  Resposta, para preencher os cabeçalhos `RateLimit-*`.
 * @throws {ExcessoRequisicoes} 429 quando estourou.
 */
export function aplicarLimite(chave: string, config: ConfigLimite, reply: FastifyReply): void {
  const r = limitador.consumir(chave, config);

  // Cabeçalhos padronizados (draft IETF): o cliente consegue se comportar bem
  // sem precisar bater na parede primeiro.
  reply.header('RateLimit-Limit', String(config.maximo));
  reply.header('RateLimit-Remaining', String(r.restantes));

  if (!r.permitido) {
    reply.header('Retry-After', String(r.aguardarSegundos));
    throw new ExcessoRequisicoes(r.aguardarSegundos);
  }
}

/**
 * Hook de limite geral por rede, aplicado a toda a API.
 *
 * É o teto que impede uma varredura automatizada de consumir o servidor
 * inteiro. Limites específicos (login, reidentificação, upload) vivem nas
 * rotas e são bem mais apertados.
 */
export function limiteGeral(req: FastifyRequest, reply: FastifyReply): void {
  aplicarLimite(`geral:${chaveDeRede(req)}`, LIMITES.geral, reply);
}
