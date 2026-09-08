/**
 * Configuração da aplicação, validada na inicialização.
 *
 * ## Princípio: falhar na subida, não na requisição
 *
 * Uma variável de ambiente faltando ou com valor de exemplo precisa derrubar o
 * processo **antes** de aceitar a primeira requisição. O padrão contrário —
 * `process.env.X ?? 'valor-padrao'` espalhado pelo código — produz o pior
 * cenário possível em produção: o sistema sobe, atende, e só descobre semanas
 * depois que estava usando a chave de exemplo para cifrar prontuário.
 *
 * ## O que é bloqueado especificamente em produção
 *
 * - Chave de cifragem ausente ou igual à do `.env.example`.
 * - Origem permitida com `*`.
 * - Sessão em memória (não sobrevive a restart nem funciona com dois workers).
 * - `NODE_TLS_REJECT_UNAUTHORIZED=0`, que desliga a verificação de certificado.
 */

import { z } from 'zod';
import { Anel } from '@cinesis/security';

/**
 * Valor de chave presente no `.env.example`.
 *
 * Existe para que o `.env.example` funcione em desenvolvimento sem exigir que
 * o usuário gere chave antes de ver a tela — e para que a mesma chave seja
 * **recusada** em produção.
 */
const CHAVE_DE_EXEMPLO = 'VFJPUVVFLUVTVEEtQ0hBVkUtRU0tUFJPRFVDQU8hISE=';

/** Schema das variáveis de ambiente. */
const zAmbiente = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Porta HTTP. */
  PORT: z.coerce.number().int().min(1).max(65_535).default(3333),

  /** Endereço de escuta. `127.0.0.1` por padrão: não expõe sem intenção. */
  HOST: z.string().default('127.0.0.1'),

  /**
   * URL do PostgreSQL. Ausente em desenvolvimento ⇒ PGlite embutido.
   * Obrigatória em produção.
   */
  DATABASE_URL: z.string().url().optional(),

  /** URL do Redis para sessões. Ausente ⇒ armazenamento em memória. */
  REDIS_URL: z.string().url().optional(),

  /**
   * Origens permitidas, separadas por vírgula.
   * Ex.: `https://clinica.exemplo.br,https://portal.clinica.exemplo.br`
   */
  ORIGENS_PERMITIDAS: z.string().default('http://localhost:5173,http://localhost:5174'),

  /** Base pública do portal, usada para montar o link mágico. */
  PORTAL_URL: z.string().url().default('http://localhost:5174'),

  /** Diretório do armazenamento privado de mídia clínica. */
  MIDIA_DIR: z.string().default('./uploads'),

  /** Nível de log. `info` em produção; `debug` vaza detalhe demais. */
  LOG_NIVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

/** Tipo do ambiente validado. */
export type Ambiente = z.infer<typeof zAmbiente>;

/** Configuração pronta para uso, já com objetos derivados construídos. */
export interface Config {
  ambiente: Ambiente;
  /** `true` em `NODE_ENV=production`. Usado em dezenas de decisões de segurança. */
  producao: boolean;
  /** Anel de chaves. Construído aqui para falhar cedo se faltar chave. */
  anel: Anel;
  /** Origens permitidas, já quebradas em lista. */
  origens: string[];
}

/**
 * Carrega e valida a configuração.
 *
 * @param env Ambiente bruto. Injetável para testar sem mexer no processo.
 * @throws    `Error` com a lista completa de problemas — todos de uma vez, para
 *            não obrigar a descobrir um a cada tentativa de subir.
 */
export function carregarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const analise = zAmbiente.safeParse(env);

  if (!analise.success) {
    const problemas = analise.error.issues.map((i) => `  · ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuração inválida:\n${problemas.join('\n')}`);
  }

  const ambiente = analise.data;
  const producao = ambiente.NODE_ENV === 'production';
  const erros: string[] = [];

  // --- Anel de chaves --------------------------------------------------------
  let anel: Anel;
  try {
    anel = Anel.doAmbiente(env);
  } catch (e) {
    if (producao) {
      // Em produção não há plano B: sem chave, a PII não pode ser cifrada.
      throw new Error(
        `Chave de cifragem ausente ou inválida: ${(e as Error).message}\n` +
          'Gere uma com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      );
    }
    // Em desenvolvimento, uma chave efêmera permite ver a tela sem configurar
    // nada. O dado cifrado morre no restart — o que é aceitável em dev e
    // catastrófico em produção, por isso o caminho é separado.
    anel = Anel.paraTeste();
  }

  // --- Verificações que só valem em produção ---------------------------------
  if (producao) {
    if (env.CINESIS_KEY_V1?.includes(CHAVE_DE_EXEMPLO)) {
      erros.push('CINESIS_KEY_V1 ainda é a chave de exemplo do .env.example. Gere uma real.');
    }
    if (!ambiente.DATABASE_URL) {
      erros.push('DATABASE_URL é obrigatória em produção — PGlite é de processo único.');
    }
    if (!ambiente.REDIS_URL) {
      erros.push(
        'REDIS_URL é obrigatória em produção — sessão em memória não sobrevive a restart nem funciona com mais de um processo.',
      );
    }
    if (ambiente.ORIGENS_PERMITIDAS.includes('*')) {
      erros.push('ORIGENS_PERMITIDAS não pode conter "*" — isso desliga a proteção de origem.');
    }
    if (!ambiente.ORIGENS_PERMITIDAS.split(',').every((o) => o.trim().startsWith('https://'))) {
      erros.push('Em produção, toda origem permitida precisa ser https://.');
    }
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      erros.push(
        'NODE_TLS_REJECT_UNAUTHORIZED=0 desliga a verificação de certificado TLS. Nunca em produção.',
      );
    }
    if (ambiente.LOG_NIVEL === 'debug' || ambiente.LOG_NIVEL === 'trace') {
      erros.push('LOG_NIVEL debug/trace registra corpo de requisição. Use info em produção.');
    }
  }

  if (erros.length > 0) {
    throw new Error(`Configuração de produção inválida:\n${erros.map((e) => `  · ${e}`).join('\n')}`);
  }

  return {
    ambiente,
    producao,
    anel,
    origens: ambiente.ORIGENS_PERMITIDAS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
