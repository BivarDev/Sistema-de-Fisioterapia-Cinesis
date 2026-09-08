/**
 * Serviço de autenticação do profissional.
 *
 * ## As defesas, na ordem em que entram
 *
 * 1. **Rate limit por rede e por conta** (aplicado na rota, antes daqui).
 * 2. **Backoff progressivo por conta** — 3 falhas livres, depois 1s, 2s, 4s…
 *    até 5 minutos. Sem bloqueio permanente: bloquear a conta após N erros
 *    deixaria qualquer um trancar o fisioterapeuta fora do sistema no meio do
 *    expediente, sabendo só o e-mail.
 * 3. **Tempo de resposta constante** — e-mail inexistente é conferido contra um
 *    hash-isca de mesmo custo. Sem isso, a diferença de tempo entre "conta
 *    existe" e "não existe" enumera os usuários do sistema.
 * 4. **Mensagem de erro única** — "e-mail ou senha inválidos" para todos os
 *    casos. Nunca "senha incorreta", que confirma o e-mail.
 * 5. **MFA quando ativo**, conferido antes de emitir a sessão.
 * 6. **Rotação de sessão** no login, fechando fixação de sessão.
 */

import { and, eq } from 'drizzle-orm';
import {
  conferirSenha,
  derivarSenha,
  precisaReforcar,
  hashIsca,
  conferirTotp,
  conferirRecuperacao,
  esperaDoBackoff,
  registrarFalha,
  decifrar,
  cifrar,
  type Anel,
  type GestorSessao,
  type SessaoEmitida,
} from '@cinesis/security';
import { NaoAutenticado, ExcessoRequisicoes, type Papel } from '@cinesis/shared';
import { organizacoes, profissionais } from '../db/schema.js';
import { semEscopoDeTenant, comTenant, type Banco } from '../db/conexao.js';
import { auditar } from './auditoria.js';

/**
 * Hash-isca do processo, calculado uma vez.
 *
 * Uma promessa (e não um valor) porque derivar custa ~50 ms de propósito — não
 * queremos pagar isso a cada login com e-mail inexistente, só na primeira vez.
 */
let iscaCache: Promise<string> | null = null;
function obterIsca(): Promise<string> {
  iscaCache ??= hashIsca();
  return iscaCache;
}

/** Credenciais do login. */
export interface Credenciais {
  email: string;
  senha: string;
  totp?: string | undefined;
}

/** O que um login bem-sucedido devolve. */
export interface LoginOk {
  sessao: SessaoEmitida;
  profissionalId: string;
  organizacaoId: string;
  papel: Papel;
  nome: string;
  /** `true` quando o papel exige MFA e a conta ainda não ativou. */
  precisaAtivarMfa: boolean;
}

/**
 * Autentica um profissional.
 *
 * @param db        Banco (sem escopo de tenant — o login precede o tenant).
 * @param anel      Anel de chaves, para decifrar o segredo TOTP.
 * @param gestor    Gestor de sessão.
 * @param cred      Credenciais.
 * @param userAgent Header da requisição, para vincular a sessão.
 * @throws {NaoAutenticado}    Credenciais inválidas (mensagem única).
 * @throws {ExcessoRequisicoes} Conta em backoff.
 */
