/**
 * `@cinesis/domain` — entidades e regras dos bounded contexts.
 *
 * ## Organização
 *
 * | Contexto        | Módulos                                    |
 * |-----------------|--------------------------------------------|
 * | Clinical Core   | `imutabilidade`, `avaliacao`, `longitudinal` |
 * | Adherence       | `adesao`, `biblioteca`                     |
 * | Platform        | `consentimento`, `eventos`                 |
 *
 * Operations (agenda, pacotes) não tem regra de domínio complexa o bastante
 * para justificar um módulo próprio — vive nos serviços da API. Criar a pasta
 * antes de existir a regra é o tipo de estrutura vazia que o princípio 7 da
 * especificação manda evitar.
 *
 * ## Uma característica comum a tudo aqui
 *
 * Nenhuma função deste pacote faz I/O. Não há acesso a banco, rede, relógio do
 * sistema (o "agora" é sempre parâmetro) nem variável de ambiente. É o que
 * permite testar a regra clínica de forma exaustiva e determinística, e o que
 * garante que a mesma regra vale em qualquer chamada — vinda da API, de um job
 * ou de um script de migração.
 */

export * from './imutabilidade.js';
export * from './avaliacao.js';
export * from './longitudinal.js';
export * from './adesao.js';
export * from './biblioteca.js';
export * from './consentimento.js';
export * from './eventos.js';
