/**
 * Anel de chaves (keyring) com versionamento e rotação.
 *
 * Por que isto existe: a especificação pede "HMAC de segredo isolado" para a
 * pseudonimização, mas não diz o que acontece quando esse segredo precisa ser
 * trocado. Sem versionamento, rotacionar chave significa invalidar TODOS os
 * códigos pseudonimizados já emitidos e tornar ilegível toda a PII cifrada —
 * ou seja, na prática ninguém rotaciona nunca. Este módulo resolve isso:
 *
 * - Cada valor derivado carrega o número da versão da chave que o gerou (`v1$…`).
 * - A chave ATUAL é usada para escrever.
 * - Chaves ANTIGAS continuam disponíveis apenas para leitura.
 * - Rotacionar = adicionar uma chave nova; nada quebra retroativamente.
 *
 * As chaves vêm do ambiente, nunca do banco e nunca do código. Se o processo
 * subir sem elas, ele **falha na inicialização** em vez de gerar uma chave
 * aleatória silenciosamente — uma chave gerada em runtime some no restart e
 * levaria toda a PII cifrada junto.
 */

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Tamanho mínimo aceitável de uma chave-mestra, em bytes (256 bits). */
const TAMANHO_MINIMO_BYTES = 32;

/**
 * Finalidades de derivação.
 *
 * A chave-mestra nunca é usada diretamente. Dela derivamos uma subchave por
 * finalidade via HKDF, para que comprometer um uso não comprometa os outros
 * (uma subchave de pseudonimização vazada não decifra PII).
 */
export type Finalidade =
  | 'pseudonimizacao' // Gera o código estável `PC-XXXX` a partir do id do paciente.
  | 'blind-index' // Índice cego que permite buscar por CPF/e-mail sem decifrar.
  | 'cifragem-pii' // Chave AES-256-GCM dos campos de identificação.
  | 'token-portal' // HMAC dos tokens de link mágico.
  | 'sessao'; // HMAC do identificador de sessão guardado no Redis.

/** Uma chave-mestra registrada no anel, com sua versão. */
interface ChaveVersionada {
  /** Número da versão. Começa em 1 e só cresce. */
  versao: number;
  /** Material bruto da chave-mestra. */
  material: Buffer;
}

/**
 * Anel de chaves do processo.
 *
 * Uso típico:
 * ```ts
 * const anel = Anel.doAmbiente(process.env);
 * const sub = anel.derivar('cifragem-pii');          // versão atual, para escrever
 * const antiga = anel.derivar('cifragem-pii', 1);    // versão 1, para ler dado velho
 * ```
 */
export class Anel {
  /** Todas as versões conhecidas, indexadas por número de versão. */
  private readonly chaves: Map<number, Buffer>;
  /** Versão usada em toda escrita nova. É sempre a maior versão registrada. */
  readonly versaoAtual: number;
  /** Cache de subchaves já derivadas — HKDF é barato, mas não de graça. */
  private readonly cache = new Map<string, Buffer>();

  private constructor(chaves: ChaveVersionada[]) {
    if (chaves.length === 0) {
      throw new Error('Anel de chaves vazio: defina ao menos CINESIS_KEY_V1 no ambiente.');
    }
    this.chaves = new Map(chaves.map((c) => [c.versao, c.material]));
    // A versão de escrita é a maior — rotacionar é só publicar uma versão maior.
    this.versaoAtual = Math.max(...chaves.map((c) => c.versao));
  }

