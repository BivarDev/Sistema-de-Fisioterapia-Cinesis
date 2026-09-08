/**
 * Componentes de animação de texto.
 *
 * ## Origem e por que são implementados aqui
 *
 * São equivalentes dos efeitos de *Text Animations* do React Bits
 * (reactbits.dev, MIT), reescritos para este projeto por três motivos:
 *
 * 1. **Modo reduzido de verdade.** Cada componente aqui consulta as
 *    preferências e vai direto ao estado final — não é um `if` que o chamador
 *    pode esquecer.
 * 2. **Acessibilidade.** Quebrar um título em `<span>` por palavra faz um
 *    leitor de tela soletrar o texto pedaço a pedaço. Aqui o texto completo
 *    fica num `aria-label` e os fragmentos são `aria-hidden`.
 * 3. **Sem dependência nova.** São ~40 linhas cada; um pacote a mais na árvore
 *    de um sistema que trata dado de saúde é superfície de supply chain que
 *    precisa de justificativa melhor do que "economizei 40 linhas".
 *
 * A técnica é a mesma; o crédito é do React Bits.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { usarPreferencias } from './preferencias.js';
import { usarContador, usarNaTela } from './ganchos.js';

/** Propriedades comuns dos efeitos de texto. */
interface PropsTexto {
  /** O texto. Sempre string: precisamos fatiá-lo. */
  children: string;
  /** Classe CSS do elemento externo. */
  className?: string;
  /** Atraso antes de começar, em ms. */
  atraso?: number;
  /** Elemento HTML a renderizar. Padrão `span`. */
  como?: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div';
}

/**
 * Entrada palavra por palavra, com desfoque.
 *
 * Cada palavra sobe, desfoca de 10px a 0 e aparece, com 70 ms de defasagem
 * entre elas. É o efeito do H1 da landing.
 */
export function TextoPorPalavra({
  children,
  className = '',
  atraso = 0,
  como: Como = 'span',
}: PropsTexto) {
  const { reduzido } = usarPreferencias();

  // No modo reduzido, devolve o texto inteiro num nó só. Além de não animar,
  // isso elimina os `<span>` intermediários — melhor para leitor de tela.
  if (reduzido) return <Como className={className}>{children}</Como>;

  const palavras = children.split(' ');

  return (
    // `aria-label` com o texto completo + fragmentos ocultos: o leitor de tela
    // lê a frase de uma vez, como deveria.
    <Como className={className} aria-label={children}>
      {palavras.map((palavra, i) => (
        <span
          key={`${palavra}-${i}`}
          aria-hidden="true"
          style={{
            display: 'inline-block',
            // `will-change` avisa o navegador para promover a camada antes de
            // animar, evitando o "pulo" do primeiro quadro.
            willChange: 'opacity, transform, filter',
            animation: `palavraEntra var(--dur) var(--ease) both`,
            animationDelay: `${atraso + i * 70}ms`,
          }}
        >
          {palavra}
          {/* Espaço fora do span animado, senão as palavras colam. */}
          {i < palavras.length - 1 ? ' ' : ''}
        </span>
      ))}
    </Como>
  );
}

/**
 * Entrada de bloco com desfoque, sem fatiar o texto.
 *
 * Para parágrafos e legendas: fatiar um parágrafo de 60 palavras produziria 60
 * animações simultâneas, o que custa caro e parece ruído visual.
 */
export function TextoDesfocado({
  children,
  className = '',
  atraso = 0,
  como: Como = 'p',
}: PropsTexto) {
  const { reduzido } = usarPreferencias();

  if (reduzido) return <Como className={className}>{children}</Como>;

  return (
    <Como
      className={className}
      style={{
        animation: `desfoqueEntra var(--dur) var(--ease) both`,
        animationDelay: `${atraso}ms`,
      }}
    >
      {children}
    </Como>
  );
}

/**
 * Texto com um brilho que atravessa da esquerda para a direita.
 *
 * **Use com parcimônia.** Num sistema clínico, um texto que se move
 * continuamente compete com o dado por atenção. Aqui está reservado ao selo da
 * marca na landing e a nada mais.
 */
