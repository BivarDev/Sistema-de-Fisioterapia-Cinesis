/**
 * Portal do paciente.
 *
 * ## Metade do ciclo
 *
 * Prescrever é fácil; saber se o paciente fez é o que muda a conduta. Este app
 * existe para capturar essa metade — e por isso ele é otimizado para uma
 * situação muito específica: alguém no sofá, no celular, com a rede ruim, que
 * abriu um link do WhatsApp.
 *
 * ## Quatro ações possíveis, e nada mais
 *
 * Confirmar a sessão, ver o exercício, registrar a execução, ver o progresso.
 * A superfície mínima é decisão de segurança tanto quanto de usabilidade: o que
 * não existe não pode ser abusado, e o que não está na tela não confunde.
 *
 * ## Como o token do link é tratado
 *
 * Ele chega no **path** da URL. A primeira coisa que este componente faz é
 * trocá-lo por um cookie de sessão e **limpar a URL** com `history.replaceState`
 * — para que o token não fique no histórico do navegador nem no `Referer` de
 * nenhum recurso carregado depois. Num celular compartilhado, isso importa.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  BarrasSimples,
  Cartao,
  EspacoDeMidia,
  Barra,
  TextoPorPalavra,
  usarPreferencias,
  Segmentado,
} from '@cinesis/ui';
import type { StatusAdesao } from '@cinesis/shared';

/** O que o painel do portal devolve. */
interface Painel {
  metaSemanal: number;
  exercicios: {
    itemId: string;
    nome: string;
    orientacao: string;
    series: number;
    repeticoes: number;
    carga: string;
    registroHoje: StatusAdesao | null;
  }[];
  feitosHoje: number;
  sequencia: number;
  progresso: number[];
  resumo: string;
}

/** Estados da tela. */
type Estado = 'entrando' | 'pronto' | 'sem_acesso';

/** Token CSRF da sessão do portal. Em memória, como na aplicação profissional. */
let csrf = '';

/** Chamada à API do portal. */
async function chamar<T>(caminho: string, corpo?: unknown): Promise<T> {
  const resposta = await fetch(`/api${caminho}`, {
    method: corpo ? 'POST' : 'GET',
    headers: corpo ? { 'Content-Type': 'application/json', 'x-cinesis-csrf': csrf } : {},
    credentials: 'include',
    // Espalhamento condicional: sob `exactOptionalPropertyTypes`, passar
    // `body: undefined` explicitamente e diferente de omitir a propriedade.
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  });

  if (!resposta.ok) throw new Error(String(resposta.status));
  return (await resposta.json()) as T;
}