export async function autenticar(
  db: Banco,
  anel: Anel,
  gestor: GestorSessao,
  cred: Credenciais,
  userAgent: string,
): Promise<LoginOk> {
  // O login roda fora do escopo de tenant: ainda não sabemos a organização do
  // usuário — é justamente o que estamos descobrindo. É um dos três lugares do
  // sistema em que isso é legítimo.
  const [prof] = await semEscopoDeTenant(db, (d) =>
    d
      .select()
      .from(profissionais)
      .where(and(eq(profissionais.email, cred.email), eq(profissionais.ativo, true)))
      .limit(1),
  );

  // --- Backoff ---------------------------------------------------------------
  if (prof) {
    const espera = esperaDoBackoff(
      prof.ultimaFalhaEm ? { falhas: prof.falhasLogin, ultimaFalhaEm: prof.ultimaFalhaEm.getTime() } : null,
    );
    if (espera > 0) {
      await comTenant(db, prof.organizacaoId, (tx) =>
        auditar(tx, {
          organizacaoId: prof.organizacaoId,
          atorId: prof.id,
          atorPapel: prof.papel,
          acao: 'LOGIN_BLOQUEADO',
          entidade: 'Profissional',
          entidadeId: prof.id,
          detalhe: `Backoff ativo: ${espera}s.`,
        }),
      );
      throw new ExcessoRequisicoes(espera, 'Muitas tentativas. Aguarde antes de tentar de novo.');
    }
  }

  // --- Senha -----------------------------------------------------------------
  // Conta inexistente é conferida contra a isca. O custo é o mesmo de um
  // Argon2id real, então o tempo de resposta não distingue os dois casos.
  const hashAlvo = prof?.senhaHash ?? (await obterIsca());
  const senhaConfere = await conferirSenha(hashAlvo, cred.senha);

  if (!prof || !senhaConfere) {
    if (prof) await registrarFalhaLogin(db, prof);
    // Mensagem única. "Senha incorreta" confirmaria que o e-mail existe.
    throw new NaoAutenticado('E-mail ou senha inválidos.');
  }

  // --- Segundo fator ---------------------------------------------------------
  if (prof.mfaSegredoCifrado) {
    const segredo = decifrar(anel, prof.mfaSegredoCifrado, `mfa:${prof.id}`);

    // Aceita o TOTP normal ou um código de recuperação — quem perdeu o celular
    // precisa de um caminho de volta que não seja "ligue para o suporte".
    const totpOk = cred.totp !== undefined && conferirTotp(segredo, cred.totp);
    const recuperacaoUsada =
      !totpOk && cred.totp !== undefined
        ? conferirRecuperacao(prof.mfaRecuperacao, cred.totp)
        : null;

    if (!totpOk && !recuperacaoUsada) {
      await registrarFalhaLogin(db, prof);
      throw new NaoAutenticado('Código de verificação inválido.');
    }

    if (recuperacaoUsada) {
      // Código de recuperação é de uso único. Não removê-lo o transformaria
      // numa segunda senha permanente.
      await semEscopoDeTenant(db, async (d) => {
        await d
          .update(profissionais)
          .set({ mfaRecuperacao: prof.mfaRecuperacao.filter((h) => h !== recuperacaoUsada) })
          .where(eq(profissionais.id, prof.id));
      });
    }
  }

  // --- Sucesso ---------------------------------------------------------------
  // Zera o backoff e re-deriva a senha se o custo do hash ficou abaixo do
  // padrão atual. É assim que a base inteira migra para um custo maior sem
  // pedir troca de senha a ninguém.
  const atualizacao: Partial<typeof profissionais.$inferInsert> = {
    falhasLogin: 0,
    ultimaFalhaEm: null,
  };
  if (precisaReforcar(prof.senhaHash)) {
    atualizacao.senhaHash = await derivarSenha(cred.senha);
  }
  await semEscopoDeTenant(db, async (d) => {
    await d.update(profissionais).set(atualizacao).where(eq(profissionais.id, prof.id));
  });

  // Sessão nova a cada login: um token plantado antes do login não sobrevive
  // a ele (fixação de sessão).
  const sessao = await gestor.abrir(
    {
      sujeitoId: prof.id,
      organizacaoId: prof.organizacaoId,
      papel: prof.papel as Papel,
      tipo: 'profissional',
    },
    userAgent,
  );

  await comTenant(db, prof.organizacaoId, (tx) =>
    auditar(tx, {
      organizacaoId: prof.organizacaoId,
      atorId: prof.id,
      atorPapel: prof.papel,
      acao: 'LOGIN_SUCESSO',
      entidade: 'Profissional',
      entidadeId: prof.id,
    }),
  );

  return {
    sessao,
    profissionalId: prof.id,
    organizacaoId: prof.organizacaoId,
    papel: prof.papel as Papel,
    nome: prof.nome,
    // O sistema insiste no MFA para quem pode reidentificar PII, mas não
    // bloqueia: o público-alvo tem baixa familiaridade técnica e exigir no
    // primeiro acesso mataria a adoção. Quem decide é o operador.
    precisaAtivarMfa: prof.papel === 'fisioterapeuta' && prof.mfaSegredoCifrado === null,
  };
}

