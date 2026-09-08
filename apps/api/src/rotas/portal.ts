/**
 * Rotas do portal do paciente.
 *
 * ## Contexto isolado, por construção
 *
 * O portal usa cookie próprio (`cinesis_portal`), sessão com timeout mais curto
 * (1 hora, porque o dispositivo pode ser compartilhado) e um tipo de escopo
 * distinto (`EscopoPortal`). Não é possível usar uma sessão de portal numa rota
 * profissional nem por engano de programação — os tipos são incompatíveis e o
 * compilador barra.
 *
 * ## As quatro ações possíveis, e nada mais
 *
 * Ver a próxima sessão, ver os exercícios, registrar a execução, ver o
 * progresso. A superfície mínima é uma decisão de segurança tanto quanto de
 * usabilidade: o que não existe não pode ser abusado.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { zRegistrarAdesao, NaoAutenticado } from '@cinesis/shared';
import { LIMITES, TIMEOUT_PORTAL_S, opcoesCookieSessao } from '@cinesis/security';
import { evento } from '@cinesis/domain';
import type { Deps } from '../deps.js';
import { comTenant, semEscopoDeTenant } from '../db/conexao.js';
import { exigirPortal } from '../plugins/autenticacao.js';
import { aplicarLimite, chaveDeRede, COOKIE_PORTAL } from '../plugins/seguranca.js';
import { consumirTokenPortal, painelDoPortal, registrarAdesao } from '../servicos/adesao.js';

export function rotasPortal(deps: Deps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { db, anel, gestor, config, eventos } = deps;

    /**
     * `POST /api/portal/entrar` — troca o token do link mágico por uma sessão.
     *
     * O token chega no **corpo**, não na URL desta requisição: a página do
     * portal o lê do path, faz este POST e limpa a URL com
     * `history.replaceState`. Assim o token não fica no histórico do navegador
     * nem no `Referer` de nenhum recurso carregado depois.
     *
     * O consumo é atômico: dois cliques simultâneos no mesmo link abrem uma
     * sessão só.
     */
    app.post('/api/portal/entrar', async (req, reply) => {
      const { token } = (req.body ?? {}) as { token?: string };

      // Rate limit por rede: barra varredura de tokens. O token tem 256 bits,
      // então adivinhar é inviável — mas o limite fecha a porta de qualquer
      // jeito e torna a tentativa visível.
      aplicarLimite(`portal:entrar:${chaveDeRede(req)}`, LIMITES.consumoLinkPorRede, reply);

      if (typeof token !== 'string' || token.length !== 43) {
        throw new NaoAutenticado('Link inválido ou expirado. Peça um novo à sua clínica.');
      }

      // O consumo roda fora do escopo de tenant porque ainda não sabemos de
      // qual organização é o token — é exatamente o que estamos descobrindo.
      const r = await semEscopoDeTenant(db, (d) => consumirTokenPortal(d, anel, token));

      if (!r.ok) {
        // Mensagem única para todas as recusas. Distinguir "expirado" de
        // "já usado" de "inexistente" daria a um atacante um oráculo sobre
        // quais tokens já existiram.
        throw new NaoAutenticado('Link inválido ou expirado. Peça um novo à sua clínica.');
      }

      const sessao = await gestor.abrir(
        {
          sujeitoId: r.pacienteId,
          organizacaoId: r.organizacaoId,
          papel: 'paciente',
          tipo: 'paciente',
        },
        req.headers['user-agent'] ?? '',
      );

      reply.setCookie(
        COOKIE_PORTAL,
        sessao.token,
        opcoesCookieSessao(config.producao, TIMEOUT_PORTAL_S),
      );

      return { csrf: sessao.csrf, expiraEm: new Date(sessao.expiraEm).toISOString() };
    });

    /**
     * `GET /api/portal/painel` — a tela única do paciente.
     *
     * Todo dado parte do `pacienteId` **da sessão**. Não existe parâmetro de
     * id em nenhuma rota do portal — é o que torna impossível ver o programa de
     * outro paciente, mesmo conhecendo o id dele.
     */
    app.get('/api/portal/painel', { preHandler: app.exigirPaciente }, async (req) => {
      const escopo = exigirPortal(req);

      return comTenant(db, escopo.organizacaoId, (tx) => painelDoPortal(tx, escopo));
    });

    /** `POST /api/portal/registros` — Fiz / Fiz parte / Não fiz. */
    app.post(
      '/api/portal/registros',
      { preHandler: app.exigirPaciente },
      async (req, reply) => {
        const escopo = exigirPortal(req);
        const dados = zRegistrarAdesao.parse(req.body);

        aplicarLimite(`portal:registro:${escopo.pacienteId}`, LIMITES.registroPortal, reply);

        await comTenant(db, escopo.organizacaoId, (tx) =>
          registrarAdesao(
            tx,
            escopo,
            dados.prescricaoItemId,
            dados.data,
            dados.status,
            dados.observacao ?? null,
          ),
        );

        await eventos.publicar(
          evento('ExerciseCompleted', escopo.organizacaoId, escopo.pacienteId, {
            prescricaoItemId: dados.prescricaoItemId,
            status: dados.status,
          }),
        );

        // Devolve o painel atualizado: o portal roda em celular, muitas vezes
        // em rede ruim, e uma ida a mais ao servidor é uma chance a mais de o
        // paciente ver a tela travada.
        return comTenant(db, escopo.organizacaoId, (tx) => painelDoPortal(tx, escopo));
      },
    );

    /** `POST /api/portal/sair` — encerra a sessão do portal. */
    app.post('/api/portal/sair', { preHandler: app.exigirPaciente }, async (req, reply) => {
      if (req.tokenSessao) await gestor.encerrar(req.tokenSessao);
      reply.clearCookie(COOKIE_PORTAL, { path: '/' });
      return { ok: true };
    });
  };
}
