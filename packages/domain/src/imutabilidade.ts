/**
 * Imutabilidade do prontuário — COFFITO 415/2012.
 *
 * ## A regra
 *
 * Registro clínico finalizado não é editado. Nunca. Uma correção **cria uma
 * versão nova** e a anterior permanece íntegra e visível na linha do tempo.
 * A tela de plano de tratamento mostra isso explicitamente com o selo
 * "7 registros · 0 sobrescritos".
 *
 * ## Por que isto vive no domínio, e não no handler HTTP
 *
 * Se a regra estivesse num `if` dentro da rota `PATCH /evolucoes/:id`, bastaria
 * uma segunda rota (um endpoint de importação, um job de migração, um script de
 * correção rodado às pressas) para furá-la. Aqui ela é uma função pura que toda
 * escrita atravessa, testada isoladamente, e o repositório não expõe UPDATE de
 * registro finalizado — o banco também recusa, via gatilho.
 *
 * Três camadas para a mesma regra:
 * 1. Esta função (domínio).
 * 2. O repositório, que só faz `UPDATE ... WHERE finalizado_em IS NULL`.
 * 3. Um gatilho no PostgreSQL que lança exceção ao alterar linha finalizada.
 */

import { Conflito } from '@cinesis/shared';

/** O estado de um registro clínico do ponto de vista da imutabilidade. */
export interface RegistroSelavel {
  id: string;
  /** `null` enquanto é rascunho; preenchido no momento de selar. */
  finalizadoEm: Date | null;
  /** Número da versão. Começa em 1. */
  versao: number;
  /** Id do registro que esta versão substitui, se for uma correção. */
  substituiId: string | null;
  /** Quem assinou: id do profissional. `null` enquanto rascunho. */
  assinadoPorId: string | null;
}

/** Um registro já finalizado é imutável? Sim — esta função é a pergunta formal. */
export function estaSelado(registro: RegistroSelavel): boolean {
  return registro.finalizadoEm !== null;
}

/**
 * Garante que um registro pode ser editado no lugar.
 *
 * @throws {Conflito} 409 se o registro já estiver selado. A mensagem cita a
 *         resolução para que o profissional entenda que não é limitação do
 *         software, e sim exigência do conselho.
 */
export function exigirEditavel(registro: RegistroSelavel): void {
  if (estaSelado(registro)) {
    throw new Conflito(
      'Registro finalizado é imutável (COFFITO 415/2012). Crie uma nova versão para corrigir.',
    );
  }
}

/** Dados necessários para selar um registro. */
export interface DadosAssinatura {
  /** Id do profissional que assina. */
  profissionalId: string;
  /** Registro no conselho. Obrigatório: a assinatura sem CREFITO não vale. */
  crefito: string | null;
  /** Instante da assinatura. Injetável para teste. */
  agora: Date;
}

/**
 * Sela um registro: torna-o imutável e grava a assinatura.
 *
 * @param registro Registro em rascunho.
 * @param dados    Quem assina e quando.
 * @returns        O registro selado (objeto novo — não muta a entrada).
 * @throws {Conflito} Se já estiver selado, ou se faltar CREFITO.
 */
export function selar(registro: RegistroSelavel, dados: DadosAssinatura): RegistroSelavel {
  // Selar duas vezes normalmente é clique duplo, mas seria um bug perigoso se
  // sobrescrevesse a assinatura original com outro profissional.
  if (estaSelado(registro)) {
    throw new Conflito('Este registro já foi finalizado e assinado.');
  }

  // COFFITO 415/2012 exige o número de inscrição vinculado ao registro. Sem
  // ele o prontuário é formalmente inválido — melhor barrar na hora do que
  // descobrir numa fiscalização.
  if (!dados.crefito) {
    throw new Conflito('É preciso ter CREFITO cadastrado para assinar um registro clínico.');
  }

  return {
    ...registro,
    finalizadoEm: dados.agora,
    assinadoPorId: dados.profissionalId,
  };
}

