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
 * Linha  = dor EVA (eixo direito, 0–10).
 *
 * Os dois eixos juntos são o produto inteiro numa imagem: a barra subindo
 * enquanto a linha desce é a evolução que a especificação chama de tese central.
 */
export function GraficoLongitudinal({
  serie,
  altura = 240,
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

  const larguraViewBox = 100;
  const alturaViewBox = 40;
  // Espaço entre barras: 22% da largura de cada slot.
  const passo = larguraViewBox / serie.length;

  /** Converte EVA (0–10) na coordenada Y do viewBox (invertida). */
  const yDaEva = (eva: number) => alturaViewBox - (eva / 10) * alturaViewBox * 0.9 - 2;

  const pontosLinha = serie
    .map((p, i) => `${i * passo + passo / 2},${yDaEva(p.eva)}`)
    .join(' ');

  return (
    <div ref={ref}>
      {/* Descrição textual completa, para leitor de tela. O SVG é decorativo
          — quem não enxerga o gráfico recebe a mesma informação em palavras. */}
      <p className="apenas-leitor-de-tela">
        Evolução ao longo de {serie.length} sessões. Escore funcional de{' '}
        {serie[0]?.escore} a {serie[serie.length - 1]?.escore} em 100. Dor de{' '}
        {serie[0]?.eva} a {serie[serie.length - 1]?.eva} em 10.
      </p>

      <div
        aria-hidden="true"
        style={{
          position: 'relative',
          height: altura,
          display: 'flex',
          alignItems: 'flex-end',
          gap: 0,
        }}
      >
        {/* Barras de escore funcional. */}
        {serie.map((p, i) => (
          <div
            key={p.rotulo}
            title={`${p.rotulo}: escore ${p.escore}, dor ${p.eva}`}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}
          >
            <div
              style={{
                width: '58%',
                // No modo reduzido a barra já nasce na altura final.
                height: visivel || reduzido ? `${(p.escore / 100) * (altura - 26)}px` : 0,
                background: 'linear-gradient(to top, var(--pri), color-mix(in oklab, var(--pri) 38%, transparent))',
                borderRadius: '6px 6px 0 0',
                // A defasagem por barra dá o efeito de "crescimento" da série.
                transition: `height var(--dur) var(--ease) ${i * 60}ms`,
              }}
            />
            <span className="mono" style={{ fontSize: 9.5, marginTop: 6 }}>
              {p.rotulo}
            </span>
          </div>
        ))}

        {/* Linha de EVA sobreposta. */}
        <svg
          viewBox={`0 0 ${larguraViewBox} ${alturaViewBox}`}
          preserveAspectRatio="none"
          style={{
            position: 'absolute',
            inset: `0 0 26px 0`,
            width: '100%',
            height: `${altura - 26}px`,
            pointerEvents: 'none',
          }}
        >
          <polyline
            points={pontosLinha}
            fill="none"
            stroke="var(--acc)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            // Sem isto, o `preserveAspectRatio="none"` esticaria a espessura da
            // linha junto com o eixo X e ela ficaria disforme.
            vectorEffect="non-scaling-stroke"
            style={{
              opacity: visivel || reduzido ? 1 : 0,
              transition: `opacity var(--dur) var(--ease) 300ms`,
            }}
          />
          {serie.map((p, i) => (
            <circle
              key={p.rotulo}
              cx={i * passo + passo / 2}
              cy={yDaEva(p.eva)}
              r={0.9}
              fill="var(--acc)"
              vectorEffect="non-scaling-stroke"
              style={{
                opacity: visivel || reduzido ? 1 : 0,
                transition: `opacity var(--dur) var(--ease) ${300 + i * 40}ms`,
              }}
            />
          ))}
        </svg>
      </div>

      {/* Legenda: a cor sozinha não diz qual série é qual. */}
      <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 11.5 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink2)' }}>
          <span
            style={{ width: 11, height: 11, borderRadius: 3, background: 'var(--pri)' }}
            aria-hidden="true"
          />
          Escore funcional (0–100, maior é melhor)
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink2)' }}>
          <span
            style={{ width: 11, height: 2, background: 'var(--acc)' }}
            aria-hidden="true"
          />
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
