/**
 * Tela de segurança e auditoria.
 *
 * ## Propósito
 *
 * Tornar a fundação de segurança **visível e verificável pelo operador** — que
 * é quem responde como controlador dos dados perante a LGPD. Ele precisa poder
 * demonstrar, sem ler código, que o sistema faz o que promete.
 *
 * Daí os três blocos: a matriz RBAC que o backend realmente usa, a verificação
 * de integridade da cadeia de auditoria (calculada na hora, não um selo
 * estático) e a trilha em si.
 */

import { useEffect, useState } from 'react';
import { Botao, Cartao, Pill, TituloSecao } from '@cinesis/ui';
import { PAPEIS, PERMISSOES, ROTULO_PAPEL, type Nivel, type Papel } from '@cinesis/shared';
import { buscar, remover } from '../api.js';
import { Aviso } from './Hoje.js';

/** Um evento da trilha. */
interface EventoAuditoria {
  id: string;
  sequencia: number;
  ocorridoEm: string;
  atorPapel: string;
  acao: string;
  entidade: string;
  entidadeId: string;
  detalhe: string | null;
  hash: string;
}

/** Uma sessão ativa do profissional. */
interface SessaoAtiva {
  referencia: string;
  atual: boolean;
  criadaEm: string;
  usadaEm: string;
  dispositivo: string;
  chave: string;
}

/** Resultado da verificação de integridade. */
interface Integridade {
  integra: boolean;
  conferidos: number;
  quebraEm: number | null;
  motivo: string | null;
  ancora: { sequencia: number; hash: string; geradaEm: string } | null;
}

/** Cor da etiqueta por família de ação. */
function tomDaAcao(acao: string): 'good' | 'acc' | 'bad' | 'pri' | 'ink' {
  if (acao.includes('NEGADA') || acao.includes('FORA_DE_ESCOPO') || acao.includes('RECUSADO'))
    return 'bad';
  if (acao.includes('REIDENTIFICACAO')) return 'acc';
  if (acao.includes('FINALIZADA') || acao.includes('SUCESSO')) return 'good';
  if (acao.includes('LEITURA')) return 'ink';
  return 'pri';
}

