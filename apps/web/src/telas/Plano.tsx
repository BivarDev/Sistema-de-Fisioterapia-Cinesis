/**
 * Tela de plano de tratamento — a mais importante do sistema.
 *
 * ## Propósito
 *
 * O episódio inteiro numa leitura: quem é o paciente, como ele evoluiu, quais
 * testes foram aplicados e o que aconteceu em cada sessão.
 *
 * ## O detalhe que prova a regra
 *
 * A linha do tempo mostra as **versões antigas**. Quando um registro é
 * corrigido, a v1 continua ali, selada e assinada, com a v2 ao lado. O selo
 * "N registros · 0 sobrescritos" é calculado a partir do dado real — não é um
 * literal escrito no frontend. Se algum dia aparecer um número diferente de
 * zero, isso significa que alguém contornou o domínio, e vale que apareça.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Botao,
  Cartao,
  GraficoLongitudinal,
  Pill,
  TituloSecao,
  EspacoDeMidia,
  Revelar,
  type PontoGrafico,
} from '@cinesis/ui';
import { buscar } from '../api.js';
import { Aviso } from './Hoje.js';

/** Um registro na linha do tempo. */
interface RegistroTimeline {
  id: string;
  tipo: string;
  codigo: string;
  eva: number | null;
  conduta: string;
  ocorridoEm: string;
  finalizadoEm: string | null;
  versao: number;
  substituiId: string | null;
  motivoVersao: string | null;
  assinadoPorNome: string | null;
  assinadoPorCrefito: string | null;
}

/** Um teste funcional com seu delta. */
interface TesteComDelta {
  chave: string;
  nome: string;
  versao: string;
  unidade: string;
  fonte: string;
  licenca: string;
  atual: number;
  delta: { valor: number; direcao: 'melhora' | 'piora' | 'estavel'; percentual: number | null } | null;
}

/** Resposta de `GET /api/planos/:id`. */
interface DadosPlano {
  plano: {
    id: string;
    titulo: string;
    diagnostico: string;
    objetivo: string;
    fase: string | null;
    sessoesPrevistas: number;
    reavaliacaoEm: string | null;
  };
  registros: RegistroTimeline[];
  serie: PontoGrafico[];
  tendencia: { tendencia: string; explicacao: string };
  integridade: { total: number; sobrescritos: number };
  testes: TesteComDelta[];
}

