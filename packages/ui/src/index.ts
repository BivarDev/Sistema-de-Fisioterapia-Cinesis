/**
 * `@cinesis/ui` — design system compartilhado entre a aplicação profissional e
 * o portal do paciente.
 *
 * ## O que este pacote garante
 *
 * - **Um tema só, dois modos.** Claro e noturno saem das mesmas variáveis;
 *   nenhuma tela precisa saber qual está ativo.
 * - **Dois modos de animação, aplicados de verdade.** Cada gancho e cada
 *   componente daqui consulta as preferências por conta própria — não é um
 *   `if` que o consumidor pode esquecer.
 * - **Nenhuma cor literal.** Tudo vem dos tokens; um verde novo em alguma tela
 *   é um bug visível na revisão.
 *
 * O consumidor importa o CSS uma vez:
 * ```ts
 * import '@cinesis/ui/estilos.css';
 * ```
 */

export * from './animacao/preferencias.js';
export * from './animacao/ganchos.js';
export * from './animacao/Texto.js';
export * from './animacao/FundoTresD.js';
export * from './componentes/basicos.js';
export * from './componentes/graficos.js';
