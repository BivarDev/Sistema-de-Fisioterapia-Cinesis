/**
 * Cifragem de PII em repouso + índice cego para busca.
 *
 * ## Por que este arquivo existe (lacuna da especificação v1.1)
 *
 * A especificação separa `PacienteIdentificacao` de `PacienteClinico` em
 * tabelas distintas. Isso resolve *acesso indevido pela aplicação*, mas não
 * resolve **dump de banco**, **backup vazado** ou **snapshot de disco**: nesses
 * cenários a tabela de PII está lá, em texto claro, com nome e CPF de todo
 * paciente da clínica. Separar tabela sem cifrar é meia proteção.
 *
 * Aqui a PII é cifrada com AES-256-GCM (cifra autenticada: detecta adulteração
 * do ciphertext, não só o decifra) usando uma subchave derivada do anel.
 *
 * ## O problema que a cifragem cria — e como resolvemos
 *
 * Dado cifrado não é pesquisável. "Buscar paciente pelo CPF" deixaria de
 * funcionar, porque cada cifragem do mesmo CPF gera um ciphertext diferente
 * (IV aleatório, como deve ser). A solução é o **índice cego**: além do
 * ciphertext, guardamos `HMAC(subchave_blind_index, valor_normalizado)`.
 *
 * O índice cego é determinístico — logo, pesquisável por igualdade — mas
 * irreversível sem a chave, e **inútil fora desta instalação** porque a chave
 * é local. Ele NÃO permite busca parcial (por prefixo, por "contém"), e isso é
 * proposital: busca parcial sobre PII cifrada só é possível com esquemas que
 * vazam ordem/frequência.
 *
 * Limitação honesta: quem tem o índice cego e uma lista de CPFs candidatos
 * pode confirmar presença por força bruta **se também tiver a chave**. Sem a
 * chave, não. Por isso a subchave de blind index é derivada separadamente da
 * de cifragem, e ambas moram fora do banco.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type Anel, type Finalidade, hmac } from './chaves.js';

/** Bytes do vetor de inicialização. 12 é o tamanho recomendado para AES-GCM. */
const IV_BYTES = 12;
/** Bytes da tag de autenticação do GCM. 16 é o máximo e o padrão. */
const TAG_BYTES = 16;
/** Prefixo do formato serializado, para reconhecer o esquema no futuro. */
const ESQUEMA = 'c1';

/**
 * Cifra um valor de PII.
 *
 * Formato de saída: `c1$<versaoChave>$<iv>$<tag>$<ciphertext>`, tudo em base64url.
 * A versão da chave viaja junto com o dado — é o que permite rotacionar a chave
 * sem reescrever a tabela inteira de uma vez.
 *
 * @param anel  Anel de chaves do processo.
 * @param texto Valor em claro (nome, CPF, telefone, e-mail...).
 * @param aad   Dado adicional autenticado. Amarre o ciphertext ao seu contexto
 *              (ex.: o id do paciente). Sem isso, um atacante com acesso de
 *              escrita ao banco poderia mover o nome cifrado do paciente A para
 *              a linha do paciente B, e o GCM não notaria — o ciphertext é
 *              válido, só está no lugar errado.
 * @returns     String serializada, segura para guardar em coluna `text`.
 */
