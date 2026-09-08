/**
 * Gráficos clínicos, em SVG puro.
 *
 * ## Por que SVG à mão e não uma biblioteca
 *
 * São dois gráficos, com requisitos muito específicos: barras de escore com uma
 * linha de EVA sobreposta em eixo invertido, e um heatmap de 7 quadrados.
 * Qualquer biblioteca capaz disso pesa mais que estas 200 linhas, e nenhuma
 * entrega de graça o que aqui é obrigatório: escala de cor que não engana
 * (verde nunca marca piora), texto alternativo real e respeito ao modo reduzido.
 *
 * ## A regra que atravessa este arquivo
 *
 * **Cor nunca é a única informação.** Toda barra e todo quadrado carregam
 * número, rótulo ou `title`. Quem não distingue verde de vermelho — cerca de 8%
 * dos homens — precisa ler o mesmo dado.
 */

import { usarPreferencias } from '../animacao/preferencias.js';
import { usarNaTela } from '../animacao/ganchos.js';

/** Um ponto da série longitudinal. */
export interface PontoGrafico {
  rotulo: string;
  /** Escore funcional composto, 0–100. Sobe = melhora. */
  escore: number;
  /** Dor EVA, 0–10. Desce = melhora. */
  eva: number;
}

/**
 * Gráfico de comparação longitudinal.
 *
 * Barras = escore funcional (eixo esquerdo, 0–100).
 * Linha  = dor EVA (eixo direito, 0–10, com a dor alta no topo).
 *
 * Os dois eixos juntos são o produto inteiro numa imagem: a barra subindo
 * enquanto a linha desce é a evolução que a especificação chama de tese central.
 *
 * ## O que mudou nesta versão, e por quê
 *
 * A primeira versão dava barras de mais de 100px de largura num plano de 8
 * sessões, porque cada slot era `flex: 1` sobre a largura inteira do cartão.
 * Barra mais larga do que alta não lê como valor, lê como bloco. Quatro
 * correções:
 *
 * 1. **Largura da barra tem teto** (`LARGURA_MAX_BARRA`), e a área de plotagem
 *    tem largura máxima proporcional ao número de sessões, centralizada. Um
 *    plano de 4 sessões ocupa metade do cartão em vez de virar quatro lajes.
 * 2. **Existe eixo.** Antes não dava para ler nenhum valor: nem o escore, nem a
 *    dor. Agora há linhas de grade, rótulo nos dois eixos e o número em cima de
 *    cada barra. Num gráfico clínico, "subiu" sem dizer quanto não sustenta
 *    conduta.
 * 3. **O gradiente foi invertido.** Ele clareava em direção ao topo, que é
 *    justamente onde está o valor: a borda que o olho precisa medir era a parte
 *    mais fraca da barra. Agora o topo é sólido e a base é que suaviza.
 * 4. **Os pontos da linha eram elipses.** O SVG usa `preserveAspectRatio="none"`
 *    para a linha acompanhar o eixo X, e isso achatava os `<circle>`.
 *    `vectorEffect` protege o traço, não a forma. Os pontos passaram a ser
 *    elementos HTML posicionados, que não distorcem.
 */
