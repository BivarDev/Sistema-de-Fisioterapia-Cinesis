/**
 * Preferências de tema e de movimento.
 *
 * ## Os dois requisitos do produto que este arquivo implementa
 *
 * 1. **Duas opções de animação**: completas e reduzidas.
 * 2. **Modo noturno**.
 *
 * Ambos são persistidos em `localStorage` e aplicados como atributo no
 * elemento raiz (`data-theme` e `data-motion`). O CSS faz o resto — trocar de
 * tema não re-renderiza componente nenhum, e por isso é instantâneo mesmo numa
 * tela com centenas de linhas de tabela.
 *
 * ## Detalhe que costuma passar batido
 *
 * O padrão de movimento **não** é "completas". É o que o sistema operacional
 * do usuário diz em `prefers-reduced-motion`. Quem ligou "reduzir movimento"
 * no sistema fez isso por um motivo — frequentemente distúrbio vestibular ou
 * sensibilidade a movimento —, e ignorar essa preferência para mostrar uma
 * animação bonita é escolher a estética em cima da saúde de quem usa.
 *
 * A escolha manual sobrepõe o sistema, nos dois sentidos.
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

/** Temas possíveis. `sistema` segue o `prefers-color-scheme`. */
export type Tema = 'claro' | 'escuro' | 'sistema';

/** Modos de animação. */
export type Movimento = 'completas' | 'reduzidas';

/** Chaves do `localStorage`. Prefixadas para não colidir com outro app no host. */
const CHAVE_TEMA = 'cinesis:tema';
const CHAVE_MOVIMENTO = 'cinesis:motion';

/** O que o contexto expõe. */
interface Preferencias {
  tema: Tema;
  /** Tema efetivamente aplicado, já resolvido de `sistema`. */
  temaEfetivo: 'claro' | 'escuro';
  definirTema: (t: Tema) => void;
  movimento: Movimento;
  definirMovimento: (m: Movimento) => void;
  /** Atalho: `true` quando as animações estão reduzidas. */
  reduzido: boolean;
}

const Contexto = createContext<Preferencias | null>(null);

/**
 * Lê o `localStorage` com proteção.
 *
 * Acessar `localStorage` **lança** em algumas situações reais: navegação
 * privativa em Safari antigo, cookies de terceiros bloqueados num iframe, e
 * política corporativa que desliga armazenamento de site. Sem o `try`, a
 * aplicação inteira quebraria na primeira linha — por causa de uma preferência
 * de cor.
 */
function lerArmazenado(chave: string): string | null {
  try {
    return localStorage.getItem(chave);
  } catch {
    return null;
  }
}

/** Grava no `localStorage`, ignorando falha (ver `lerArmazenado`). */
function gravarArmazenado(chave: string, valor: string): void {
  try {
    localStorage.setItem(chave, valor);
  } catch {
    // A preferência vale só para esta aba. Aceitável.
  }
}

/** O sistema operacional está em modo escuro? */
function sistemaEstaEscuro(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** O sistema pede movimento reduzido? */
function sistemaPedeReduzido(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Provedor de preferências. Envolve a aplicação inteira.
 */
export function ProvedorPreferencias({ children }: { children: ReactNode }) {
  // Inicialização preguiçosa: a função só roda na primeira renderização, e não
  // a cada re-render. Sem isso, cada render leria o `localStorage` de novo.
  const [tema, setTema] = useState<Tema>(() => {
    const salvo = lerArmazenado(CHAVE_TEMA);
    return salvo === 'claro' || salvo === 'escuro' ? salvo : 'sistema';
  });

  const [movimento, setMovimento] = useState<Movimento>(() => {
    const salvo = lerArmazenado(CHAVE_MOVIMENTO);
    if (salvo === 'completas' || salvo === 'reduzidas') return salvo;
    // Sem escolha salva: obedece ao sistema. Ver a nota no topo do arquivo.
    return sistemaPedeReduzido() ? 'reduzidas' : 'completas';
  });

  // Estado do sistema, observado para reagir a mudança em tempo real (o usuário
  // pode alternar o modo escuro do SO com o app aberto).
  const [sistemaEscuro, setSistemaEscuro] = useState(sistemaEstaEscuro);

  useEffect(() => {
    const consulta = window.matchMedia('(prefers-color-scheme: dark)');
    const aoMudar = (e: MediaQueryListEvent) => setSistemaEscuro(e.matches);
    consulta.addEventListener('change', aoMudar);
    return () => consulta.removeEventListener('change', aoMudar);
  }, []);

  /** Tema resolvido: `sistema` vira `claro` ou `escuro` de verdade. */
  const temaEfetivo: 'claro' | 'escuro' =
    tema === 'sistema' ? (sistemaEscuro ? 'escuro' : 'claro') : tema;

  // Aplica os atributos no `<html>`. É daqui que o CSS lê.
  useEffect(() => {
    const raiz = document.documentElement;

    if (tema === 'sistema') {
      // Remove o atributo em vez de escrever "sistema": assim o bloco
      // `@media (prefers-color-scheme: dark)` do CSS volta a valer.
      raiz.removeAttribute('data-theme');
    } else {
      raiz.dataset.theme = tema === 'escuro' ? 'dark' : 'light';
    }

    raiz.dataset.motion = movimento;

    // `color-scheme` informa ao navegador para pintar barra de rolagem,
    // controles de formulário e o fundo do próprio documento no tom certo.
    // Sem isso, a barra de rolagem fica branca num tema escuro.
    raiz.style.colorScheme = temaEfetivo === 'escuro' ? 'dark' : 'light';
  }, [tema, movimento, temaEfetivo]);

  const definirTema = useCallback((t: Tema) => {
    setTema(t);
    gravarArmazenado(CHAVE_TEMA, t);
  }, []);

  const definirMovimento = useCallback((m: Movimento) => {
    setMovimento(m);
    gravarArmazenado(CHAVE_MOVIMENTO, m);
  }, []);

  const valor = useMemo(
    () => ({
      tema,
      temaEfetivo,
      definirTema,
      movimento,
      definirMovimento,
      reduzido: movimento === 'reduzidas',
    }),
    [tema, temaEfetivo, definirTema, movimento, definirMovimento],
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

/**
 * Acessa as preferências.
 *
 * @throws Se usado fora do `ProvedorPreferencias`. O erro é explícito porque o
 *         sintoma sem ele seria animação silenciosamente sempre ligada —
 *         justamente o oposto do que o usuário pediu.
 */
export function usarPreferencias(): Preferencias {
  const ctx = useContext(Contexto);
  if (!ctx) {
    throw new Error('usarPreferencias precisa estar dentro de <ProvedorPreferencias>.');
  }
  return ctx;
}
