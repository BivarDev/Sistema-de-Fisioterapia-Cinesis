/**
 * Componentes básicos do design system.
 *
 * Todos usam **exclusivamente** variáveis CSS dos tokens. Nenhuma cor literal
 * aparece aqui — é isso que faz o tema noturno funcionar sem duplicar código, e
 * é o que impede que uma tela nova use um verde ligeiramente diferente.
 */

import type { CSSProperties, ReactNode } from 'react';

/** Tons semânticos. `ink` é o neutro. */
export type Tom = 'pri' | 'acc' | 'good' | 'bad' | 'ink';

/** Mapa de tom → variáveis de cor. Ponto único de tradução. */
const CORES: Record<Tom, { fundo: string; texto: string; borda: string }> = {
  pri: { fundo: 'var(--pri-soft)', texto: 'var(--pri-on-soft)', borda: 'var(--pri)' },
  acc: { fundo: 'var(--acc-soft)', texto: 'var(--acc-on-soft)', borda: 'var(--acc)' },
  good: { fundo: 'var(--good-soft)', texto: 'var(--good)', borda: 'var(--good)' },
  bad: { fundo: 'var(--bad-soft)', texto: 'var(--bad)', borda: 'var(--bad)' },
  ink: { fundo: 'var(--surface2)', texto: 'var(--ink2)', borda: 'var(--line)' },
};

/**
 * Etiqueta arredondada de estado.
 *
 * Usada em situação de paciente, estado de sessão e estado de publicação.
 * A cor **sempre** acompanha um texto — cor sozinha não comunica a quem não
 * distingue as duas, e num sistema clínico isso vira erro de leitura.
 */
export function Pill({
  children,
  tom = 'ink',
  className = '',
}: {
  children: ReactNode;
  tom?: Tom;
  className?: string;
}) {
  const c = CORES[tom];
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 'var(--r-pill)',
        background: c.fundo,
        color: c.texto,
        fontSize: 11.5,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

/** Cartão: superfície com borda. Sombra só no hover, quando `interativo`. */
export function Cartao({
  children,
  className = '',
  tom,
  interativo = false,
  style,
  ...resto
}: {
  children: ReactNode;
  className?: string | undefined;
  /**
   * Preenche fundo e borda com o tom. Para cartões de destaque.
   *
   * `| undefined` explicito: sob `exactOptionalPropertyTypes`, passar
   * `tom={condicao ? 'pri' : undefined}` seria recusado sem ele.
   */
  tom?: Tom | undefined;
  /** Liga a elevação no hover. */
  interativo?: boolean | undefined;
  style?: CSSProperties | undefined;
} & React.HTMLAttributes<HTMLDivElement>) {
  const c = tom ? CORES[tom] : null;

  return (
    <div
      className={`${className} ${interativo ? 'cartao-interativo' : ''}`}
      style={{
        background: c ? c.fundo : 'var(--surface)',
        border: `1px solid ${c ? c.borda : 'var(--line)'}`,
        borderRadius: 'var(--r-cartao)',
        padding: 22,
        transition: `transform var(--dur-rapida) var(--ease), box-shadow var(--dur-rapida) var(--ease)`,
        ...style,
      }}
      {...resto}
    >
      {children}
    </div>
  );
}

/** Botão. Três variantes, e nenhuma decorativa. */
export function Botao({
  children,
  variante = 'primario',
  tamanho = 'medio',
  className = '',
  ...resto
}: {
  children: ReactNode;
  variante?: 'primario' | 'secundario' | 'perigo';
  tamanho?: 'pequeno' | 'medio' | 'grande';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const paddings = {
    pequeno: '7px 12px',
    medio: '10px 18px',
    // 14px de padding vertical + line-height dá ~46px de altura: acima do
    // mínimo de 44px para alvo de toque, exigido no portal do paciente.
    grande: '14px 24px',
  };

  const estilos: Record<string, CSSProperties> = {
    primario: { background: 'var(--pri)', color: 'var(--pri-ink)', border: '1px solid var(--pri)' },
    secundario: {
      background: 'var(--surface)',
      color: 'var(--ink)',
      border: '1px solid var(--line2)',
    },
    perigo: { background: 'var(--bad)', color: 'var(--surface)', border: '1px solid var(--bad)' },
  };

  return (
    <button
      className={`botao ${className}`}
      style={{
        padding: paddings[tamanho],
        borderRadius: 'var(--r-botao)',
        fontSize: tamanho === 'pequeno' ? 12.5 : 13.5,
        fontWeight: 700,
        // `min-height` garante o alvo de toque mesmo se o conteúdo for curto.
        minHeight: tamanho === 'grande' ? 44 : undefined,
        transition: `filter var(--dur-rapida) var(--ease), transform var(--dur-rapida) var(--ease)`,
        ...estilos[variante],
      }}
      {...resto}
    >
      {children}
    </button>
  );
}

/**
 * Barra de progresso.
 *
 * A cor sai da própria taxa: verde ≥ 70, âmbar ≥ 50, vermelho abaixo. Os cortes
 * vêm da tela de adesão e ficam aqui para que toda barra do sistema use os
 * mesmos — uma tela pintando 60% de verde e outra de âmbar seria pior que não
 * ter cor nenhuma.
 */
export function Barra({
  valor,
  altura = 6,
  tom,
}: {
  /** 0 a 100. */
  valor: number;
  altura?: number;
  /** Força um tom, ignorando os cortes automáticos. */
  tom?: Tom | undefined;
}) {
  const automatico: Tom = valor >= 70 ? 'good' : valor >= 50 ? 'acc' : 'bad';
  const cor = tom ? CORES[tom].borda : CORES[automatico].borda;

  return (
    <div
      // Semântica de barra de progresso: um leitor de tela anuncia o valor.
      role="progressbar"
      aria-valuenow={valor}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        height: altura,
        background: 'var(--surface3)',
        borderRadius: 'var(--r-pill)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          // Prende entre 0 e 100: um valor calculado errado não deve estourar
          // o layout da tabela inteira.
          width: `${Math.min(100, Math.max(0, valor))}%`,
          height: '100%',
          background: cor,
          borderRadius: 'var(--r-pill)',
          transition: `width var(--dur) var(--ease)`,
        }}
      />
    </div>
  );
}