export function Seguranca() {
  const [matriz, setMatriz] = useState<Record<Papel, Record<string, Nivel>> | null>(null);
  const [eventos, setEventos] = useState<EventoAuditoria[]>([]);
  const [sessoes, setSessoes] = useState<SessaoAtiva[]>([]);
  const [integridade, setIntegridade] = useState<Integridade | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  /** Carrega tudo em paralelo. */
  function carregar() {
    void buscar<{ matriz: Record<Papel, Record<string, Nivel>> }>('/rbac')
      .then((r) => setMatriz(r.matriz))
      .catch(() => setErro('Não foi possível carregar a matriz RBAC.'));

    void buscar<{ eventos: EventoAuditoria[] }>('/auditoria?limite=25')
      .then((r) => setEventos(r.eventos))
      .catch(() => undefined);

    void buscar<{ sessoes: SessaoAtiva[] }>('/sessoes')
      .then((r) => setSessoes(r.sessoes))
      .catch(() => undefined);

    void buscar<Integridade>('/auditoria/integridade')
      .then(setIntegridade)
      .catch(() => undefined);
  }

  useEffect(carregar, []);

  if (erro) return <Aviso texto={erro} />;

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 27, margin: '0 0 4px' }}>
        Segurança e auditoria
      </h1>
      <p style={{ color: 'var(--ink2)', fontSize: 13.5, margin: '0 0 22px' }}>
        Quem instala e opera este sistema é o controlador dos dados dos próprios pacientes. Esta
        tela existe para que essa responsabilidade seja verificável, não apenas declarada.
      </p>

      {/* --- Integridade da cadeia -------------------------------------------- */}
      {integridade && (
        <Cartao tom={integridade.integra ? 'good' : 'bad'} style={{ marginBottom: 20 }}>
          <div
            style={{
              display: 'flex',
              gap: 16,
              alignItems: 'center',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
                <Pill tom={integridade.integra ? 'good' : 'bad'}>
                  {integridade.integra ? 'Cadeia íntegra' : 'Cadeia comprometida'}
                </Pill>
                <span className="mono" style={{ fontSize: 10.5 }}>
                  {integridade.conferidos} eventos conferidos
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, maxWidth: '58ch' }}>
                {integridade.integra
                  ? 'Cada evento tem o hash do anterior. Alterar ou remover qualquer um quebraria a cadeia a partir dali — e esta verificação recalcula tudo, agora.'
                  : `Quebra detectada na sequência ${integridade.quebraEm} (${integridade.motivo}). Isto indica alteração feita por fora da aplicação.`}
              </p>
            </div>
            <Botao variante="secundario" onClick={carregar}>
              Verificar de novo
            </Botao>
          </div>

          {integridade.ancora && (
            <div
              style={{
                marginTop: 14,
                paddingTop: 14,
                borderTop: '1px solid var(--line)',
              }}
            >
              <div className="rotulo">Âncora para publicação externa</div>
              <div className="mono" style={{ fontSize: 10.5, marginTop: 6, wordBreak: 'break-all' }}>
                seq {integridade.ancora.sequencia} · {integridade.ancora.hash}
              </div>
              <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--ink2)', lineHeight: 1.6 }}>
                Publique este valor fora do banco — e-mail diário ao responsável, armazenamento
                imutável, ou um repositório separado. Sem uma cópia externa da ponta da cadeia, quem
                tem acesso total ao banco pode reescrever tudo e o hash final continuará consistente
                consigo mesmo.
              </p>
            </div>
          )}
        </Cartao>
      )}

      {/* --- Matriz RBAC ------------------------------------------------------ */}
      {matriz && (
        <Cartao style={{ marginBottom: 20 }}>
          <TituloSecao
            titulo="Matriz de permissões"
            subtitulo="Esta é a mesma constante que o servidor usa para decidir — não uma cópia mantida à mão. Sem acesso responde 404, nunca 403."
          />

          <div className="rolagem-horizontal">
            <table
              style={{
                width: '100%',
                minWidth: 620,
                borderCollapse: 'collapse',
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--line)' }}
                  >
                    <span className="rotulo">Permissão</span>
                  </th>
                  {PAPEIS.map((p) => (
                    <th
                      key={p}
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid var(--line)',
                        textAlign: 'center',
                      }}
                    >
                      <span className="rotulo">{ROTULO_PAPEL[p]}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSOES.map((perm) => (
                  <tr key={perm}>
                    <td
                      className="mono"
                      style={{ padding: '7px 10px', borderBottom: '1px solid var(--line)' }}
                    >
                      {perm}
                    </td>
                    {PAPEIS.map((papel) => {
                      const nivel = matriz[papel]?.[perm] ?? 'negado';
                      return (
                        <td
                          key={papel}
                          style={{
                            padding: '7px 10px',
                            borderBottom: '1px solid var(--line)',
                            textAlign: 'center',
                          }}
                          // O símbolo sozinho não basta: o `title` diz o que ele
                          // significa, e o `aria-label` faz o leitor de tela ler.
                          title={
                            nivel === 'total'
                              ? 'acesso total'
                              : nivel === 'restrito'
                                ? 'restrito ao escopo supervisionado'
                                : 'sem acesso — responde 404'
                          }
                          aria-label={nivel}
                        >
                          <span
                            style={{
                              color:
                                nivel === 'total'
                                  ? 'var(--good)'
                                  : nivel === 'restrito'
                                    ? 'var(--acc)'
                                    : 'var(--ink3)',
                              fontSize: 14,
                            }}
                          >
                            {nivel === 'total' ? '●' : nivel === 'restrito' ? '◐' : '—'}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 18, marginTop: 14, fontSize: 11.5, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--ink2)' }}>
              <span style={{ color: 'var(--good)' }}>●</span> acesso total
            </span>
            <span style={{ color: 'var(--ink2)' }}>
              <span style={{ color: 'var(--acc)' }}>◐</span> restrito ao escopo supervisionado
            </span>
            <span style={{ color: 'var(--ink2)' }}>
              <span style={{ color: 'var(--ink3)' }}>—</span> sem acesso — responde 404, não 403
            </span>
          </div>
        </Cartao>
      )}

      {/* --- Sessões ativas ---------------------------------------------------- */}
      <Cartao style={{ marginBottom: 20 }}>
        <TituloSecao
          titulo="Sessões ativas"
          subtitulo="Sessão opaca revogável. O servidor guarda o HMAC do token, nunca o token. IP nunca em claro."
        />

        <div style={{ display: 'grid', gap: 1, background: 'var(--line)' }}>
          {sessoes.map((s) => (
            <div
              key={s.chave}
              style={{
                background: 'var(--surface)',
                padding: '12px 4px',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="mono" style={{ fontSize: 11 }}>
                  sess:{s.referencia}… · dispositivo {s.dispositivo}
                </div>
                <div className="mono" style={{ fontSize: 10, marginTop: 3 }}>
                  aberta em {new Date(s.criadaEm).toLocaleString('pt-BR')} · usada{' '}
                  {new Date(s.usadaEm).toLocaleTimeString('pt-BR')}
                </div>
              </div>

              {s.atual ? (
                <Pill tom="good">esta sessão</Pill>
              ) : (
                <Botao
                  tamanho="pequeno"
                  variante="perigo"
                  onClick={() => {
                    void remover(`/sessoes/${encodeURIComponent(s.chave)}`).then(carregar);
                  }}
                >
                  Revogar
                </Botao>
              )}
            </div>
          ))}
        </div>
      </Cartao>

      {/* --- Trilha de auditoria ----------------------------------------------- */}
      <Cartao>
        <TituloSecao
          titulo="Trilha de auditoria"
          subtitulo="Append-only em três camadas: privilégio revogado no banco, gatilho que lança exceção, e cadeia de hash que detecta adulteração externa."
          acao={<Pill tom="pri">append-only</Pill>}
        />

        <div className="rolagem-horizontal">
          <div style={{ display: 'grid', gap: 1, background: 'var(--line)', minWidth: 640 }}>
            <div
              style={{
                background: 'var(--surface2)',
                display: 'grid',
                gridTemplateColumns: '0.9fr 1fr 1.3fr 1.6fr',
                gap: 12,
                padding: '10px 14px',
              }}
            >
              <span className="rotulo">Quando</span>
              <span className="rotulo">Ator</span>
              <span className="rotulo">Ação</span>
              <span className="rotulo">Entidade</span>
            </div>

            {eventos.map((e) => (
              <div
                key={e.id}
                style={{
                  background: 'var(--surface)',
                  display: 'grid',
                  gridTemplateColumns: '0.9fr 1fr 1.3fr 1.6fr',
                  gap: 12,
                  padding: '11px 14px',
                  alignItems: 'center',
                }}
              >
                <span className="mono" style={{ fontSize: 10.5 }}>
                  #{e.sequencia} · {new Date(e.ocorridoEm).toLocaleString('pt-BR')}
                </span>
                <span className="mono" style={{ fontSize: 10.5 }}>
                  {e.atorPapel}
                </span>
                <span>
                  <Pill tom={tomDaAcao(e.acao)}>{e.acao}</Pill>
                </span>
                <span className="mono" style={{ fontSize: 10.5, minWidth: 0 }}>
                  {e.entidade}
                  {e.detalhe ? ` — ${e.detalhe}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>

        {eventos.length === 0 && (
          <p style={{ color: 'var(--ink3)', fontSize: 13, marginTop: 14 }}>
            Nenhum evento registrado ainda.
          </p>
        )}
      </Cartao>
    </div>
  );
}