  /**
   * Monta o anel a partir de variáveis de ambiente `CINESIS_KEY_V<n>`.
   *
   * Cada valor deve ser uma chave de ≥32 bytes em base64. Gere assim:
   * `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   *
   * @param env Objeto de ambiente (injetável, para testar sem mexer no processo).
   * @throws   Se nenhuma chave for encontrada ou alguma for curta demais.
   */
  static doAmbiente(env: NodeJS.ProcessEnv): Anel {
    const chaves: ChaveVersionada[] = [];

    for (const [nome, valor] of Object.entries(env)) {
      // Só olha variáveis no formato exato — evita capturar `CINESIS_KEY_VELHA`.
      const m = /^CINESIS_KEY_V(\d+)$/.exec(nome);
      if (!m || !valor) continue;

      const versao = Number(m[1]);
      const material = Buffer.from(valor, 'base64');

      if (material.length < TAMANHO_MINIMO_BYTES) {
        // Falha alto e cedo. Uma chave curta é pior que nenhuma, porque passa
        // a sensação de que a cifragem está protegendo algo.
        throw new Error(
          `CINESIS_KEY_V${versao} tem ${material.length} bytes; o mínimo é ${TAMANHO_MINIMO_BYTES}.`,
        );
      }
      chaves.push({ versao, material });
    }

    return new Anel(chaves);
  }

  /**
   * Cria um anel efêmero com chaves aleatórias. **Apenas para testes.**
   *
   * Não é exposto em produção porque uma chave que morre com o processo torna
   * toda a PII cifrada irrecuperável no primeiro restart.
   */
  static paraTeste(versoes = 1): Anel {
    const chaves = Array.from({ length: versoes }, (_, i) => ({
      versao: i + 1,
      material: randomBytes(32),
    }));
    return new Anel(chaves);
  }

  /**
   * Deriva a subchave de uma finalidade, para uma versão específica.
   *
   * Usa HKDF-SHA256 com a finalidade como `info`. Chamar com a mesma versão e
   * finalidade sempre devolve os mesmos bytes — é isso que torna o código
   * pseudonimizado estável entre reinícios.
   *
   * @param finalidade Para que a subchave serve.
   * @param versao     Versão da chave-mestra. Omitido = versão atual (escrita).
   * @returns          32 bytes de subchave.
   * @throws           Se a versão pedida não estiver no anel (chave descartada
   *                   cedo demais — o dado antigo agora é ilegível).
   */
  derivar(finalidade: Finalidade, versao = this.versaoAtual): Buffer {
    const chaveCache = `${versao}:${finalidade}`;
    const emCache = this.cache.get(chaveCache);
    if (emCache) return emCache;

    const mestra = this.chaves.get(versao);
    if (!mestra) {
      throw new Error(
        `Chave versão ${versao} não está no anel. Restaure CINESIS_KEY_V${versao} para ler dados antigos.`,
      );
    }

    // HKDF: sal fixo por finalidade + info descritiva. O sal não precisa ser
    // secreto (RFC 5869); ele existe para separar domínios de derivação.
    const derivada = Buffer.from(
      hkdfSync('sha256', mestra, `cinesis:${finalidade}`, `v${versao}`, 32),
    );

    this.cache.set(chaveCache, derivada);
    return derivada;
  }

  /** Todas as versões disponíveis, da mais nova para a mais antiga. */
  versoes(): number[] {
    return [...this.chaves.keys()].sort((a, b) => b - a);
  }
}

/**
 * HMAC-SHA256 em hexadecimal.
 *
 * @param chave  Subchave derivada do anel (nunca a chave-mestra).
 * @param dados  Conteúdo a autenticar.
 * @returns      Digest de 64 caracteres hex.
 */
export function hmac(chave: Buffer, dados: string): string {
  return createHmac('sha256', chave).update(dados, 'utf8').digest('hex');
}

/**
 * Comparação de strings em tempo constante.
 *
 * `a === b` para segredos vaza informação pelo tempo de execução: quanto mais
 * prefixo em comum, mais tempo até divergir. Com muitas tentativas isso permite
 * descobrir um token caractere a caractere. Use esta função para **todo**
 * confronto de token, hash de sessão ou código de verificação.
 *
 * @returns `true` se forem idênticos, sem vazar onde divergiram.
 */
export function iguaisEmTempoConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // `timingSafeEqual` exige o mesmo comprimento. Comparar comprimentos antes
  // vaza apenas o tamanho, que não é segredo em nenhum dos nossos formatos
  // (todos têm comprimento fixo por construção).
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
