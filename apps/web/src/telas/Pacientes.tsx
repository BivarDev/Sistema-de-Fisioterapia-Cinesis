/**
 * Tela de pacientes.
 *
 * ## O aviso de RBAC que aparece aqui
 *
 * Quando o papel não pode reidentificar, a tela mostra uma faixa explicando
 * **por que** os nomes não aparecem. Sem essa faixa, o estagiário concluiria
 * que o sistema está quebrado, ou que os pacientes foram cadastrados sem nome.
 *
 * E o ponto que vale repetir: o nome não está escondido no navegador. Ele não
 * foi lido do banco. A resposta da API traz `nome: null`.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Barra, Cartao, Pill } from '@cinesis/ui';
import type { PacienteResumo } from '@cinesis/shared';
import { buscar, enviar, ErroApi } from '../api.js';
import { Aviso } from './Hoje.js';
import { usarSessao } from '../sessao.js';

interface Resposta {
  pacientes: PacienteResumo[];
  podeReidentificar: boolean;
}

/** Filtros da tela, com o critério de cada um. */
const FILTROS = [
  { chave: 'todos', rotulo: 'Todos' },
  { chave: 'evoluindo', rotulo: 'Evoluindo' },
  { chave: 'baixa_adesao', rotulo: 'Baixa adesão' },
  { chave: 'estagnado', rotulo: 'Estagnado' },
] as const;

