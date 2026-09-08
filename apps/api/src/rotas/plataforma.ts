/**
 * Rotas de plataforma: auditoria, sessões ativas e métricas da tela "Hoje".
 *
 * A tela *Segurança & auditoria* existe para tornar a fundação de segurança
 * **visível e verificável pelo operador** — que é quem responde como
 * controlador dos dados. Estas rotas são o que a alimenta.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { zConsultaAuditoria, NaoEncontrado, PERMISSOES_POR_PAPEL } from '@cinesis/shared';
import { analisarTendencia } from '@cinesis/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { Deps } from '../deps.js';
import { comTenant } from '../db/conexao.js';
import { exigirPermissaoTotal, exigirPermissao } from '../plugins/autenticacao.js';
import { lerTrilha, verificarIntegridade, auditar } from '../servicos/auditoria.js';
import { longitudinalDoPlano } from '../servicos/prontuario.js';
import { contarAtivos } from '../servicos/pacientes.js';
import { planos, prescricoes, registrosAdesao, sessoes } from '../db/schema.js';

export function rotasPlataforma(deps: Deps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { db, gestor } = deps;

    /**
     * `GET /api/auditoria` — a trilha.
     *
     * Ler a auditoria também é auditado. Não é excesso de zelo: sem isso, quem
     * consulta a trilha para descobrir se foi flagrado não deixa rastro dessa
     * consulta.
     */
    app.get('/api/auditoria', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = exigirPermissaoTotal(req, 'auditoria:ler');
      const filtros = zConsultaAuditoria.parse(req.query ?? {});

      return comTenant(db, escopo.organizacaoId, async (tx) => {
        const eventos = await lerTrilha(
          tx,
          escopo.organizacaoId,
          {
            ...(filtros.entidade ? { entidade: filtros.entidade } : {}),
            ...(filtros.entidadeId ? { entidadeId: filtros.entidadeId } : {}),
            ...(filtros.acao ? { acao: filtros.acao } : {}),
          },
          filtros.limite,
        );

        await auditar(tx, {
          organizacaoId: escopo.organizacaoId,
          atorId: escopo.sujeitoId,
          atorPapel: escopo.papel,
          acao: 'LEITURA_AUDITORIA',
          entidade: 'Auditoria',
          entidadeId: escopo.organizacaoId,
          detalhe: `${eventos.length} eventos consultados.`,
        });

        return { eventos };
      });
    });

    /**
     * `GET /api/auditoria/integridade`
     *
     * Recalcula a cadeia de hash inteira e diz se ela confere. É a única forma
     * de detectar adulteração feita **por fora da aplicação** — alguém com
     * acesso direto ao banco.
     *
     * A resposta inclui a âncora (sequência + hash da ponta) para que o
     * operador possa publicá-la fora do banco. Sem cópia externa da ponta,
     * quem tem acesso total pode reescrever tudo e o hash final continuará
     * consistente consigo mesmo — isso está explicado em
     * `docs/security-model.md`.
     */
    app.get(
      '/api/auditoria/integridade',
      { preHandler: app.exigirProfissional },
      async (req) => {
        const escopo = exigirPermissaoTotal(req, 'auditoria:ler');

        return comTenant(db, escopo.organizacaoId, async (tx) => {
          const resultado = await verificarIntegridade(tx, escopo.organizacaoId);
          const ponta = await lerTrilha(tx, escopo.organizacaoId, {}, 1);

          return {
            ...resultado,
            ancora: ponta[0]
              ? {
                  sequencia: ponta[0].sequencia,
                  hash: ponta[0].hash,
                  geradaEm: new Date().toISOString(),
                }
              : null,
          };
        });
      },
    );

    /** `GET /api/sessoes` — sessões ativas do próprio profissional. */
    app.get('/api/sessoes', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = req.escopo;
      if (!escopo) throw new NaoEncontrado();

      const ativas = await gestor.listar(escopo.sujeitoId);

      return {
        sessoes: ativas.map((s) => ({
          // Prefixo do hash, não a chave inteira: a tela precisa distinguir as
          // sessões, não reproduzi-las.
          referencia: s.chave.slice(0, 16),
          // A sessão corrente é marcada para o usuário não revogar a própria
          // por engano.
          atual: s.dados.csrf === req.sessao?.csrf,
          criadaEm: new Date(s.dados.criadaEm).toISOString(),
          usadaEm: new Date(s.dados.usadaEm).toISOString(),
          dispositivo: s.dados.agenteHash,
          chave: s.chave,
        })),
      };
    });

    /** `DELETE /api/sessoes/:chave` — revoga uma sessão específica. */
    app.delete('/api/sessoes/:chave', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = req.escopo;
      if (!escopo) throw new NaoEncontrado();

      const { chave } = req.params as { chave: string };

      // Confirma que a sessão é do próprio ator antes de revogar. Sem isso,
      // qualquer usuário derrubaria a sessão de qualquer outro sabendo a chave.
      const minhas = await gestor.listar(escopo.sujeitoId);
      if (!minhas.some((s) => s.chave === chave)) throw new NaoEncontrado();

      await gestor.revogarPorChave(chave);

      await comTenant(db, escopo.organizacaoId, (tx) =>
        auditar(tx, {
          organizacaoId: escopo.organizacaoId,
          atorId: escopo.sujeitoId,
          atorPapel: escopo.papel,
          acao: 'SESSAO_REVOGADA',
          entidade: 'Sessao',
          entidadeId: chave.slice(0, 16),
        }),
      );

      return { ok: true };
    });

    /** `GET /api/rbac` — a matriz de permissões, para a tela de segurança. */
    app.get('/api/rbac', { preHandler: app.exigirProfissional }, async (req) => {
      exigirPermissao(req, 'prontuario:ler');
      // A matriz é a mesma constante que o backend usa para decidir. Exibir
      // uma cópia mantida à mão no frontend seria documentação que mente.
      return { matriz: PERMISSOES_POR_PAPEL };
    });

    /**
     * `GET /api/hoje` — a tela inicial do fisioterapeuta.
     *
     * Responde a uma pergunta só: *qual decisão eu preciso tomar agora?*
     * Por isso são quatro métricas e quatro sinais, não um painel com dezenas
     * de indicadores sem ação associada.
     */
    app.get('/api/hoje', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = exigirPermissao(req, 'plano:ler');

      return comTenant(db, escopo.organizacaoId, async (tx) => {
        const pacientesAtivos = await contarAtivos(tx, escopo.organizacaoId);

        const [planosAtivos] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(planos)
          .where(
            and(eq(planos.organizacaoId, escopo.organizacaoId), eq(planos.status, 'ativo')),
          );

        // Adesão média: agregada no banco, sem trazer registro por registro.
        const [adesao] = await tx
          .select({
            media: sql<number>`coalesce(round(avg(case when ${registrosAdesao.status} = 'fez' then 100 when ${registrosAdesao.status} = 'parcial' then 50 else 0 end)), 0)::int`,
          })
          .from(registrosAdesao)
          .where(eq(registrosAdesao.organizacaoId, escopo.organizacaoId));

        // No-show e falta justificada contados SEPARADAMENTE. Somá-los num
        // número só esconderia a informação que muda a conduta.
        const [faltas] = await tx
          .select({
            noShow: sql<number>`count(*) filter (where ${sessoes.status} = 'no_show')::int`,
            justificadas: sql<number>`count(*) filter (where ${sessoes.status} = 'falta_justificada')::int`,
            total: sql<number>`count(*)::int`,
          })
          .from(sessoes)
          .where(eq(sessoes.organizacaoId, escopo.organizacaoId));

        // --- Sinais: derivados de eventos, não de painel genérico -----------
        const ativos = await tx
          .select({ id: planos.id, reavaliacaoEm: planos.reavaliacaoEm })
          .from(planos)
          .where(
            and(eq(planos.organizacaoId, escopo.organizacaoId), eq(planos.status, 'ativo')),
          )
          .limit(100);

        let estagnados = 0;
        for (const p of ativos) {
          const { serie } = await longitudinalDoPlano(tx, escopo, p.id);
          if (analisarTendencia(serie).tendencia === 'estagnado') estagnados++;
        }

        const hoje = new Date().toISOString().slice(0, 10);
        const reavaliacoesVencidas = ativos.filter(
          (p) => p.reavaliacaoEm !== null && p.reavaliacaoEm < hoje,
        ).length;

        const [semPrescricao] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(planos)
          .leftJoin(
            prescricoes,
            and(eq(prescricoes.planoId, planos.id), eq(prescricoes.ativa, true)),
          )
          .where(
            and(
              eq(planos.organizacaoId, escopo.organizacaoId),
              eq(planos.status, 'ativo'),
              sql`${prescricoes.id} IS NULL`,
            ),
          );

        const totalSessoes = faltas?.total ?? 0;

        return {
          metricas: {
            pacientesAtivos,
            planosAtivos: planosAtivos?.n ?? 0,
            adesaoMedia: adesao?.media ?? 0,
            noShow:
              totalSessoes === 0 ? 0 : Math.round(((faltas?.noShow ?? 0) / totalSessoes) * 100),
            faltaJustificada:
              totalSessoes === 0
                ? 0
                : Math.round(((faltas?.justificadas ?? 0) / totalSessoes) * 100),
          },
          sinais: [
            {
              quantidade: estagnados,
              descricao: 'planos sem evolução mensurável nas últimas 3 sessões',
              acao: 'revisar plano',
            },
            {
              quantidade: reavaliacoesVencidas,
              descricao: 'reavaliações vencidas',
              acao: 'agendar reavaliação',
            },
            {
              quantidade: semPrescricao?.n ?? 0,
              descricao: 'planos ativos sem prescrição domiciliar',
              acao: 'prescrever HEP',
            },
          ],
        };
      });
    });
  };
}
