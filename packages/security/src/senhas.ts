/**
 * Senhas: derivação, verificação e política.
 *
 * ## Lacuna da especificação que este arquivo fecha
 *
 * A especificação v1.1 fala em sessão opaca revogável, mas em nenhum momento
 * define **como a senha é guardada**. Sem isso escrito, a implementação
 * costuma cair em bcrypt com custo default de 10 (fraco para 2026) ou, pior,
 * em SHA-256 com sal. Aqui a decisão está explícita e testável.
 *
 * ## Escolha: Argon2id
 *
 * Vencedor do Password Hashing Competition e a primeira recomendação do OWASP.
 * O modo `id` é híbrido: resiste tanto a ataque por canal lateral (herdado do
 * Argon2i) quanto a ataque por GPU/ASIC (herdado do Argon2d).
 *
 * Parâmetros no piso recomendado pelo OWASP (2024): 19 MiB de memória,
 * 2 iterações, paralelismo 1. Memória é o que encarece o ataque em hardware
 * dedicado — subir `timeCost` sem subir `memoryCost` é o erro comum.
 */

import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * Identificador numérico do Argon2id na biblioteca nativa.
 *
 * O valor vem como `const enum` ambiente no `.d.ts` do `@node-rs/argon2`, que
 * o TypeScript não deixa acessar sob `verbatimModuleSyntax` (o enum não existe
 * em runtime — some na compilação). Usamos o literal, com o tipo aplicado por
 * asserção: se a biblioteca renumerar os algoritmos, a asserção continua
 * válida em tipo mas o teste `senhas.test.ts` acusa a mudança na hora.
 *
 * 0 = Argon2d · 1 = Argon2i · 2 = Argon2id.
 */
const ARGON2ID = 2 as Algorithm;

/**
 * Parâmetros de custo.
 *
 * Ao mudar estes valores, senhas antigas continuam validando (os parâmetros
 * viajam dentro do próprio hash) — mas passe a re-derivar no login bem-sucedido,
 * via `precisaReforcar`.
 */
const CUSTO = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // 19 MiB. Piso OWASP para Argon2id com t=2, p=1.
  timeCost: 2, // Número de passagens sobre a memória.
  parallelism: 1, // 1 thread: previsível em container com CPU limitada.
} as const;

/**
 * Comprimento mínimo. 12 caracteres, alinhado ao NIST SP 800-63B, que
 * recomenda **comprimento** e checagem contra listas de vazamento em vez de
 * regras de composição ("1 maiúscula, 1 símbolo") — que empurram o usuário
 * para senhas previsíveis e anotadas no papel.
 */
export const TAMANHO_MINIMO_SENHA = 12;

/**
 * Senhas obviamente ruins, bloqueadas mesmo tendo 12+ caracteres.
 *
 * Em produção, substitua/complemente por uma checagem contra a API k-anonymity
 * do Have I Been Pwned (envia só 5 caracteres do SHA-1 — a senha não sai da
 * máquina). Esta lista embutida existe para que a instalação offline, que é o
 * caso do público-alvo, ainda tenha alguma barreira.
 */
const SENHAS_PROIBIDAS = new Set([
  'senha123456',
  'senhasenha12',
  '123456789012',
  'fisioterapia',
  'fisioterapia1',
  'clinicafisio',
  'qwertyuiop12',
  'administrador',
  'password1234',
  'senhadaclinica',
]);

/** Resultado de uma checagem de política de senha. */
export interface ResultadoPolitica {
  /** `true` quando a senha pode ser aceita. */
  ok: boolean;
  /** Motivos da recusa, prontos para exibir ao usuário. Vazio quando `ok`. */
  motivos: string[];
}

/**
 * Aplica a política de senha.
 *
 * @param senha  Senha em claro digitada pelo usuário.
 * @param pistas Termos que a senha não pode conter (nome, e-mail, nome da
 *               clínica). Senha derivada do próprio identificador é a primeira
 *               coisa que um atacante testa.
 */
