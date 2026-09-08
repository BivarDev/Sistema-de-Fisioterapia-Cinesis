/**
 * Rotas de plano de tratamento e registros clínicos.
 *
 * É aqui que vive o ciclo central do produto: criar plano → registrar evolução
 * → finalizar e assinar → comparar longitudinalmente. A rota de finalização e a
 * de nova versão são as que fazem valer a COFFITO 415/2012.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { zCriarPlano, zCriarEvolucao, zNovaVersao, NaoEncontrado } from '@cinesis/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Deps } from '../deps.js';
import { comTenant } from '../db/conexao.js';
import { exigirPermissao, exigirPermissaoTotal } from '../plugins/autenticacao.js';
import {
  criarPlano,
  buscarPlano,
  criarEvolucao,
  finalizarRegistro,
  criarVersao,
  longitudinalDoPlano,
  linhaDoTempo,
  deltasDoPlano,
} from '../servicos/prontuario.js';
import { definicoesTeste, planos } from '../db/schema.js';
import { evento } from '@cinesis/domain';

export function rotasPlanos(deps: Deps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { db, eventos } = deps;

    /** `POST /api/planos` — cria um episódio de tratamento. */
    app.post('/api/planos', { preHandler: app.exigirProfissional }, async (req, reply) => {
      const escopo = exigirPermissaoTotal(req, 'plano:escrever');
      const dados = zCriarPlano.parse(req.body);

      const criado = await comTenant(db, escopo.organizacaoId, (tx) =>
        criarPlano(tx, escopo, dados),
      );

      // O evento é publicado **depois** do commit, de propósito: um consumidor
      // que dispare notificação não pode agir sobre uma transação que ainda
      // pode reverter.
      await eventos.publicar(
        evento('TreatmentPlanCreated', escopo.organizacaoId, escopo.sujeitoId, {
          planoId: criado.id,
        }),
      );

      return reply.status(201).send(criado);
    });

    /** `GET /api/planos` — planos ativos do escopo. */
    app.get('/api/planos', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = exigirPermissao(req, 'plano:ler');

      const lista = await comTenant(db, escopo.organizacaoId, (tx) =>
        tx
          .select()
          .from(planos)
          .where(and(eq(planos.organizacaoId, escopo.organizacaoId), eq(planos.status, 'ativo')))
          .orderBy(desc(planos.iniciadoEm))
          .limit(100),
      );

      return { planos: lista };
    });

    /**
     * `GET /api/planos/:id`
     *
     * A tela mais importante do sistema: o episódio inteiro numa leitura.
     * Devolve o plano, a linha do tempo (com as versões antigas visíveis), a
     * série longitudinal e os deltas dos testes funcionais.
     */
    app.get('/api/planos/:id', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = exigirPermissao(req, 'plano:ler');
      const { id } = req.params as { id: string };

      return comTenant(db, escopo.organizacaoId, async (tx) => {
        const plano = await buscarPlano(tx, escopo, id);
        // `linhaDoTempo` grava `LEITURA_PRONTUARIO` — ler prontuário é evento
        // auditável, é assim que se detecta curiosidade indevida.
        const registros = await linhaDoTempo(tx, escopo, id);
        const longitudinal = await longitudinalDoPlano(tx, escopo, id);
        const testes = await deltasDoPlano(tx, escopo, id);

        return { plano, registros, ...longitudinal, testes };
      });
    });

    /** `POST /api/planos/:id/evolucoes` — cria a evolução como rascunho. */
    app.post(
      '/api/planos/:id/evolucoes',
      { preHandler: app.exigirProfissional },
      async (req, reply) => {
        const escopo = exigirPermissao(req, 'prontuario:escrever');
        const { id } = req.params as { id: string };
        const dados = zCriarEvolucao.parse(req.body);

        const criado = await comTenant(db, escopo.organizacaoId, (tx) =>
          criarEvolucao(tx, escopo, id, dados),
        );

        return reply.status(201).send(criado);
      },
    );

    /**
     * `POST /api/evolucoes/:id/finalizar` — sela e assina.
     *
     * Exige permissão **total**: estagiário tem `prontuario:escrever` restrito,
     * mas `prontuario:finalizar` negado. A assinatura carrega o CREFITO de um
     * profissional habilitado, e não há como um estagiário emprestá-la.
     */
    app.post(
      '/api/evolucoes/:id/finalizar',
      { preHandler: app.exigirProfissional },
      async (req) => {
        const escopo = exigirPermissaoTotal(req, 'prontuario:finalizar');
        const { id } = req.params as { id: string };

        await comTenant(db, escopo.organizacaoId, (tx) =>
          finalizarRegistro(tx, escopo, id),
        );

        await eventos.publicar(
          evento('EvolutionFinalized', escopo.organizacaoId, escopo.sujeitoId, {
            registroId: id,
          }),
        );

        return { ok: true };
      },
    );

    /**
     * `POST /api/evolucoes/:id/versoes` — corrige criando a versão seguinte.
     *
     * O registro anterior não é tocado. É esta rota que torna verdadeiro o selo
     * "N registros · 0 sobrescritos" da tela de plano de tratamento.
     */
    app.post(
      '/api/evolucoes/:id/versoes',
      { preHandler: app.exigirProfissional },
      async (req, reply) => {
        const escopo = exigirPermissaoTotal(req, 'prontuario:finalizar');
        const { id } = req.params as { id: string };
        const dados = zNovaVersao.parse(req.body);

        const criado = await comTenant(db, escopo.organizacaoId, (tx) =>
          criarVersao(tx, escopo, id, dados),
        );

        await eventos.publicar(
          evento('EvolutionVersioned', escopo.organizacaoId, escopo.sujeitoId, {
            registroId: criado.id,
            substituiId: id,
          }),
        );

        return reply.status(201).send(criado);
      },
    );

    /**
     * `GET /api/avaliacao-definicoes`
     *
     * O catálogo de testes funcionais. É **dado**, não código: incorporar o
     * WOMAC é inserir uma linha no banco, e esta rota já o devolve — sem
     * recompilar nem tocar no frontend.
     */
    app.get(
      '/api/avaliacao-definicoes',
      { preHandler: app.exigirProfissional },
      async (req) => {
        exigirPermissao(req, 'prontuario:ler');

        // Definições são catálogo compartilhado, sem tenant: a EVA é a mesma
        // escala em toda instalação. Por isso a consulta não filtra por
        // organização — e por isso a tabela não está sob RLS.
        const lista = await db
          .select()
          .from(definicoesTeste)
          .where(eq(definicoesTeste.ativo, true));

        if (lista.length === 0) throw new NaoEncontrado('Catálogo de testes vazio.');
        return { definicoes: lista };
      },
    );
  };
}
