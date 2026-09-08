/**
 * Fundo animado em Three.js para o herói da landing.
 *
 * ## O que é, e por que este e não outro
 *
 * Uma malha de pontos em onda lenta, na cor primária do tema. A escolha é
 * temática: o produto mede **movimento** e trajetória ao longo do tempo, e a
 * onda é exatamente isso — uma superfície que se desloca de forma contínua e
 * previsível. Um campo de partículas aleatórias seria bonito e não diria nada.
 *
 * ## Cuidados que um fundo 3D numa página de saúde exige
 *
 * 1. **Some no modo reduzido.** Não fica mais lento: some. Movimento contínuo
 *    de fundo é justo o que incomoda quem liga essa preferência.
 * 2. **Pausa quando a aba não está visível.** Um `requestAnimationFrame`
 *    rodando numa aba de fundo consome bateria de graça — e o público-alvo
 *    inclui gente atendendo em domicílio, no celular.
 * 3. **Teto de `devicePixelRatio` em 2.** Num celular com DPR 3, renderizar na
 *    resolução nativa custa 2,25× mais pixels sem diferença visível numa malha
 *    de pontos.
 * 4. **Segue o tema.** As cores vêm das variáveis CSS, então trocar para o
 *    modo noturno troca o fundo junto, sem recriar a cena.
 * 5. **`aria-hidden`.** É decoração. Um leitor de tela não tem o que anunciar.
 */

import { useEffect, useRef } from 'react';
// Import de TIPO apenas: nao gera codigo em runtime. O modulo em si e
// carregado sob demanda dentro do efeito — ver a nota em `FundoOnda`.
import type * as TresTipos from 'three';
import { usarPreferencias } from './preferencias.js';

/**
 * Lê uma variável CSS e converte para uma cor do Three.js.
 *
 * O Three não entende `oklch()`. A conversão passa pelo próprio navegador:
 * pintamos a cor num canvas 1×1 e lemos o RGB resultante — que é exatamente o
 * que o navegador exibiria.
 */
function corDaVariavel(
  THREE: typeof TresTipos,
  nome: string,
  alternativa: number,
): TresTipos.Color {
  if (typeof window === 'undefined') return new THREE.Color(alternativa);

  const valor = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
  if (!valor) return new THREE.Color(alternativa);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return new THREE.Color(alternativa);

    ctx.fillStyle = valor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;

    return new THREE.Color((r ?? 0) / 255, (g ?? 0) / 255, (b ?? 0) / 255);
  } catch {
    // Canvas bloqueado (política de privacidade agressiva) ou cor inválida.
    return new THREE.Color(alternativa);
  }
}

/**
 * Fundo de onda em pontos.
 *
 * @param densidade Pontos por lado da malha. 48 dá ~2.300 pontos: suave em
 *                  celular e denso o bastante para a onda ser legível.
 */