export function GraficoLongitudinal({
  serie,
  altura = 260,
}: {
  serie: PontoGrafico[];
  altura?: number;
}) {
  const { reduzido } = usarPreferencias();
  const [ref, visivel] = usarNaTela<HTMLDivElement>();

  if (serie.length === 0) {
    return (
      <div
        style={{
          height: altura,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ink3)',
          fontSize: 12.5,
          border: '1px dashed var(--line)',
          borderRadius: 'var(--r-cartao)',
        }}
      >
        Ainda não há sessões com teste funcional aplicado neste plano.
      </div>
    );
  }

  // --- Medidas do desenho ---------------------------------------------------
  /** Faixa acima da plotagem, onde vai o número de cada barra. */
  const ALTURA_VALOR = 20;
  /** Faixa abaixo da plotagem, onde vai o rótulo da sessão. */
  const ALTURA_ROTULO = 24;
  /** Teto da barra. Acima disso ela deixa de parecer uma medida. */
  const LARGURA_MAX_BARRA = 46;
  /**
   * Largura máxima de um slot. Multiplicada pelo número de sessões, define até
   * onde a área de plotagem cresce; o resto vira margem simétrica. Sem isto, um
   * plano curto espalha três barras por 1400px.
   */
  const LARGURA_MAX_SLOT = 92;

  const alturaPlot = altura - ALTURA_VALOR - ALTURA_ROTULO;

  /** Marcas do eixo esquerdo (escore) e do direito (dor). */
  const MARCAS_ESCORE = [100, 75, 50, 25, 0];
  const MARCAS_EVA = [10, 5, 0];

  /** Escore (0–100) para distância do topo da plotagem, em px. */
  const yDoEscore = (escore: number) => alturaPlot - (escore / 100) * alturaPlot;
  /** EVA (0–10) para distância do topo. Dor alta no topo: descer = melhorar. */
  const yDaEva = (eva: number) => alturaPlot - (eva / 10) * alturaPlot;

  // A linha usa viewBox 0–100 nos dois eixos e é esticada no X pelo CSS.
  const passo = 100 / serie.length;
  const pontosLinha = serie
    .map((p, i) => `${i * passo + passo / 2},${(yDaEva(p.eva) / alturaPlot) * 100}`)
    .join(' ');

  const primeiro = serie[0];
  const ultimo = serie[serie.length - 1];

  return (
    <div ref={ref}>
      {/* Descrição textual completa, para leitor de tela. O desenho é
          decorativo: quem não enxerga recebe a mesma informação em palavras. */}
      <p className="apenas-leitor-de-tela">
        Evolução ao longo de {serie.length} sessões. Escore funcional de{' '}
        {primeiro?.escore} a {ultimo?.escore} em 100. Dor de {primeiro?.eva} a{' '}
        {ultimo?.eva} em 10.
      </p>

      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 10,
          // Centraliza o conjunto quando a série é curta demais para o cartão.
          maxWidth: serie.length * LARGURA_MAX_SLOT + 76,
          margin: '0 auto',
        }}
      >
        {/* --- Eixo esquerdo: escore funcional ------------------------------ */}
        <div style={{ position: 'relative', width: 26, height: altura, flexShrink: 0 }}>
          {MARCAS_ESCORE.map((v) => (
            <span
              key={v}
              className="mono numero"
              style={{
                position: 'absolute',
                right: 0,
                // -6px centra o texto na linha de grade em vez de pendurá-lo.
                top: ALTURA_VALOR + yDoEscore(v) - 6,
                fontSize: 9.5,
                lineHeight: 1,
                color: 'var(--ink3)',
              }}
            >
              {v}
            </span>
          ))}
        </div>

        {/* --- Área de plotagem --------------------------------------------- */}
        <div style={{ position: 'relative', flex: 1, height: altura, minWidth: 0 }}>
          {/* Linhas de grade. A do zero é mais forte: é a base das barras. */}
          {MARCAS_ESCORE.map((v) => (
            <div
              key={v}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: ALTURA_VALOR + yDoEscore(v),
                height: 1,
                background: v === 0 ? 'var(--line2)' : 'var(--line)',
              }}
            />
          ))}

          {/* Barras de escore funcional. */}
          <div
            style={{
              position: 'absolute',
              inset: `${ALTURA_VALOR}px 0 ${ALTURA_ROTULO}px 0`,
              display: 'flex',
              alignItems: 'flex-end',
            }}
          >
            {serie.map((p, i) => (
              <div
                key={p.rotulo}
                title={`${p.rotulo}: escore ${p.escore} de 100, dor ${p.eva} de 10`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  height: '100%',
                }}
              >
                {/* O valor, acima da barra. */}
                <span
                  className="numero"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    lineHeight: 1,
                    color: 'var(--ink2)',
                    marginBottom: 5,
                    opacity: visivel || reduzido ? 1 : 0,
                    transition: `opacity var(--dur) var(--ease) ${300 + i * 60}ms`,
                  }}
                >
                  {p.escore}
                </span>
                <div
                  style={{
                    width: '68%',
                    maxWidth: LARGURA_MAX_BARRA,
                    // No modo reduzido a barra já nasce na altura final.
                    height: visivel || reduzido ? (p.escore / 100) * alturaPlot : 0,
                    // Sólido no topo: a borda de cima é o valor que se lê.
                    background:
                      'linear-gradient(to bottom, var(--pri), color-mix(in oklab, var(--pri) 62%, transparent))',
                    borderRadius: '5px 5px 0 0',
                    // A defasagem por barra dá o efeito de crescimento da série.
                    transition: `height var(--dur) var(--ease) ${i * 60}ms`,
                  }}
                />
              </div>
            ))}
          </div>

          {/* Rótulo de cada sessão, alinhado com a barra. */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: ALTURA_ROTULO,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {serie.map((p) => (
              <span
                key={p.rotulo}
                className="mono"
                style={{ flex: 1, textAlign: 'center', fontSize: 9.5, minWidth: 0 }}
              >
                {p.rotulo}
              </span>
            ))}
          </div>

          {/* Linha de EVA sobreposta. Só o traço vem do SVG. */}
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: ALTURA_VALOR,
              width: '100%',
              height: alturaPlot,
              pointerEvents: 'none',
              overflow: 'visible',
            }}
          >
            <polyline
              points={pontosLinha}
              fill="none"
              stroke="var(--acc)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              // Sem isto, o `preserveAspectRatio="none"` esticaria a espessura
              // da linha junto com o eixo X e ela ficaria disforme.
              vectorEffect="non-scaling-stroke"
              style={{
                opacity: visivel || reduzido ? 1 : 0,
                transition: `opacity var(--dur) var(--ease) 300ms`,
              }}
            />
          </svg>

          {/* Pontos da linha, em HTML. Dentro do SVG esticado eles virariam
              elipses: `vectorEffect` protege o traço, não a forma do círculo. */}
          {serie.map((p, i) => (
            <div
              key={p.rotulo}
              title={`${p.rotulo}: dor ${p.eva} de 10`}
              style={{
                position: 'absolute',
                left: `${((i + 0.5) / serie.length) * 100}%`,
                top: ALTURA_VALOR + yDaEva(p.eva),
                width: 7,
                height: 7,
                marginLeft: -3.5,
                marginTop: -3.5,
                borderRadius: '50%',
                background: 'var(--acc)',
                // Anel na cor do fundo: separa o ponto da barra por baixo dele.
                boxShadow: '0 0 0 2px var(--surface)',
                opacity: visivel || reduzido ? 1 : 0,
                transition: `opacity var(--dur) var(--ease) ${300 + i * 40}ms`,
              }}
            />
          ))}
        </div>

        {/* --- Eixo direito: dor EVA ---------------------------------------- */}
        <div style={{ position: 'relative', width: 18, height: altura, flexShrink: 0 }}>
          {MARCAS_EVA.map((v) => (
            <span
              key={v}
              className="mono numero"
              style={{
                position: 'absolute',
                left: 0,
                top: ALTURA_VALOR + yDaEva(v) - 6,
                fontSize: 9.5,
                lineHeight: 1,
                color: 'var(--acc)',
              }}
            >
              {v}
            </span>
          ))}
        </div>
      </div>

      {/* Legenda: a cor sozinha não diz qual série é qual. */}
      <div
        style={{
          display: 'flex',
          gap: 18,
          marginTop: 14,
          fontSize: 11.5,
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink2)' }}>
          <span
            style={{ width: 11, height: 11, borderRadius: 3, background: 'var(--pri)' }}
            aria-hidden="true"
          />
          Escore funcional (0–100, maior é melhor)
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink2)' }}>
          <span style={{ width: 11, height: 2, background: 'var(--acc)' }} aria-hidden="true" />
          Dor EVA (0–10, menor é melhor)
        </span>
      </div>
    </div>
  );
}