export function cifrar(anel: Anel, texto: string, aad: string): string {
  const versao = anel.versaoAtual;
  const chave = anel.derivar('cifragem-pii', versao);
  const iv = randomBytes(IV_BYTES); // Novo a cada cifragem — reusar IV quebra o GCM.

  const cipher = createCipheriv('aes-256-gcm', chave, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8')); // Amarra o dado ao contexto.

  const ciphertext = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ESQUEMA,
    String(versao),
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('$');
}

/**
 * Decifra um valor produzido por `cifrar`.
 *
 * @param anel        Anel de chaves.
 * @param serializado String no formato `c1$…`.
 * @param aad         O MESMO contexto usado ao cifrar. Divergiu, falha.
 * @returns           Valor em claro.
 * @throws            Se o formato for inválido, a chave da versão não estiver
 *                    no anel, ou a autenticação falhar (dado adulterado).
 */
export function decifrar(anel: Anel, serializado: string, aad: string): string {
  const partes = serializado.split('$');
  if (partes.length !== 5 || partes[0] !== ESQUEMA) {
    throw new Error('Formato de valor cifrado inválido.');
  }

  const versao = Number(partes[1]);
  if (!Number.isInteger(versao) || versao < 1) {
    throw new Error('Versão de chave inválida no valor cifrado.');
  }

  const chave = anel.derivar('cifragem-pii', versao);
  const iv = Buffer.from(partes[2] as string, 'base64url');
  const tag = Buffer.from(partes[3] as string, 'base64url');
  const ciphertext = Buffer.from(partes[4] as string, 'base64url');

  const decipher = createDecipheriv('aes-256-gcm', chave, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag); // Se o ciphertext ou o AAD mudaram, `final()` lança.

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Verifica se um valor cifrado precisa ser reescrito com a chave atual.
 *
 * Use num job de rotação: leia, `decifrar`, `cifrar` de novo, grave. Enquanto
 * a reescrita não termina, leitura continua funcionando pelas chaves antigas.
 *
 * @returns `true` quando o dado foi cifrado com uma versão anterior à atual.
 */
export function precisaRecifrar(anel: Anel, serializado: string): boolean {
  const versao = Number(serializado.split('$')[1]);
  return Number.isInteger(versao) && versao < anel.versaoAtual;
}

/**
 * Normaliza um valor antes de indexar.
 *
 * Sem normalização o índice cego não casa: `"Ana@X.com "` e `"ana@x.com"`
 * produziriam HMACs diferentes e a busca falharia. Também removemos pontuação
 * de documento, para que `123.456.789-00` e `12345678900` sejam o mesmo.
 */
function normalizar(valor: string): string {
  return valor
    .trim()
    .toLowerCase()
    .normalize('NFKD') // Separa acento da letra base…
    .replace(/[̀-ͯ]/g, '') // …e remove o acento, para "José" == "Jose".
    .replace(/[.\-/()\s]/g, ''); // Tira pontuação de CPF, telefone e afins.
}

/**
 * Gera o índice cego de um valor: um HMAC determinístico e pesquisável.
 *
 * @param anel   Anel de chaves.
 * @param valor  Valor em claro.
 * @param campo  Nome do campo (`cpf`, `email`...). Entra no HMAC para que o
 *               mesmo número usado como CPF e como telefone não colida, e para
 *               que o índice de um campo não sirva para consultar outro.
 * @returns      Hex de 64 caracteres, com prefixo de versão: `v1:<hex>`.
 */
export function indiceCego(anel: Anel, valor: string, campo: string): string {
  const versao = anel.versaoAtual;
  const chave = anel.derivar('blind-index', versao);
  return `v${versao}:${hmac(chave, `${campo}|${normalizar(valor)}`)}`;
}

/**
 * Gera o índice cego para TODAS as versões de chave do anel.
 *
 * Necessário na busca durante uma rotação: linhas já reescritas têm índice na
 * versão nova, linhas ainda não migradas têm na antiga. A consulta usa
 * `WHERE indice = ANY($1)` com este array e encontra as duas.
 */
export function indicesCegosParaBusca(anel: Anel, valor: string, campo: string): string[] {
  return anel.versoes().map((v) => {
    const chave = anel.derivar('blind-index', v);
    return `v${v}:${hmac(chave, `${campo}|${normalizar(valor)}`)}`;
  });
}

/**
 * Deriva material de chave para um uso pontual sem expor o anel inteiro.
 * Açúcar sintático sobre `anel.derivar`, mantido para legibilidade nos módulos
 * que só precisam de uma finalidade.
 */
export function subchave(anel: Anel, finalidade: Finalidade): Buffer {
  return anel.derivar(finalidade);
}
