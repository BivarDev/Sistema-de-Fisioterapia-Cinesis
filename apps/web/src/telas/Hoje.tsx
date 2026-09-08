/**
 * Tela "Hoje" — a primeira coisa que o fisioterapeuta vê.
 *
 * ## O critério da tela
 *
 * Responde a uma pergunta só: *qual decisão eu preciso tomar agora?*
 *
 * Por isso são quatro métricas e três sinais, e cada sinal traz uma ação
 * sugerida. Um painel com dezenas de indicadores sem ação associada é bonito na
 * demonstração e inútil na segunda semana — o profissional para de olhar.
 *
 * ## Os sinais vêm de eventos, não de agregação genérica
 *
 * "3 planos sem evolução mensurável em 3 sessões" sai da regra estatística de
 * tendência, não de um `COUNT` qualquer. É informação que muda conduta.
 */

import { useEffect, useState } from 'react';
import { Cartao, Contador, Revelar, TituloSecao } from '@cinesis/ui';
import { buscar } from '../api.js';

/** Resposta de `GET /api/hoje`. */
interface DadosHoje {
  metricas: {
    pacientesAtivos: number;
    planosAtivos: number;
    adesaoMedia: number;
    noShow: number;
    faltaJustificada: number;
  };
  sinais: { quantidade: number; descricao: string; acao: string }[];
}

export function Hoje() {
  const [dados, setDados] = useState<DadosHoje | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    buscar<DadosHoje>('/hoje')
      .then(setDados)
      .catch(() => setErro('Não foi possível carregar o painel.'));
  }, []);

  if (erro) return <Aviso texto={erro} />;
  if (!dados) return <Aviso texto="Carregando…" />;

  const m = dados.metricas;

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 27, margin: '0 0 4px' }}>Hoje</h1>
      <p style={{ color: 'var(--ink2)', fontSize: 13.5, margin: '0 0 24px' }}>
        Quem precisa de atenção agora, e por quê.
      </p>

      {/* --- Faixa de métricas ---------------------------------------------- */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          // `gap: 1px` sobre um fundo de linha produz divisores de 1px sem
          // precisar de borda em cada célula.
          gap: 1,
          background: 'var(--line)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-cartao)',
          overflow: 'hidden',
          marginBottom: 26,
        }}
      >
        <Metrica valor={m.pacientesAtivos} rotulo="Pacientes ativos" nota="com plano em curso" />
        <Metrica valor={m.planosAtivos} rotulo="Planos ativos" nota="episódios de tratamento" />
        <Metrica valor={m.adesaoMedia} sufixo="%" rotulo="Adesão média" nota="últimos 30 dias" />
        {/*
          No-show e falta justificada aparecem SEPARADOS.
          Somar os dois num número só esconderia exatamente a informação que
          muda a conduta: quem avisa que não vem é um problema de agenda; quem
          some é um problema de adesão ao tratamento.
        */}
        <Metrica
          valor={m.noShow}
          sufixo="%"
          rotulo="No-show"
          nota={`falta justificada: ${m.faltaJustificada}%`}
        />
      </div>

      {/* --- Sinais --------------------------------------------------------- */}
      <TituloSecao
        titulo="Quem precisa de atenção"
        subtitulo="Sinais derivados dos dados do tratamento — não de um painel genérico. Cada linha traz a ação sugerida."
      />

      <div style={{ display: 'grid', gap: 10, marginBottom: 26 }}>
        {dados.sinais.map((sinal, i) => (
          <Revelar key={sinal.descricao} atraso={i * 70}>
            <Cartao style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 9,
                    display: 'grid',
                    placeItems: 'center',
                    fontWeight: 800,
                    fontSize: 15,
                    flexShrink: 0,
                    // Zero é bom: pinta de verde. Qualquer número acima de zero
                    // pede atenção.
                    background: sinal.quantidade === 0 ? 'var(--good-soft)' : 'var(--acc-soft)',
                    color: sinal.quantidade === 0 ? 'var(--good)' : 'var(--acc-on-soft)',
                  }}
                >
                  {sinal.quantidade}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{sinal.descricao}</div>
                </div>
                <span className="mono" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>
                  {sinal.acao}
                </span>
              </div>
            </Cartao>
          </Revelar>
        ))}
      </div>

      {/* --- Cartão de tese: explica o critério da própria tela -------------- */}
      <Cartao tom="pri">
        <div className="mono" style={{ fontSize: 10.5, marginBottom: 8 }}>
          o critério desta tela
        </div>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>
          Cada elemento aqui responde a &quot;qual decisão eu preciso tomar agora?&quot;. Um número
          que não leva a uma ação não entra nesta tela — vai para o relatório. É por isso que a
          primeira dobra tem quatro métricas e três sinais, e não um mural de indicadores.
        </p>
      </Cartao>
    </div>
  );
}

/** Uma célula da faixa de métricas. O número anima ao entrar na tela. */
function Metrica({
  valor,
  rotulo,
  nota,
  sufixo = '',
}: {
  valor: number;
  rotulo: string;
  nota: string;
  sufixo?: string;
}) {
  return (
    <div style={{ background: 'var(--surface)', padding: '20px 18px' }}>
      <div style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 38, lineHeight: 1 }}>
        <Contador valor={valor} sufixo={sufixo} />
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 6 }}>{rotulo}</div>
      <div className="mono" style={{ fontSize: 10, marginTop: 3 }}>
        {nota}
      </div>
    </div>
  );
}

/** Estado neutro de carregamento ou erro. */
export function Aviso({ texto }: { texto: string }) {
  return (
    <div style={{ color: 'var(--ink3)', fontSize: 13.5, padding: '40px 0' }}>{texto}</div>
  );
}
