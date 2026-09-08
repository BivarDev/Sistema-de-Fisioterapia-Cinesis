/**
 * Papéis (roles) e permissões do Cinesis.
 *
 * Este arquivo é a ÚNICA fonte da verdade sobre "quem pode o quê". Backend e
 * frontend importam daqui, então não existe divergência entre o que a interface
 * esconde e o que a API realmente permite — a interface esconder um botão é
 * conveniência; o backend negar é a segurança de fato.
 *
 * Referência: matriz RBAC da seção "Modelo de segurança" do handoff de design.
 */

/** Papéis possíveis dentro de uma organização (tenant). */
export const PAPEIS = ['fisioterapeuta', 'recepcao', 'estagiario', 'paciente'] as const;

/** Tipo de um papel. Derivado do array acima para nunca sair de sincronia. */
export type Papel = (typeof PAPEIS)[number];

/**
 * Permissões atômicas do sistema.
 *
 * Regra de nomenclatura: `recurso:acao`. Sempre no infinitivo e no singular.
 * Ao criar uma permissão nova, adicione-a aqui e depois em `PERMISSOES_POR_PAPEL`
 * — o TypeScript quebra a build se você esquecer de algum papel.
 */
export const PERMISSOES = [
  // --- Clinical Core ---------------------------------------------------------
  'prontuario:ler', // Ler avaliações, evoluções e reavaliações dentro do escopo.
  'prontuario:escrever', // Criar/editar registro clínico enquanto ele está em rascunho.
  'prontuario:finalizar', // Selar o registro (assinatura + CREFITO). Torna-o imutável.
  'plano:ler', // Ler planos de tratamento.
  'plano:escrever', // Criar e alterar planos de tratamento.
  'paciente:ler', // Listar/ler pacientes (sempre pseudonimizado por padrão).
  'paciente:escrever', // Cadastrar e editar dados do paciente.
  'paciente:reidentificar', // Religar código pseudonimizado à PII real. Operação auditada.

  // --- Adherence -------------------------------------------------------------
  'hep:prescrever', // Criar prescrição de exercício domiciliar.
  'hep:ler', // Ver prescrições e painel de adesão.
  'biblioteca:ler', // Ver o catálogo de exercícios.
  'biblioteca:escrever', // Criar/editar exercício (entra como rascunho).
  'biblioteca:publicar', // Mover exercício de `in_review` para `published`.

  // --- Operations ------------------------------------------------------------
  'agenda:ler', // Ver a agenda da organização.
  'agenda:escrever', // Criar, remarcar e cancelar sessões.
  'financeiro:ler', // Ver pacotes, saldos e pagamentos.
  'financeiro:escrever', // Registrar pagamento e emitir recibo.

  // --- Platform --------------------------------------------------------------
  'auditoria:ler', // Ler a trilha de auditoria.
  'organizacao:administrar', // Convidar profissionais, mudar papéis, configurar a org.
  'portal:proprio', // Acessar o portal do paciente (escopo do próprio paciente).
] as const;

/** Tipo de uma permissão. */
export type Permissao = (typeof PERMISSOES)[number];

/**
 * Nível de acesso de um papel a uma permissão.
 *
 * - `total`    — acesso completo dentro do escopo da organização.
 * - `restrito` — acesso apenas ao escopo supervisionado (ex.: estagiário vê só
 *                os pacientes do supervisor a que está vinculado).
 * - `negado`   — sem acesso. A API responde 404 (não 403) para não confirmar
 *                a existência do recurso.
 */
export type Nivel = 'total' | 'restrito' | 'negado';

/**
 * Matriz RBAC completa.
 *
 * `Record<Papel, Record<Permissao, Nivel>>` força exaustividade: se você criar
 * um papel ou uma permissão e não preencher aqui, a compilação falha. Isso é
 * deliberado — uma permissão esquecida não pode "cair no default permissivo".
 */
