/**
 * Redação de dados sensíveis em logs, métricas e telemetria.
 *
 * ## O requisito
 *
 * A especificação diz: "logs técnicos, métricas e telemetria não podem carregar
 * PII nem dado clínico — isso precisa ser regra de lint/revisão, não confiança
 * na disciplina de quem escreve o log."
 *
 * Regra de lint é metade da solução: ela pega `logger.info(paciente)`, mas não
 * pega o caso mais comum, que é PII entrando por dentro de um objeto de erro,
 * de um corpo de requisição repassado, ou de uma query logada. Por isso a
 * defesa é dupla:
 *
 * 1. **Este redator**, plugado no serializador do logger. Nada é logado sem
 *    passar por aqui. É a defesa que funciona mesmo quando alguém erra.
 * 2. **A regra de ESLint** em `eslint.config.js`, que proíbe passar objetos de
 *    domínio conhecidos direto ao logger. É a defesa que educa em tempo de
 *    escrita.
 *
 * ## Estratégia: lista de permissão, não de bloqueio
 *
 * Bloquear campos por nome (`nome`, `cpf`, `email`) falha no primeiro campo
 * novo que alguém criar. Aqui a lógica é inversa: **tudo que não for
 * reconhecido como seguro é redigido**. Erra para o lado de perder informação
 * de depuração, que é o lado certo de errar.
 */

/** Marcador que substitui um valor redigido. */
export const REDIGIDO = '[redigido]';

/**
 * Campos que podem ser logados por completo.
 *
 * Regra para incluir um campo aqui: ele precisa ser um identificador opaco,
 * um enum, um número técnico ou um timestamp. Se um humano consegue ler o
 * valor e saber de quem é, ele não entra nesta lista.
 */
const CAMPOS_SEGUROS = new Set([
  // Identificadores opacos
  'id',
  'organizacaoId',
  'pacienteId',
  'planoId',
  'registroId',
  'sessaoId',
  'prescricaoId',
  'exercicioId',
  'profissionalId',
  'atorId',
  'entidadeId',
  'correlationId',
  'requestId',
  'traceId',
  // Códigos pseudonimizados: já são a forma protegida do identificador.
  'codigo',
  'pacienteCodigo',
  // Enums e metadados técnicos
  'papel',
  'acao',
  'entidade',
  'status',
  'tipo',
  'metodo',
  'method',
  'rota',
  'route',
  'url',
  'statusCode',
  'motivo',
  'recusa',
  'falha',
  'versao',
  'sequencia',
  'hash',
  'nivel',
  'level',
  'ambiente',
  // Diagnóstico de inicialização. São nomes de tecnologia e contagens — nada
  // que identifique pessoa. Sem eles, o log de subida vira uma parede de
  // "[redigido]" e deixa de servir para diagnosticar instalação.
  'driver',
  'sessao',
  'chaves',
  'porta',
  'origens',
  'estaticos',
  // Tempo e volume
  'duracaoMs',
  'responseTime',
  'ocorridoEm',
  'criadaEm',
  'time',
  'timestamp',
  'total',
  'limite',
  'contagem',
]);

/**
 * Campos que precisam de tratamento especial em vez de redação total.
 * O valor é uma função que devolve a versão segura.
 */
const TRANSFORMACOES: Record<string, (v: unknown) => unknown> = {
  /**
   * IP nunca em claro (requisito explícito da especificação).
   * Guardamos apenas o prefixo de rede, suficiente para investigar um ataque
   * distribuído sem identificar o assinante.
   */
  ip: (v) => mascararIp(String(v)),
  remoteAddress: (v) => mascararIp(String(v)),
  'x-forwarded-for': (v) => mascararIp(String(v).split(',')[0]?.trim() ?? ''),

  /** E-mail: mantém só o domínio, que é útil para diagnóstico de entrega. */
  email: (v) => mascararEmail(String(v)),

  /** User-Agent: mantém a família do navegador, corta o resto (é identificante). */
  'user-agent': (v) => String(v).slice(0, 24),
  userAgent: (v) => String(v).slice(0, 24),
};

/**
 * Chaves cujo valor é segredo e nunca deve aparecer nem parcialmente.
 * Comparação por *substring* em minúsculas, para pegar variações
 * (`authorization`, `Authorization`, `x-auth-token`...).
 */
const FRAGMENTOS_SECRETOS = [
  'senha',
  'password',
  'token',
  'secret',
  'segredo',
  'authorization',
  'cookie',
  'csrf',
  'chave',
  'key',
  'totp',
  'mfa',
  'apikey',
  'credential',
];

/**
 * Mascara um endereço IP.
 *
 * IPv4: zera o último octeto (`203.0.113.42` → `203.0.113.0/24`).
 * IPv6: mantém os 48 bits de prefixo (`2001:db8:1:…` → `2001:db8:1::/48`).
 */