/** O que a criação de uma nova versão precisa saber. */
export interface DadosNovaVersao {
  /** Id da nova linha (gerado por quem chama). */
  novoId: string;
  /** Justificativa da correção. Vai para a auditoria e para a linha do tempo. */
  motivo: string;
}

/**
 * Cria a próxima versão de um registro selado.
 *
 * Ponto central: o registro devolvido é **um novo rascunho**, apontando para o
 * anterior por `substituiId`. Nada da versão anterior é alterado — nem o
 * conteúdo, nem a assinatura, nem a data. É por isso que a linha do tempo
 * consegue mostrar "Evolução · v2 — Correção de registro (nova versão)" tendo a
 * v1 logo acima, exatamente como no protótipo.
 *
 * @param original Registro selado a corrigir.
 * @param dados    Id da nova linha e motivo.
 * @returns        Novo rascunho, versão + 1.
 * @throws {Conflito} Se o original ainda for rascunho (basta editá-lo), ou se
 *                    o motivo for curto demais para servir de justificativa.
 */
export function criarNovaVersao(
  original: RegistroSelavel,
  dados: DadosNovaVersao,
): RegistroSelavel {
  if (!estaSelado(original)) {
    throw new Conflito('O registro ainda é um rascunho — edite-o em vez de criar nova versão.');
  }

  if (dados.motivo.trim().length < 10) {
    throw new Conflito('Descreva o motivo da correção com pelo menos 10 caracteres.');
  }

  return {
    id: dados.novoId,
    finalizadoEm: null, // Nasce como rascunho: precisa ser revisada e assinada.
    versao: original.versao + 1,
    substituiId: original.id, // O elo que preserva a rastreabilidade.
    assinadoPorId: null,
  };
}

/**
 * Reconstrói a cadeia de versões de um registro, da v1 até a mais recente.
 *
 * Usada na linha do tempo para mostrar o histórico completo de uma correção.
 *
 * @param registros Todos os registros do plano.
 * @param idFinal   Id da versão mais recente.
 * @returns         Do mais antigo ao mais novo.
 */
export function cadeiaDeVersoes(
  registros: readonly RegistroSelavel[],
  idFinal: string,
): RegistroSelavel[] {
  const porId = new Map(registros.map((r) => [r.id, r]));
  const cadeia: RegistroSelavel[] = [];

  let atual = porId.get(idFinal);
  // Teto de iterações: protege contra um `substituiId` circular criado por
  // dado corrompido, que travaria a requisição num laço infinito.
  let voltas = 0;

  while (atual && voltas < 100) {
    cadeia.unshift(atual);
    atual = atual.substituiId ? porId.get(atual.substituiId) : undefined;
    voltas++;
  }

  return cadeia;
}

/**
 * Quantos registros foram efetivamente sobrescritos.
 *
 * Sempre `0` por construção — a função existe para que a interface possa
 * exibir o número calculado a partir do dado real, em vez de um literal
 * escrito à mão no frontend. Um valor diferente de zero aqui significaria que
 * alguém contornou o domínio, e vale a pena que isso apareça na tela.
 *
 * @param registros Registros do plano.
 * @returns         Total de registros e quantos foram sobrescritos.
 */
export function contarIntegridade(registros: readonly RegistroSelavel[]): {
  total: number;
  sobrescritos: number;
} {
  // Um registro "sobrescrito" seria um que foi substituído E teve o próprio
  // conteúdo alterado. Como `criarNovaVersao` nunca toca no original, o único
  // jeito de isto passar de zero é escrita fora do domínio.
  const substituidos = new Set(
    registros.map((r) => r.substituiId).filter((id): id is string => id !== null),
  );

  const sobrescritos = registros.filter(
    (r) => substituidos.has(r.id) && r.finalizadoEm === null,
  ).length;

  return { total: registros.length, sobrescritos };
}