export function Plano() {
  const { id } = useParams<{ id: string }>();
  const [dados, setDados] = useState<DadosPlano | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    buscar<DadosPlano>(`/planos/${id}`)
      .then(setDados)
      .catch(() => setErro('Plano não encontrado ou fora do seu escopo.'));
  }, [id]);

  if (erro) return <Aviso texto={erro} />;
  if (!dados) return <Aviso texto="Carregando…" />;

  return (
    <div style={{ maxWidth: 1100 }}>
      {/* --- Cabeçalho do episódio ------------------------------------------ */}
      <Cartao style={{ marginBottom: 22 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 20,
            flexWrap: 'wrap',
            alignItems: 'flex-start',
          }}
        >
          <div>
            <h1
              style={{
                fontFamily: 'var(--fonte-titulo)',
                fontSize: 25,
                margin: 0,
                letterSpacing: '-0.01em',
              }}
            >
              {dados.plano.titulo}
            </h1>
            <div className="mono" style={{ marginTop: 6 }}>
              {dados.plano.diagnostico}
            </div>
            <p
              style={{
                margin: '10px 0 0',
                fontSize: 13,
                color: 'var(--ink2)',
                maxWidth: '62ch',
                lineHeight: 1.6,
              }}
            >
              {dados.plano.objetivo}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <CampoResumo rotulo="Fase" valor={dados.plano.fase ?? '—'} />
            <CampoResumo
              rotulo="Sessões"
              valor={`${dados.registros.filter((r) => r.tipo === 'evolucao').length} de ${dados.plano.sessoesPrevistas}`}
            />
            <CampoResumo rotulo="Reavaliação" valor={dados.plano.reavaliacaoEm ?? '—'} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
          <Link to={`/app/planos/${dados.plano.id}/avaliacao`}>
            <Botao>Registrar evolução</Botao>
          </Link>
          <Link to={`/app/planos/${dados.plano.id}/prescricao`}>
            <Botao variante="secundario">Prescrever exercício domiciliar</Botao>
          </Link>
        </div>
      </Cartao>

      {/* --- Comparação longitudinal ---------------------------------------- */}
      <Cartao style={{ marginBottom: 22 }}>
        <TituloSecao
          titulo="Comparação longitudinal"
          subtitulo={dados.tendencia.explicacao}
        />
        <GraficoLongitudinal serie={dados.serie} />
      </Cartao>

      {/* --- Testes funcionais ---------------------------------------------- */}
      {dados.testes.length > 0 && (
        <Cartao style={{ marginBottom: 22 }}>
          <TituloSecao
            titulo="Testes funcionais"
            subtitulo="Cada teste traz versão, unidade, fonte bibliográfica e licença. A definição é dado no banco — incorporar um teste novo não exige mexer no código."
          />

          <div className="rolagem-horizontal">
            <div style={{ display: 'grid', gap: 1, background: 'var(--line)', minWidth: 520 }}>
              {dados.testes.map((t) => (
                <div
                  key={t.chave}
                  style={{
                    background: 'var(--surface)',
                    padding: '14px 16px',
                    display: 'grid',
                    gridTemplateColumns: '1.7fr 0.7fr 1.6fr',
                    gap: 14,
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.nome}</div>
                    <div className="mono" style={{ fontSize: 10, marginTop: 3 }}>
                      {t.versao} · {t.unidade} · {t.fonte} · {t.licenca}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 26, lineHeight: 1 }}>
                      {t.atual}
                    </div>
                    {/*
                      A unidade vai numa LINHA PRÓPRIA, não colada ao número.
                      Várias escalas descrevem a unidade como faixa ("0–10"), e
                      juntar as duas coisas produzia "20–10" para o valor 2 —
                      um número clínico ilegível, que é o pior tipo de bug de
                      interface num prontuário.
                    */}
                    <div className="mono" style={{ fontSize: 10, marginTop: 4 }}>
                      {t.unidade}
                    </div>
                  </div>

                  <div>
                    {t.delta ? (
                      // A cor sai da DIREÇÃO, não do sinal do número. Numa escala
                      // invertida como a Oswestry, "+15" é piora — e aparece em
                      // vermelho, como deve.
                      <Pill
                        tom={
                          t.delta.direcao === 'melhora'
                            ? 'good'
                            : t.delta.direcao === 'piora'
                              ? 'bad'
                              : 'ink'
                        }
                      >
                        {t.delta.valor > 0 ? '+' : ''}
                        {t.delta.valor} · {t.delta.direcao}
                      </Pill>
                    ) : (
                      <span className="mono">primeira aplicação</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Cartao>
      )}

      {/* --- Mapa de dor ---------------------------------------------------- */}
      <Cartao style={{ marginBottom: 22 }}>
        <TituloSecao
          titulo="Mapa de dor"
          subtitulo="Silhueta corporal com regiões nomeadas e clicáveis. Precisa de SVG próprio — conteúdo pendente."
        />
        <EspacoDeMidia
          legenda="silhueta corporal (frente e costas) — SVG com regiões nomeadas"
          altura={210}
        />
      </Cartao>

      {/* --- Linha do tempo ------------------------------------------------- */}
      <Cartao>
        <TituloSecao
          titulo="Linha do tempo do episódio"
          subtitulo="Cada registro finalizado é imutável. Correções criam nova versão; a anterior permanece."
          acao={
            <Pill tom={dados.integridade.sobrescritos === 0 ? 'good' : 'bad'}>
              {dados.integridade.total} registros · {dados.integridade.sobrescritos} sobrescritos
            </Pill>
          }
        />

        <div style={{ display: 'grid', gap: 2 }}>
          {dados.registros.map((r, i) => (
            <Revelar key={r.id} atraso={i * 55}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '132px 1fr',
                  gap: 16,
                  padding: '16px 0',
                  borderBottom: '1px solid var(--line)',
                }}
                className="linha-timeline"
              >
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      color:
                        r.tipo === 'avaliacao'
                          ? 'var(--pri)'
                          : r.tipo === 'reavaliacao'
                            ? 'var(--acc)'
                            : 'var(--ink2)',
                      textTransform: 'capitalize',
                    }}
                  >
                    {r.tipo}
                    {r.versao > 1 ? ` · v${r.versao}` : ''}
                  </div>
                  <div className="mono" style={{ fontSize: 10, marginTop: 3 }}>
                    {new Date(r.ocorridoEm).toLocaleDateString('pt-BR')}
                  </div>
                </div>

                <div style={{ borderLeft: '2px solid var(--line)', paddingLeft: 16 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                    {r.codigo}
                    {r.eva !== null && (
                      <span className="mono" style={{ marginLeft: 8, fontSize: 11 }}>
                        EVA {r.eva}
                      </span>
                    )}
                  </div>

                  <p
                    style={{
                      margin: '6px 0 0',
                      fontSize: 13,
                      color: 'var(--ink2)',
                      lineHeight: 1.6,
                    }}
                  >
                    {r.conduta}
                  </p>

                  {/* O motivo da correção fica visível: é o que torna a
                      versão nova auditável por quem lê o prontuário depois. */}
                  {r.motivoVersao && (
                    <p
                      style={{
                        margin: '8px 0 0',
                        fontSize: 12.5,
                        color: 'var(--acc-on-soft)',
                        background: 'var(--acc-soft)',
                        padding: '8px 11px',
                        borderRadius: 'var(--r-badge)',
                      }}
                    >
                      Motivo da correção: {r.motivoVersao}
                    </p>
                  )}

                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <Pill tom={r.finalizadoEm ? 'good' : 'acc'}>
                      {r.finalizadoEm ? 'Finalizado · imutável' : 'Rascunho · editável'}
                    </Pill>
                    {r.substituiId && <Pill tom="ink">v{r.versao - 1} preservada</Pill>}
                    {r.assinadoPorNome && (
                      <span className="mono" style={{ fontSize: 10, alignSelf: 'center' }}>
                        {r.assinadoPorNome}
                        {r.assinadoPorCrefito ? ` · ${r.assinadoPorCrefito}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Revelar>
          ))}
        </div>
      </Cartao>
    </div>
  );
}

/** Um campo de resumo no cabeçalho do plano. */
function CampoResumo({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <div className="rotulo">{rotulo}</div>
      <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 4 }}>{valor}</div>
    </div>
  );
}
