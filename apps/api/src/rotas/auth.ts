/**
 * Rotas de autenticação do profissional.
 *
 * As três rotas públicas do sistema estão aqui (`login`, `registrar` e o
 * `entrar` do portal, que fica em `portal.ts`). Todas as demais exigem sessão.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  zLogin,
  zRegistrarOrganizacao,
  zAtivarMfa,
  NaoAutenticado,
  PERMISSOES_POR_PAPEL,
} from '@cinesis/shared';
import {
  gerarSegredoMfa,
  verificarPolitica,
  LIMITES,
  TIMEOUT_ABSOLUTO_S,
  opcoesCookieSessao,
  hmac,
} from '@cinesis/security';
import { DadosInvalidos } from '@cinesis/shared';
import { and, eq } from 'drizzle-orm';
import type { Deps } from '../deps.js';
import { autenticar, registrarOrganizacao, ativarMfa } from '../servicos/autenticacao.js';
import { aplicarLimite, chaveDeRede, COOKIE_SESSAO } from '../plugins/seguranca.js';
import { organizacoes, profissionais } from '../db/schema.js';
import { semEscopoDeTenant, comTenant } from '../db/conexao.js';
import { auditar } from '../servicos/auditoria.js';
import { novoId } from '../infra/ids.js';

/**
 * Segredos MFA pendentes de confirmação, por profissional.
 *
 * Ficam em memória e expiram junto com o processo. É deliberado: um segredo
 * ainda não confirmado não deve ser gravado no banco (senão uma ativação
 * abandonada trancaria o usuário fora da conta), e a janela de confirmação é
 * de segundos. Em produção com múltiplos workers, mova para o Redis.
 */
const mfaPendente = new Map<string, { segredo: string; hashes: string[]; uri: string }>();

