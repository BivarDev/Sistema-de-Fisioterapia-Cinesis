/**
 * Rotas de HEP, biblioteca de exercícios e painel de adesão.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { zCriarPrescricao, zCriarExercicio, NaoEncontrado, Conflito } from '@cinesis/shared';
import { LIMITES, decifrar } from '@cinesis/security';
import { validarTransicao, evento, type ExercicioGovernavel } from '@cinesis/domain';
import { and, eq, inArray } from 'drizzle-orm';
import type { Deps } from '../deps.js';
import { comTenant } from '../db/conexao.js';
import { exigirPermissao, exigirPermissaoTotal } from '../plugins/autenticacao.js';
import { aplicarLimite } from '../plugins/seguranca.js';
import {
  criarPrescricao,
  emitirLinkPortal,
  painelDeAdesao,
  adesaoPorExercicioDaOrganizacao,
} from '../servicos/adesao.js';
import { exercicios, pacienteIdentificacao, planos } from '../db/schema.js';
import { catalogoVisivelPara } from '../servicos/catalogo-visivel.js';
import { novoId } from '../infra/ids.js';
import { auditar } from '../servicos/auditoria.js';

export function rotasAdesao(deps: Deps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { db, anel, config, eventos } = deps;

    /**
     * `GET /api/biblioteca`
     *
     * O filtro por status é do cliente, mas a regra de prescrição não depende
     * dele: `criarPrescricao` revalida cada item no servidor. Filtrar só aqui
     * deixaria passar quem enviasse o id de um rascunho direto na prescrição.
     */
    app.get('/api/biblioteca', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = exigirPermissao(req, 'biblioteca:ler');
      const { status } = (req.query ?? {}) as { status?: string };

      const lista = await db
        .select()
        .from(exercicios)
        .where(
          and(
            // `exercicios` fica FORA da RLS por ser catálogo híbrido (global +
            // por organização), então este filtro é a única defesa contra ler
            // o exercício personalizado de outra clínica. Ver
            // `servicos/catalogo-visivel.ts`.
            catalogoVisivelPara(escopo.organizacaoId),
            status ? eq(exercicios.status, status) : undefined,
          ),
        )
        .limit(200);

      return { exercicios: lista };
    });

    /** `POST /api/biblioteca` — cria exercício. Nasce sempre como rascunho. */
    app.post('/api/biblioteca', { preHandler: app.exigirProfissional }, async (req, reply) => {
      const escopo = exigirPermissao(req, 'biblioteca:escrever');
      const dados = zCriarExercicio.parse(req.body);

      const id = novoId();
      await db.insert(exercicios).values({
        id,
        organizacaoId: escopo.organizacaoId,
        nome: dados.nome,
        categoria: dados.categoria,
        regiao: dados.regiao,
        orientacao: dados.orientacao,
        // `status` fica no default `draft`. Não é parâmetro da requisição de
        // propósito: aceitar `status` do cliente permitiria publicar sem revisão.
        autorId: escopo.sujeitoId,
        licenca: dados.licenca ?? null,
      });

      return reply.status(201).send({ id });
    });

    /**
     * `POST /api/biblioteca/:id/publicar`
     *
     * As regras de governança (licença obrigatória, revisor diferente do autor,
     * fluxo draft → in_review → published) vivem no domínio e são aplicadas
     * aqui. Um exercício sem licença simplesmente não publica.
     */
    app.post(
      '/api/biblioteca/:id/publicar',
      { preHandler: app.exigirProfissional },
      async (req) => {
        const escopo = exigirPermissaoTotal(req, 'biblioteca:publicar');
        const { id } = req.params as { id: string };
        const { status } = (req.body ?? {}) as { status?: string };

        const alvo = status ?? 'published';
        if (alvo !== 'published' && alvo !== 'in_review' && alvo !== 'draft') {
          throw new Conflito('Status inválido.');
        }

        const [ex] = await db
          .select()
          .from(exercicios)
          .where(and(eq(exercicios.id, id), catalogoVisivelPara(escopo.organizacaoId)))
          .limit(1);

        // 404 também quando o exercício existe mas é de outra organização —
        // indistinguível de propósito, como no resto do sistema.
        if (!ex) throw new NaoEncontrado();

        const governavel: ExercicioGovernavel = {
          id: ex.id,
          status: ex.status as ExercicioGovernavel['status'],
          versao: ex.versao,
          autorId: ex.autorId ?? '',
          revisorId: ex.revisorId,
          licenca: ex.licenca,
          temMidia: ex.midiaId !== null,
        };

        // Lança 409 com a razão exata: transição inválida, licença ausente, ou
        // revisor igual ao autor.
        validarTransicao(governavel, alvo, escopo.sujeitoId);

        await db
          .update(exercicios)
          .set({
            status: alvo,
            revisorId: alvo === 'published' ? escopo.sujeitoId : ex.revisorId,
          })
          .where(eq(exercicios.id, id));

        return { ok: true, status: alvo };
      },
    );

    /** `POST /api/planos/:id/prescricoes` — monta o programa domiciliar. */
    app.post(
      '/api/planos/:id/prescricoes',
      { preHandler: app.exigirProfissional },
      async (req, reply) => {
        const escopo = exigirPermissao(req, 'hep:prescrever');
        const { id } = req.params as { id: string };
        const dados = zCriarPrescricao.parse(req.body);

        const criada = await comTenant(db, escopo.organizacaoId, (tx) =>
          criarPrescricao(tx, escopo, id, dados.itens, dados.metaSemanal),
        );

        // Os três consumidores que a tela de prescrição declara: auditoria,
        // notificações e métricas opt-in.
        await eventos.publicar(
          evento('ExercisePrescribed', escopo.organizacaoId, escopo.sujeitoId, {
            prescricaoId: criada.id,
            planoId: id,
            itens: dados.itens.length,
          }),
        );

        return reply.status(201).send(criada);
      },
    );

    /**
     * `POST /api/pacientes/:id/link-portal`
     *
     * Rate limit de 5/h **por paciente**, exatamente como a especificação
     * exige. Por paciente e não por profissional: o limite existe para proteger
     * o canal do paciente, não a conta de quem envia.
     */
    app.post(
      '/api/pacientes/:id/link-portal',
      { preHandler: app.exigirProfissional },
      async (req, reply) => {
        const escopo = exigirPermissao(req, 'hep:prescrever');
        const { id } = req.params as { id: string };

        aplicarLimite(`link:${id}`, LIMITES.linkPortal, reply);

        const link = await comTenant(db, escopo.organizacaoId, (tx) =>
          emitirLinkPortal(tx, anel, escopo, id, config.ambiente.PORTAL_URL),
        );

        return {
          url: link.url,
          expiraEm: link.expiraEm.toISOString(),
          // Texto exibido na tela, junto do link. Deixa as garantias visíveis
          // para o profissional que vai colar isso num WhatsApp.
          garantias: [
            'expira em 15 minutos',
            'uso único',
            'reemissão em vez de reuso',
            'no máximo 5 envios por hora',
          ],
        };
      },
    );

    /** `GET /api/adesao` — painel de adesão do fisioterapeuta. */
    app.get('/api/adesao', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = exigirPermissao(req, 'hep:ler');

      return comTenant(db, escopo.organizacaoId, async (tx) => {
        // Os nomes só são decifrados se o ator puder reidentificar. Para os
        // demais, o painel mostra `PC-4821` — e o nome não sai do banco.
        const nomes = new Map<string, string>();

        if (escopo.podeVerPii()) {
          const pacientesDoEscopo = await tx
            .select({ pacienteId: planos.pacienteId })
            .from(planos)
            .where(
              and(eq(planos.organizacaoId, escopo.organizacaoId), eq(planos.status, 'ativo')),
            );

          const ids = pacientesDoEscopo.map((p) => p.pacienteId);
          if (ids.length > 0) {
            const pii = await tx
              .select({
                id: pacienteIdentificacao.id,
                nomeCifrado: pacienteIdentificacao.nomeCifrado,
              })
              .from(pacienteIdentificacao)
              .where(
                and(
                  eq(pacienteIdentificacao.organizacaoId, escopo.organizacaoId),
                  inArray(pacienteIdentificacao.id, ids),
                ),
              );

            for (const p of pii) {
              try {
                nomes.set(p.id, decifrar(anel, p.nomeCifrado, `paciente:${p.id}`));
              } catch {
                // Uma linha ilegível (chave rotacionada sem a versão antiga)
                // não derruba o painel inteiro.
              }
            }
          }
        }

        const linhas = await painelDeAdesao(tx, escopo, nomes);
        const porExercicio = await adesaoPorExercicioDaOrganizacao(tx, escopo);

        await auditar(tx, {
          organizacaoId: escopo.organizacaoId,
          atorId: escopo.sujeitoId,
          atorPapel: escopo.papel,
          acao: 'LEITURA_PRONTUARIO',
          entidade: 'PainelAdesao',
          entidadeId: escopo.organizacaoId,
          detalhe: `${linhas.length} pacientes no painel.`,
        });

        return { pacientes: linhas, porExercicio };
      });
    });
  };
}
