/**
 * Tratamento centralizado de erro e logger com redação.
 *
 * ## Duas regras que este arquivo faz valer no sistema inteiro
 *
 * 1. **Nenhum detalhe interno vaza para o cliente.** Stack trace, mensagem de
 *    erro do Postgres e nome de coluna ficam no log do servidor, correlacionados
 *    por `correlationId`. Uma mensagem de banco vazada informa o atacante sobre
 *    o schema; um stack trace informa sobre versões e caminhos de arquivo.
 *
 * 2. **Nada é logado sem passar pelo redator.** O serializador do Pino chama
 *    `redigir()` em todo objeto. É a defesa que continua funcionando quando
 *    alguém, um ano depois, escrever `req.log.info({ paciente })` sem pensar.
 */

import type { FastifyInstance, FastifyError, FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { ErroCinesis, type RespostaErro, type CodigoErro } from '@cinesis/shared';
import { redigir, redigirTexto, mascararIp } from '@cinesis/security';
import type { Config } from '../config.js';
import type { Estaticos } from './estaticos.js';

/**
 * Opções do logger, com redação plugada.
 *
 * @param config Configuração validada.
 */
/*
 * `NonNullable` porque, sob `exactOptionalPropertyTypes`, um tipo que inclui
 * `undefined` nao pode ser passado explicitamente a uma propriedade opcional.
 * Esta funcao sempre devolve configuracao, nunca `undefined`.
 */
export function opcoesLogger(config: Config): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: config.ambiente.LOG_NIVEL,
    // Estes serializadores substituem os padrões do Fastify, que logariam
    // headers completos (com `cookie` e `authorization`) e a URL com query.
    serializers: {
      // Os parâmetros são tipados estruturalmente (só o que de fato lemos) em
      // vez de `FastifyRequest`/`FastifyReply`. O Fastify passa tipos-wrapper
      // aos serializadores, e casá-los exatamente amarraria este arquivo a
      // detalhes internos do framework sem ganho nenhum.
      req(req: { method: string; url: string; ip: string; id: string }) {
        return {
          metodo: req.method,
          // Query string cortada de propósito: `?busca=Marina+Alencar` numa
          // rota de pacientes colocaria o nome do paciente no log.
          rota: req.url.split('?')[0],
          // Só o prefixo de rede — requisito "IP nunca em claro".
          rede: mascararIp(req.ip),
          correlationId: req.id,
        };
      },
      res(res: { statusCode: number }) {
        return { statusCode: res.statusCode };
      },
      err(erro: Error) {
        // O Fastify exige a forma `{ type, message, stack }`. Passamos o erro
        // pelo redator antes: um erro customizado pode carregar a entidade
        // inteira em propriedades extras, e `redigir` as descarta.
        const seguro = redigir(erro) as { mensagem?: string; stack?: string };
        return {
          type: erro.name,
          message: seguro.mensagem ?? erro.message,
          stack: seguro.stack ?? '',
        };
      },
    },
    // Rede de segurança final: TODO argumento passado ao logger atravessa a
    // redação, inclusive os que nenhum serializador acima cobre. É o que
    // continua funcionando quando alguém, daqui a um ano, escrever
    // `req.log.info({ paciente })` sem pensar.
    hooks: {
      logMethod(args, metodo) {
        const seguros = (args as unknown[]).map((a) => {
          if (typeof a === 'string') return redigirTexto(a);
          if (a === null || typeof a !== 'object') return a;

          // As chaves `req`, `res` e `err` pertencem aos serializadores acima.
          // Redigi-las AQUI as quebraria: `redigir` copia só propriedades
          // próprias e enumeráveis, enquanto `url`, `method` e `ip` do Fastify
          // são getters no protótipo. O objeto resultante chegaria ao
          // serializador sem eles — e `req.url.split()` estouraria, derrubando
          // o processo na primeira requisição.
          const entrada = a as Record<string, unknown>;
          const saida: Record<string, unknown> = {};

          for (const [chave, valor] of Object.entries(entrada)) {
            saida[chave] =
              chave === 'req' || chave === 'res' || chave === 'err' ? valor : redigir(valor);
          }

          return saida;
        });

        // `apply` com `this` preserva o contexto do logger filho (que carrega
        // o correlationId da requisição).
        (metodo as (...a: unknown[]) => void).apply(this, seguros);
      },
    },
  };
}

