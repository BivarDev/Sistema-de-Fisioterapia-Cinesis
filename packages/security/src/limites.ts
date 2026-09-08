/**
 * Limitação de taxa e backoff progressivo.
 *
 * ## O que a especificação pedia e o que faltava
 *
 * A especificação exige rate limit no link mágico do portal (5/h). Faltava
 * tudo o resto: login, reidentificação de PII, exportação de PDF e upload de
 * mídia são endpoints tão sensíveis quanto — e são os que um atacante usa para
 * força bruta de senha, enumeração de pacientes e exfiltração em massa.
 *
 * ## Dois mecanismos distintos
 *
 * 1. **Janela deslizante por chave** — protege o serviço. "No máximo N
 *    requisições em M segundos para esta rota vindas deste ator."
 * 2. **Backoff progressivo por conta** — protege a conta. Cada falha de
 *    autenticação dobra o tempo de espera, com teto. É o que torna força bruta
 *    inviável sem trancar a conta permanentemente (o que seria, em si, um
 *    vetor de negação de serviço contra um usuário legítimo).
 *
 * ## Escolha deliberada: sem bloqueio permanente
 *
 * Bloquear a conta depois de N erros permite que qualquer um tranque o
 * fisioterapeuta fora do sistema no meio do expediente, só sabendo o e-mail.
 * O backoff resolve o mesmo problema sem essa consequência.
 */

/** Estado de uma janela deslizante. */
interface Janela {
  /** Timestamps (ms) das requisições dentro da janela. */
  marcas: number[];
}

/** Configuração de um limite. */
export interface ConfigLimite {
  /** Máximo de eventos permitidos na janela. */
  maximo: number;
  /** Tamanho da janela, em segundos. */
  janelaSegundos: number;
}

/**
 * Limites por operação.
 *
 * Os números não são arbitrários — cada um é calibrado pelo uso legítimo:
 * um fisioterapeuta erra a senha 2 ou 3 vezes num dia ruim, não 20; ele
 * reidentifica alguns pacientes por turno, não 100.
 */
export const LIMITES = {
  /** Login por endereço de rede. Barra força bruta distribuída no mesmo /24. */
  loginPorRede: { maximo: 30, janelaSegundos: 15 * 60 },
  /** Login por conta. Complementa o backoff, cobrindo o ataque lento. */
  loginPorConta: { maximo: 10, janelaSegundos: 15 * 60 },
  /** Emissão de link mágico por paciente — o 5/h da especificação. */
  linkPortal: { maximo: 5, janelaSegundos: 60 * 60 },
  /** Consumo de link mágico por rede. Barra varredura de tokens. */
  consumoLinkPorRede: { maximo: 20, janelaSegundos: 60 * 60 },
  /** Reidentificação de PII por profissional. Limita exfiltração em massa. */
  reidentificacao: { maximo: 40, janelaSegundos: 60 * 60 },
  /** Exportação de PDF por profissional. Cada PDF leva dado clínico para fora. */
  exportacaoPdf: { maximo: 60, janelaSegundos: 60 * 60 },
  /** Upload de mídia por profissional. */
  upload: { maximo: 60, janelaSegundos: 60 * 60 },
  /** Registro de adesão pelo paciente no portal. */
  registroPortal: { maximo: 120, janelaSegundos: 60 * 60 },
  /** Teto geral por rede, para qualquer rota da API. */
  geral: { maximo: 600, janelaSegundos: 60 },
} as const satisfies Record<string, ConfigLimite>;

/** Resultado de uma consulta ao limitador. */
export interface ResultadoLimite {
  /** `true` quando a requisição pode seguir. */
  permitido: boolean;
  /** Quantas requisições ainda cabem na janela. */
  restantes: number;
  /** Segundos até liberar, quando `permitido` é `false`. */
  aguardarSegundos: number;
}

/**
 * Limitador de janela deslizante em memória.
 *
 * Em produção com mais de um processo, troque por uma implementação em Redis
 * (`apps/api/src/infra/limitador-redis.ts`) — este mapa é por processo, e dois
 * workers dobrariam o limite efetivo. A interface é a mesma.
 */
export class Limitador {
  private readonly janelas = new Map<string, Janela>();
  /** Última limpeza de chaves mortas, para não varrer o mapa a cada chamada. */
  private ultimaLimpeza = Date.now();

