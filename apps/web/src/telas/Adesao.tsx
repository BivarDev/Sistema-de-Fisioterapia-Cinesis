/**
 * Painel de adesão.
 *
 * ## O que a tela existe para responder
 *
 * Quem está fazendo o programa — e **por que não**. Por isso ela tem duas
 * seções complementares:
 *
 * - **Por paciente**: quem precisa de conversa na próxima sessão.
 * - **Por exercício**: agregado atravessando todos os pacientes. Um exercício
 *   com 42% em quinze pessoas diferentes não é problema de paciente; é
 *   prescrição mal calibrada ou orientação mal explicada.
 *
 * ## O tom da gamificação
 *
 * Meta semanal e sequência existem. Troféu, confete e linguagem infantilizada,
 * não. O paciente é um adulto em tratamento, e a métrica precisa ser confiável
 * antes de virar jogo — uma sequência calculada sobre um denominador errado dá
 * confiança falsa a uma decisão clínica.
 */

import { useEffect, useState } from 'react';
import {
  Avatar,
  BarrasHorizontais,
  Barra,
  Cartao,
  HeatmapSemana,
  TituloSecao,
  type DiaAdesao,
} from '@cinesis/ui';
import type { LinhaAdesao } from '@cinesis/shared';
import { buscar } from '../api.js';
import { Aviso } from './Hoje.js';

/** Resposta de `GET /api/adesao`. */
interface Resposta {
  pacientes: LinhaAdesao[];
  porExercicio: { exercicio: string; taxa: number; registros: number }[];
}

export function Adesao() {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    buscar<Resposta>('/adesao')
      .then(setDados)
      .catch(() => setErro('Não foi possível carregar o painel de adesão.'));
  }, []);

  if (erro) return <Aviso texto={erro} />;
  if (!dados) return <Aviso texto="Carregando…" />;

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 27, margin: '0 0 4px' }}>
        Painel de adesão
      </h1>
      <p style={{ color: 'var(--ink2)', fontSize: 13.5, margin: '0 0 22px' }}>
        Quem está fazendo o programa domiciliar — e por que não.
      </p>

      {/* --- Adesão por paciente --------------------------------------------- */}
      <Cartao style={{ marginBottom: 20 }}>
        <TituloSecao
          titulo="Adesão por paciente"
          subtitulo="Últimos 30 dias. O denominador é a frequência prescrita, não os dias corridos — quem faz 3 de 3 dias prescritos tem 100%, não 43%."
          acao={
            <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
              <Legenda cor="var(--good)" texto="fez" />
              <Legenda cor="var(--acc)" texto="fez parte" />
              <Legenda cor="var(--bad-soft)" texto="não fez" />
              <Legenda cor="transparent" texto="sem prescrição" tracejado />
            </div>
          }
        />

        {dados.pacientes.length === 0 ? (
          <p style={{ color: 'var(--ink3)', fontSize: 13, margin: 0 }}>
            Nenhum paciente com prescrição ativa. Crie uma prescrição a partir do plano de
            tratamento.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 1, background: 'var(--line)' }}>
            {dados.pacientes.map((p) => (
              <div
                key={p.pacienteId}
                style={{
                  background: 'var(--surface)',
                  padding: '14px 4px',
                  display: 'grid',
                  gridTemplateColumns: '1.5fr 1.2fr 1.4fr 1fr',
                  gap: 16,
                  alignItems: 'center',
                }}
                className="tabela-linha"
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <Avatar nome={p.nome ?? p.codigo} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{p.nome ?? p.codigo}</div>
                    <div className="mono" style={{ fontSize: 10 }}>
                      {p.codigo} · meta {p.metaSemanal}×/semana
                    </div>
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 5 }}>{p.taxa}%</div>
                  <Barra valor={p.taxa} />
                </div>

                <HeatmapSemana dias={p.ultimos7 as DiaAdesao[]} />

                <div className="mono" style={{ fontSize: 11.5 }}>
                  {p.sequencia > 0 ? `${p.sequencia} dias seguidos` : 'sequência interrompida'}
                </div>
              </div>
            ))}
          </div>
        )}
      </Cartao>

      {/* --- Adesão por exercício -------------------------------------------- */}
      <Cartao style={{ marginBottom: 20 }}>
        <TituloSecao
          titulo="Adesão por exercício"
          subtitulo="Exercício com adesão baixa costuma ser problema de prescrição, não de paciente. Ordenado do pior para o melhor."
        />

        {dados.porExercicio.length === 0 ? (
          <p style={{ color: 'var(--ink3)', fontSize: 13, margin: 0 }}>
            Ainda não há registros de execução no período.
          </p>
        ) : (
          <BarrasHorizontais
            itens={dados.porExercicio.map((e) => ({ rotulo: e.exercicio, valor: e.taxa }))}
          />
        )}
      </Cartao>

      {/* --- Camada secundária ----------------------------------------------- */}
      <Cartao tom="acc">
        <div className="mono" style={{ fontSize: 10.5, marginBottom: 8 }}>
          camada secundária
        </div>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>
          Meta semanal e sequência existem — <strong>sem troféu, sem confete e sem linguagem
          infantilizada</strong>. O paciente é um adulto em tratamento. E, mais importante: essa
          camada só entrou depois de a métrica de adesão ser confiável. Uma sequência de doze dias
          calculada sobre um denominador errado dá confiança falsa a uma decisão clínica.
        </p>
      </Cartao>
    </div>
  );
}

/** Item da legenda do heatmap. */
function Legenda({
  cor,
  texto,
  tracejado = false,
}: {
  cor: string;
  texto: string;
  tracejado?: boolean;
}) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--ink2)' }}>
      <span
        aria-hidden="true"
        style={{
          width: 11,
          height: 11,
          borderRadius: 3,
          background: cor,
          border: tracejado ? '1px dashed var(--line2)' : 'none',
        }}
      />
      {texto}
    </span>
  );
}
