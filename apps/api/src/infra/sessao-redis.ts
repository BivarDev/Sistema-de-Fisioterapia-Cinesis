/**
 * Armazenamento de sessão em Redis.
 *
 * Implementa o mesmo contrato `ArmazenamentoSessao` da versão em memória, então
 * trocar um pelo outro é uma linha na composição — sem `if (producao)` espalhado
 * pelos serviços.
 *
 * ## Detalhes que importam
 *
 * - **O TTL é do Redis**, não da aplicação. Sessão expirada some sozinha; não
 *   depende de um job de limpeza que pode falhar.
 * - **Um índice por sujeito** (`Set` do Redis) permite "revogar todas as
 *   sessões deste usuário" sem varrer o banco inteiro com `KEYS`, que trava o
 *   Redis em produção.
 * - **O índice é limpo preguiçosamente**: entradas apontando para sessões já
 *   expiradas são removidas na próxima leitura, em vez de exigirem um job.
 */

import { Redis } from 'ioredis';
import type { ArmazenamentoSessao, DadosSessao } from '@cinesis/security';

/** Prefixo do índice de sessões por sujeito. */
const PREFIXO_INDICE = 'sess:sujeito:';

/**
 * Cria o armazenamento em Redis e verifica a conexão.
 *
 * A verificação é imediata (um `PING`) para que uma URL errada derrube o
 * processo na subida, em vez de só falhar no primeiro login do dia.
 *
 * @param url URL do Redis, ex.: `redis://localhost:6379`.
 */
export async function criarArmazenamentoRedis(url: string): Promise<ArmazenamentoSessao> {
  const redis = new Redis(url, {
    // Falha rápido em vez de enfileirar comandos indefinidamente quando o
    // Redis está fora — uma sessão que "trava" é pior que uma que recusa.
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
  });

  await redis.ping();

  return new ArmazenamentoRedis(redis);
}

/** Implementação do contrato de sessão sobre Redis. */
class ArmazenamentoRedis implements ArmazenamentoSessao {
  constructor(private readonly redis: Redis) {}

  async gravar(chave: string, dados: DadosSessao, ttlSegundos: number): Promise<void> {
    // Pipeline: as duas escritas vão numa ida só à rede.
    const pipeline = this.redis.pipeline();

    // `EX` deixa a expiração a cargo do Redis. Sessão vencida some sozinha.
    pipeline.set(chave, JSON.stringify(dados), 'EX', ttlSegundos);

    // Índice por sujeito, para revogação em massa sem `KEYS`.
    const indice = `${PREFIXO_INDICE}${dados.sujeitoId}`;
    pipeline.sadd(indice, chave);
    // O índice expira um pouco depois da sessão mais longa possível, para não
    // virar lixo permanente se o usuário nunca mais aparecer.
    pipeline.expire(indice, ttlSegundos + 3600);

    await pipeline.exec();
  }

  async ler(chave: string): Promise<DadosSessao | null> {
    const bruto = await this.redis.get(chave);
    if (!bruto) return null;

    try {
      return JSON.parse(bruto) as DadosSessao;
    } catch {
      // Valor corrompido: trata como sessão inexistente e remove. Melhor
      // forçar um login novo do que propagar um objeto inválido.
      await this.redis.del(chave);
      return null;
    }
  }

  async remover(chave: string): Promise<void> {
    // Descobre o sujeito antes de apagar, para limpar o índice junto.
    const dados = await this.ler(chave);
    const pipeline = this.redis.pipeline();

    pipeline.del(chave);
    if (dados) pipeline.srem(`${PREFIXO_INDICE}${dados.sujeitoId}`, chave);

    await pipeline.exec();
  }

  async removerDoSujeito(sujeitoId: string): Promise<number> {
    const indice = `${PREFIXO_INDICE}${sujeitoId}`;
    const chaves = await this.redis.smembers(indice);
    if (chaves.length === 0) return 0;

    // `del` com várias chaves é atômico e vale uma ida à rede.
    const removidas = await this.redis.del(...chaves);
    await this.redis.del(indice);

    return removidas;
  }

  async listarDoSujeito(sujeitoId: string): Promise<{ chave: string; dados: DadosSessao }[]> {
    const indice = `${PREFIXO_INDICE}${sujeitoId}`;
    const chaves = await this.redis.smembers(indice);
    if (chaves.length === 0) return [];

    const valores = await this.redis.mget(...chaves);
    const ativas: { chave: string; dados: DadosSessao }[] = [];
    const mortas: string[] = [];

    chaves.forEach((chave, i) => {
      const bruto = valores[i];
      if (!bruto) {
        // A sessão expirou pelo TTL, mas a entrada do índice ficou.
        mortas.push(chave);
        return;
      }
      try {
        ativas.push({ chave, dados: JSON.parse(bruto) as DadosSessao });
      } catch {
        mortas.push(chave);
      }
    });

    // Limpeza preguiçosa: sem isto o índice cresceria para sempre.
    if (mortas.length > 0) await this.redis.srem(indice, ...mortas);

    return ativas;
  }
}