/**
 * Registra o tratador global de erros.
 */
export function registrarTratamentoDeErro(
  app: FastifyInstance,
  config: Config,
  estaticos: Estaticos = {
    web: null,
    portal: null,
    htmlWeb: null,
    htmlPortal: null,
    algum: false,
  },
): void {
  app.setErrorHandler((erro: FastifyError | ErroCinesis, req, reply) => {
    // --- Erros de domínio: previstos, seguros de expor -----------------------
    if (erro instanceof ErroCinesis) {
      const corpo: RespostaErro = {
        codigo: erro.codigo,
        mensagem: erro.message,
        correlationId: req.id,
        ...(erro.campos ? { campos: erro.campos } : {}),
      };

      // 4xx de cliente é ruído em `warn`; só o 5xx merece atenção.
      req.log.info({ codigo: erro.codigo, status: erro.status }, 'erro de domínio');
      return reply.status(erro.status).send(corpo);
    }

    // --- Erro de validação do Zod -------------------------------------------
    // Os handlers chamam `schema.parse()` direto, que lança `ZodError`. Sem
    // esta tradução, TODA entrada malformada — a maioria absoluta dos erros de
    // cliente — viraria 500, e a interface não teria como dizer qual campo
    // falhou.
    if (erro instanceof ZodError) {
      const campos: Record<string, string[]> = {};
      for (const problema of erro.issues) {
        // `path` vazio acontece em erro de nível de objeto (ex.: `.refine`
        // no schema inteiro). Agrupamos esses sob `_`.
        const chave = problema.path.length > 0 ? problema.path.join('.') : '_';
        (campos[chave] ??= []).push(problema.message);
      }

      req.log.info({ campos: Object.keys(campos) }, 'entrada inválida');

      return reply.status(422).send({
        codigo: 'DADOS_INVALIDOS' satisfies CodigoErro,
        mensagem: 'Dados inválidos.',
        correlationId: req.id,
        campos,
      } satisfies RespostaErro);
    }

    // --- Erro de validação do Fastify (schema de rota) ----------------------
    if ('validation' in erro && erro.validation) {
      return reply.status(422).send({
        codigo: 'DADOS_INVALIDOS' satisfies CodigoErro,
        mensagem: 'Dados inválidos.',
        correlationId: req.id,
      } satisfies RespostaErro);
    }

    // --- Violação de gatilho do banco ---------------------------------------
    // O gatilho de imutabilidade lança `raise_exception` (SQLSTATE P0001).
    // Traduzimos para 409 porque, do ponto de vista do cliente, é conflito de
    // invariante — não erro interno.
    const codigoPg = (erro as { code?: string }).code;
    if (codigoPg === 'P0001') {
      req.log.warn({ rota: req.url }, 'invariante do banco violada');
      return reply.status(409).send({
        codigo: 'CONFLITO' satisfies CodigoErro,
        mensagem: 'A operação viola uma regra do prontuário. O registro não foi alterado.',
        correlationId: req.id,
      } satisfies RespostaErro);
    }

    // --- Violação de unicidade ----------------------------------------------
    if (codigoPg === '23505') {
      return reply.status(409).send({
        codigo: 'CONFLITO' satisfies CodigoErro,
        mensagem: 'Já existe um registro com esses dados.',
        correlationId: req.id,
      } satisfies RespostaErro);
    }

    // --- Erro do cliente sinalizado pelo Fastify -----------------------------
    //
    // O framework (e os parsers) marcam falhas de requisicao com `statusCode`
    // 4xx: JSON malformado, corpo maior que o limite, content-type recusado.
    // Sem este ramo, todos cairiam no 500 abaixo — e um erro de digitacao do
    // cliente apareceria como falha do servidor, tanto para ele quanto no
    // monitoramento de quem opera.
    const statusFastify = (erro as { statusCode?: number }).statusCode;
    if (typeof statusFastify === 'number' && statusFastify >= 400 && statusFastify < 500) {
      req.log.info({ status: statusFastify }, 'requisicao malformada');

      return reply.status(statusFastify).send({
        codigo: 'DADOS_INVALIDOS' satisfies CodigoErro,
        // Mensagem generica: o texto do framework pode citar detalhe interno.
        mensagem: 'Requisicao malformada.',
        correlationId: req.id,
      } satisfies RespostaErro);
    }

    // --- Qualquer outra coisa: bug ------------------------------------------
    // O detalhe vai INTEIRO para o log (redigido) e NADA para o cliente.
    req.log.error({ err: erro }, 'erro não tratado');

    return reply.status(500).send({
      codigo: 'ERRO_INTERNO' satisfies CodigoErro,
      // Mensagem fixa. Em desenvolvimento acrescentamos o texto real para não
      // obrigar a caçar no terminal a cada iteração.
      mensagem: config.producao
        ? 'Erro interno. Informe o código abaixo ao suporte.'
        : `Erro interno: ${erro.message}`,
      correlationId: req.id,
    } satisfies RespostaErro);
  });

  /**
   * Tratador de 404 — o unico da aplicacao.
   *
   * O Fastify aceita apenas um `setNotFoundHandler` por instancia, entao este
   * cobre os dois casos:
   *
   * 1. **Caminho de API inexistente** devolve 404 em JSON, no mesmo formato de
   *    todo erro. Sem isto, o 404 padrao do Fastify teria outro corpo e
   *    revelaria que a rota nao existe de forma distinguivel de "recurso nao
   *    encontrado".
   *
   * 2. **Rota do cliente** (so quando ha frontend compilado) devolve o
   *    `index.html`. A aplicacao roteia no navegador: recarregar em
   *    `/app/pacientes` pede esse caminho ao servidor, que nao tem arquivo
   *    nenhum ali. Sem este tratamento, F5 em qualquer tela interna daria 404.
   */
  app.setNotFoundHandler((req, reply) => {
    const respostaJson = {
      codigo: 'NAO_ENCONTRADO' satisfies CodigoErro,
      mensagem: 'Recurso nao encontrado.',
      correlationId: req.id,
    } satisfies RespostaErro;

    // Caminho de API sempre responde JSON. Devolver HTML aqui faria o cliente
    // tentar interpretar uma pagina como resposta de erro.
    if (req.url.startsWith('/api/') || !estaticos.algum) {
      return reply.status(404).send(respostaJson);
    }

    // `/entrar/<token>` e a rota de entrada do portal: vai para o app do
    // paciente, nao para o profissional.
    const paraPortal = req.url.startsWith('/portal') || req.url.startsWith('/entrar/');
    const html = (paraPortal ? estaticos.htmlPortal : estaticos.htmlWeb) ?? estaticos.htmlWeb;

    if (!html) return reply.status(404).send(respostaJson);

    // Status 200, nao 404: do ponto de vista do usuario, `/app/pacientes` e uma
    // pagina que existe. Devolver 404 com o HTML certo confundiria buscador,
    // monitoramento e o proprio navegador.
    return reply
      .status(200)
      .type('text/html; charset=utf-8')
      // A pagina de entrada nunca e cacheada: e o unico arquivo cujo nome nao
      // muda entre versoes, entao um cache aqui congelaria a aplicacao inteira
      // na versao antiga.
      .header('Cache-Control', 'no-cache')
      .send(html);
  });
}
