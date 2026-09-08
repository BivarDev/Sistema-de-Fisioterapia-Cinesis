/**
 * Cliente HTTP da API.
 *
 * ## Três coisas que este arquivo centraliza
 *
 * 1. **O token CSRF.** É guardado em memória (nunca em `localStorage`) e
 *    enviado automaticamente em toda escrita. Se cada tela precisasse lembrar
 *    de mandá-lo, uma tela nova nasceria quebrada — ou, pior, alguém removeria
 *    a proteção para "fazer funcionar".
 *
 * 2. **`credentials: 'include'`.** Sem isso o cookie de sessão não viaja e
 *    todas as requisições voltam 401. Fica aqui, uma vez.
 *
 * 3. **A tradução do erro.** A API devolve `{ codigo, mensagem, campos }`; a
 *    interface recebe um `ErroApi` tipado, com `campos` pronto para marcar o
 *    input errado.
 *
 * ## Por que o CSRF fica em memória e não no `localStorage`
 *
 * `localStorage` é legível por qualquer script da página. Um XSS numa
 * dependência leria o token e derrubaria a proteção. Em memória, ele morre com
 * a aba — e o custo é ter que buscá-lo de novo no recarregamento, o que a rota
 * `/api/auth/sessao` já faz.
 */

import type { CodigoErro, RespostaErro } from '@cinesis/shared';

/** Token CSRF da sessão corrente. Vive só nesta variável. */
let tokenCsrf: string | null = null;

/** Guarda o token CSRF depois do login ou da restauração de sessão. */
export function definirCsrf(token: string | null): void {
  tokenCsrf = token;
}

/** Erro vindo da API, já tipado. */
export class ErroApi extends Error {
  constructor(
    readonly codigo: CodigoErro,
    mensagem: string,
    readonly status: number,
    /** Detalhe por campo, quando é erro de validação. */
    readonly campos?: Record<string, string[]>,
    /** Para o usuário citar ao suporte. */
    readonly correlationId?: string,
  ) {
    super(mensagem);
    this.name = 'ErroApi';
  }

  /**
   * Apelido em portugues para `message`.
   *
   * O resto do projeto — dominio, servicos, telas — nomeia tudo em portugues.
   * `Error.message` e imposto pela plataforma; este getter evita que as telas
   * precisem alternar de idioma no meio de uma expressao.
   */
  get mensagem(): string {
    return this.message;
  }
}

/** Opções de uma requisição. */
interface Opcoes {
  metodo?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  corpo?: unknown;
}

/**
 * Faz uma requisição à API.
 *
 * @param caminho Caminho a partir de `/api`, ex.: `/pacientes`.
 * @param opcoes  Método e corpo.
 * @throws {ErroApi} Em qualquer status fora de 2xx.
 */
export async function api<T>(caminho: string, opcoes: Opcoes = {}): Promise<T> {
  const metodo = opcoes.metodo ?? 'GET';

  const cabecalhos: Record<string, string> = {};
  if (opcoes.corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';

  // O token CSRF vai só nas escritas — leitura não precisa e o servidor
  // dispensa. Mandar em tudo não teria custo, mas deixa a intenção menos clara.
  if (tokenCsrf && metodo !== 'GET') cabecalhos['x-cinesis-csrf'] = tokenCsrf;

  const resposta = await fetch(`/api${caminho}`, {
    method: metodo,
    headers: cabecalhos,
    // Manda o cookie de sessão. Sem isto, tudo volta 401.
    credentials: 'include',
    // Espalhamento condicional em vez de `body: ... : undefined`: sob
    // `exactOptionalPropertyTypes`, passar `undefined` explicitamente a uma
    // propriedade opcional e diferente de omiti-la, e o `fetch` recusa.
    ...(opcoes.corpo !== undefined ? { body: JSON.stringify(opcoes.corpo) } : {}),
  });

  if (!resposta.ok) {
    // Tenta ler o corpo de erro padrão. Se a resposta não for JSON (um 502 do
    // proxy, por exemplo), monta um erro genérico em vez de estourar aqui.
    let corpo: RespostaErro;
    try {
      corpo = (await resposta.json()) as RespostaErro;
    } catch {
      corpo = {
        codigo: 'ERRO_INTERNO',
        mensagem: 'Não foi possível falar com o servidor.',
        correlationId: '',
      };
    }

    throw new ErroApi(
      corpo.codigo,
      corpo.mensagem,
      resposta.status,
      corpo.campos,
      corpo.correlationId,
    );
  }

  // 204 e afins não têm corpo. `json()` estouraria.
  if (resposta.status === 204) return undefined as T;

  return (await resposta.json()) as T;
}

/** Atalhos por verbo, para deixar as chamadas mais curtas nas telas. */
export const buscar = <T>(caminho: string) => api<T>(caminho);
export const enviar = <T>(caminho: string, corpo?: unknown) =>
  api<T>(caminho, { metodo: 'POST', corpo });
export const remover = <T>(caminho: string) => api<T>(caminho, { metodo: 'DELETE' });