/** Incrementa o contador de falhas e audita. */
async function registrarFalhaLogin(
  db: Banco,
  prof: typeof profissionais.$inferSelect,
): Promise<void> {
  const novo = registrarFalha(
    prof.ultimaFalhaEm ? { falhas: prof.falhasLogin, ultimaFalhaEm: prof.ultimaFalhaEm.getTime() } : null,
  );

  await semEscopoDeTenant(db, async (d) => {
    await d
      .update(profissionais)
      .set({ falhasLogin: novo.falhas, ultimaFalhaEm: new Date(novo.ultimaFalhaEm) })
      .where(eq(profissionais.id, prof.id));
  });

  await comTenant(db, prof.organizacaoId, (tx) =>
    auditar(tx, {
      organizacaoId: prof.organizacaoId,
      atorId: prof.id,
      atorPapel: prof.papel,
      acao: 'LOGIN_FALHA',
      entidade: 'Profissional',
      entidadeId: prof.id,
      detalhe: `Falha ${novo.falhas}.`,
    }),
  );
}

/** Dados de criação da organização e do primeiro profissional. */
export interface NovaOrganizacao {
  organizacaoNome: string;
  organizacaoTipo: 'autonomo' | 'clinica';
  nome: string;
  email: string;
  senha: string;
  crefito: string;
}

/**
 * Cria a organização e o profissional fundador.
 *
 * O fundador é sempre `fisioterapeuta`: é o único papel que pode administrar a
 * organização e assinar prontuário. Criar uma clínica cuja conta inicial é de
 * recepção deixaria a instalação sem ninguém apto a fechar um registro.
 */
export async function registrarOrganizacao(
  db: Banco,
  dados: NovaOrganizacao,
  novoIdFn: () => string,
): Promise<{ organizacaoId: string; profissionalId: string }> {
  const organizacaoId = novoIdFn();
  const profissionalId = novoIdFn();

  await semEscopoDeTenant(db, async (d) => {
    await d.insert(organizacoes).values({
      id: organizacaoId,
      nome: dados.organizacaoNome,
      tipo: dados.organizacaoTipo,
      tcleVersao: 'v1',
    });

    await d.insert(profissionais).values({
      id: profissionalId,
      organizacaoId,
      nome: dados.nome,
      email: dados.email,
      senhaHash: await derivarSenha(dados.senha),
      crefito: dados.crefito,
      papel: 'fisioterapeuta',
    });
  });

  return { organizacaoId, profissionalId };
}

/**
 * Grava o segredo TOTP pendente, **cifrado**.
 *
 * O segredo só é gravado depois que o usuário provou, com um código válido,
 * que conseguiu cadastrá-lo no app autenticador. Ativar antes da prova
 * trancaria fora da conta quem errasse o cadastro.
 */
export async function ativarMfa(
  db: Banco,
  anel: Anel,
  profissionalId: string,
  organizacaoId: string,
  papel: string,
  segredoBase32: string,
  hashesRecuperacao: string[],
): Promise<void> {
  await semEscopoDeTenant(db, async (d) => {
    await d
      .update(profissionais)
      .set({
        // Cifrado com o AAD amarrado ao profissional: mover o segredo de uma
        // linha para outra no banco não funciona.
        mfaSegredoCifrado: cifrar(anel, segredoBase32, `mfa:${profissionalId}`),
        mfaRecuperacao: hashesRecuperacao,
      })
      .where(eq(profissionais.id, profissionalId));
  });

  await comTenant(db, organizacaoId, (tx) =>
    auditar(tx, {
      organizacaoId,
      atorId: profissionalId,
      atorPapel: papel,
      acao: 'MFA_ATIVADO',
      entidade: 'Profissional',
      entidadeId: profissionalId,
    }),
  );
}

/** Busca os supervisores de um profissional. Define o escopo do estagiário. */
export async function buscarSupervisores(db: Banco, profissionalId: string): Promise<string[]> {
  const [prof] = await semEscopoDeTenant(db, (d) =>
    d
      .select({ supervisorId: profissionais.supervisorId })
      .from(profissionais)
      .where(eq(profissionais.id, profissionalId))
      .limit(1),
  );

  return prof?.supervisorId ? [prof.supervisorId] : [];
}