export const PERMISSOES_POR_PAPEL: Record<Papel, Record<Permissao, Nivel>> = {
  fisioterapeuta: {
    'prontuario:ler': 'total',
    'prontuario:escrever': 'total',
    'prontuario:finalizar': 'total',
    'plano:ler': 'total',
    'plano:escrever': 'total',
    'paciente:ler': 'total',
    'paciente:escrever': 'total',
    'paciente:reidentificar': 'total',
    'hep:prescrever': 'total',
    'hep:ler': 'total',
    'biblioteca:ler': 'total',
    'biblioteca:escrever': 'total',
    'biblioteca:publicar': 'total',
    'agenda:ler': 'total',
    'agenda:escrever': 'total',
    'financeiro:ler': 'total',
    'financeiro:escrever': 'total',
    'auditoria:ler': 'total',
    'organizacao:administrar': 'total',
    'portal:proprio': 'negado',
  },
  recepcao: {
    // Recepção opera a clínica, mas NÃO lê prontuário. Esse é o ponto inteiro
    // de separar os papéis: quem marca consulta não precisa ver evolução clínica.
    'prontuario:ler': 'negado',
    'prontuario:escrever': 'negado',
    'prontuario:finalizar': 'negado',
    'plano:ler': 'negado',
    'plano:escrever': 'negado',
    'paciente:ler': 'total', // Vê o cadastro (para agendar), não o conteúdo clínico.
    'paciente:escrever': 'total',
    'paciente:reidentificar': 'negado',
    'hep:prescrever': 'negado',
    'hep:ler': 'negado',
    'biblioteca:ler': 'negado',
    'biblioteca:escrever': 'negado',
    'biblioteca:publicar': 'negado',
    'agenda:ler': 'total',
    'agenda:escrever': 'total',
    'financeiro:ler': 'total',
    'financeiro:escrever': 'total',
    'auditoria:ler': 'negado',
    'organizacao:administrar': 'negado',
    'portal:proprio': 'negado',
  },
  estagiario: {
    // Estagiário vê e escreve dentro do escopo supervisionado, mas nunca assina
    // (a assinatura carrega o CREFITO de um profissional habilitado) e nunca
    // reidentifica PII.
    'prontuario:ler': 'restrito',
    'prontuario:escrever': 'restrito',
    'prontuario:finalizar': 'negado',
    'plano:ler': 'restrito',
    'plano:escrever': 'negado',
    'paciente:ler': 'restrito',
    'paciente:escrever': 'negado',
    'paciente:reidentificar': 'negado',
    'hep:prescrever': 'restrito',
    'hep:ler': 'restrito',
    'biblioteca:ler': 'total',
    'biblioteca:escrever': 'total', // Pode propor exercício — entra como rascunho.
    'biblioteca:publicar': 'negado', // Mas não publica: publicação exige revisão clínica.
    'agenda:ler': 'restrito',
    'agenda:escrever': 'negado',
    'financeiro:ler': 'negado',
    'financeiro:escrever': 'negado',
    'auditoria:ler': 'negado',
    'organizacao:administrar': 'negado',
    'portal:proprio': 'negado',
  },
  paciente: {
    // O paciente vive num contexto isolado (app /portal). Ele nunca toca a API
    // profissional; a única permissão que carrega é o próprio portal.
    'prontuario:ler': 'negado',
    'prontuario:escrever': 'negado',
    'prontuario:finalizar': 'negado',
    'plano:ler': 'negado',
    'plano:escrever': 'negado',
    'paciente:ler': 'negado',
    'paciente:escrever': 'negado',
    'paciente:reidentificar': 'negado',
    'hep:prescrever': 'negado',
    'hep:ler': 'negado',
    'biblioteca:ler': 'negado',
    'biblioteca:escrever': 'negado',
    'biblioteca:publicar': 'negado',
    'agenda:ler': 'negado',
    'agenda:escrever': 'negado',
    'financeiro:ler': 'negado',
    'financeiro:escrever': 'negado',
    'auditoria:ler': 'negado',
    'organizacao:administrar': 'negado',
    'portal:proprio': 'total',
  },
};

/**
 * Consulta o nível de acesso de um papel a uma permissão.
 *
 * @param papel     Papel do ator na organização corrente.
 * @param permissao Permissão pretendida.
 * @returns         `total`, `restrito` ou `negado`.
 */
export function nivelDe(papel: Papel, permissao: Permissao): Nivel {
  return PERMISSOES_POR_PAPEL[papel][permissao];
}

/**
 * Atalho booleano: o papel tem QUALQUER acesso a essa permissão?
 *
 * Cuidado: `true` aqui inclui `restrito`. Quem precisa saber se o acesso é
 * completo deve comparar com `'total'` explicitamente — a diferença entre
 * "vê tudo da organização" e "vê só o escopo supervisionado" é aplicada na
 * cláusula WHERE da consulta, nunca depois de buscar.
 */
export function podeAlgo(papel: Papel, permissao: Permissao): boolean {
  return nivelDe(papel, permissao) !== 'negado';
}

/**
 * Rótulo legível de cada papel, para exibir na interface.
 * Mantido aqui (e não no frontend) para que web e portal usem o mesmo texto.
 */
export const ROTULO_PAPEL: Record<Papel, string> = {
  fisioterapeuta: 'Fisioterapeuta',
  recepcao: 'Recepção',
  estagiario: 'Estagiário',
  paciente: 'Paciente',
};
