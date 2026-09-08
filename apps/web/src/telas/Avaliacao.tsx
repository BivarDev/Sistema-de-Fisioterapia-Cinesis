/**
 * Tela de registro de evolução — onde a sessão vira prontuário.
 *
 * ## O momento mais importante do sistema
 *
 * Finalizar e assinar. Antes disso o registro é rascunho e pode ser corrigido
 * à vontade; depois, ele é imutável e qualquer correção vira uma versão nova.
 * A interface deixa isso explícito **antes** do clique, com a faixa de aviso e
 * a menção à COFFITO 415/2012 — não depois, num erro.
 *
 * ## Os testes funcionais não são campos fixos
 *
 * O formulário é montado a partir de `GET /api/avaliacao-definicoes`. Cadastrar
 * o WOMAC no banco faz ele aparecer aqui, com os campos, a faixa de valores e a
 * interpretação certos, sem tocar neste arquivo.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Botao, Cartao, Pill, TituloSecao, EspacoDeMidia } from '@cinesis/ui';
import type { DefinicaoTeste } from '@cinesis/shared';
import { buscar, enviar, ErroApi } from '../api.js';
import { Aviso } from './Hoje.js';
import { usarSessao } from '../sessao.js';

/** Rótulos da escala EVA, por faixa. */
function rotuloEva(valor: number): string {
  if (valor === 0) return 'Sem dor';
  if (valor <= 3) return 'Dor leve';
  if (valor <= 6) return 'Dor moderada';
  if (valor <= 9) return 'Dor intensa';
  return 'Pior dor imaginável';
}

/** Cor da EVA, pela mesma faixa da definição clínica. */
function tomEva(valor: number): string {
  if (valor <= 3) return 'var(--good)';
  if (valor <= 6) return 'var(--acc)';
  return 'var(--bad)';
}

