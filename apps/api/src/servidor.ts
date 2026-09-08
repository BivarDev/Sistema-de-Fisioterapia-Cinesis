/**
 * Ponto de entrada da API.
 *
 * ## Ordem de inicialização, e por que importa
 *
 * 1. **Configuração** — valida tudo e derruba o processo se faltar chave ou se
 *    algum valor de exemplo sobreviveu até produção. Falhar aqui é barato;
 *    falhar depois de aceitar requisições é caro.
 * 2. **Banco** — conecta e aplica o schema (idempotente).
 * 3. **Sessão** — Redis em produção, memória em desenvolvimento.
 * 4. **Fastify** — segurança, autenticação, erros, rotas. Nessa ordem: os
 *    hooks de segurança precisam existir antes de qualquer rota ser registrada.
 * 5. **Desligamento gracioso** — SIGTERM fecha as conexões antes de sair, para
 *    não deixar transação pela metade num `docker compose down`.
 */

import Fastify from 'fastify';
import { Barramento } from '@cinesis/domain';
import { GestorSessao, ArmazenamentoMemoria } from '@cinesis/security';
import { carregarConfig } from './config.js';
import { conectar, aplicarSchema } from './db/conexao.js';
import { opcoesLogger, registrarTratamentoDeErro } from './plugins/erros.js';
import { registrarSeguranca, limiteGeral } from './plugins/seguranca.js';
import { registrarAutenticacao } from './plugins/autenticacao.js';
import { registrarRotas } from './rotas/index.js';
import { localizarEstaticos, registrarEstaticos } from './plugins/estaticos.js';
import { buscarSupervisores } from './servicos/autenticacao.js';
import { criarArmazenamentoRedis } from './infra/sessao-redis.js';
import type { Deps } from './deps.js';

/**
 * Monta a aplicação sem subir o servidor HTTP.
 *
 * Separado de `main` porque é exatamente isto que os testes de integração
 * usam: `app.inject()` exercita as rotas de verdade — com CSRF, RBAC, RLS e
 * gatilhos ativos — sem abrir porta nenhuma.
 */
export async function montarApp(env: NodeJS.ProcessEnv = process.env) {
  const config = carregarConfig(env);

  const conexao = await conectar(
    config.ambiente.DATABASE_URL,
    // Em teste, banco em memória: cada arquivo de teste sobe o seu, isolado.
    // Fora de teste, deixamos o padrão de `conectar` decidir — ele ancora o
    // caminho na raiz do repositório. Passar `'./.data/cinesis'` aqui faria o
    // servidor abrir um banco relativo ao diretório de execução e, portanto,
    // DIFERENTE do que o `db:seed` escreve.
    ...(config.ambiente.NODE_ENV === 'test' ? (['memory://'] as const) : []),
  );
  await aplicarSchema(conexao);

  // Redis em produção; memória em desenvolvimento e teste. A configuração já
  // recusou subir em produção sem `REDIS_URL`, então não há caminho em que a
  // memória seja usada por acidente onde ela quebraria.
  const armazenamento = config.ambiente.REDIS_URL
    ? await criarArmazenamentoRedis(config.ambiente.REDIS_URL)
    : new ArmazenamentoMemoria();

  const gestor = new GestorSessao(config.anel, armazenamento);
  const eventos = new Barramento();

  const app = Fastify({
    logger: opcoesLogger(config),
    // Confia no cabeçalho `X-Forwarded-For` só quando há proxy à frente. Ligado
    // sem proxy, qualquer cliente forjaria o próprio IP e escaparia do rate
    // limit — por isso segue o ambiente, não um valor fixo.
    trustProxy: config.producao,
    // Tempo máximo para o cliente enviar o corpo. Sem isto, uma conexão lenta
    // deliberada (Slowloris) segura um worker indefinidamente.
    requestTimeout: 30_000,
    // Corpo padrão de 1 MiB. A rota de mídia tem o próprio teto.
    bodyLimit: 1_048_576,
  });

  const deps: Deps = { db: conexao.db, conexao, anel: config.anel, gestor, eventos, config };

  // Descobre os frontends ANTES do tratador de erro: ele precisa saber se pode
  // devolver `index.html` num 404, e o Fastify aceita um so `setNotFoundHandler`.
  const estaticos = localizarEstaticos();

  await registrarSeguranca(app, config);
  registrarTratamentoDeErro(app, config, estaticos);
  registrarAutenticacao(app, {
    gestor,
    config,
    buscarSupervisores: (id) => buscarSupervisores(conexao.db, id),
  });

  // Teto geral por rede, antes de qualquer rota. Limites específicos (login,
  // reidentificação, portal) são bem mais apertados e vivem nas rotas.
  app.addHook('onRequest', async (req, reply) => {
    limiteGeral(req, reply);
  });

  await registrarRotas(app, deps);

  // Frontends compilados, DEPOIS das rotas de API: o prefixo `/` do estatico
  // capturaria `/api/...` se viesse antes.
  await registrarEstaticos(app, estaticos);

  return { app, deps, config, servindoEstaticos: estaticos.algum };
}

/** Sobe o servidor HTTP. */
async function main(): Promise<void> {
  const { app, deps, config, servindoEstaticos } = await montarApp();

  app.log.info(
    {
      driver: deps.conexao.driver,
      sessao: config.ambiente.REDIS_URL ? 'redis' : 'memoria',
      ambiente: config.ambiente.NODE_ENV,
      chaves: config.anel.versoes().length,
      estaticos: servindoEstaticos ? 'servindo' : 'ausentes (Vite em dev)',
    },
    'Cinesis iniciando',
  );

  // Aviso alto em desenvolvimento: é fácil esquecer que o dado cifrado some no
  // restart quando a chave é efêmera.
  if (!config.producao && !process.env.CINESIS_KEY_V1) {
    app.log.warn(
      'Rodando com chave de cifragem EFÊMERA. Todo dado cifrado se perde ao reiniciar. ' +
        'Defina CINESIS_KEY_V1 no .env para persistir.',
    );
  }

  await app.listen({ port: config.ambiente.PORT, host: config.ambiente.HOST });

  /**
   * Desligamento gracioso.
   *
   * `close()` do Fastify espera as requisições em andamento terminarem antes
   * de fechar. Sem isso, um `docker compose down` no meio de um `POST` deixaria
   * a transação pela metade e o cliente sem resposta.
   */
  const desligar = async (sinal: string): Promise<void> => {
    app.log.info({ sinal }, 'desligando');
    await app.close();
    await deps.conexao.encerrar();
    process.exit(0);
  };

  process.on('SIGTERM', () => void desligar('SIGTERM'));
  process.on('SIGINT', () => void desligar('SIGINT'));
}

// Só executa quando este arquivo é o ponto de entrada — importar `montarApp`
// num teste não deve subir servidor nenhum.
if (process.argv[1]?.includes('servidor')) {
  main().catch((erro) => {
    // O logger ainda não existe se a falha foi na configuração, então este é
    // um dos raríssimos `console.error` legítimos do projeto.
    console.error('Falha ao iniciar o Cinesis:\n', erro instanceof Error ? erro.message : erro);
    process.exit(1);
  });
}
