/**
 * Rotas de pacientes.
 *
 * A rota de reidentificação é a mais sensível do sistema inteiro: ela desfaz a
 * pseudonimização. Por isso carrega quatro barreiras — permissão, motivo
 * obrigatório, rate limit e auditoria — e todas as quatro são verificáveis nos
 * testes de integração.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { zCriarPaciente, zReidentificar, zPaginacao, NaoEncontrado } from '@cinesis/shared';
import { LIMITES } from '@cinesis/security';
import { eq, and } from 'drizzle-orm';
import type { Deps } from '../deps.js';
import { comTenant } from '../db/conexao.js';
import { exigirPermissao, exigirPermissaoTotal } from '../plugins/autenticacao.js';
import { aplicarLimite } from '../plugins/seguranca.js';
import {
  cadastrarPaciente,
  listarPacientes,
  reidentificar,
  auditarReidentificacaoNegada,
} from '../servicos/pacientes.js';
import { auditarForaDeEscopo } from '../servicos/auditoria.js';
import { organizacoes } from '../db/schema.js';

export function rotasPacientes(deps: Deps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { db, anel } = deps;

    /**
     * `GET /api/pacientes`
     *
     * O nome só sai para quem pode reidentificar. Para os demais, o campo
     * `nome` vem `null` e a interface exibe o código — mas a diferença real é
     * que o nome **não foi lido do banco**.
     */
    app.get('/api/pacientes', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = exigirPermissao(req, 'paciente:ler');
      const { limite } = zPaginacao.parse(req.query ?? {});

      const lista = await comTenant(db, escopo.organizacaoId, (tx) =>
        listarPacientes(tx, anel, escopo, limite),
      );

      return {
        pacientes: lista,
        // A interface usa isto para decidir se mostra o aviso de RBAC da tela
        // de Pacientes. É informação sobre o próprio ator, não sobre os dados.
        podeReidentificar: escopo.podeVerPii(),
      };
    });

    /** `POST /api/pacientes` — cadastra separando e cifrando a PII. */
    app.post('/api/pacientes', { preHandler: app.exigirProfissional }, async (req, reply) => {
      const escopo = exigirPermissao(req, 'paciente:escrever');
      const dados = zCriarPaciente.parse(req.body);

      const criado = await comTenant(db, escopo.organizacaoId, async (tx) => {
        // O TCLE aceito precisa ser o vigente na organização. Aceitar uma
        // versão qualquer tornaria o campo decorativo.
        const [org] = await tx
          .select({ tcleVersao: organizacoes.tcleVersao })
          .from(organizacoes)
          .where(eq(organizacoes.id, escopo.organizacaoId))
          .limit(1);

        return cadastrarPaciente(tx, anel, escopo, {
          ...dados,
          consentimentoVersao: org?.tcleVersao ?? dados.consentimentoVersao,
        });
      });

      return reply.status(201).send(criado);
    });

    /**
     * `POST /api/pacientes/:id/reidentificar`
     *
     * A operação mais sensível do sistema. Ordem das barreiras:
     *
     * 1. `exigirPermissaoTotal` — papel sem a permissão recebe **404**, e a
     *    tentativa é auditada como `REIDENTIFICACAO_NEGADA`.
     * 2. Rate limit de 40/h por profissional — limita exfiltração em massa por
     *    conta legítima comprometida.
     * 3. Motivo obrigatório de 10+ caracteres (validado pelo schema).
     * 4. `REIDENTIFICACAO_AUTORIZADA` gravado na mesma transação.
     */
    app.post(
      '/api/pacientes/:id/reidentificar',
      { preHandler: app.exigirProfissional },
      async (req, reply) => {
        const { id } = req.params as { id: string };

        // Barreira 1. Um papel sem permissão nem chega ao serviço — mas a
        // tentativa precisa aparecer na trilha antes do 404.
        const escopoBase = req.escopo;
        if (escopoBase && !escopoBase.podeVerPii()) {
          await comTenant(db, escopoBase.organizacaoId, (tx) =>
            auditarReidentificacaoNegada(tx, escopoBase, id),
          );
          throw new NaoEncontrado();
        }

        const escopo = exigirPermissaoTotal(req, 'paciente:reidentificar');

        // Barreira 2.
        aplicarLimite(
          `reidentificar:${escopo.sujeitoId}`,
          LIMITES.reidentificacao,
          reply,
        );

        // Barreira 3: o schema recusa motivo com menos de 10 caracteres.
        const { motivo } = zReidentificar.parse(req.body);

        // Barreira 4 (sucesso) acontece dentro do serviço, na mesma transação:
        // não existe reidentificar sem deixar rastro.
        try {
          return await comTenant(db, escopo.organizacaoId, (tx) =>
            reidentificar(tx, anel, escopo, id, motivo),
          );
        } catch (erro) {
          // A tentativa FALHA precisa ser auditada numa transação SEPARADA.
          // Se fosse gravada dentro da transação que falhou, o rollback a
          // descartaria — e uma varredura de ids entre tenants não deixaria
          // rastro nenhum, que é o oposto do que a trilha existe para fazer.
          if (erro instanceof NaoEncontrado) {
            await comTenant(db, escopo.organizacaoId, (tx) =>
              auditarForaDeEscopo(
                tx,
                escopo.organizacaoId,
                escopo.sujeitoId,
                escopo.papel,
                'PacienteIdentificacao',
                id,
              ),
            );
          }
          throw erro;
        }
      },
    );

    /**
     * `GET /api/pacientes/:id`
     *
     * Devolve o paciente pseudonimizado. Note que **não existe** uma rota que
     * devolva a PII junto por padrão: para ver o nome é preciso chamar
     * `/reidentificar` e deixar rastro.
     */
    app.get('/api/pacientes/:id', { preHandler: app.exigirProfissional }, async (req) => {
      const escopo = exigirPermissao(req, 'paciente:ler');
      const { id } = req.params as { id: string };

      const { pacientes } = await import('../db/schema.js');

      const [paciente] = await comTenant(db, escopo.organizacaoId, (tx) =>
        tx
          .select({
            id: pacientes.id,
            codigo: pacientes.codigo,
            idade: pacientes.idade,
          })
          .from(pacientes)
          // Escopo na cláusula WHERE, sempre.
          .where(and(eq(pacientes.id, id), eq(pacientes.organizacaoId, escopo.organizacaoId)))
          .limit(1),
      );

      if (!paciente) throw new NaoEncontrado();
      return paciente;
    });
  };
}
