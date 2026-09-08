/**
 * Biblioteca de exercícios.
 *
 * ## Governança visível
 *
 * O fluxo `draft → in_review → published` aparece no cabeçalho, e cada cartão
 * mostra autor, revisor e licença. O rascunho sem licença traz o aviso de que
 * a publicação está bloqueada — e o botão de publicar dele falha com a razão,
 * porque a regra vive no servidor.
 *
 * Isso é deliberado: a biblioteca é conteúdo redistribuído por um projeto de
 * código aberto. Item sem licença conhecida é passivo para todo mundo que
 * instalar o sistema, não só para quem o escreveu.
 */

import { useEffect, useState } from 'react';
import { Botao, Cartao, EspacoDeMidia, Pill, Revelar, TituloSecao } from '@cinesis/ui';
import type { Exercicio, StatusExercicio } from '@cinesis/shared';
import { buscar, enviar, ErroApi } from '../api.js';
import { Aviso } from './Hoje.js';
import { usarSessao } from '../sessao.js';

/** As quatro perguntas em aberto antes de abrir à comunidade. */
const DECISOES = [
  {
    pergunta: 'Quem pode publicar?',
    situacao:
      'Hoje: qualquer profissional com a permissão, desde que não seja o autor. Para contribuição externa, falta definir um papel de revisor.',
  },
  {
    pergunta: 'Como versionar sem invalidar prescrição ativa?',
    situacao:
      'Resolvido: a prescrição guarda a versão usada. Editar publica uma versão nova; a anterior permanece legível para quem já a recebeu.',
  },
  {
    pergunta: 'Onde a mídia é armazenada?',
    situacao:
      'Hoje: disco local do operador, servido por rota autenticada e auditada. Falta decidir o caminho para instalação com múltiplos nós.',
  },
  {
    pergunta: 'Como a licença é verificada?',
    situacao:
      'Hoje: campo declarado pelo autor, bloqueante para publicação. A verificação da veracidade continua sendo humana.',
  },
];

/** Rótulo e tom de cada estado de publicação. */
const ESTADO: Record<StatusExercicio, { rotulo: string; tom: 'good' | 'acc' | 'ink' }> = {
  published: { rotulo: 'Publicado', tom: 'good' },
  in_review: { rotulo: 'Em revisão', tom: 'acc' },
  draft: { rotulo: 'Rascunho', tom: 'ink' },
};

