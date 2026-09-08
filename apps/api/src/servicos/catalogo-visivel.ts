/**
 * Visibilidade do catálogo de exercícios.
 *
 * ## O vazamento que este arquivo fecha
 *
 * `exercicios` é um catálogo **híbrido**: `organizacao_id IS NULL` marca os
 * itens globais e curados, e um valor preenchido marca o exercício que uma
 * clínica criou para si.
 *
 * Por ser híbrida, a tabela fica fora do Row-Level Security — a política
 * `organizacao_id = current_setting(...)` esconderia os itens globais de todo
 * mundo, já que `NULL = 'org-x'` é `NULL`, nunca verdadeiro.
 *
 * Consequência: a rede de segurança da RLS **não vale aqui**, e o filtro na
 * consulta deixa de ser redundante para virar a única defesa. Sem ele, uma
 * clínica lê os exercícios personalizados de outra — incluindo o texto de
 * orientação, que pode conter informação sobre a prática dela.
 *
 * Esta função existe para que esse filtro tenha um nome, um lugar e um motivo
 * escrito, em vez de ser um `or(...)` repetido em quatro consultas — das quais
 * uma inevitavelmente ficaria para trás.
 */

import { eq, isNull, or, type SQL } from 'drizzle-orm';
import { exercicios } from '../db/schema.js';

/**
 * Condição de visibilidade do catálogo para uma organização.
 *
 * Devolve "global **ou** meu". Nunca "de outra clínica".
 *
 * @param organizacaoId Tenant do ator.
 */
export function catalogoVisivelPara(organizacaoId: string): SQL | undefined {
  return or(
    // Catálogo padrão, compartilhado por todas as instalações.
    isNull(exercicios.organizacaoId),
    // O que esta organização criou.
    eq(exercicios.organizacaoId, organizacaoId),
  );
}