export function Pacientes() {
  const navegar = useNavigate();
  const { pode } = usarSessao();

  const [dados, setDados] = useState<Resposta | null>(null);
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState<(typeof FILTROS)[number]['chave']>('todos');
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    buscar<Resposta>('/pacientes')
      .then(setDados)
      .catch(() => setErro('Não foi possível carregar os pacientes.'));
  }, []);

  /**
   * Filtro e busca aplicados no cliente.
   *
   * Legítimo aqui porque a lista já vem limitada a 100 pelo servidor — que é o
   * teto de uma clínica pequena. Se o público mudasse para clínicas grandes,
   * isto viraria parâmetro de query; até lá, buscar no servidor a cada tecla
   * seria latência sem ganho.
   */
  const visiveis = useMemo(() => {
    if (!dados) return [];
    const termo = busca.trim().toLowerCase();

    return dados.pacientes.filter((p) => {
      // A busca cobre nome (quando disponível), código e plano.
      const casa =
        termo === '' ||
        p.codigo.toLowerCase().includes(termo) ||
        (p.nome?.toLowerCase().includes(termo) ?? false) ||
        (p.planoAtivo?.toLowerCase().includes(termo) ?? false);

      if (!casa) return false;

      if (filtro === 'evoluindo') return p.situacao === 'evoluindo';
      if (filtro === 'estagnado') return p.situacao === 'estagnado';
      if (filtro === 'baixa_adesao') return p.adesao !== null && p.adesao < 40;
      return true;
    });
  }, [dados, busca, filtro]);

  /**
   * Abre o plano ativo do paciente.
   *
   * A lista de planos é buscada aqui, e não junto com os pacientes, porque só
   * é necessária no clique — trazê-la sempre custaria uma consulta a mais em
   * toda abertura da tela para servir a um caso que pode não acontecer.
   */
  async function abrirPlano(pacienteId: string) {
    try {
      const r = await buscar<{ planos: { id: string; pacienteId: string }[] }>('/planos');
      const plano = r.planos.find((pl) => pl.pacienteId === pacienteId);

      if (plano) navegar(`/app/planos/${plano.id}`);
      else setErro('Este paciente ainda não tem um plano de tratamento ativo.');
    } catch {
      setErro('Não foi possível abrir o plano.');
    }
  }

  if (erro) return <Aviso texto={erro} />;
  if (!dados) return <Aviso texto="Carregando…" />;

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 27, margin: '0 0 4px' }}>
        Pacientes
      </h1>
      <p style={{ color: 'var(--ink2)', fontSize: 13.5, margin: '0 0 20px' }}>
        Encontre um paciente e leia o estado dele num varrimento.
      </p>

      {/* --- Busca ---------------------------------------------------------- */}
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <span
          aria-hidden="true"
          className="mono"
          style={{
            position: 'absolute',
            left: 14,
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: 14,
          }}
        >
          ⌕
        </span>
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por nome, identificador pseudonimizado ou plano"
          aria-label="Buscar pacientes"
          style={{
            width: '100%',
            padding: '11px 15px 11px 36px',
            borderRadius: 'var(--r-botao)',
            border: '1px solid var(--line2)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            fontSize: 13.5,
            fontFamily: 'inherit',
          }}
        />
      </div>

      {/* --- Filtros -------------------------------------------------------- */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTROS.map((f) => {
          const ativo = filtro === f.chave;
          const contagem =
            f.chave === 'todos'
              ? dados.pacientes.length
              : dados.pacientes.filter((p) =>
                  f.chave === 'baixa_adesao'
                    ? p.adesao !== null && p.adesao < 40
                    : p.situacao === f.chave,
                ).length;

          return (
            <button
              key={f.chave}
              onClick={() => setFiltro(f.chave)}
              aria-pressed={ativo}
              style={{
                padding: '6px 13px',
                borderRadius: 'var(--r-pill)',
                border: `1px solid ${ativo ? 'var(--ink)' : 'var(--line2)'}`,
                background: ativo ? 'var(--ink)' : 'var(--surface)',
                color: ativo ? 'var(--bg)' : 'var(--ink2)',
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              {f.rotulo} · {contagem}
            </button>
          );
        })}
      </div>

      {/* --- Aviso de RBAC -------------------------------------------------- */}
      {!dados.podeReidentificar && (
        <Cartao tom="acc" style={{ marginBottom: 16, padding: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <Pill tom="acc">RBAC</Pill>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
              Seu papel exibe os pacientes apenas pelo identificador pseudonimizado. Isto não é
              máscara de interface: o nome <strong>não é lido do banco</strong> para este papel.
              Religar o código à identidade real é uma operação governada — exige cargo autorizado,
              motivo escrito e fica registrada na trilha de auditoria.
            </p>
          </div>
        </Cartao>
      )}

      {/* --- Tabela --------------------------------------------------------- */}
      <div className="tabela">
        <div
          className="tabela-cabecalho"
          style={{ gridTemplateColumns: '2fr 1.6fr 1fr 0.8fr 1fr' }}
        >
          <span className="rotulo">Paciente</span>
          <span className="rotulo">Plano</span>
          <span className="rotulo">Adesão</span>
          <span className="rotulo">EVA</span>
          <span className="rotulo">Situação</span>
        </div>

        {visiveis.length === 0 && (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--ink3)', fontSize: 13 }}>
            Nenhum paciente corresponde ao filtro.
          </div>
        )}

        {visiveis.map((p) => (
          <LinhaPaciente
            key={p.id}
            paciente={p}
            podeReidentificar={dados.podeReidentificar && pode('paciente:reidentificar')}
            // A linha leva ao PLANO ATIVO, que é onde a informação clínica
            // está. O plano é o agregado principal — abrir "o paciente" não
            // teria o que mostrar além do que já está nesta linha.
            aoAbrir={() => abrirPlano(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** Uma linha da tabela de pacientes. */
function LinhaPaciente({
  paciente,
  podeReidentificar,
  aoAbrir,
}: {
  paciente: PacienteResumo;
  podeReidentificar: boolean;
  aoAbrir: () => void;
}) {
  const [nomeRevelado, setNomeRevelado] = useState<string | null>(null);
  const [erroReidentificar, setErroReidentificar] = useState<string | null>(null);

  // O que exibir: o nome já entregue pelo servidor, o nome revelado por
  // reidentificação explícita, ou o código.
  const exibido = nomeRevelado ?? paciente.nome ?? paciente.codigo;

  /**
   * Reidentifica sob demanda, pedindo o motivo.
   *
   * O `prompt` é intencionalmente rústico nesta versão — o que importa é que o
   * motivo seja obrigatório e vá para a auditoria. Um modal caprichado com o
   * campo opcional seria pior.
   */
  async function reidentificar() {
    const motivo = window.prompt(
      'Reidentificação é uma operação auditada. Descreva o motivo (mínimo 10 caracteres):',
    );
    if (!motivo) return;

    try {
      const r = await enviar<{ nome: string }>(`/pacientes/${paciente.id}/reidentificar`, {
        motivo,
      });
      setNomeRevelado(r.nome);
      setErroReidentificar(null);
    } catch (e) {
      setErroReidentificar(e instanceof ErroApi ? e.mensagem : 'Falha ao reidentificar.');
    }
  }

  return (
    <div
      className="tabela-linha"
      style={{ gridTemplateColumns: '2fr 1.6fr 1fr 0.8fr 1fr' }}
      data-clicavel="true"
      onClick={aoAbrir}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        // A linha é clicável, então precisa ser acionável por teclado também.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          aoAbrir();
        }
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <Avatar nome={exibido} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>{exibido}</div>
          <div className="mono" style={{ fontSize: 10 }}>
            {paciente.codigo}
            {paciente.idade !== null ? ` · ${paciente.idade} anos` : ''}
          </div>
          {/* O botão de reidentificar só aparece se o nome ainda não estiver
              disponível E o papel puder fazê-lo. */}
          {paciente.nome === null && nomeRevelado === null && podeReidentificar && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void reidentificar();
              }}
              className="mono"
              style={{
                marginTop: 4,
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--pri)',
                fontSize: 10,
                textDecoration: 'underline',
              }}
            >
              reidentificar (auditado)
            </button>
          )}
          {erroReidentificar && (
            <div className="mono" style={{ fontSize: 10, color: 'var(--bad)', marginTop: 3 }}>
              {erroReidentificar}
            </div>
          )}
        </div>
      </div>

      <div style={{ fontSize: 12.5, minWidth: 0 }}>
        {paciente.planoAtivo ?? <span style={{ color: 'var(--ink3)' }}>sem plano ativo</span>}
      </div>

      <div>
        {paciente.adesao === null ? (
          <span className="mono">—</span>
        ) : (
          <>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>
              {paciente.adesao}%
            </div>
            <Barra valor={paciente.adesao} altura={5} />
          </>
        )}
      </div>

      <div className="mono" style={{ fontSize: 11.5 }}>
        {paciente.evaAtual ?? '—'}
        {paciente.evaInicial !== null && (
          <span style={{ color: 'var(--ink3)' }}> ← {paciente.evaInicial}</span>
        )}
      </div>

      <div>
        <SituacaoPill situacao={paciente.situacao} />
      </div>
    </div>
  );
}

/** Etiqueta de situação, com cor e texto sempre juntos. */
function SituacaoPill({ situacao }: { situacao: PacienteResumo['situacao'] }) {
  const mapa = {
    evoluindo: { tom: 'good' as const, texto: 'Evoluindo' },
    estavel: { tom: 'ink' as const, texto: 'Estável' },
    estagnado: { tom: 'acc' as const, texto: 'Estagnado' },
    sem_plano: { tom: 'ink' as const, texto: 'Sem plano' },
  };
  const s = mapa[situacao];
  return <Pill tom={s.tom}>{s.texto}</Pill>;
}