  /**
   * Consome uma unidade do limite.
   *
   * @param chave  Identidade do limite, ex.: `login:rede:203.0.113.0/24`.
   * @param config Máximo e janela.
   * @param agora  Instante base (injetável para teste).
   */
  consumir(chave: string, config: ConfigLimite, agora = Date.now()): ResultadoLimite {
    this.limparSePreciso(agora);

    const inicio = agora - config.janelaSegundos * 1000;
    const janela = this.janelas.get(chave) ?? { marcas: [] };

    // Descarta o que saiu da janela. É isso que torna a janela "deslizante"
    // em vez de "fixa" — janela fixa permite 2× o limite na virada do balde.
    janela.marcas = janela.marcas.filter((t) => t > inicio);

    if (janela.marcas.length >= config.maximo) {
      // A mais antiga define quando abre a próxima vaga.
      const maisAntiga = janela.marcas[0] ?? agora;
      const aguardar = Math.ceil((maisAntiga + config.janelaSegundos * 1000 - agora) / 1000);
      this.janelas.set(chave, janela);
      return { permitido: false, restantes: 0, aguardarSegundos: Math.max(1, aguardar) };
    }

    janela.marcas.push(agora);
    this.janelas.set(chave, janela);

    return {
      permitido: true,
      restantes: config.maximo - janela.marcas.length,
      aguardarSegundos: 0,
    };
  }

  /**
   * Consulta sem consumir.
   * Útil para devolver headers `RateLimit-*` numa resposta de sucesso.
   */
  consultar(chave: string, config: ConfigLimite, agora = Date.now()): ResultadoLimite {
    const inicio = agora - config.janelaSegundos * 1000;
    const marcas = (this.janelas.get(chave)?.marcas ?? []).filter((t) => t > inicio);
    return {
      permitido: marcas.length < config.maximo,
      restantes: Math.max(0, config.maximo - marcas.length),
      aguardarSegundos: 0,
    };
  }

  /** Zera o limite de uma chave. Use após login bem-sucedido. */
  liberar(chave: string): void {
    this.janelas.delete(chave);
  }

  /**
   * Zera TODOS os limites.
   *
   * Existe para os testes: a suíte roda dezenas de registros e logins no mesmo
   * processo e no mesmo endereço, e sem isto o próprio limitador derrubaria a
   * suíte a partir do sexto caso — o que esconderia as falhas reais atrás de
   * uma parede de 429.
   *
   * **Nunca chame isto numa rota.** Um endpoint que zera o rate limit é um
   * endpoint que desliga o rate limit.
   */
  zerarTudo(): void {
    this.janelas.clear();
  }

  /** Remove janelas totalmente vencidas, no máximo uma vez por minuto. */
  private limparSePreciso(agora: number): void {
    if (agora - this.ultimaLimpeza < 60_000) return;
    this.ultimaLimpeza = agora;

    // Uma hora cobre a maior janela configurada (`linkPortal`).
    const corte = agora - 60 * 60 * 1000;
    for (const [chave, janela] of this.janelas) {
      if (janela.marcas.every((t) => t <= corte)) this.janelas.delete(chave);
    }
  }
}

// ---------------------------------------------------------------------------
// Backoff progressivo por conta
// ---------------------------------------------------------------------------

/** Espera inicial após a primeira falha, em segundos. */
const BACKOFF_BASE_S = 1;
/** Teto da espera. 5 minutos torna a força bruta inviável sem trancar ninguém. */
const BACKOFF_TETO_S = 5 * 60;
/** Falhas toleradas antes de o backoff começar a valer. */
const FALHAS_LIVRES = 3;

/** Estado de backoff de uma conta. */
export interface EstadoBackoff {
  /** Falhas consecutivas de autenticação. */
  falhas: number;
  /** Epoch (ms) da última falha. */
  ultimaFalhaEm: number;
}

/**
 * Calcula quantos segundos a conta ainda precisa esperar.
 *
 * Progressão: 3 falhas livres, depois 1 s, 2 s, 4 s, 8 s… até 5 min.
 * O crescimento exponencial faz o custo de 1.000 tentativas passar de minutos
 * para dias, sem impacto nenhum em quem errou a senha duas vezes.
 *
 * @param estado Estado atual, ou `null` se não há falhas registradas.
 * @param agora  Instante base (injetável).
 * @returns      Segundos a esperar. `0` significa "pode tentar".
 */
export function esperaDoBackoff(estado: EstadoBackoff | null, agora = Date.now()): number {
  if (!estado || estado.falhas <= FALHAS_LIVRES) return 0;

  const expoente = estado.falhas - FALHAS_LIVRES - 1;
  // `Math.min` antes da conta evita `2 ** 40` virar Infinity em conta atacada.
  const esperaS = Math.min(BACKOFF_TETO_S, BACKOFF_BASE_S * 2 ** Math.min(expoente, 20));

  const liberaEm = estado.ultimaFalhaEm + esperaS * 1000;
  return Math.max(0, Math.ceil((liberaEm - agora) / 1000));
}

/** Registra mais uma falha e devolve o estado atualizado. */
export function registrarFalha(estado: EstadoBackoff | null, agora = Date.now()): EstadoBackoff {
  return { falhas: (estado?.falhas ?? 0) + 1, ultimaFalhaEm: agora };
}
