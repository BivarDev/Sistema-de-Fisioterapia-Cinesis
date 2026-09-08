/**
 * Ganchos (hooks) de animação: rolagem suave, revelação no scroll e contadores.
 *
 * ## Regra que vale para todos
 *
 * Todo gancho aqui **respeita o modo reduzido**. Não é uma opção do chamador:
 * o gancho consulta as preferências por conta própria. Deixar isso a cargo de
 * quem chama garantiria que, em algum componente, alguém esqueceria — e o
 * usuário que pediu "sem movimento" veria movimento.
 *
 * No modo reduzido cada gancho vai direto ao estado final. A informação é
 * exatamente a mesma; só o caminho até ela é instantâneo.
 */

import { useEffect, useRef, useState } from 'react';
import Lenis from 'lenis';
import { usarPreferencias } from './preferencias.js';

/**
 * Rolagem suave da página (Lenis).
 *
 * ## Por que Lenis e não `scroll-behavior: smooth`
 *
 * O CSS nativo só suaviza saltos programáticos (clique em âncora). Ele não
 * toca na rolagem por roda do mouse ou trackpad, que é 99% da rolagem real.
 * O Lenis interpola a posição a cada quadro, o que dá a inércia contínua que a
 * especificação pede — e, de quebra, um relógio único para sincronizar com o
 * GSAP.
 *
 * **Só na landing.** Dentro do sistema, rolagem com inércia atrapalha: o
 * profissional quer que a lista pare onde ele soltou, não que continue
 * deslizando por mais meio segundo enquanto procura um paciente.
 *
 * @param ativo `false` desliga sem desmontar o componente.
 */
export function usarScrollSuave(ativo = true): void {
  const { reduzido } = usarPreferencias();

  useEffect(() => {
    // Movimento reduzido ⇒ rolagem nativa. Interpolação de posição é
    // exatamente o tipo de movimento que quem liga essa preferência quer evitar.
    if (!ativo || reduzido) return;

    const lenis = new Lenis({
      // ~1s para assentar: perceptível como suavidade, sem parecer travado.
      duration: 1.05,
      // Exponencial de saída: rápido no começo, desacelerando no fim. É a
      // curva que o olho lê como "peso", em vez de "atraso".
      easing: (t: number) => Math.min(1, 1.001 - 2 ** (-10 * t)),
      // Toque em celular fica nativo: o navegador móvel já faz isso melhor, e
      // interceptar quebra o "puxar para atualizar" e a rolagem em iOS.
      smoothWheel: true,
      touchMultiplier: 2,
    });

    let quadro = 0;
    const animar = (tempo: number) => {
      lenis.raf(tempo);
      quadro = requestAnimationFrame(animar);
    };
    quadro = requestAnimationFrame(animar);

    return () => {
      cancelAnimationFrame(quadro);
      lenis.destroy();
    };
  }, [ativo, reduzido]);
}

/**
 * Revela elementos ao entrarem na viewport.
 *
 * Aplique `data-reveal` no elemento; o gancho troca para `data-reveal="visivel"`
 * quando ele aparece, e o CSS anima a transição.
 *
 * ## Duas decisões
 *
 * - **`unobserve` depois de revelar.** O elemento aparece uma vez e pronto.
 *   Sem isso, rolar para cima e para baixo repetiria a animação, o que é
 *   irritante e caro.
 * - **`rootMargin` negativo no rodapé.** O elemento começa a animar quando já
 *   entrou 6% na tela, não no instante em que encosta na borda — senão a
 *   animação termina antes de o usuário conseguir vê-la.
 *
 * @param dependencias Redispara a varredura quando muda (ex.: troca de tela).
 */
export function usarRevelacao(dependencias: unknown[] = []): void {
  const { reduzido } = usarPreferencias();

  useEffect(() => {
    const alvos = document.querySelectorAll<HTMLElement>('[data-reveal]');

    // No modo reduzido, tudo já nasce visível (o CSS cuida). Marcamos assim
    // mesmo para que qualquer lógica que leia o atributo veja o estado final.
    if (reduzido) {
      alvos.forEach((el) => {
        el.dataset.reveal = 'visivel';
      });
      return;
    }

    const observador = new IntersectionObserver(
      (entradas) => {
        for (const entrada of entradas) {
          if (!entrada.isIntersecting) continue;
          (entrada.target as HTMLElement).dataset.reveal = 'visivel';
          // Uma vez revelado, para de observar: menos trabalho por quadro.
          observador.unobserve(entrada.target);
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -6% 0px' },
    );

    alvos.forEach((el) => {
      if (el.dataset.reveal !== 'visivel') observador.observe(el);
    });

    return () => observador.disconnect();
    // As dependências extras vêm do chamador: é assim que uma tela redispara a
    // varredura ao trocar de conteúdo.
  }, [reduzido, ...dependencias]);
}

/**
 * Contador animado de 0 até o alvo.
 *
 * @param alvo     Valor final.
 * @param duracao  Duração em ms.
 * @param iniciar  `false` segura o contador em 0 até virar `true`.
 * @returns        O valor corrente, para renderizar.
 */
export function usarContador(alvo: number, duracao = 900, iniciar = true): number {
  const { reduzido } = usarPreferencias();
  // No modo reduzido o valor já nasce no alvo — nada de contar de 0 a 78.
  const [valor, setValor] = useState(reduzido ? alvo : 0);
  const quadroRef = useRef(0);

  useEffect(() => {
    if (reduzido || !iniciar) {
      setValor(reduzido ? alvo : 0);
      return;
    }

    const inicio = performance.now();

    const passo = (agora: number) => {
      const p = Math.min(1, (agora - inicio) / duracao);
      // Easing cúbico de saída: desacelera no fim, como o número "chegando"
      // ao lugar em vez de parar de repente.
      const eased = 1 - (1 - p) ** 3;
      setValor(Math.round(alvo * eased));

      if (p < 1) quadroRef.current = requestAnimationFrame(passo);
    };

    quadroRef.current = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(quadroRef.current);
  }, [alvo, duracao, iniciar, reduzido]);

  return valor;
}

/**
 * Dispara quando o elemento entra na viewport. Para contadores e gráficos que
 * só devem animar quando o usuário chega neles.
 *
 * @returns `[ref, visivel]` — anexe a `ref` ao elemento.
 */
export function usarNaTela<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const { reduzido } = usarPreferencias();
  const [visivel, setVisivel] = useState(reduzido);

  useEffect(() => {
    if (reduzido) {
      setVisivel(true);
      return;
    }

    const el = ref.current;
    if (!el) return;

    const observador = new IntersectionObserver(
      ([entrada]) => {
        if (entrada?.isIntersecting) {
          setVisivel(true);
          observador.disconnect();
        }
      },
      { threshold: 0.25 },
    );

    observador.observe(el);
    return () => observador.disconnect();
  }, [reduzido]);

  return [ref, visivel];
}

/**
 * Rola o container de conteúdo para o topo.
 *
 * Chamado ao trocar de tela: sem isso, o usuário que estava no fim de uma lista
 * longa abre a tela seguinte já no meio dela, sem entender por quê.
 */
export function rolarParaTopo(seletor = '[data-scroll-conteudo]'): void {
  const el = document.querySelector<HTMLElement>(seletor);
  // `instant` de propósito: isto não é navegação do usuário, é reposicionamento
  // do sistema. Animar seria mostrar um movimento que ninguém pediu.
  el?.scrollTo({ top: 0, behavior: 'instant' });
}
