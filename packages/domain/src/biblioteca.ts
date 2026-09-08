/**
 * Governança de publicação da biblioteca de exercícios.
 *
 * ## O fluxo
 *
 * ```
 * draft → in_review → published
 * ```
 *
 * Simples de descrever, e com duas regras que a interface do protótipo já
 * mostra e que precisam existir no servidor:
 *
 * 1. **Somente exercício `published` pode ser prescrito.** Rascunho e item em
 *    revisão não aparecem no passo 1 da prescrição HEP.
 * 2. **Item sem licença declarada não publica.** É o cartão do protótipo com
 *    "licença: pendente — bloqueia publicação". Não é preciosismo jurídico: a
 *    biblioteca é conteúdo redistribuído por um projeto de código aberto, e
 *    conteúdo sem licença conhecida é passivo para todo mundo que instalar.
 *
 * ## A pergunta em aberto que a especificação registra
 *
 * "Como versionar mudança sem invalidar prescrição ativa". A resposta adotada
 * aqui: **prescrição guarda a versão do exercício que usou**. Editar um
 * exercício publicado cria a versão seguinte; prescrições existentes continuam
 * apontando para a versão que o profissional de fato prescreveu. Ver
 * `docs/adr/0009-versionamento-biblioteca.md`.
 */

import { Conflito } from '@cinesis/shared';
import type { StatusExercicio } from '@cinesis/shared';

/** Um exercício do catálogo, do ponto de vista da governança. */
export interface ExercicioGovernavel {
  id: string;
  status: StatusExercicio;
  versao: number;
  /** Quem escreveu. */
  autorId: string;
  /** Quem revisou clinicamente. `null` até passar pela revisão. */
  revisorId: string | null;
  /** Licença declarada. `null` bloqueia a publicação. */
  licenca: string | null;
  /** Tem mídia (vídeo/imagem) associada? */
  temMidia: boolean;
}

/** Transições permitidas no fluxo de publicação. */
const TRANSICOES: Record<StatusExercicio, StatusExercicio[]> = {
  draft: ['in_review'], // Rascunho só avança para revisão.
  in_review: ['published', 'draft'], // Revisor aprova ou devolve.
  published: ['draft'], // Despublicar volta a rascunho (a versão fica).
};

/**
 * Valida uma transição de estado do exercício.
 *
 * @param exercicio    Estado atual.
 * @param novoStatus   Estado pretendido.
 * @param revisorId    Quem está revisando, quando aplicável.
 * @throws {Conflito}  Se a transição for inválida ou faltar pré-requisito.
 */
export function validarTransicao(
  exercicio: ExercicioGovernavel,
  novoStatus: StatusExercicio,
  revisorId: string | null,
): void {
  const permitidas = TRANSICOES[exercicio.status];

  if (!permitidas.includes(novoStatus)) {
    throw new Conflito(
      `Transição inválida: ${exercicio.status} → ${novoStatus}. Fluxo: draft → in_review → published.`,
    );
  }

  if (novoStatus === 'published') {
    // Regra 2: licença é pré-requisito duro de publicação.
    if (!exercicio.licenca) {
      throw new Conflito(
        'Exercício sem licença declarada não pode ser publicado. Informe a licença do conteúdo.',
      );
    }

    // Revisão clínica por outra pessoa. Autor revisando o próprio texto não é
    // revisão — e num catálogo que orienta exercício domiciliar, revisão é o
    // que separa conteúdo curado de conteúdo aleatório da internet.
    if (!revisorId) {
      throw new Conflito('Publicação exige revisão clínica registrada.');
    }
    if (revisorId === exercicio.autorId) {
      throw new Conflito('O revisor precisa ser diferente do autor do exercício.');
    }

    // Exercício sem mídia é instrução escrita sozinha. Aceitamos, mas com
    // aviso explícito — não bloqueia, porque um catálogo inicial curado pode
    // legitimamente começar sem vídeo.
  }
}

/**
 * O exercício pode ser prescrito?
 *
 * Ponto único de decisão, chamado tanto pela listagem (para filtrar) quanto
 * pela criação da prescrição (para recusar). Filtrar só na listagem deixaria
 * passar quem enviasse o id direto na requisição.
 */
export function podeSerPrescrito(exercicio: ExercicioGovernavel): boolean {
  return exercicio.status === 'published' && exercicio.licenca !== null;
}

/**
 * Exige que o exercício seja prescritível.
 *
 * @throws {Conflito} Com a razão específica, para que o profissional entenda
 *                    por que aquele item não aparece na lista.
 */
export function exigirPrescritivel(exercicio: ExercicioGovernavel): void {
  if (exercicio.status !== 'published') {
    throw new Conflito(
      `Somente exercício publicado pode ser prescrito. Este está em "${exercicio.status}".`,
    );
  }
  if (!exercicio.licenca) {
    throw new Conflito('Exercício sem licença declarada não pode ser prescrito.');
  }
}

/**
 * Cria a próxima versão de um exercício publicado.
 *
 * A versão anterior **continua existindo** para as prescrições que já a
 * referenciam. Isso é o que impede que um ajuste de texto hoje mude
 * retroativamente a orientação que um paciente recebeu há três semanas — o que
 * seria, na prática, alterar uma conduta clínica já prescrita.
 *
 * @param exercicio Versão publicada corrente.
 * @param novoId    Id da nova linha.
 */
export function novaVersaoExercicio(
  exercicio: ExercicioGovernavel,
  novoId: string,
): ExercicioGovernavel {
  if (exercicio.status !== 'published') {
    throw new Conflito('Só faz sentido versionar um exercício já publicado. Edite o rascunho.');
  }

  return {
    ...exercicio,
    id: novoId,
    versao: exercicio.versao + 1,
    status: 'draft', // A nova versão recomeça o fluxo de revisão.
    revisorId: null, // E precisa de revisão nova — a anterior não vale.
  };
}

/** As quatro perguntas em aberto antes de abrir a biblioteca à comunidade. */
export const DECISOES_PENDENTES = [
  {
    pergunta: 'Quem pode publicar?',
    situacao:
      'Hoje: qualquer profissional com `biblioteca:publicar`, desde que não seja o autor. Para contribuição externa, falta definir um papel de revisor.',
  },
  {
    pergunta: 'Como versionar sem invalidar prescrição ativa?',
    situacao:
      'Resolvido: a prescrição guarda a versão usada. Editar publica uma versão nova; a antiga permanece legível.',
  },
  {
    pergunta: 'Onde a mídia é armazenada?',
    situacao:
      'Hoje: disco local do operador, servido por rota autenticada. Falta decidir o caminho para instalação com múltiplos nós.',
  },
  {
    pergunta: 'Como a licença é verificada?',
    situacao:
      'Hoje: campo declarado pelo autor, bloqueante para publicação. A verificação da veracidade continua sendo humana.',
  },
] as const;
