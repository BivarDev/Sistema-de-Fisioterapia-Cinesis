/**
 * Pseudonimização: o código `PC-XXXX` que substitui o nome do paciente.
 *
 * ## O que é e o que não é
 *
 * Pseudonimização (LGPD Art. 13) é tratar o dado de forma que ele não possa
 * ser associado ao titular **sem informação adicional mantida separadamente**.
 * Aqui a "informação adicional" é a subchave HMAC, que vive no ambiente do
 * operador e nunca no banco. Quem rouba um dump de banco fica com códigos
 * `PC-4821` sem forma de voltar ao nome.
 *
 * Isto **não** é anonimização. O dado continua sendo dado pessoal para efeitos
 * da LGPD, e a reidentificação continua sendo possível para quem tem a chave —
 * por isso ela é uma operação governada e auditada, não um clique silencioso.
 *
 * ## Por que HMAC e não hash simples
 *
 * `sha256(uuid)` seria reversível por qualquer um que tenha a lista de UUIDs:
 * bastaria hashear todos e comparar. O HMAC exige a chave, que o atacante não
 * tem. Esse é exatamente o cenário de "dump de banco" — os UUIDs estão no dump.
 */

import { type Anel, hmac } from './chaves.js';

/**
 * Alfabeto do código legível.
 *
 * Sem `I`, `O`, `0` e `1`: são os pares que geram erro quando alguém dita o
 * código por telefone ou copia de uma tela. Como o código aparece impresso em
 * relatório e é lido em voz alta na clínica, legibilidade aqui é requisito,
 * não capricho.
 */
const ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Quantos caracteres o código tem depois do prefixo. */
const COMPRIMENTO = 4;

/**
 * Gera o código pseudonimizado estável de um paciente.
 *
 * Determinístico: o mesmo `pacienteId` na mesma instalação sempre produz o
 * mesmo código. Isso é necessário para que o profissional reconheça `PC-4821`
 * ao longo do tratamento inteiro.
 *
 * @param anel        Anel de chaves do processo.
 * @param pacienteId  UUID do paciente.
 * @param prefixo     Prefixo do código. `PC` = paciente clínico.
 * @returns           Código no formato `PC-4821`.
 */
export function codigoPseudonimo(anel: Anel, pacienteId: string, prefixo = 'PC'): string {
  // Subchave dedicada: vazá-la não ajuda a decifrar PII nem a forjar sessão.
  const chave = anel.derivar('pseudonimizacao');
  const digest = hmac(chave, `paciente:${pacienteId}`);

  let codigo = '';
  for (let i = 0; i < COMPRIMENTO; i++) {
    // Consome 2 caracteres hex (1 byte) por posição e mapeia no alfabeto.
    const byte = parseInt(digest.slice(i * 2, i * 2 + 2), 16);
    codigo += ALFABETO[byte % ALFABETO.length];
  }

  return `${prefixo}-${codigo}`;
}

/**
 * Decide o que expor como "nome" de um paciente, conforme o ator.
 *
 * Esta função é o ponto único onde a decisão "mostra nome ou mostra código"
 * acontece. Espalhar esse `if` pelas rotas é como o nome acaba vazando numa
 * rota esquecida.
 *
 * @param podeReidentificar `true` só quando o papel tem `paciente:reidentificar`.
 * @param nomeReal          Nome já decifrado. Passe `null` se nem foi buscado.
 * @param codigo            Código pseudonimizado, sempre disponível.
 * @returns                 O nome quando permitido; o código caso contrário.
 */
export function nomeExibivel(
  podeReidentificar: boolean,
  nomeReal: string | null,
  codigo: string,
): string {
  return podeReidentificar && nomeReal ? nomeReal : codigo;
}

/**
 * Converte data de nascimento em idade — a forma menos identificante de expor
 * a mesma informação clínica útil.
 *
 * A data completa de nascimento é um quase-identificador forte: combinada com
 * CEP e sexo, ela reidentifica boa parte da população. A idade em anos não.
 * Por isso listagens devolvem `idade`, nunca `nascimento`.
 *
 * @param nascimentoISO Data `YYYY-MM-DD`.
 * @param referencia    Data base do cálculo. Padrão: agora.
 * @returns             Idade em anos completos, ou `null` se a data for inválida.
 */
export function idadeEmAnos(nascimentoISO: string, referencia = new Date()): number | null {
  const nasc = new Date(`${nascimentoISO}T00:00:00Z`);
  if (Number.isNaN(nasc.getTime())) return null;

  let idade = referencia.getUTCFullYear() - nasc.getUTCFullYear();

  // Ainda não fez aniversário este ano? Desconta um.
  const mes = referencia.getUTCMonth() - nasc.getUTCMonth();
  if (mes < 0 || (mes === 0 && referencia.getUTCDate() < nasc.getUTCDate())) {
    idade--;
  }

  return idade >= 0 && idade < 130 ? idade : null;
}