/** Título de seção com subtítulo opcional. */
export function TituloSecao({
  titulo,
  subtitulo,
  acao,
}: {
  titulo: string;
  subtitulo?: string;
  acao?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 16,
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: 15.5, fontWeight: 800, letterSpacing: '-0.01em' }}>
          {titulo}
        </h2>
        {subtitulo && (
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--ink2)', maxWidth: '62ch' }}>
            {subtitulo}
          </p>
        )}
      </div>
      {acao}
    </div>
  );
}

/**
 * Avatar circular com iniciais.
 *
 * Quando o ator não pode reidentificar, recebe o **código** (`PC-4821`) em vez
 * do nome — e as iniciais viram os caracteres do código. É consistente com a
 * pseudonimização: nem as iniciais do nome real escapam.
 */
export function Avatar({ nome, tamanho = 32 }: { nome: string; tamanho?: number }) {
  const iniciais = nome
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <div
      aria-hidden="true"
      style={{
        width: tamanho,
        height: tamanho,
        borderRadius: '50%',
        background: 'var(--pri-soft)',
        color: 'var(--pri-on-soft)',
        display: 'grid',
        placeItems: 'center',
        fontSize: tamanho * 0.36,
        fontWeight: 800,
        flexShrink: 0,
      }}
    >
      {iniciais}
    </div>
  );
}

/**
 * Placeholder explícito de mídia ausente.
 *
 * A hachura diagonal e a legenda deixam claro que ali **vai** entrar conteúdo
 * real. É melhor que uma caixa cinza silenciosa: quem instalar o sistema
 * precisa saber que aquele vídeo é responsabilidade dele, com licença própria.
 */
export function EspacoDeMidia({
  legenda,
  altura = 120,
}: {
  legenda: string;
  altura?: number;
}) {
  return (
    <div
      style={{
        height: altura,
        borderRadius: 'var(--r-badge)',
        border: '1px dashed var(--line2)',
        background:
          'repeating-linear-gradient(135deg, var(--surface2) 0 8px, var(--surface) 8px 16px)',
        display: 'grid',
        placeItems: 'center',
        padding: 12,
        textAlign: 'center',
      }}
    >
      <span className="mono" style={{ fontSize: 10 }}>
        {legenda}
      </span>
    </div>
  );
}

/**
 * Seletor segmentado. Usado para tema, modo de animação e filtros.
 *
 * Implementado com `role="radiogroup"`: um leitor de tela anuncia "1 de 2
 * selecionado", e as setas navegam entre as opções. Um `<div>` com `onClick`
 * não daria nada disso.
 */
export function Segmentado<T extends string>({
  opcoes,
  valor,
  aoMudar,
  rotulo,
}: {
  opcoes: { valor: T; rotulo: string }[];
  valor: T;
  aoMudar: (v: T) => void;
  rotulo: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={rotulo}
      style={{
        display: 'inline-flex',
        background: 'var(--surface2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-botao)',
        padding: 3,
        gap: 3,
      }}
    >
      {opcoes.map((o) => {
        const ativo = o.valor === valor;
        return (
          <button
            key={o.valor}
            role="radio"
            aria-checked={ativo}
            onClick={() => aoMudar(o.valor)}
            style={{
              padding: '6px 13px',
              borderRadius: 'calc(var(--r-botao) - 3px)',
              border: 'none',
              background: ativo ? 'var(--surface)' : 'transparent',
              color: ativo ? 'var(--ink)' : 'var(--ink2)',
              fontSize: 12.5,
              fontWeight: ativo ? 700 : 500,
              boxShadow: ativo ? 'var(--shadow)' : 'none',
              transition: `background var(--dur-rapida) var(--ease), color var(--dur-rapida) var(--ease)`,
            }}
          >
            {o.rotulo}
          </button>
        );
      })}
    </div>
  );
}