export function Avaliacao() {
  const { id: planoId } = useParams<{ id: string }>();
  const navegar = useNavigate();
  const { podeTotal, profissional } = usarSessao();

  const [definicoes, setDefinicoes] = useState<DefinicaoTeste[]>([]);
  const [eva, setEva] = useState(5);
  const [conduta, setConduta] = useState('');
  const [resposta, setResposta] = useState('');
  /** Valores dos testes: `chave da definição` → `chave do campo` → valor. */
  const [valores, setValores] = useState<Record<string, Record<string, number>>>({});
  /** Quais testes o profissional escolheu aplicar nesta sessão. */
  const [aplicando, setAplicando] = useState<Set<string>>(new Set());

  const [registroId, setRegistroId] = useState<string | null>(null);
  const [selado, setSelado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    buscar<{ definicoes: DefinicaoTeste[] }>('/avaliacao-definicoes')
      .then((r) => setDefinicoes(r.definicoes))
      .catch(() => setErro('Não foi possível carregar o catálogo de testes.'));
  }, []);

  /** Monta a lista de testes aplicados, no formato que a API espera. */
  function testesParaEnviar() {
    return [...aplicando].map((chave) => ({
      definicaoChave: chave,
      // Só os valores brutos. O escore é calculado no SERVIDOR — aceitar o
      // escore do cliente permitiria escrever o resultado clínico desejado.
      valores: valores[chave] ?? {},
    }));
  }

  /** Salva como rascunho. Ainda editável. */
  async function salvarRascunho() {
    if (!planoId) return;
    setErro(null);
    setEnviando(true);

    try {
      const r = await enviar<{ id: string; codigo: string }>(`/planos/${planoId}/evolucoes`, {
        ocorridoEm: new Date().toISOString(),
        eva,
        conduta,
        resposta,
        testes: testesParaEnviar(),
      });
      setRegistroId(r.id);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.mensagem : 'Falha ao salvar.');
    } finally {
      setEnviando(false);
    }
  }

  /** Finaliza e assina. **A partir daqui o registro é imutável.** */
  async function finalizar() {
    if (!planoId) return;
    setErro(null);
    setEnviando(true);

    try {
      // Cria o rascunho se ainda não existir, para que "preencher e assinar"
      // seja um clique só no fluxo normal.
      let alvo = registroId;
      if (!alvo) {
        const r = await enviar<{ id: string }>(`/planos/${planoId}/evolucoes`, {
          ocorridoEm: new Date().toISOString(),
          eva,
          conduta,
          resposta,
          testes: testesParaEnviar(),
        });
        alvo = r.id;
        setRegistroId(alvo);
      }

      await enviar(`/evolucoes/${alvo}/finalizar`);
      setSelado(true);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.mensagem : 'Falha ao finalizar.');
    } finally {
      setEnviando(false);
    }
  }

  if (erro && definicoes.length === 0) return <Aviso texto={erro} />;

  return (
    <div style={{ maxWidth: 880 }}>
      <h1 style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 27, margin: '0 0 4px' }}>
        Registrar evolução
      </h1>
      <p style={{ color: 'var(--ink2)', fontSize: 13.5, margin: '0 0 22px' }}>
        Preencha durante o atendimento e assine ao final. Assinar é um ato deliberado, não um
        efeito colateral de salvar.
      </p>

      {/* --- Faixa de "selado" ---------------------------------------------- */}
      {selado && (
        <Cartao tom="good" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <Pill tom="good">Selado</Pill>
            <p style={{ margin: 0, fontSize: 13.5, flex: 1, minWidth: 240 }}>
              Evolução finalizada e assinada. O registro é <strong>imutável</strong> — COFFITO
              415/2012. Uma correção cria a versão 2 e preserva esta.
            </p>
            <Botao
              variante="secundario"
              onClick={() => navegar(`/app/planos/${planoId}`)}
            >
              Voltar ao plano
            </Botao>
          </div>
        </Cartao>
      )}

      {/* --- Escala EVA ------------------------------------------------------ */}
      <Cartao style={{ marginBottom: 18 }}>
        <TituloSecao titulo="Dor nesta sessão (EVA)" />

        <div
          role="radiogroup"
          aria-label="Escala visual analógica de dor, de 0 a 10"
          style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}
        >
          {Array.from({ length: 11 }, (_, n) => {
            const ativo = eva === n;
            return (
              <button
                key={n}
                role="radio"
                aria-checked={ativo}
                disabled={selado}
                onClick={() => setEva(n)}
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 'var(--r-botao)',
                  border: `1px solid ${ativo ? tomEva(n) : 'var(--line)'}`,
                  background: ativo ? tomEva(n) : 'var(--surface2)',
                  color: ativo ? 'var(--surface)' : 'var(--ink2)',
                  fontSize: 14,
                  fontWeight: 700,
                  transition: 'transform var(--dur-rapida) var(--ease)',
                }}
                onMouseEnter={(e) => {
                  if (!selado) e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = '';
                }}
              >
                {n}
              </button>
            );
          })}

          {/* O rótulo textual acompanha o número: cor sozinha não comunica. */}
          <span style={{ marginLeft: 10, fontSize: 13.5, fontWeight: 700, color: tomEva(eva) }}>
            {rotuloEva(eva)}
          </span>
        </div>
      </Cartao>

      {/* --- Conduta e resposta ---------------------------------------------- */}
      <Cartao style={{ marginBottom: 18 }}>
        <div style={{ display: 'grid', gap: 16 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>Conduta realizada</span>
            <textarea
              rows={4}
              value={conduta}
              onChange={(e) => setConduta(e.target.value)}
              disabled={selado}
              style={areaTexto}
            />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>
              Resposta do paciente / intercorrências
            </span>
            <textarea
              rows={4}
              value={resposta}
              onChange={(e) => setResposta(e.target.value)}
              disabled={selado}
              style={areaTexto}
            />
          </label>
        </div>
      </Cartao>

      {/* --- Testes funcionais ----------------------------------------------- */}
      <Cartao style={{ marginBottom: 18 }}>
        <TituloSecao
          titulo="Testes funcionais"
          subtitulo="O catálogo vem do banco. O escore e a interpretação são calculados no servidor a partir dos valores brutos."
        />

        <div style={{ display: 'grid', gap: 14 }}>
          {definicoes.map((d) => {
            const marcado = aplicando.has(d.chave);

            return (
              <div
                key={d.chave}
                style={{
                  border: `1px solid ${marcado ? 'var(--pri)' : 'var(--line)'}`,
                  borderRadius: 'var(--r-badge)',
                  padding: 14,
                  background: marcado ? 'var(--pri-soft)' : 'var(--surface)',
                }}
              >
                <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={marcado}
                    disabled={selado}
                    onChange={(e) => {
                      const novo = new Set(aplicando);
                      if (e.target.checked) novo.add(d.chave);
                      else novo.delete(d.chave);
                      setAplicando(novo);
                    }}
                    style={{ marginTop: 3 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{d.nome}</div>
                    {/* Procedência sempre visível: versão, unidade, fonte e licença. */}
                    <div className="mono" style={{ fontSize: 10, marginTop: 3 }}>
                      {d.versao} · {d.categoria} · {d.unidade} · {d.fonte} · {d.licenca}
                    </div>
                  </div>
                </label>

                {marcado && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                      gap: 10,
                      marginTop: 14,
                    }}
                  >
                    {d.campos.map((campo) => (
                      <label key={campo.chave} style={{ display: 'grid', gap: 4 }}>
                        <span className="mono" style={{ fontSize: 10 }}>
                          {campo.rotulo} ({campo.min}–{campo.max})
                        </span>
                        <input
                          type="number"
                          min={campo.min}
                          max={campo.max}
                          disabled={selado}
                          value={valores[d.chave]?.[campo.chave] ?? ''}
                          onChange={(e) =>
                            setValores((v) => ({
                              ...v,
                              [d.chave]: {
                                ...(v[d.chave] ?? {}),
                                [campo.chave]: Number(e.target.value),
                              },
                            }))
                          }
                          style={{ ...areaTexto, minHeight: 38, padding: '8px 10px' }}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Cartao>

      {/* --- Mídia ------------------------------------------------------------ */}
      <Cartao style={{ marginBottom: 18 }}>
        <TituloSecao
          titulo="Anexos"
          subtitulo="Foto de avaliação postural e vídeo de movimento. O acesso a estes arquivos é auditado, e os metadados EXIF são removidos no envio."
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 12,
          }}
        >
          <EspacoDeMidia legenda="foto de avaliação postural — acesso auditado" />
          <EspacoDeMidia legenda="vídeo de movimento — acesso auditado" />
        </div>
      </Cartao>

      {/* --- Erro ------------------------------------------------------------- */}
      {erro && (
        <Cartao tom="bad" style={{ marginBottom: 18 }} role="alert">
          <p style={{ margin: 0, fontSize: 13 }}>{erro}</p>
        </Cartao>
      )}

      {/* --- Rodapé de assinatura --------------------------------------------- */}
      <Cartao>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{profissional?.nome}</div>
            <div className="mono" style={{ fontSize: 10.5 }}>
              {profissional?.crefito ?? 'sem CREFITO cadastrado — não é possível assinar'}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <Botao variante="secundario" disabled={selado || enviando} onClick={salvarRascunho}>
              Salvar rascunho
            </Botao>
            <Botao
              // Estagiário tem `prontuario:escrever` restrito, mas
              // `prontuario:finalizar` negado — o botão nem aparece habilitado.
              // O servidor recusa de qualquer forma.
              disabled={selado || enviando || !podeTotal('prontuario:finalizar')}
              onClick={finalizar}
            >
              {enviando ? 'Salvando…' : 'Finalizar e assinar'}
            </Botao>
          </div>
        </div>

        {!podeTotal('prontuario:finalizar') && (
          <p className="mono" style={{ marginTop: 12, fontSize: 10.5 }}>
            Seu papel pode registrar a evolução, mas não assiná-la — a assinatura carrega o CREFITO
            de um profissional habilitado.
          </p>
        )}
      </Cartao>
    </div>
  );
}

/** Estilo compartilhado dos campos de texto. */
const areaTexto: React.CSSProperties = {
  padding: '11px 14px',
  borderRadius: 'var(--r-botao)',
  border: '1px solid var(--line2)',
  background: 'var(--surface2)',
  color: 'var(--ink)',
  fontSize: 13.5,
  fontFamily: 'inherit',
  resize: 'vertical',
};