export function TextoBrilhante({ children, className = '' }: PropsTexto) {
  const { reduzido } = usarPreferencias();

  if (reduzido) return <span className={className}>{children}</span>;

  return (
    <span
      className={className}
      style={{
        // O gradiente com uma faixa clara no meio é o "brilho"; a animação
        // move a posição do fundo, e o `background-clip: text` recorta no
        // formato das letras.
        background:
          'linear-gradient(110deg, var(--ink3) 35%, var(--ink) 50%, var(--ink3) 65%)',
        backgroundSize: '240% auto',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        animation: 'brilho 4.5s linear infinite',
      }}
    >
      {children}
    </span>
  );
}

/**
 * Número que conta de 0 ao alvo quando entra na tela.
 *
 * As métricas da tela "Hoje" e os contadores da landing usam este componente.
 */
export function Contador({
  valor,
  sufixo = '',
  className = '',
  duracao = 900,
}: {
  valor: number;
  sufixo?: string;
  className?: string;
  duracao?: number;
}) {
  const [ref, visivel] = usarNaTela<HTMLSpanElement>();
  const atual = usarContador(valor, duracao, visivel);

  return (
    // `aria-label` com o valor final: um leitor de tela não deve anunciar
    // "12... 34... 56..." enquanto o número sobe.
    <span ref={ref} className={className} aria-label={`${valor}${sufixo}`}>
      <span aria-hidden="true">
        {atual}
        {sufixo}
      </span>
    </span>
  );
}

/**
 * Envelope que revela o conteúdo ao entrar na viewport.
 *
 * Alternativa em componente ao atributo `data-reveal`, para quando o elemento
 * é criado dinamicamente e o observador global já passou.
 */
export function Revelar({
  children,
  atraso = 0,
  className = '',
}: {
  children: ReactNode;
  atraso?: number;
  className?: string;
}) {
  const { reduzido } = usarPreferencias();
  const [ref, visivel] = usarNaTela<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className={className}
      style={
        reduzido
          ? undefined
          : {
              opacity: visivel ? 1 : 0,
              transform: visivel ? 'none' : 'translateY(24px)',
              transition: `opacity var(--dur) var(--ease) ${atraso}ms, transform var(--dur) var(--ease) ${atraso}ms`,
            }
      }
    >
      {children}
    </div>
  );
}

/**
 * Cartão que responde ao ponteiro com uma inclinação 3D sutil.
 *
 * Equivalente ao efeito *TiltedCard* do React Bits. O limite de 6 graus é
 * deliberado: acima disso o conteúdo fica difícil de ler durante o movimento,
 * o que num cartão de paciente é o oposto do objetivo.
 */
export function CartaoInclinavel({
  children,
  className = '',
  maxGraus = 6,
}: {
  children: ReactNode;
  className?: string;
  maxGraus?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { reduzido } = usarPreferencias();

  useEffect(() => {
    const el = ref.current;
    if (!el || reduzido) return;

    /** Converte a posição do ponteiro em rotação nos dois eixos. */
    const aoMover = (e: PointerEvent) => {
      const caixa = el.getBoundingClientRect();
      // Posição relativa ao centro, normalizada para -0.5 … 0.5.
      const x = (e.clientX - caixa.left) / caixa.width - 0.5;
      const y = (e.clientY - caixa.top) / caixa.height - 0.5;

      // O eixo Y do ponteiro gira em X (e vice-versa) — é o que faz a
      // inclinação parecer que o cartão "segue" o cursor.
      el.style.transform = `perspective(900px) rotateX(${-y * maxGraus}deg) rotateY(${x * maxGraus}deg)`;
    };

    const aoSair = () => {
      el.style.transform = '';
    };

    el.addEventListener('pointermove', aoMover);
    el.addEventListener('pointerleave', aoSair);

    return () => {
      el.removeEventListener('pointermove', aoMover);
      el.removeEventListener('pointerleave', aoSair);
    };
  }, [maxGraus, reduzido]);

  return (
    <div
      ref={ref}
      className={className}
      style={{ transition: 'transform var(--dur-rapida) var(--ease)' }}
    >
      {children}
    </div>
  );
}
