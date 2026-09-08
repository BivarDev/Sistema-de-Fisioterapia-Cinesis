/**
 * Prescrição de exercício domiciliar (HEP), em três passos.
 *
 * ## A regra de governança em ação
 *
 * O passo 1 lista **apenas** exercícios publicados. Isso é conveniência — o
 * servidor revalida item a item na criação da prescrição, então mandar o id de
 * um rascunho direto na requisição também é recusado, com 409 e a razão.
 *
 * ## A progressão é campo declarado, não texto livre solto
 *
 * "unipodal na semana 3", "+5 min por semana". Ter a regra declarada é o que
 * permitirá, numa fase futura, o sistema aplicar a progressão sozinho — e é o
 * que já hoje faz a orientação chegar clara ao paciente.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Botao, Cartao, Pill, TituloSecao, EspacoDeMidia } from '@cinesis/ui';
import type { Exercicio } from '@cinesis/shared';
import { buscar, enviar, ErroApi } from '../api.js';
import { Aviso } from './Hoje.js';

/** Parâmetros FITT de um item selecionado. */
interface ItemFitt {
  exercicioId: string;
  nome: string;
  series: number;
  repeticoes: number;
  carga: string;
  frequenciaSemanal: number;
  progressao: string;
}

export function Prescricao() {
  const { id: planoId } = useParams<{ id: string }>();
  const navegar = useNavigate();

  const [passo, setPasso] = useState<1 | 2 | 3>(1);
  const [catalogo, setCatalogo] = useState<Exercicio[]>([]);
  const [itens, setItens] = useState<ItemFitt[]>([]);
  const [metaSemanal, setMetaSemanal] = useState(5);
  const [link, setLink] = useState<{ url: string; garantias: string[] } | null>(null);
  /** Paciente do plano, descoberto ao criar a prescrição. */
  const [pacienteId, setPacienteId] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    // Só os publicados. O servidor confirma na criação.
    buscar<{ exercicios: Exercicio[] }>('/biblioteca?status=published')
      .then((r) => setCatalogo(r.exercicios))
      .catch(() => setErro('Não foi possível carregar a biblioteca.'));
  }, []);

  /** Marca ou desmarca um exercício, com valores FITT padrão razoáveis. */
  function alternar(ex: Exercicio) {
    setItens((atual) => {
      const existe = atual.find((i) => i.exercicioId === ex.id);
      if (existe) return atual.filter((i) => i.exercicioId !== ex.id);

      return [
        ...atual,
        {
          exercicioId: ex.id,
          nome: ex.nome,
          series: 3,
          repeticoes: 12,
          carga: 'peso corporal',
          frequenciaSemanal: 5,
          progressao: '+2 repetições por semana',
        },
      ];
    });
  }

  /** Atualiza um campo FITT de um item. */
  function atualizar(id: string, campo: keyof ItemFitt, valor: string | number) {
    setItens((atual) =>
      atual.map((i) => (i.exercicioId === id ? { ...i, [campo]: valor } : i)),
    );
  }

  /** Cria a prescrição e emite o link mágico. */
  async function concluir() {
    if (!planoId) return;
    setErro(null);
    setEnviando(true);

    try {
      await enviar(`/planos/${planoId}/prescricoes`, {
        metaSemanal,
        itens: itens.map(({ nome: _nome, ...resto }) => resto),
      });

      // Guarda o paciente do plano: o passo 3 precisa dele para emitir o link.
      const dados = await buscar<{ plano: { id: string; pacienteId: string } }>(
        `/planos/${planoId}`,
      );
      setPacienteId(dados.plano.pacienteId);

      setPasso(3);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.mensagem : 'Falha ao criar a prescrição.');
    } finally {
      setEnviando(false);
    }
  }

  /** Emite o link mágico para o paciente. */
  async function emitirLink(pacienteId: string) {
    try {
      const r = await enviar<{ url: string; garantias: string[] }>(
        `/pacientes/${pacienteId}/link-portal`,
      );
      setLink(r);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.mensagem : 'Falha ao emitir o link.');
    }
  }

  if (catalogo.length === 0 && !erro) return <Aviso texto="Carregando catálogo…" />;

  return (
    <div style={{ maxWidth: 980 }}>
      <h1 style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 27, margin: '0 0 4px' }}>
        Prescrição domiciliar
      </h1>
      <p style={{ color: 'var(--ink2)', fontSize: 13.5, margin: '0 0 20px' }}>
        Monte o programa em três passos. A metade do ciclo que acontece fora da clínica.
      </p>

      {/* --- Stepper --------------------------------------------------------- */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 22, flexWrap: 'wrap' }}>
        {[
          { n: 1, t: 'Selecionar exercícios' },
          { n: 2, t: 'Parâmetros FITT' },
          { n: 3, t: 'Enviar ao paciente' },
        ].map((p) => {
          const ativo = passo === p.n;
          return (
            <div
              key={p.n}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 15px',
                borderRadius: 'var(--r-pill)',
                background: ativo ? 'var(--pri)' : 'var(--surface2)',
                color: ativo ? 'var(--pri-ink)' : 'var(--ink2)',
                border: `1px solid ${ativo ? 'var(--pri)' : 'var(--line)'}`,
                fontSize: 12.5,
                fontWeight: 700,
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  background: ativo ? 'var(--pri-ink)' : 'var(--surface3)',
                  color: ativo ? 'var(--pri)' : 'var(--ink2)',
                  fontSize: 11,
                }}
              >
                {p.n}
              </span>
              {p.t}
            </div>
          );
        })}
      </div>

      {erro && (
        <Cartao tom="bad" style={{ marginBottom: 18 }} role="alert">
          <p style={{ margin: 0, fontSize: 13 }}>{erro}</p>
        </Cartao>
      )}

      {/* --- Passo 1 --------------------------------------------------------- */}
      {passo === 1 && (
        <Cartao>
          <TituloSecao
            titulo="Catálogo curado"
            subtitulo="Somente exercícios publicados podem ser prescritos. Rascunho e item em revisão ficam fora por regra de governança — e o servidor recusa mesmo com o id enviado direto."
          />

          <div style={{ display: 'grid', gap: 8 }}>
            {catalogo.map((ex) => {
              const marcado = itens.some((i) => i.exercicioId === ex.id);
              return (
                <button
                  key={ex.id}
                  onClick={() => alternar(ex)}
                  aria-pressed={marcado}
                  style={{
                    display: 'flex',
                    gap: 14,
                    alignItems: 'center',
                    padding: 12,
                    borderRadius: 'var(--r-badge)',
                    border: `1px solid ${marcado ? 'var(--pri)' : 'var(--line)'}`,
                    background: marcado ? 'var(--pri-soft)' : 'var(--surface)',
                    textAlign: 'left',
                    width: '100%',
                  }}
                >
                  <div style={{ width: 56, flexShrink: 0 }}>
                    <EspacoDeMidia legenda="vídeo" altura={44} />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{ex.nome}</div>
                    <div className="mono" style={{ fontSize: 10, marginTop: 3 }}>
                      {ex.status} · {ex.licenca ?? 'sem licença'} ·{' '}
                      {ex.revisor ? 'revisado' : 'sem revisor'} · {ex.categoria} / {ex.regiao}
                    </div>
                  </div>

                  {marcado && <Pill tom="pri">selecionado</Pill>}
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
            <Botao disabled={itens.length === 0} onClick={() => setPasso(2)}>
              Continuar com {itens.length} exercício{itens.length === 1 ? '' : 's'}
            </Botao>
          </div>
        </Cartao>
      )}

      {/* --- Passo 2 --------------------------------------------------------- */}
      {passo === 2 && (
        <Cartao>
          <TituloSecao
            titulo="Parâmetros FITT"
            subtitulo="Frequência, intensidade, tempo e tipo. A regra de progressão é campo declarado, não anotação livre."
          />

          <div className="rolagem-horizontal">
            <div style={{ minWidth: 720 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1.4fr',
                  gap: 10,
                  padding: '0 0 8px',
                }}
              >
                {['Exercício', 'Séries', 'Reps', 'Carga', 'Freq.', 'Progressão'].map((h) => (
                  <span key={h} className="rotulo">
                    {h}
                  </span>
                ))}
              </div>

              {itens.map((item) => (
                <div
                  key={item.exercicioId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1.4fr',
                    gap: 10,
                    padding: '10px 0',
                    borderTop: '1px solid var(--line)',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{item.nome}</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={item.series}
                    onChange={(e) => atualizar(item.exercicioId, 'series', Number(e.target.value))}
                    style={campoPequeno}
                    aria-label={`Séries de ${item.nome}`}
                  />
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={item.repeticoes}
                    onChange={(e) =>
                      atualizar(item.exercicioId, 'repeticoes', Number(e.target.value))
                    }
                    style={campoPequeno}
                    aria-label={`Repetições de ${item.nome}`}
                  />
                  <input
                    value={item.carga}
                    onChange={(e) => atualizar(item.exercicioId, 'carga', e.target.value)}
                    style={campoPequeno}
                    aria-label={`Carga de ${item.nome}`}
                  />
                  <input
                    type="number"
                    min={1}
                    max={14}
                    value={item.frequenciaSemanal}
                    onChange={(e) =>
                      atualizar(item.exercicioId, 'frequenciaSemanal', Number(e.target.value))
                    }
                    style={campoPequeno}
                    aria-label={`Frequência semanal de ${item.nome}`}
                  />
                  <input
                    value={item.progressao}
                    onChange={(e) => atualizar(item.exercicioId, 'progressao', e.target.value)}
                    style={campoPequeno}
                    aria-label={`Progressão de ${item.nome}`}
                  />
                </div>
              ))}
            </div>
          </div>

          <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 20 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>Meta semanal (dias)</span>
            <input
              type="number"
              min={1}
              max={7}
              value={metaSemanal}
              onChange={(e) => setMetaSemanal(Number(e.target.value))}
              style={{ ...campoPequeno, width: 70 }}
            />
            <span className="mono" style={{ fontSize: 10.5 }}>
              é o denominador do cálculo de adesão
            </span>
          </label>

          <div style={{ marginTop: 18, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Botao variante="secundario" onClick={() => setPasso(1)}>
              Voltar
            </Botao>
            <Botao disabled={enviando} onClick={concluir}>
              {enviando ? 'Salvando…' : 'Criar prescrição'}
            </Botao>
          </div>
        </Cartao>
      )}

      {/* --- Passo 3 --------------------------------------------------------- */}
      {passo === 3 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
            gap: 18,
          }}
          className="grade-seguranca"
        >
          <Cartao>
            <TituloSecao
              titulo="Enviar ao paciente"
              subtitulo="Um link leve, que abre no navegador do celular. Sem instalar aplicativo."
            />

            {link ? (
              <>
                <div
                  className="mono"
                  style={{
                    background: 'var(--surface2)',
                    border: '1px solid var(--line)',
                    borderRadius: 'var(--r-badge)',
                    padding: 14,
                    fontSize: 11,
                    wordBreak: 'break-all',
                  }}
                >
                  {link.url}
                </div>

                <ul
                  style={{
                    margin: '14px 0 0',
                    padding: 0,
                    listStyle: 'none',
                    display: 'grid',
                    gap: 6,
                  }}
                >
                  {link.garantias.map((g) => (
                    <li
                      key={g}
                      className="mono"
                      style={{ fontSize: 10.5, display: 'flex', gap: 8 }}
                    >
                      <span style={{ color: 'var(--good)' }}>●</span>
                      {g}
                    </li>
                  ))}
                </ul>

                <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
                  <Botao
                    onClick={() => {
                      void navigator.clipboard.writeText(link.url);
                    }}
                  >
                    Copiar link
                  </Botao>
                  <Botao
                    variante="secundario"
                    onClick={() => navegar(`/app/planos/${planoId}`)}
                  >
                    Voltar ao plano
                  </Botao>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: 'var(--ink2)', lineHeight: 1.6 }}>
                  A prescrição foi criada. Emita o link de acesso ao portal para enviar ao
                  paciente.
                </p>
                <Botao
                  tamanho="grande"
                  disabled={!pacienteId}
                  onClick={() => pacienteId && void emitirLink(pacienteId)}
                >
                  Emitir link do portal
                </Botao>
              </>
            )}

            <p className="mono" style={{ marginTop: 18, fontSize: 10.5, lineHeight: 1.7 }}>
              COFFITO 516/2020 — prescrição remota é acompanhamento à distância: exige consentimento
              informado explícito e registro da conduta fundamentada. O sistema bloqueia a
              prescrição sem esse consentimento.
            </p>
          </Cartao>

          <Cartao tom="pri">
            <div className="mono" style={{ fontSize: 10.5, marginBottom: 10 }}>
              evento ExercisePrescribed
            </div>
            <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.6 }}>
              A criação da prescrição publica um evento de domínio consumido por três destinos:
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.9 }}>
              <li>auditoria — sempre, na mesma transação</li>
              <li>notificações — lembrete ao paciente</li>
              <li>métricas — agregadas e opt-in</li>
            </ul>
          </Cartao>
        </div>
      )}
    </div>
  );
}

/** Estilo dos campos compactos da tabela FITT. */
const campoPequeno: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 'var(--r-badge)',
  border: '1px solid var(--line2)',
  background: 'var(--surface2)',
  color: 'var(--ink)',
  fontSize: 12.5,
  fontFamily: 'inherit',
  width: '100%',
};
