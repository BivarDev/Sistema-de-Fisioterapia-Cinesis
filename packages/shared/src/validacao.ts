/**
 * Schemas Zod de validação de entrada.
 *
 * Regra do projeto: **nenhum handler de rota toca em `request.body` cru.**
 * Todo corpo, query e parâmetro passa por um schema daqui primeiro. Isso dá
 * três coisas de graça:
 *
 * 1. Rejeição de campo desconhecido (`.strict()`), que fecha mass assignment.
 * 2. Limite de tamanho em toda string, que fecha uma classe inteira de DoS.
 * 3. Um único lugar para auditar o que o sistema aceita como entrada.
 */

import { z } from 'zod';
import { PAPEIS } from './papeis.js';

// ---------------------------------------------------------------------------
// Primitivas reaproveitadas
// ---------------------------------------------------------------------------

/**
 * Identificador de recurso. Sempre UUID.
 *
 * Nunca use inteiro sequencial em rota pública: id previsível convida
 * enumeração (IDOR). UUID v7 mantém ordenação temporal sem ser adivinhável.
 */
export const zId = z.string().uuid('Identificador inválido.');

/** Texto curto de formulário. 200 caracteres cobre nome, título, rótulo. */
export const zTextoCurto = z.string().trim().min(1, 'Campo obrigatório.').max(200);

/** Texto longo (conduta, anamnese). O teto evita corpo gigante como vetor de DoS. */
export const zTextoLongo = z.string().trim().max(5_000);

/** Escala visual analógica de dor: inteiro de 0 a 10. */
export const zEva = z.number().int().min(0).max(10);

/**
 * E-mail.
 *
 * `.toLowerCase()` normaliza antes de comparar/armazenar — sem isso,
 * `Ana@x.com` e `ana@x.com` viram duas contas e o rate limit por e-mail vaza.
 */
export const zEmail = z.string().trim().toLowerCase().email('E-mail inválido.').max(254);

/**
 * Senha.
 *
 * Mínimo de 12 caracteres, sem exigência de "1 maiúscula + 1 símbolo".
 * Essa exigência é contraproducente: empurra o usuário para `Senha@123`.
 * O que realmente importa é comprimento + checagem contra senhas vazadas,
 * que acontece no serviço de autenticação (`packages/security`).
 * O teto de 128 evita DoS por hash de entrada gigante no Argon2.
 */
export const zSenha = z
  .string()
  .min(12, 'A senha precisa de ao menos 12 caracteres.')
  .max(128, 'A senha é longa demais.');

/** Registro profissional. Formato aceito: `CREFITO-3 12345-F`. */
export const zCrefito = z
  .string()
  .trim()
  .regex(/^CREFITO-\d{1,2}\s\d{3,7}-[A-Z]{1,2}$/, 'CREFITO em formato inválido.');

/** Data sem hora, `YYYY-MM-DD`. */
export const zDataISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');

/** Data e hora completas em ISO 8601. */
export const zDataHoraISO = z.string().datetime({ offset: true });

/**
 * Paginação.
 *
 * O teto de `limite` não é estética: sem ele, `?limite=100000` transforma um
 * endpoint de listagem em ferramenta de exfiltração e de negação de serviço.
 */