export function rotasAuth(deps: Deps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { db, anel, gestor, config } = deps;

    /**
     * `POST /api/auth/login`
     *
     * Rate limit em duas dimensões: por rede (barra força bruta distribuída no
     * mesmo /24) e por conta (barra o ataque lento contra um alvo específico).
     * As duas juntas cobrem os dois formatos de ataque.
     */
    app.post('/api/auth/login', async (req, reply) => {
      const dados = zLogin.parse(req.body);

      aplicarLimite(`login:rede:${chaveDeRede(req)}`, LIMITES.loginPorRede, reply);
      // A chave por conta usa HMAC do e-mail: o limitador guarda a chave em
      // memória, e um e-mail em claro ali acabaria num dump de heap.
      const chaveConta = hmac(anel.derivar('blind-index'), `login:${dados.email}`);
      aplicarLimite(`login:conta:${chaveConta}`, LIMITES.loginPorConta, reply);

      const r = await autenticar(
        db,
        anel,
        gestor,
        dados,
        req.headers['user-agent'] ?? '',
      );

      reply.setCookie(
        COOKIE_SESSAO,
        r.sessao.token,
        opcoesCookieSessao(config.producao, TIMEOUT_ABSOLUTO_S),
      );

      const [org] = await semEscopoDeTenant(db, (d) =>
        d.select().from(organizacoes).where(eq(organizacoes.id, r.organizacaoId)).limit(1),
      );

      return {
        // O token CSRF vai no CORPO, não em cookie. Se fosse cookie, o
        // navegador o enviaria automaticamente junto com o de sessão e o
        // double-submit deixaria de proteger contra coisa nenhuma.
        csrf: r.sessao.csrf,
        expiraEm: new Date(r.sessao.expiraEm).toISOString(),
        precisaAtivarMfa: r.precisaAtivarMfa,
        profissional: {
          id: r.profissionalId,
          nome: r.nome,
          email: dados.email,
          papel: r.papel,
          organizacaoId: r.organizacaoId,
        },
        organizacao: org ? { id: org.id, nome: org.nome, tipo: org.tipo } : null,
        // As permissões vêm resolvidas do servidor. A interface as usa apenas
        // para esconder botão — a decisão real acontece em cada endpoint.
        permissoes: PERMISSOES_POR_PAPEL[r.papel],
      };
    });

    /**
     * `POST /api/auth/registrar` — cria organização + profissional fundador.
     *
     * Rate limit apertado: criar organização é raro por natureza, e sem limite
     * a rota vira ferramenta de enchimento do banco.
     */
    app.post('/api/auth/registrar', async (req, reply) => {
      const dados = zRegistrarOrganizacao.parse(req.body);

      aplicarLimite(`registro:${chaveDeRede(req)}`, { maximo: 5, janelaSegundos: 3600 }, reply);

      // A política de senha considera o nome, o e-mail e o nome da clínica:
      // senha derivada do próprio identificador é a primeira coisa testada num
      // ataque.
      const politica = verificarPolitica(dados.senha, [
        dados.nome,
        dados.email.split('@')[0] ?? '',
        dados.organizacaoNome,
      ]);
      if (!politica.ok) throw new DadosInvalidos({ senha: politica.motivos });

      // E-mail já usado responde igual a sucesso? Não — aqui o cadastro é da
      // organização, não de usuário final, e o operador precisa saber que o
      // e-mail está em uso. O rate limit acima é o que impede usar isto para
      // enumerar contas em massa.
      const [existente] = await semEscopoDeTenant(db, (d) =>
        d
          .select({ id: profissionais.id })
          .from(profissionais)
          .where(eq(profissionais.email, dados.email))
          .limit(1),
      );
      if (existente) {
        throw new DadosInvalidos({ email: ['Este e-mail já está cadastrado.'] });
      }

      const r = await registrarOrganizacao(db, dados, novoId);

      await comTenant(db, r.organizacaoId, (tx) =>
        auditar(tx, {
          organizacaoId: r.organizacaoId,
          atorId: r.profissionalId,
          atorPapel: 'fisioterapeuta',
          acao: 'MEMBRO_CONVIDADO',
          entidade: 'Organizacao',
          entidadeId: r.organizacaoId,
          detalhe: 'Organização criada com o profissional fundador.',
        }),
      );

      return reply.status(201).send({ organizacaoId: r.organizacaoId });
    });

    /** `POST /api/auth/sair` — encerra a sessão corrente. */
    app.post(
      '/api/auth/sair',
      { preHandler: app.exigirProfissional },
      async (req, reply) => {
        if (req.tokenSessao) await gestor.encerrar(req.tokenSessao);
        // Limpar o cookie no cliente é cortesia; o que de fato encerra a sessão
        // é a remoção no servidor, acima.
        reply.clearCookie(COOKIE_SESSAO, { path: '/' });
        return { ok: true };
      },
    );

    /** `GET /api/auth/sessao` — quem sou eu, para a interface se montar. */
    app.get('/api/auth/sessao', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = req.escopo;
      if (!escopo) throw new NaoAutenticado();

      const [prof] = await comTenant(db, escopo.organizacaoId, (tx) =>
        tx
          .select()
          .from(profissionais)
          .where(
            and(
              eq(profissionais.id, escopo.sujeitoId),
              eq(profissionais.organizacaoId, escopo.organizacaoId),
            ),
          )
          .limit(1),
      );

      if (!prof) throw new NaoAutenticado();

      const [org] = await semEscopoDeTenant(db, (d) =>
        d.select().from(organizacoes).where(eq(organizacoes.id, escopo.organizacaoId)).limit(1),
      );

      return {
        profissional: {
          id: prof.id,
          nome: prof.nome,
          email: prof.email,
          crefito: prof.crefito,
          papel: prof.papel,
          organizacaoId: prof.organizacaoId,
          mfaAtivo: prof.mfaSegredoCifrado !== null,
        },
        organizacao: org ? { id: org.id, nome: org.nome, tipo: org.tipo } : null,
        permissoes: PERMISSOES_POR_PAPEL[escopo.papel],
        csrf: req.sessao?.csrf,
      };
    });

    /**
     * `POST /api/auth/mfa/preparar` — gera o segredo e o QR Code.
     *
     * Não ativa nada: só devolve o segredo para o usuário cadastrar. A ativação
     * exige a prova em `/mfa/ativar`.
     */
    app.post(
      '/api/auth/mfa/preparar',
      { preHandler: app.exigirProfissional },
      async (req) => {
        const escopo = req.escopo;
        if (!escopo) throw new NaoAutenticado();

        const [prof] = await semEscopoDeTenant(db, (d) =>
          d
            .select({ email: profissionais.email })
            .from(profissionais)
            .where(eq(profissionais.id, escopo.sujeitoId))
            .limit(1),
        );

        const segredo = gerarSegredoMfa('Cinesis', prof?.email ?? 'profissional');
        mfaPendente.set(escopo.sujeitoId, {
          segredo: segredo.segredoBase32,
          hashes: segredo.hashesRecuperacao,
          uri: segredo.uri,
        });

        return {
          uri: segredo.uri,
          segredo: segredo.segredoBase32,
          // Os códigos de recuperação em claro aparecem **uma única vez**.
          // Depois disto, só os hashes existem.
          codigosRecuperacao: segredo.codigosRecuperacao,
        };
      },
    );

    /** `POST /api/auth/mfa/ativar` — confirma com um código válido e ativa. */
    app.post(
      '/api/auth/mfa/ativar',
      { preHandler: app.exigirProfissional },
      async (req) => {
        const escopo = req.escopo;
        if (!escopo) throw new NaoAutenticado();

        const dados = zAtivarMfa.parse(req.body);
        const pendente = mfaPendente.get(escopo.sujeitoId);
        if (!pendente) {
          throw new NaoAutenticado('Nenhuma ativação de MFA em andamento. Comece de novo.');
        }

        // A prova: o código só sai certo se o segredo foi mesmo cadastrado no
        // app autenticador. É o que impede trancar o usuário fora da conta.
        const { conferirTotp } = await import('@cinesis/security');
        if (!conferirTotp(pendente.segredo, dados.totp)) {
          throw new NaoAutenticado('Código de verificação inválido.');
        }

        await ativarMfa(
          db,
          anel,
          escopo.sujeitoId,
          escopo.organizacaoId,
          escopo.papel,
          pendente.segredo,
          pendente.hashes,
        );

        mfaPendente.delete(escopo.sujeitoId);
        return { ok: true };
      },
    );
  };
}
