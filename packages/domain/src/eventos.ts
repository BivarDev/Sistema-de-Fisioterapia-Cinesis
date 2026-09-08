/**
 * Eventos de domínio — publish/subscribe interno ao processo.
 *
 * ## O que isto é e o que deliberadamente não é
 *
 * A especificação pede um "mecanismo leve, não event sourcing", com
 * "implementação mínima viável: um publish/subscribe interno ao processo (nem
 * fila externa, nem event store)". É exatamente isso: um `Map` de handlers e
 * um `publicar`. Sem RabbitMQ, sem Kafka, sem tabela de eventos como fonte da
 * verdade.
 *
 * Isso vale enquanto o sistema for um monólito de um processo. Quando (e se)
 * aparecer necessidade real de consumidor assíncrono fora do processo, o
 * contrato aqui não muda — troca-se a implementação de `publicar`.
 *
 * ## Decisão sobre falha de consumidor
 *
 * Um consumidor que lança **não derruba a operação de domínio**. Se a auditoria
 * falhar ao gravar uma métrica, a evolução clínica que o fisioterapeuta acabou
 * de assinar não pode ser perdida. A exceção é o consumidor de auditoria
 * crítica, que roda de forma síncrona na mesma transação — ver
 * `apps/api/src/servicos/auditoria.ts`.
 */

/** Catálogo de eventos. Nomes em inglês por serem termos do modelo de domínio. */
export type TipoEvento =
  | 'PatientRegistered'
  | 'AssessmentCompleted'
  | 'AssessmentFinalized'
  | 'TreatmentPlanCreated'
  | 'TreatmentPlanChanged'
  | 'TreatmentPlanClosed'
  | 'EvolutionFinalized'
  | 'EvolutionVersioned'
  | 'ReassessmentCreated'
  | 'ReassessmentDue'
  | 'ExercisePrescribed'
  | 'ExerciseCompleted'
  | 'SessionScheduled'
  | 'SessionConfirmed'
  | 'PatientAbsent'
  | 'ConsentRecorded'
  | 'AdherenceDropped';

/**
 * Um evento publicado.
 *
 * `payload` carrega apenas identificadores e números. **Nunca PII nem texto
 * clínico** — eventos alimentam métricas e notificações, e o que entra num
 * evento tende a acabar num log.
 */
export interface EventoDominio<P = Record<string, unknown>> {
  tipo: TipoEvento;
  /** Organização de origem. Consumidores precisam para não cruzar tenants. */
  organizacaoId: string;
  /** Quem causou o evento. `null` para evento gerado por regra do sistema. */
  atorId: string | null;
  /** Momento em que aconteceu. */
  ocorridoEm: Date;
  /** Dados do evento. Só identificadores e escalares. */
  payload: P;
}

/** Assinatura de um consumidor. Pode ser assíncrono. */
export type Consumidor<P = Record<string, unknown>> = (
  evento: EventoDominio<P>,
) => void | Promise<void>;

/** O que fazer quando um consumidor lança. */
export type TratadorDeErro = (erro: unknown, evento: EventoDominio, indice: number) => void;

/**
 * Barramento de eventos do processo.
 *
 * Uma instância por aplicação, criada na composição e injetada nos serviços.
 * Não é singleton global de propósito: singleton global torna teste dependente
 * de ordem de execução, porque consumidores de um teste vazam para o próximo.
 */
export class Barramento {
  /** Consumidores registrados por tipo de evento. */
  private readonly consumidores = new Map<TipoEvento, Consumidor<never>[]>();

  /** Consumidores que recebem todos os eventos (auditoria, métricas). */
  private readonly universais: Consumidor[] = [];

  /**
   * @param aoFalhar O que fazer quando um consumidor lança.
   *                 Padrão: `console.error`. Em produção, a composição injeta
   *                 o logger estruturado — que passa pela redação de PII.
   */
  constructor(
    private readonly aoFalhar: TratadorDeErro = (erro, evento) => {
      // Tratador PADRÃO, usado só quando ninguém injetou um logger — o que
      // acontece em teste e em script. Sem este `catch`, uma falha de
      // notificação abortaria a transação clínica que a originou.
      // eslint-disable-next-line no-console -- alternativa sem logger injetado
      console.error(`[eventos] consumidor de ${evento.tipo} falhou:`, erro);
    },
  ) {}

  /**
   * Registra um consumidor para um tipo de evento.
   * @returns Função que cancela a inscrição. Útil em teste.
   */
  assinar<P>(tipo: TipoEvento, consumidor: Consumidor<P>): () => void {
    const lista = this.consumidores.get(tipo) ?? [];
    lista.push(consumidor as Consumidor<never>);
    this.consumidores.set(tipo, lista);

    return () => {
      const atual = this.consumidores.get(tipo) ?? [];
      const i = atual.indexOf(consumidor as Consumidor<never>);
      if (i >= 0) atual.splice(i, 1);
    };
  }

  /** Registra um consumidor que recebe todos os eventos. */
  assinarTudo(consumidor: Consumidor): () => void {
    this.universais.push(consumidor);
    return () => {
      const i = this.universais.indexOf(consumidor);
      if (i >= 0) this.universais.splice(i, 1);
    };
  }

  /**
   * Publica um evento.
   *
   * Aguarda todos os consumidores, mas **isola as falhas**: um consumidor que
   * lança não impede os outros de rodar nem propaga o erro para quem publicou.
   *
   * @param evento Evento a publicar.
   */
  async publicar<P>(evento: EventoDominio<P>): Promise<void> {
    const alvos = [
      ...(this.consumidores.get(evento.tipo) ?? []),
      ...this.universais,
    ] as Consumidor<P>[];

    // `allSettled` em vez de `all`: queremos rodar todos e depois olhar as
    // falhas, não parar no primeiro erro.
    //
    // O `Promise.resolve().then(...)` não é decorativo: um consumidor que lança
    // de forma SÍNCRONA (antes do primeiro `await`) explodiria dentro do `map`,
    // antes de a promessa existir — e o `allSettled` nunca chegaria a capturá-lo.
    // O erro escaparia para quem publicou e abortaria a operação clínica, que é
    // exatamente o que este método existe para impedir.
    const resultados = await Promise.allSettled(
      alvos.map((c) => Promise.resolve().then(() => c(evento))),
    );

    resultados.forEach((r, i) => {
      if (r.status === 'rejected') this.aoFalhar(r.reason, evento as EventoDominio, i);
    });
  }

  /** Quantidade de consumidores de um tipo. Diagnóstico e teste. */
  contarConsumidores(tipo: TipoEvento): number {
    return (this.consumidores.get(tipo)?.length ?? 0) + this.universais.length;
  }
}

/**
 * Atalho para montar um evento com os campos padrão preenchidos.
 *
 * @param tipo           Tipo do evento.
 * @param organizacaoId  Tenant de origem.
 * @param atorId         Quem causou, ou `null`.
 * @param payload        Identificadores e escalares. Sem PII.
 * @param agora          Instante (injetável para teste).
 */
export function evento<P extends Record<string, unknown>>(
  tipo: TipoEvento,
  organizacaoId: string,
  atorId: string | null,
  payload: P,
  agora = new Date(),
): EventoDominio<P> {
  return { tipo, organizacaoId, atorId, ocorridoEm: agora, payload };
}