export const zPaginacao = z
  .object({
    limite: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Autenticação (profissional)
// ---------------------------------------------------------------------------

/** Corpo de `POST /api/auth/login`. */
export const zLogin = z
  .object({
    email: zEmail,
    senha: z.string().min(1).max(128), // No login não validamos política, só presença.
    /** Código TOTP de 6 dígitos, quando a conta tem MFA ativo. */
    totp: z
      .string()
      .regex(/^\d{6}$/, 'Código de verificação inválido.')
      .optional(),
  })
  .strict();

/** Corpo de `POST /api/auth/registrar` (criação da organização + primeiro usuário). */
export const zRegistrarOrganizacao = z
  .object({
    organizacaoNome: zTextoCurto,
    organizacaoTipo: z.enum(['autonomo', 'clinica']),
    nome: zTextoCurto,
    email: zEmail,
    senha: zSenha,
    crefito: zCrefito,
  })
  .strict();

/** Corpo de `POST /api/auth/mfa/ativar`. */
export const zAtivarMfa = z
  .object({
    /** Código gerado pelo app autenticador, provando que o segredo foi salvo. */
    totp: z.string().regex(/^\d{6}$/),
  })
  .strict();

// ---------------------------------------------------------------------------
// Clinical Core
// ---------------------------------------------------------------------------

/** Corpo de `POST /api/pacientes`. */
export const zCriarPaciente = z
  .object({
    nome: zTextoCurto,
    /** Data de nascimento. Guardada cifrada; só a idade sai em listagens. */
    nascimento: zDataISO,
    email: zEmail.optional(),
    /** Telefone em dígitos, com DDD. Guardado cifrado. */
    telefone: z
      .string()
      .trim()
      .regex(/^\d{10,13}$/, 'Telefone inválido.')
      .optional(),
    /** CPF apenas dígitos. Guardado cifrado + blind index para busca. */
    documento: z
      .string()
      .trim()
      .regex(/^\d{11}$/, 'CPF inválido.')
      .optional(),
    /** Versão do TCLE aceita no cadastro. Sem isso não há registro clínico. */
    consentimentoVersao: z.string().trim().max(20),
  })
  .strict();

/** Corpo de `POST /api/planos`. */
export const zCriarPlano = z
  .object({
    pacienteId: zId,
    titulo: zTextoCurto,
    diagnostico: zTextoCurto,
    objetivo: zTextoLongo,
    sessoesPrevistas: z.number().int().min(1).max(200),
    /** Data-alvo da primeira reavaliação. */
    reavaliacaoEm: zDataISO.optional(),
  })
  .strict();

/** Uma aplicação de teste funcional dentro de um registro clínico. */
export const zAplicacaoTeste = z
  .object({
    definicaoChave: z.string().trim().max(60),
    /**
     * Valores brutos por chave de campo. O escore NÃO vem do cliente — é
     * recalculado no servidor a partir da definição. Aceitar escore do cliente
     * seria aceitar que ele escreva o resultado clínico que quiser.
     */
    valores: z.record(z.string().max(60), z.number().finite()),
  })
  .strict();

/** Corpo de `POST /api/planos/:id/evolucoes` (cria rascunho). */
export const zCriarEvolucao = z
  .object({
    ocorridoEm: zDataHoraISO,
    eva: zEva,
    conduta: zTextoLongo,
    resposta: zTextoLongo,
    testes: z.array(zAplicacaoTeste).max(20).default([]),
  })
  .strict();

/** Corpo de `POST /api/evolucoes/:id/versoes` (correção que preserva a anterior). */
export const zNovaVersao = zCriarEvolucao.extend({
  /** Por que a correção foi feita. Vai para a auditoria e fica visível na timeline. */
  motivo: z.string().trim().min(10, 'Descreva o motivo da correção.').max(500),
});

/** Corpo de `POST /api/pacientes/:id/reidentificar`. */
export const zReidentificar = z
  .object({
    /**
     * Motivo obrigatório. Não é burocracia: é o que transforma reidentificação
     * numa operação governada em vez de um clique silencioso. Vai íntegro para
     * a trilha de auditoria.
     */
    motivo: z.string().trim().min(10, 'Descreva o motivo da reidentificação.').max(500),
  })
  .strict();

// ---------------------------------------------------------------------------
// Adherence
// ---------------------------------------------------------------------------

/** Um item FITT da prescrição. */
export const zItemPrescricao = z
  .object({
    exercicioId: zId,
    series: z.number().int().min(1).max(20),
    repeticoes: z.number().int().min(1).max(200),
    carga: z.string().trim().max(80),
    frequenciaSemanal: z.number().int().min(1).max(14),
    progressao: z.string().trim().max(200),
  })
  .strict();

/** Corpo de `POST /api/planos/:id/prescricoes`. */
export const zCriarPrescricao = z
  .object({
    itens: z.array(zItemPrescricao).min(1, 'Selecione ao menos um exercício.').max(20),
    metaSemanal: z.number().int().min(1).max(7),
  })
  .strict();

/** Corpo de `POST /api/portal/registros` (o paciente registra a execução). */
export const zRegistrarAdesao = z
  .object({
    prescricaoItemId: zId,
    data: zDataISO,
    status: z.enum(['fez', 'parcial', 'nao_fez']),
    observacao: z.string().trim().max(300).optional(),
  })
  .strict();

/** Corpo de `POST /api/biblioteca` (criar exercício — entra como rascunho). */
export const zCriarExercicio = z
  .object({
    nome: zTextoCurto,
    categoria: zTextoCurto,
    regiao: zTextoCurto,
    orientacao: zTextoLongo,
    /** Sem licença o exercício existe como rascunho, mas nunca é publicado. */
    licenca: z.string().trim().max(80).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Corpo de `POST /api/agenda`. */
export const zCriarSessao = z
  .object({
    pacienteId: zId,
    planoId: zId.optional(),
    inicioEm: zDataHoraISO,
    duracaoMin: z.number().int().min(15).max(240),
    /** Quantas ocorrências semanais gerar. 1 = sessão avulsa. */
    repetirSemanas: z.number().int().min(1).max(52).default(1),
  })
  .strict();

/** Corpo de `PATCH /api/agenda/:id`. */
export const zAtualizarSessao = z
  .object({
    status: z.enum(['agendada', 'confirmada', 'realizada', 'falta_justificada', 'no_show', 'cancelada']),
    /**
     * Motivo obrigatório quando a falta é justificada — é exatamente o que
     * separa "falta com aviso" de "no-show", e somar os dois num número só
     * esconde a informação que muda a conduta.
     */
    motivo: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => v.status !== 'falta_justificada' || (v.motivo?.length ?? 0) > 0, {
    message: 'Falta justificada exige o motivo registrado.',
    path: ['motivo'],
  });

// ---------------------------------------------------------------------------
// Plataforma
// ---------------------------------------------------------------------------

/** Corpo de `POST /api/organizacao/membros` (convite de profissional). */
export const zConvidarMembro = z
  .object({
    nome: zTextoCurto,
    email: zEmail,
    papel: z.enum(PAPEIS).exclude(['paciente']), // Paciente entra pelo portal, não por convite.
    crefito: zCrefito.optional(),
    /** Para estagiário: de quem ele herda o escopo supervisionado. */
    supervisorId: zId.optional(),
  })
  .strict()
  .refine((v) => v.papel !== 'estagiario' || v.supervisorId !== undefined, {
    message: 'Estagiário precisa de um supervisor — é o supervisor que define o escopo.',
    path: ['supervisorId'],
  });

/** Query de `GET /api/auditoria`. */
export const zConsultaAuditoria = zPaginacao.extend({
  entidade: z.string().trim().max(60).optional(),
  entidadeId: zId.optional(),
  acao: z.string().trim().max(60).optional(),
});
