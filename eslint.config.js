/**
 * Configuração do ESLint.
 *
 * ## A regra que este arquivo existe para ter
 *
 * A especificação pede: *"logs técnicos, métricas e telemetria de aplicação não
 * podem carregar PII nem dado clínico — isso precisa ser regra de lint/revisão,
 * não confiança na disciplina de quem escreve o log."*
 *
 * A regra `no-restricted-syntax` no final deste arquivo é essa exigência,
 * implementada. Ela é a **segunda** camada: a primeira é o redator em
 * `packages/security/src/redacao.ts`, que roda no serializador do logger e
 * funciona mesmo quando alguém erra.
 *
 * As duas se complementam: o redator protege em runtime; o lint educa em tempo
 * de escrita e evita que o código chegue à revisão com o erro dentro.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Nada gerado entra no lint.
    ignores: ['**/dist/**', '**/node_modules/**', '**/.data/**', '**/coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // --- Qualidade geral ---------------------------------------------------
      // Parâmetro intencionalmente não usado leva `_` no início. Sem esta
      // exceção, todo handler do Fastify que ignora `reply` viraria um aviso.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // `any` desliga o verificador de tipos exatamente onde ele mais importa.
      '@typescript-eslint/no-explicit-any': 'error',

      // `console` fora do log estruturado escapa da redação. As poucas exceções
      // legítimas (scripts de terminal, falha antes de o logger existir) estão
      // marcadas com `eslint-disable` e um comentário explicando.
      'no-console': 'error',

      // Comparação frouxa esconde bug de tipo.
      eqeqeq: ['error', 'always'],

      // --- A regra do requisito ----------------------------------------------
      'no-restricted-syntax': [
        'error',
        {
          // Nome de entidade com PII passado direto ao logger.
          //
          // Pega `log.info({ paciente })`, `log.error({ pii })` e afins. Não
          // pega tudo — nenhuma regra sintática pegaria —, mas cobre o caminho
          // pelo qual isso de fato acontece: alguém logando o objeto inteiro
          // que tem em mãos para depurar, e esquecendo de tirar.
          selector:
            'CallExpression[callee.property.name=/^(info|warn|error|debug|trace|fatal|log)$/] > ObjectExpression > Property[key.name=/^(paciente|pacienteIdentificacao|pii|nome|cpf|documento|telefone|nascimento|anamnese|conduta|evolucao|prontuario|registroClinico)$/]',
          message:
            'Não logue PII nem dado clínico. Use o identificador (pacienteId) ou o código pseudonimizado. Ver docs/security-model.md.',
        },
        {
          // Variável de ambiente lida direto, fora de `config.ts`.
          //
          // O ponto de `config.ts` é validar tudo na subida e derrubar o
          // processo se faltar algo. Um `process.env.X` espalhado pelo código
          // fura isso e reintroduz o "sobe, atende, e só descobre semanas
          // depois que estava com a chave de exemplo".
          selector:
            'MemberExpression[object.object.name="process"][object.property.name="env"]',
          message:
            'Leia variáveis de ambiente apenas em apps/api/src/config.ts, que valida tudo na inicialização.',
        },
        {
          // `SET` sem `LOCAL` numa transação com tenant.
          //
          // O valor ficaria na conexão do pool e a requisição seguinte, de
          // outra clínica, herdaria o tenant errado. É um bug de isolamento
          // entre organizações que não produz erro nenhum — só dado errado.
          selector: 'Literal[value=/SET\\s+(?!LOCAL)(ROLE|app\\.)/i]',
          message:
            'Use SET LOCAL (ou set_config com o terceiro argumento true) dentro de transação. SET sem LOCAL vaza o tenant para a próxima requisição da conexão.',
        },
      ],
    },
  },

  {
    // Scripts de orquestração rodam em Node puro, fora de qualquer workspace
    // com `@types/node`. Declaramos os globais que eles usam.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },

  {
    // --- Exceções conscientes ------------------------------------------------
    // Scripts de terminal e semeadura existem para falar com quem os executa.
    files: ['scripts/**', '**/db/semear.ts', '**/db/aplicar-schema.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // O ponto de entrada precisa reportar falha de configuração antes de o
    // logger existir, e `config.ts` é o único lugar que pode ler `process.env`.
    files: ['**/servidor.ts', '**/config.ts'],
    rules: { 'no-console': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    // Testes montam ambientes e objetos de mentira; as restrições de produção
    // não se aplicam.
    files: ['**/test/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);