export function verificarPolitica(senha: string, pistas: string[] = []): ResultadoPolitica {
  const motivos: string[] = [];
  const normal = senha.toLowerCase();

  if (senha.length < TAMANHO_MINIMO_SENHA) {
    motivos.push(`A senha precisa de ao menos ${TAMANHO_MINIMO_SENHA} caracteres.`);
  }
  if (senha.length > 128) {
    // Teto: Argon2 sobre entrada gigante vira vetor de DoS.
    motivos.push('A senha é longa demais (máximo de 128 caracteres).');
  }
  if (SENHAS_PROIBIDAS.has(normal)) {
    motivos.push('Essa senha é comum demais. Escolha outra.');
  }
  // Repetição de um único caractere ("aaaaaaaaaaaa") passa no teste de tamanho
  // mas tem entropia quase nula.
  if (/^(.)\1+$/.test(senha)) {
    motivos.push('A senha não pode ser um único caractere repetido.');
  }
  for (const pista of pistas) {
    const p = pista.toLowerCase().trim();
    // Só considera pistas com 4+ caracteres — abaixo disso o falso positivo
    // seria constante (qualquer senha "contém" um trecho de 3 letras).
    if (p.length >= 4 && normal.includes(p)) {
      motivos.push('A senha não pode conter seu nome, e-mail ou o nome da clínica.');
      break;
    }
  }

  return { ok: motivos.length === 0, motivos };
}

/**
 * Deriva o hash de uma senha.
 *
 * O sal é gerado internamente pelo Argon2 e embutido no resultado — não há sal
 * separado para guardar. O formato de saída (`$argon2id$v=19$m=…`) já carrega
 * algoritmo, versão e parâmetros, o que torna a migração de custo transparente.
 *
 * @param senha Senha em claro.
 * @returns     Hash serializado, pronto para gravar na coluna.
 */
export async function derivarSenha(senha: string): Promise<string> {
  return hash(senha, CUSTO);
}

/**
 * Confere uma senha contra o hash guardado.
 *
 * Nunca lança em caso de senha errada — devolve `false`. Um `throw` aqui viraria
 * 500 e transformaria "senha inválida" num sinal diferente de "usuário
 * inexistente", que é justamente o que queremos evitar.
 *
 * @param hashGuardado Valor da coluna.
 * @param senha        Senha em claro digitada.
 * @returns            `true` se confere.
 */
export async function conferirSenha(hashGuardado: string, senha: string): Promise<boolean> {
  try {
    return await verify(hashGuardado, senha, CUSTO);
  } catch {
    // Hash corrompido ou em formato desconhecido. Trata como não confere.
    return false;
  }
}

/**
 * O hash foi gerado com custo abaixo do atual?
 *
 * Chame depois de um login bem-sucedido: se `true`, re-derive a senha (que você
 * tem em claro naquele instante) e regrave. É assim que a base inteira migra
 * para um custo maior sem pedir troca de senha a ninguém.
 */
export function precisaReforcar(hashGuardado: string): boolean {
  const m = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)/.exec(hashGuardado);
  if (!m) return true; // Formato desconhecido (bcrypt legado?) — re-derive.

  const [, mem, tempo, par] = m;
  return (
    Number(mem) < CUSTO.memoryCost ||
    Number(tempo) < CUSTO.timeCost ||
    Number(par) < CUSTO.parallelism
  );
}

/**
 * Hash "isca" com o mesmo custo de um hash real.
 *
 * Serve para o caso "e-mail não existe" no login: em vez de responder na hora,
 * verificamos a senha contra este hash. O tempo de resposta fica igual ao de um
 * e-mail existente, fechando a **enumeração de contas por tempo** — que é como
 * um atacante descobre quem são os usuários do sistema antes de atacar senhas.
 *
 * Gerado uma vez na subida do processo e reaproveitado.
 */
export async function hashIsca(): Promise<string> {
  // Valor fixo: não precisa ser secreto, só precisa custar o mesmo.
  return hash('cinesis-usuario-inexistente-placeholder', CUSTO);
}

/**
 * Compara dois códigos curtos (TOTP, código de recuperação) em tempo constante.
 *
 * Passa pelo SHA-256 antes para igualar o comprimento — `timingSafeEqual` exige
 * buffers do mesmo tamanho, e comparar tamanhos antes vazaria o comprimento do
 * código esperado.
 */
export function codigosIguais(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