/** Estados possíveis de um dia no heatmap. */
export type DiaAdesao = 'fez' | 'parcial' | 'nao_fez' | 'sem_prescricao';

/** Cor e texto de cada estado. O texto vai no `title` e no `aria-label`. */
const ESTADO_DIA: Record<DiaAdesao, { cor: string; borda: string; texto: string }> = {
  fez: { cor: 'var(--good)', borda: 'var(--good)', texto: 'fez' },
  parcial: { cor: 'var(--acc)', borda: 'var(--acc)', texto: 'fez parte' },
  nao_fez: { cor: 'var(--bad-soft)', borda: 'var(--bad-soft)', texto: 'não fez' },
  sem_prescricao: { cor: 'transparent', borda: 'var(--line2)', texto: 'sem prescrição' },
};

/**
 * Heatmap de 7 dias de adesão.
 *
 * "Sem prescrição" é tracejado, não vermelho: o paciente não deixou de fazer —
 * não havia o que fazer. Pintar os dois igual inflaria artificialmente a
 * impressão de baixa adesão e levaria a conduta errada.
 */
export function HeatmapSemana({ dias }: { dias: DiaAdesao[] }) {
  const nomes = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

  return (
    <div style={{ display: 'flex', gap: 5 }}>
      {dias.map((dia, i) => {
        const e = ESTADO_DIA[dia];
        const nomeDia = nomes[(new Date().getDay() - (dias.length - 1 - i) + 7) % 7];

        return (
          <div
            key={i}
            title={`${nomeDia}: ${e.texto}`}
            aria-label={`${nomeDia}: ${e.texto}`}
            style={{
              width: 29,
              height: 29,
              borderRadius: 8,
              background: e.cor,
              border: dia === 'sem_prescricao' ? `1px dashed ${e.borda}` : `1px solid ${e.borda}`,
              flexShrink: 0,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Barras horizontais para adesão por exercício.
 *
 * Ordenadas do pior para o melhor, porque a tela existe para achar o que está
 * falhando — não para celebrar o que já vai bem.
 */
export function BarrasHorizontais({
  itens,
}: {
  itens: { rotulo: string; valor: number }[];
}) {
  const { reduzido } = usarPreferencias();
  const [ref, visivel] = usarNaTela<HTMLDivElement>();

  return (
    <div ref={ref} style={{ display: 'grid', gap: 12 }}>
      {itens.map((item, i) => (
        <div key={item.rotulo}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: 5,
              fontSize: 12.5,
            }}
          >
            <span style={{ fontWeight: 600 }}>{item.rotulo}</span>
            {/* O número ao lado da barra: a informação existe sem depender da
                cor. `numero` alinha os dígitos entre as linhas da lista. */}
            <span className="mono numero" style={{ color: 'var(--ink2)' }}>
              {item.valor}%
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={item.valor}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={item.rotulo}
            style={{
              height: 8,
              background: 'var(--surface3)',
              borderRadius: 'var(--r-pill)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: visivel || reduzido ? `${item.valor}%` : 0,
                height: '100%',
                background:
                  item.valor >= 70 ? 'var(--good)' : item.valor >= 50 ? 'var(--acc)' : 'var(--bad)',
                borderRadius: 'var(--r-pill)',
                transition: `width var(--dur) var(--ease) ${i * 70}ms`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Barras verticais simples, para o portal do paciente.
 *
 * Sem eixo, sem número, sem legenda — de propósito. A tela do paciente responde
 * "como estou evoluindo", e a resposta em número está na frase logo abaixo, em
 * linguagem de paciente. O gráfico aqui é a forma, não o dado.
 */
export function BarrasSimples({ valores, altura = 80 }: { valores: number[]; altura?: number }) {
  const { reduzido } = usarPreferencias();
  const [ref, visivel] = usarNaTela<HTMLDivElement>();
  const maximo = Math.max(...valores, 1);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: altura }}
    >
      {valores.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: visivel || reduzido ? `${(v / maximo) * 100}%` : 0,
            minHeight: 4,
            background: 'var(--good)',
            borderRadius: '5px 5px 0 0',
            transition: `height var(--dur) var(--ease) ${i * 55}ms`,
          }}
        />
      ))}
    </div>
  );
}