export function Biblioteca() {
  const { podeTotal } = usarSessao();
  const [aba, setAba] = useState<StatusExercicio>('published');
  const [todos, setTodos] = useState<Exercicio[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);

  /** Recarrega o catálogo inteiro (as três abas de uma vez). */
  function carregar() {
    buscar<{ exercicios: Exercicio[] }>('/biblioteca')
      .then((r) => setTodos(r.exercicios))
      .catch(() => setErro('Não foi possível carregar a biblioteca.'));
  }

  useEffect(carregar, []);

  /** Move um exercício no fluxo de publicação. */
  async function mover(id: string, status: StatusExercicio) {
    setErro(null);
    setMensagem(null);

    try {
      await enviar(`/biblioteca/${id}/publicar`, { status });
      setMensagem(`Exercício movido para "${ESTADO[status].rotulo}".`);
      carregar();
    } catch (e) {
      // A mensagem do servidor é específica: licença ausente, revisor igual ao
      // autor, transição inválida. Exibi-la crua é melhor que traduzir para um
      // "não foi possível" genérico.
      setErro(e instanceof ErroApi ? e.mensagem : 'Falha ao alterar o estado.');
    }
  }

  if (erro && todos.length === 0) return <Aviso texto={erro} />;

  const visiveis = todos.filter((e) => e.status === aba);
  const contagem = (s: StatusExercicio) => todos.filter((e) => e.status === s).length;

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 27, margin: '0 0 4px' }}>
        Biblioteca de exercícios
      </h1>
      <p style={{ color: 'var(--ink2)', fontSize: 13.5, margin: '0 0 20px' }}>
        Curar o catálogo com governança clínica.
      </p>

      {/* --- Abas ------------------------------------------------------------ */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 16,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          {(['published', 'in_review', 'draft'] as StatusExercicio[]).map((s) => {
            const ativo = aba === s;
            return (
              <button
                key={s}
                onClick={() => setAba(s)}
                aria-pressed={ativo}
                style={{
                  padding: '7px 14px',
                  borderRadius: 'var(--r-botao)',
                  border: `1px solid ${ativo ? 'var(--ink)' : 'var(--line2)'}`,
                  background: ativo ? 'var(--ink)' : 'var(--surface)',
                  color: ativo ? 'var(--bg)' : 'var(--ink2)',
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              >
                {ESTADO[s].rotulo} · {contagem(s)}
              </button>
            );
          })}
        </div>

        <span className="mono" style={{ fontSize: 10.5 }}>
          draft → in_review → published
        </span>
      </div>

      {mensagem && (
        <Cartao tom="good" style={{ marginBottom: 14, padding: 12 }} role="status">
          <p style={{ margin: 0, fontSize: 13 }}>{mensagem}</p>
        </Cartao>
      )}
      {erro && (
        <Cartao tom="bad" style={{ marginBottom: 14, padding: 12 }} role="alert">
          <p style={{ margin: 0, fontSize: 13 }}>{erro}</p>
        </Cartao>
      )}

      {/* --- Grade de cartões ------------------------------------------------ */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 16,
          marginBottom: 24,
        }}
      >
        {visiveis.map((ex, i) => (
          <Revelar key={ex.id} atraso={i * 55}>
            <Cartao interativo style={{ height: '100%', padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: 12 }}>
                <EspacoDeMidia legenda={`vídeo demonstrativo — ${ex.nome}`} altura={128} />
              </div>

              <div style={{ padding: '0 16px 16px' }}>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    marginBottom: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <Pill tom={ESTADO[ex.status].tom}>{ESTADO[ex.status].rotulo}</Pill>
                  <span className="mono" style={{ fontSize: 10 }}>
                    v{ex.versao}
                  </span>
                </div>

                <h3 style={{ margin: '0 0 4px', fontSize: 14.5, fontWeight: 800 }}>{ex.nome}</h3>
                <div className="mono" style={{ fontSize: 10 }}>
                  {ex.categoria} · {ex.regiao}
                </div>

                <p
                  style={{
                    margin: '10px 0 0',
                    fontSize: 12.5,
                    color: 'var(--ink2)',
                    lineHeight: 1.55,
                  }}
                >
                  {ex.orientacao}
                </p>

                <div
                  style={{
                    marginTop: 14,
                    paddingTop: 12,
                    borderTop: '1px solid var(--line)',
                  }}
                >
                  <div className="mono" style={{ fontSize: 10, lineHeight: 1.8 }}>
                    autor: {ex.autor || '—'}
                    <br />
                    revisor: {ex.revisor ?? '—'}
                    <br />
                    licença:{' '}
                    {ex.licenca ?? (
                      // O caso que a especificação pede para ser visível.
                      <span style={{ color: 'var(--acc)' }}>
                        pendente — bloqueia publicação
                      </span>
                    )}
                  </div>

                  {/* Ações de transição, só para quem pode publicar. */}
                  {podeTotal('biblioteca:publicar') && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                      {ex.status === 'draft' && (
                        <Botao
                          tamanho="pequeno"
                          variante="secundario"
                          onClick={() => void mover(ex.id, 'in_review')}
                        >
                          Enviar para revisão
                        </Botao>
                      )}
                      {ex.status === 'in_review' && (
                        <>
                          <Botao tamanho="pequeno" onClick={() => void mover(ex.id, 'published')}>
                            Publicar
                          </Botao>
                          <Botao
                            tamanho="pequeno"
                            variante="secundario"
                            onClick={() => void mover(ex.id, 'draft')}
                          >
                            Devolver
                          </Botao>
                        </>
                      )}
                      {ex.status === 'published' && (
                        <Botao
                          tamanho="pequeno"
                          variante="secundario"
                          onClick={() => void mover(ex.id, 'draft')}
                        >
                          Despublicar
                        </Botao>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </Cartao>
          </Revelar>
        ))}
      </div>

      {visiveis.length === 0 && (
        <p style={{ color: 'var(--ink3)', fontSize: 13 }}>
          Nenhum exercício em &quot;{ESTADO[aba].rotulo}&quot;.
        </p>
      )}

      {/* --- Decisões pendentes ---------------------------------------------- */}
      <Cartao tom="acc">
        <TituloSecao
          titulo="Antes de abrir para a comunidade"
          subtitulo="Quatro perguntas que precisam de resposta antes de aceitar contribuição externa. Três já têm encaminhamento; a primeira ainda não."
        />
        <div style={{ display: 'grid', gap: 12 }}>
          {DECISOES.map((d) => (
            <div key={d.pergunta}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{d.pergunta}</div>
              <p style={{ margin: '3px 0 0', fontSize: 12.5, lineHeight: 1.55 }}>{d.situacao}</p>
            </div>
          ))}
        </div>
      </Cartao>
    </div>
  );
}
