/**
 * Contexto de sessão do profissional.
 *
 * ## O que a interface pode e o que não pode decidir
 *
 * As permissões chegam **resolvidas pelo servidor** e são usadas só para
 * esconder o que o usuário não pode fazer. Isso é conveniência, não segurança:
 * cada endpoint refaz a checagem por conta própria. Um usuário que edite o
 * JavaScript e faça o botão aparecer recebe 404 do servidor.
 *
 * A distinção importa na hora de revisar código. "A UI esconde" nunca é uma
 * resposta aceitável para "como isso é protegido"; a resposta está no backend.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Nivel, Papel, Permissao } from '@cinesis/shared';
import { buscar, definirCsrf, enviar, ErroApi } from './api.js';

/** O profissional autenticado. */
export interface Profissional {
  id: string;
  nome: string;
  email: string;
  crefito: string | null;
  papel: Papel;
  organizacaoId: string;
  mfaAtivo: boolean;
}

/** A organização da sessão. */
export interface Organizacao {
  id: string;
  nome: string;
  tipo: string;
}

/** Estado de carregamento da sessão. */
type Estado = 'carregando' | 'autenticado' | 'anonimo';

/** O que o contexto expõe. */
interface ContextoSessao {
  estado: Estado;
  profissional: Profissional | null;
  organizacao: Organizacao | null;
  /** Consulta o nível de acesso a uma permissão. */
  nivel: (p: Permissao) => Nivel;
  /** Atalho: tem algum acesso? */
  pode: (p: Permissao) => boolean;
  /** Atalho: tem acesso total (não aceita `restrito`)? */
  podeTotal: (p: Permissao) => boolean;
  entrar: (email: string, senha: string, totp?: string) => Promise<void>;
  sair: () => Promise<void>;
  /** Recarrega a sessão do servidor. */
  recarregar: () => Promise<void>;
}

const Contexto = createContext<ContextoSessao | null>(null);

/** Resposta de `/api/auth/sessao` e de `/api/auth/login`. */
interface RespostaSessao {
  profissional: Profissional;
  organizacao: Organizacao | null;
  permissoes: Record<string, Nivel>;
  csrf?: string;
}

/** Provedor da sessão. Envolve as rotas autenticadas. */
export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<Estado>('carregando');
  const [profissional, setProfissional] = useState<Profissional | null>(null);
  const [organizacao, setOrganizacao] = useState<Organizacao | null>(null);
  const [permissoes, setPermissoes] = useState<Record<string, Nivel>>({});

  /** Aplica uma resposta de sessão ao estado local. */
  const aplicar = useCallback((r: RespostaSessao) => {
    setProfissional(r.profissional);
    setOrganizacao(r.organizacao);
    setPermissoes(r.permissoes);
    // O token CSRF vem no corpo; guardamos em memória (ver `api.ts`).
    if (r.csrf) definirCsrf(r.csrf);
    setEstado('autenticado');
  }, []);

  const recarregar = useCallback(async () => {
    try {
      aplicar(await buscar<RespostaSessao>('/auth/sessao'));
    } catch (e) {
      // 401 aqui é o caso normal de quem ainda não entrou — não é erro.
      if (e instanceof ErroApi && e.codigo === 'NAO_AUTENTICADO') {
        setEstado('anonimo');
        setProfissional(null);
        definirCsrf(null);
        return;
      }
      // Qualquer outra falha (rede, servidor fora) também leva ao estado
      // anônimo: melhor mandar para o login do que travar numa tela em branco.
      setEstado('anonimo');
    }
  }, [aplicar]);

  // Tenta restaurar a sessão na montagem. O cookie sobrevive a um F5; o token
  // CSRF, que vive em memória, não — por isso ele volta nesta resposta.
  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  const entrar = useCallback(
    async (email: string, senha: string, totp?: string) => {
      const r = await enviar<RespostaSessao>('/auth/login', {
        email,
        senha,
        ...(totp ? { totp } : {}),
      });
      aplicar(r);
    },
    [aplicar],
  );

  const sair = useCallback(async () => {
    try {
      await enviar('/auth/sair');
    } finally {
      // Limpa o estado local mesmo se a chamada falhar: o usuário clicou em
      // "sair" e a interface precisa refletir isso. A sessão no servidor
      // expira sozinha por timeout.
      setEstado('anonimo');
      setProfissional(null);
      setOrganizacao(null);
      definirCsrf(null);
    }
  }, []);

  const valor = useMemo<ContextoSessao>(
    () => ({
      estado,
      profissional,
      organizacao,
      // `negado` como padrão: uma permissão que o servidor não mandou é
      // tratada como negada, nunca como permitida.
      nivel: (p) => permissoes[p] ?? 'negado',
      pode: (p) => (permissoes[p] ?? 'negado') !== 'negado',
      podeTotal: (p) => permissoes[p] === 'total',
      entrar,
      sair,
      recarregar,
    }),
    [estado, profissional, organizacao, permissoes, entrar, sair, recarregar],
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

/** Acessa a sessão. */
export function usarSessao(): ContextoSessao {
  const ctx = useContext(Contexto);
  if (!ctx) throw new Error('usarSessao precisa estar dentro de <ProvedorSessao>.');
  return ctx;
}