export function mascararIp(ip: string): string {
  if (!ip) return REDIGIDO;

  if (ip.includes('.')) {
    const partes = ip.split('.');
    if (partes.length !== 4) return REDIGIDO;
    return `${partes[0]}.${partes[1]}.${partes[2]}.0/24`;
  }

  if (ip.includes(':')) {
    const grupos = ip.split(':').slice(0, 3);
    return `${grupos.join(':')}::/48`;
  }

  return REDIGIDO;
}

/** Mascara um e-mail, preservando só o domínio. */
export function mascararEmail(email: string): string {
  const arroba = email.lastIndexOf('@');
  if (arroba < 1) return REDIGIDO;
  return `${REDIGIDO}@${email.slice(arroba + 1)}`;
}

/** A chave contém algum fragmento marcado como secreto? */
function ehSecreta(chave: string): boolean {
  const k = chave.toLowerCase();
  return FRAGMENTOS_SECRETOS.some((f) => k.includes(f));
}

/**
 * Profundidade máxima de recursão.
 * Objeto muito aninhado (ou com ciclo) não pode travar o logger.
 */
const PROFUNDIDADE_MAXIMA = 6;

/**
 * Redige recursivamente uma estrutura antes de logar.
 *
 * @param valor      Qualquer coisa que iria para o log.
 * @param profundidade Controle interno de recursão.
 * @param vistos     Controle interno de referência circular.
 * @returns          Cópia segura para logar.
 */
export function redigir(
  valor: unknown,
  profundidade = 0,
  vistos = new WeakSet<object>(),
): unknown {
  // Primitivos passam direto — o risco está nas chaves que os contêm, e essa
  // decisão é tomada um nível acima, ao percorrer o objeto.
  if (valor === null || valor === undefined) return valor;
  if (typeof valor !== 'object') return valor;

  if (profundidade >= PROFUNDIDADE_MAXIMA) return '[profundo demais]';

  // Referência circular: loga o marcador em vez de estourar a pilha.
  if (vistos.has(valor)) return '[circular]';
  vistos.add(valor);

  // Erros: só mensagem e stack. Um `Error` customizado pode carregar a entidade
  // inteira em propriedades extras — que não copiamos de propósito.
  if (valor instanceof Error) {
    return { nome: valor.name, mensagem: valor.message, stack: valor.stack };
  }

  if (valor instanceof Date) return valor.toISOString();

  if (Array.isArray(valor)) {
    // Teto de itens: um array de 10 mil pacientes não vira 10 mil linhas de log.
    const limitado = valor.slice(0, 20).map((v) => redigir(v, profundidade + 1, vistos));
    if (valor.length > 20) limitado.push(`[+${valor.length - 20} itens omitidos]`);
    return limitado;
  }

  const saida: Record<string, unknown> = {};

  for (const [chave, v] of Object.entries(valor as Record<string, unknown>)) {
    // 1. Segredo: some por completo, sem transformação nem amostra.
    if (ehSecreta(chave)) {
      saida[chave] = REDIGIDO;
      continue;
    }

    // 2. Campo com tratamento especial (IP, e-mail, user-agent).
    const transformar = TRANSFORMACOES[chave] ?? TRANSFORMACOES[chave.toLowerCase()];
    if (transformar) {
      saida[chave] = transformar(v);
      continue;
    }

    // 3. Campo na lista de permissão: passa, mas ainda recursivamente redigido
    //    se for objeto (um `status` pode ser objeto num caso não previsto).
    if (CAMPOS_SEGUROS.has(chave)) {
      saida[chave] = typeof v === 'object' && v !== null ? redigir(v, profundidade + 1, vistos) : v;
      continue;
    }

    // 4. Desconhecido. Se for objeto, desce (as chaves de dentro passam pelas
    //    mesmas regras). Se for valor escalar, redige — é o caso do campo novo
    //    que ninguém lembrou de classificar.
    saida[chave] =
      typeof v === 'object' && v !== null ? redigir(v, profundidade + 1, vistos) : REDIGIDO;
  }

  return saida;
}

/**
 * Varredura de texto livre, para mensagens montadas com interpolação.
 *
 * Última linha de defesa: pega CPF, e-mail e telefone que tenham escapado para
 * dentro de uma string. Não substitui a redação estruturada — é o cinto além
 * do suspensório.
 */
export function redigirTexto(texto: string): string {
  return texto
    // CPF com ou sem pontuação.
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[cpf]')
    // E-mail.
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]')
    // Telefone brasileiro com DDD, com ou sem parênteses.
    // Sem `\b` no início: entre um espaço e um `(` não existe fronteira de
    // palavra, e o `\b` faria a captura começar depois do parêntese, deixando
    // um `(` órfão na saída.
    .replace(/(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}(?!\d)/g, '[telefone]')
    // Cartão (não usamos, mas se alguém colar num campo de observação...).
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[cartao]');
}
