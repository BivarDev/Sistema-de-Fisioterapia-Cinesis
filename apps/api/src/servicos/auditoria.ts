/**
 * Serviço de auditoria: grava eventos encadeados por hash.
 *
 * ## Por que a gravação é síncrona e dentro da transação
 *
 * O barramento de eventos isola falhas de consumidor — bom para notificação e
 * métrica, errado para auditoria. Se a gravação da evolução clínica der certo
 * e a linha de auditoria falhar, ficamos com um acesso a prontuário sem
 * rastro, que é exatamente o que a trilha existe para impedir.
 *
 * Por isso a auditoria é gravada **na mesma transação** da operação auditada:
 * ou as duas acontecem, ou nenhuma.
 *
 * ## Serialização da cadeia
 *
 * O hash de cada evento depende do anterior, então dois eventos concorrentes da
 * mesma organização não podem calcular a sequência ao mesmo tempo. A trava é o
 * `SELECT ... FOR UPDATE` sobre a linha da organização: ele serializa apenas os
 * escritores daquele tenant, sem travar o sistema inteiro.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import {
  encadear,
  verificarCadeia,
  type AcaoAuditavel,
  type EventoEncadeado,
  redigirTexto,
} from '@cinesis/security';
import { auditoria, organizacoes } from '../db/schema.js';
import type { Banco } from '../db/conexao.js';
import { novoId } from '../infra/ids.js';

/** O que uma gravação de auditoria precisa saber. */
export interface EntradaAuditoria {
  organizacaoId: string;
  atorId: string | null;
  atorPapel: string;
  acao: AcaoAuditavel;
  entidade: string;
  entidadeId: string;
  /** Contexto operacional. Passa por redação antes de gravar. */
  detalhe?: string | null;
}

/**
 * Grava um evento na trilha.
 *
 * **Chame sempre dentro da transação da operação auditada.**
 *
 * @param tx      Transação corrente (de `comTenant`).
 * @param entrada Dados do evento.
 * @param agora   Instante (injetável para teste).
 * @returns       O evento gravado, já encadeado.
 */
export async function auditar(
  tx: Banco,
  entrada: EntradaAuditoria,
  agora = new Date(),
): Promise<EventoEncadeado> {
  // Trava a linha da organização. Serializa a escrita da cadeia deste tenant e
  // só dele — sem isto, dois eventos simultâneos calculariam a mesma
  // `sequencia` e um dos dois quebraria no índice único (perdendo o evento).
  await tx.execute(
    sql`SELECT id FROM organizacoes WHERE id = ${entrada.organizacaoId} FOR UPDATE`,
  );

  // Busca a ponta atual da cadeia.
  const [ultimo] = await tx
    .select({ sequencia: auditoria.sequencia, hash: auditoria.hash })
    .from(auditoria)
    .where(eq(auditoria.organizacaoId, entrada.organizacaoId))
    .orderBy(desc(auditoria.sequencia))
    .limit(1);

  const evento = encadear(
    {
      organizacaoId: entrada.organizacaoId,
      atorId: entrada.atorId,
      atorPapel: entrada.atorPapel,
      acao: entrada.acao,
      entidade: entrada.entidade,
      entidadeId: entrada.entidadeId,
      // Redação obrigatória: `detalhe` costuma vir de texto digitado (o motivo
      // da reidentificação, por exemplo) e não pode carregar CPF ou telefone
      // para dentro da trilha.
      detalhe: entrada.detalhe ? redigirTexto(entrada.detalhe).slice(0, 500) : null,
      ocorridoEm: agora,
    },
    ultimo ?? null,
  );

  await tx.insert(auditoria).values({
    id: novoId(),
    organizacaoId: evento.organizacaoId,
    sequencia: evento.sequencia,
    atorId: evento.atorId,
    atorPapel: evento.atorPapel,
    acao: evento.acao,
    entidade: evento.entidade,
    entidadeId: evento.entidadeId,
    detalhe: evento.detalhe,
    hashAnterior: evento.hashAnterior,
    hash: evento.hash,
    ocorridoEm: evento.ocorridoEm,
  });

  return evento;
}

/**
 * Lê a trilha de auditoria de uma organização.
 *
 * @param tx            Transação com tenant fixado.
 * @param organizacaoId Tenant.
 * @param filtros       Filtros opcionais de entidade e ação.
 * @param limite        Máximo de eventos. Sempre limitado — a trilha cresce
 *                      sem parar e um `SELECT *` nela derrubaria o processo.
 */
export async function lerTrilha(
  tx: Banco,
  organizacaoId: string,
  filtros: { entidade?: string; entidadeId?: string; acao?: string } = {},
  limite = 50,
) {
  const condicoes = [eq(auditoria.organizacaoId, organizacaoId)];

  // Cada filtro entra na cláusula WHERE. Nenhum é aplicado depois da busca.
  if (filtros.entidade) condicoes.push(eq(auditoria.entidade, filtros.entidade));
  if (filtros.entidadeId) condicoes.push(eq(auditoria.entidadeId, filtros.entidadeId));
  if (filtros.acao) condicoes.push(eq(auditoria.acao, filtros.acao));

  return tx
    .select()
    .from(auditoria)
    .where(and(...condicoes))
    .orderBy(desc(auditoria.sequencia))
    .limit(Math.min(limite, 200));
}

/**
 * Verifica a integridade da cadeia inteira de uma organização.
 *
 * Rode num job periódico e exponha na tela de segurança. É a única forma de
 * detectar adulteração feita **por fora da aplicação** — que é justamente o
 * cenário em que a auditoria mais importa.
 *
 * @param tx            Transação com tenant fixado.
 * @param organizacaoId Tenant.
 */
export async function verificarIntegridade(tx: Banco, organizacaoId: string) {
  const linhas = await tx
    .select()
    .from(auditoria)
    .where(eq(auditoria.organizacaoId, organizacaoId))
    .orderBy(auditoria.sequencia);

  const eventos: EventoEncadeado[] = linhas.map((l) => ({
    organizacaoId: l.organizacaoId,
    atorId: l.atorId,
    atorPapel: l.atorPapel,
    acao: l.acao as AcaoAuditavel,
    entidade: l.entidade,
    entidadeId: l.entidadeId,
    detalhe: l.detalhe,
    ocorridoEm: l.ocorridoEm,
    sequencia: l.sequencia,
    hashAnterior: l.hashAnterior,
    hash: l.hash,
  }));

  return verificarCadeia(eventos);
}

/**
 * Registra uma tentativa de acesso fora de escopo.
 *
 * Chamado quando o RBAC nega ou quando um id de outra organização é
 * consultado. O cliente recebe 404; a trilha guarda o que realmente aconteceu.
 * Sem este registro, uma varredura entre tenants seria invisível ao operador.
 */
export async function auditarForaDeEscopo(
  tx: Banco,
  organizacaoId: string,
  atorId: string,
  atorPapel: string,
  entidade: string,
  entidadeId: string,
): Promise<void> {
  await auditar(tx, {
    organizacaoId,
    atorId,
    atorPapel,
    acao: 'ACESSO_FORA_DE_ESCOPO',
    entidade,
    entidadeId,
    detalhe: 'Resposta 404 — recurso inexistente ou fora do escopo do ator.',
  });
}

/** Garante que a organização existe — usado antes de travar a linha. */
export async function organizacaoExiste(tx: Banco, organizacaoId: string): Promise<boolean> {
  const [org] = await tx
    .select({ id: organizacoes.id })
    .from(organizacoes)
    .where(eq(organizacoes.id, organizacaoId))
    .limit(1);
  return org !== undefined;
}