export function FundoOnda({ densidade = 48 }: { densidade?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { reduzido, temaEfetivo } = usarPreferencias();

  useEffect(() => {
    const container = containerRef.current;
    // Modo reduzido: nem monta a cena. Não é só não animar — é não baixar a
    // biblioteca, não criar contexto WebGL e não consumir GPU.
    if (!container || reduzido) return;

    /** Limpeza registrada pelo carregamento assíncrono. */
    let limpar: (() => void) | null = null;
    /** O componente ainda está montado quando o import terminar? */
    let vivo = true;

    void (async () => {
      // Import DINÂMICO: o Three.js (~600 KB) vira um chunk separado, baixado
      // só quando esta cena de fato vai existir. Quem escolheu animações
      // reduzidas — ou quem nunca chega ao herói — não paga por ele.
      const THREE = await import('three');
      if (!vivo) return;

      const desmontar = montarCena(THREE, container, temaEfetivo, densidade);
      if (!vivo) {
        // O componente desmontou enquanto o import estava em voo. Sem isto,
        // a cena ficaria rodando sem ninguém para pará-la.
        desmontar?.();
        return;
      }
      limpar = desmontar;
    })();

    return () => {
      vivo = false;
      limpar?.();
    };
  }, [densidade, reduzido, temaEfetivo]);

  return (
    <div
      ref={containerRef}
      // Decoração pura: invisível para tecnologia assistiva.
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        // Nunca intercepta clique nem seleção de texto.
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
}

/**
 * Monta a cena Three.js e devolve a função de limpeza.
 *
 * Separada do componente porque o carregamento é assíncrono: o efeito precisa
 * poder desfazer o que esta função criou, mesmo que o componente desmonte
 * antes de o import terminar.
 *
 * @returns Função que libera todos os recursos, ou `null` se o WebGL faltar.
 */
function montarCena(
  THREE: typeof TresTipos,
  container: HTMLDivElement,
  temaEfetivo: 'claro' | 'escuro',
  densidade: number,
): (() => void) | null {
    // --- Cena, câmera, renderizador ----------------------------------------
    const cena = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.1,
      100,
    );
    camera.position.set(0, 3.2, 7);
    camera.lookAt(0, 0, 0);

    let renderizador: TresTipos.WebGLRenderer;
    try {
      renderizador = new THREE.WebGLRenderer({
        // Transparente: o gradiente do herói continua visível por baixo.
        alpha: true,
        antialias: true,
        // `low-power` pede a GPU integrada em máquinas com duas placas. Um
        // fundo decorativo não justifica ligar a GPU dedicada de um notebook.
        powerPreference: 'low-power',
      });
    } catch {
      // WebGL indisponível (driver antigo, VM, política corporativa). O herói
      // continua funcionando com os gradientes CSS — só sem a onda.
      return null;
    }

    // Teto de 2 no DPR: ver a nota no topo do arquivo.
    renderizador.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderizador.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderizador.domElement);

    // --- Geometria: uma grade de pontos no plano XZ ------------------------
    const posicoes = new Float32Array(densidade * densidade * 3);
    const largura = 18;
    const passo = largura / (densidade - 1);

    for (let i = 0; i < densidade; i++) {
      for (let j = 0; j < densidade; j++) {
        const indice = (i * densidade + j) * 3;
        posicoes[indice] = -largura / 2 + j * passo; // x
        posicoes[indice + 1] = 0; // y — animado a cada quadro
        posicoes[indice + 2] = -largura / 2 + i * passo; // z
      }
    }

    const geometria = new THREE.BufferGeometry();
    geometria.setAttribute('position', new THREE.BufferAttribute(posicoes, 3));

    const material = new THREE.PointsMaterial({
      color: corDaVariavel(THREE, '--pri', 0x2f6f6a),
      size: 0.055,
      transparent: true,
      // Discreto de propósito: é fundo, não conteúdo.
      opacity: temaEfetivo === 'escuro' ? 0.5 : 0.34,
      // Pontos distantes não encolhem: mantém a densidade visual uniforme.
      sizeAttenuation: true,
    });

    const pontos = new THREE.Points(geometria, material);
    cena.add(pontos);

    // --- Laço de animação ---------------------------------------------------
    const atributo = geometria.getAttribute('position') as TresTipos.BufferAttribute;
    let quadro = 0;
    let rodando = true;
    const inicio = performance.now();

    const animar = () => {
      if (!rodando) return;

      // Tempo em segundos, desacelerado. A onda leva ~25 s para dar uma volta
      // completa: presente, mas nunca competindo com o texto por atenção.
      const t = (performance.now() - inicio) / 1000;

      for (let i = 0; i < densidade; i++) {
        for (let j = 0; j < densidade; j++) {
          const indice = i * densidade + j;
          const x = atributo.getX(indice);
          const z = atributo.getZ(indice);

          // Duas senoides cruzadas, com frequências diferentes: o resultado
          // não se repete de forma óbvia, que é o que faz parecer orgânico.
          const y =
            Math.sin(x * 0.42 + t * 0.55) * 0.42 + Math.cos(z * 0.36 + t * 0.38) * 0.34;

          atributo.setY(indice, y);
        }
      }

      // Sem isto, o Three não reenvia o buffer para a GPU e nada se move.
      atributo.needsUpdate = true;

      // Rotação lenta do conjunto: dá profundidade sem exigir mais geometria.
      pontos.rotation.y = Math.sin(t * 0.06) * 0.12;

      renderizador.render(cena, camera);
      quadro = requestAnimationFrame(animar);
    };

    quadro = requestAnimationFrame(animar);

    // --- Pausa em aba oculta ------------------------------------------------
    const aoTrocarVisibilidade = () => {
      if (document.hidden) {
        rodando = false;
        cancelAnimationFrame(quadro);
      } else if (!rodando) {
        rodando = true;
        quadro = requestAnimationFrame(animar);
      }
    };
    document.addEventListener('visibilitychange', aoTrocarVisibilidade);

    // --- Redimensionamento --------------------------------------------------
    // `ResizeObserver` em vez de `window.resize`: pega também mudança de layout
    // que não vem de redimensionar a janela (abrir uma barra lateral, por ex.).
    const observador = new ResizeObserver(() => {
      const l = container.clientWidth;
      const a = container.clientHeight;
      if (l === 0 || a === 0) return;

      camera.aspect = l / a;
      camera.updateProjectionMatrix();
      renderizador.setSize(l, a);
    });
    observador.observe(container);

    // --- Limpeza ------------------------------------------------------------
    return () => {
      rodando = false;
      cancelAnimationFrame(quadro);
      document.removeEventListener('visibilitychange', aoTrocarVisibilidade);
      observador.disconnect();

      // Recursos de GPU não são coletados pelo garbage collector do JS.
      // Sem estes `dispose`, navegar entre páginas vaza memória de vídeo até
      // o navegador derrubar o contexto WebGL.
      geometria.dispose();
      material.dispose();
      renderizador.dispose();

      container.removeChild(renderizador.domElement);
  };
}