export function App() {
  const [estado, setEstado] = useState<Estado>('entrando');
  const [painel, setPainel] = useState<Painel | null>(null);
  const { tema, temaEfetivo, definirTema, movimento, definirMovimento } =
    usarPreferencias();

  /** Carrega o painel. */
  const carregar = useCallback(async () => {
    try {
      setPainel(await chamar<Painel>('/portal/painel'));
      setEstado('pronto');
    } catch {
      setEstado('sem_acesso');
    }
  }, []);

  // Entrada: troca o token do path por uma sessão, e limpa a URL.
  useEffect(() => {
    // Aceita `/entrar/<token>` (o formato do link enviado ao paciente) e
    // `/portal/entrar/<token>` (quando a API serve o portal sob um prefixo).
    const casa = /\/entrar\/([A-Za-z0-9_-]{43})$/.exec(window.location.pathname);

    if (!casa) {
      // Sem token na URL: talvez já exista sessão (o paciente voltou à aba).
      void carregar();
      return;
    }

    void (async () => {
      try {
        const r = await chamar<{ csrf: string }>('/portal/entrar', { token: casa[1] });
        csrf = r.csrf;

        // Remove o token da URL ANTES de qualquer outra coisa. `replaceState`
        // não deixa entrada no histórico — o token some do "voltar" também.
        window.history.replaceState({}, '', import.meta.env.BASE_URL);

        await carregar();
      } catch {
        window.history.replaceState({}, '', import.meta.env.BASE_URL);
        setEstado('sem_acesso');
      }
    })();
  }, [carregar]);

  /** Registra a execução de um exercício. */
  async function registrar(itemId: string, status: StatusAdesao) {
    try {
      const atualizado = await chamar<Painel>('/portal/registros', {
        prescricaoItemId: itemId,
        data: new Date().toISOString().slice(0, 10),
        status,
      });
      // A resposta já traz o painel atualizado: uma ida a menos ao servidor,
      // o que importa numa rede móvel ruim.
      setPainel(atualizado);
    } catch {
      setEstado('sem_acesso');
    }
  }

  // --- Estados de exceção ---------------------------------------------------

  if (estado === 'entrando') {
    return <Centralizado texto="Abrindo seu tratamento…" />;
  }

  if (estado === 'sem_acesso') {
    return (
      <Centralizado>
        <Cartao style={{ maxWidth: 380, textAlign: 'center' }}>
          <h1 style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 24, margin: '0 0 10px' }}>
            Este link não vale mais
          </h1>
          <p style={{ fontSize: 14, color: 'var(--ink2)', lineHeight: 1.6, margin: 0 }}>
            Os links são de uso único e expiram em 15 minutos, para proteger seus dados. Peça um
            novo à sua clínica quando precisar.
          </p>
        </Cartao>
      </Centralizado>
    );
  }

  if (!painel) return <Centralizado texto="Carregando…" />;

  const total = painel.exercicios.length;
  const percentual = total === 0 ? 0 : Math.round((painel.feitosHoje / total) * 100);

  // --- Tela principal -------------------------------------------------------

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--surface2)' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '20px 16px 60px' }}>
        {/* Cabeçalho enxuto: nome do produto e as duas preferências. */}
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 20,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 21 }}>Cinesis</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Segmentado
              rotulo="Animações"
              valor={movimento}
              aoMudar={definirMovimento}
              opcoes={[
                { valor: 'completas', rotulo: 'Animações' },
                { valor: 'reduzidas', rotulo: 'Reduzidas' },
              ]}
            />
            <Segmentado
              rotulo="Tema"
              // Quando o tema segue o sistema, o seletor mostra o tema
              // EFETIVO — nao 'claro' por padrao. Marcar "Claro" numa tela
              // escura faz o usuario achar que o botao esta quebrado.
              valor={tema === 'sistema' ? temaEfetivo : tema}
              aoMudar={definirTema}
              opcoes={[
                { valor: 'claro', rotulo: 'Claro' },
                { valor: 'escuro', rotulo: 'Noturno' },
              ]}
            />
          </div>
        </header>

        <TextoPorPalavra
          como="h1"
          className="titulo-portal"
        >
          Seu tratamento esta semana
        </TextoPorPalavra>

        {/* --- Progresso do dia --------------------------------------------- */}
        <Cartao style={{ marginTop: 18, marginBottom: 14 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 10,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700 }}>Hoje</span>
            <span style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 26 }}>
              {painel.feitosHoje} de {total}
            </span>
          </div>

          <Barra valor={percentual} altura={8} tom="good" />

          <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--ink2)' }}>
            Meta da semana: {painel.metaSemanal} dias.
            {painel.sequencia > 0
              ? ` Você está no ${painel.sequencia}º dia seguido.`
              : ' Comece hoje.'}
          </p>
        </Cartao>

        {/* --- Exercícios de hoje ------------------------------------------- */}
        <h2 style={{ fontSize: 15, fontWeight: 800, margin: '22px 0 12px' }}>
          Exercícios de hoje
        </h2>

        {painel.exercicios.length === 0 && (
          <Cartao>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink2)' }}>
              Você ainda não tem exercícios prescritos. Fale com sua clínica.
            </p>
          </Cartao>
        )}

        <div style={{ display: 'grid', gap: 12 }}>
          {painel.exercicios.map((ex) => (
            <Cartao key={ex.itemId} style={{ padding: 16 }}>
              <EspacoDeMidia legenda={`vídeo — ${ex.nome}`} altura={104} />

              <h3 style={{ margin: '12px 0 4px', fontSize: 15, fontWeight: 800 }}>{ex.nome}</h3>
              <div className="mono" style={{ fontSize: 11 }}>
                {ex.series} séries · {ex.repeticoes} repetições · {ex.carga}
              </div>

              {/* Orientação em linguagem de paciente. Nada de jargão clínico. */}
              <p style={{ margin: '10px 0 14px', fontSize: 13.5, lineHeight: 1.6 }}>
                {ex.orientacao}
              </p>

              {/* Três botões, todos com 44px de altura mínima — alvo de toque
                  confortável, inclusive para quem tem limitação de destreza. */}
              <div style={{ display: 'flex', gap: 8 }}>
                {(
                  [
                    { status: 'fez' as const, rotulo: 'Fiz', cor: 'var(--good)' },
                    { status: 'parcial' as const, rotulo: 'Fiz parte', cor: 'var(--acc)' },
                    { status: 'nao_fez' as const, rotulo: 'Não fiz', cor: 'var(--bad)' },
                  ]
                ).map((b) => {
                  const ativo = ex.registroHoje === b.status;
                  return (
                    <button
                      key={b.status}
                      onClick={() => void registrar(ex.itemId, b.status)}
                      aria-pressed={ativo}
                      style={{
                        flex: 1,
                        minHeight: 44,
                        borderRadius: 'var(--r-botao)',
                        border: `1px solid ${ativo ? b.cor : 'var(--line2)'}`,
                        background: ativo ? b.cor : 'var(--surface)',
                        color: ativo ? 'var(--surface)' : 'var(--ink2)',
                        fontSize: 13.5,
                        fontWeight: 700,
                        transition: 'background var(--dur-rapida) var(--ease)',
                      }}
                    >
                      {b.rotulo}
                    </button>
                  );
                })}
              </div>
            </Cartao>
          ))}
        </div>

        {/* --- Progresso ----------------------------------------------------- */}
        {painel.progresso.length > 0 && (
          <Cartao style={{ marginTop: 22 }}>
            <h2 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 14px' }}>
              Como você está evoluindo
            </h2>

            <BarrasSimples valores={painel.progresso} />

            {/*
              O resumo vem do servidor em LINGUAGEM DE PACIENTE.
              "Sua dor caiu de 7 para 2 desde o início" — não "escore funcional
              composto subiu 44 pontos". Quem lê isto é a pessoa em tratamento,
              não o profissional.
            */}
            <p style={{ margin: '14px 0 0', fontSize: 14, lineHeight: 1.6, fontWeight: 600 }}>
              {painel.resumo}
            </p>
          </Cartao>
        )}

        <p className="mono" style={{ marginTop: 24, fontSize: 10.5, lineHeight: 1.8 }}>
          Este link expira e é de uso único · peça um novo à sua clínica quando precisar
        </p>
      </div>
    </div>
  );
}

/** Tela centralizada, para carregamento e erro. */
function Centralizado({ texto, children }: { texto?: string; children?: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'var(--surface2)',
      }}
    >
      {children ?? <span style={{ color: 'var(--ink3)', fontSize: 14 }}>{texto}</span>}
    </div>
  );
}
