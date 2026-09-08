/**
 * Casca da aplicação: barra lateral, cabeçalho e área de conteúdo.
 *
 * ## O RBAC agindo de forma observável
 *
 * A navegação é filtrada pelas permissões da sessão. Entrar como recepção
 * **remove** Plano, Avaliação, Adesão e Auditoria da lista — não as desabilita:
 * remove. Um item cinza que não faz nada é pior que a ausência dele, porque
 * sugere que existe algo a destravar.
 *
 * De novo: isso é conveniência. O servidor recusa as rotas correspondentes
 * independentemente do que a interface mostre.
 */

import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { Segmentado, usarPreferencias, rolarParaTopo, Avatar } from '@cinesis/ui';
import { ROTULO_PAPEL, type Permissao } from '@cinesis/shared';
import { usarSessao } from '../sessao.js';

/** Um item de navegação, com a permissão que o torna visível. */
interface ItemNav {
  para: string;
  rotulo: string;
  /** Permissão exigida. `null` = sempre visível. */
  permissao: Permissao | null;
}

/** Grupos da navegação, na ordem do handoff de design. */
const GRUPOS: { titulo: string; itens: ItemNav[] }[] = [
  {
    titulo: 'Clínico',
    itens: [
      { para: '/app/hoje', rotulo: 'Hoje', permissao: null },
      { para: '/app/pacientes', rotulo: 'Pacientes', permissao: 'paciente:ler' },
    ],
  },
  {
    titulo: 'Adesão',
    itens: [
      { para: '/app/adesao', rotulo: 'Painel de adesão', permissao: 'hep:ler' },
      { para: '/app/biblioteca', rotulo: 'Biblioteca', permissao: 'biblioteca:ler' },
    ],
  },
  {
    titulo: 'Plataforma',
    itens: [
      { para: '/app/seguranca', rotulo: 'Segurança e auditoria', permissao: 'auditoria:ler' },
      { para: '/app/configuracoes', rotulo: 'Configurações', permissao: null },
    ],
  },
];

export function Layout() {
  const { profissional, organizacao, pode, sair } = usarSessao();
  const { tema, temaEfetivo, definirTema, movimento, definirMovimento } =
    usarPreferencias();
  const local = useLocation();
  const navegar = useNavigate();

  // Troca de tela reseta a rolagem do conteúdo. Sem isso, quem estava no fim
  // de uma lista longa abre a tela seguinte já no meio dela.
  useEffect(() => {
    rolarParaTopo();
  }, [local.pathname]);

  return (
    <div className="app-layout">
      {/* --- Barra lateral -------------------------------------------------- */}
      <aside className="app-sidebar">
        <div
          style={{
            padding: '18px 18px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span
            style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 23, letterSpacing: '-0.02em' }}
          >
            Cinesis
          </span>
        </div>

        <nav style={{ flex: 1, padding: '0 8px 16px' }}>
          {GRUPOS.map((grupo) => {
            // Filtra os itens que o papel corrente pode ver. Um grupo cujos
            // itens sumiram todos não renderiza nem o título.
            const visiveis = grupo.itens.filter((i) => i.permissao === null || pode(i.permissao));
            if (visiveis.length === 0) return null;

            return (
              <div key={grupo.titulo}>
                <div className="nav-grupo">{grupo.titulo}</div>
                {visiveis.map((item) => (
                  <NavLink
                    key={item.para}
                    to={item.para}
                    className="nav-item"
                    style={{ display: 'block' }}
                  >
                    {item.rotulo}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        {/* Atalho para o portal do paciente, em app separado. */}
        <div style={{ padding: 16, borderTop: '1px solid var(--line)' }}>
          <a
            href="http://localhost:5174"
            target="_blank"
            rel="noreferrer"
            className="mono"
            style={{ fontSize: 10.5 }}
          >
            Portal do paciente ↗
          </a>
        </div>
      </aside>

      {/* --- Área principal ------------------------------------------------- */}
      <div className="app-principal">
        <header className="app-cabecalho">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <Avatar nome={profissional?.nome ?? '??'} tamanho={34} />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {profissional?.nome}
              </div>
              <div className="mono" style={{ fontSize: 10 }}>
                {ROTULO_PAPEL[profissional?.papel ?? 'fisioterapeuta']}
                {profissional?.crefito ? ` · ${profissional.crefito}` : ''}
                {organizacao ? ` · ${organizacao.nome}` : ''}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Segmentado
              rotulo="Animações"
              valor={movimento}
              aoMudar={definirMovimento}
              opcoes={[
                { valor: 'completas', rotulo: 'Completas' },
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
            <button
              onClick={() => {
                void sair().then(() => navegar('/entrar'));
              }}
              style={{
                background: 'none',
                border: '1px solid var(--line2)',
                borderRadius: 'var(--r-botao)',
                padding: '7px 13px',
                fontSize: 12.5,
                color: 'var(--ink2)',
              }}
            >
              Sair
            </button>
          </div>
        </header>

        {/* `data-scroll-conteudo` é o alvo de `rolarParaTopo`. */}
        <main className="app-conteudo" data-scroll-conteudo>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
