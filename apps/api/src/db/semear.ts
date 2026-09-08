/**
 * Semeadura do banco: catálogo padrão + dados de demonstração.
 *
 * ## Duas coisas diferentes, deliberadamente separadas
 *
 * 1. **Catálogo** (`semearCatalogo`) — testes funcionais e exercícios. Roda em
 *    **toda** instalação, inclusive em produção: sem ele o sistema sobe sem
 *    nenhuma escala clínica e a tela de avaliação fica vazia.
 *
 * 2. **Demonstração** (`semearDemonstracao`) — uma clínica fictícia com
 *    pacientes, planos e evoluções. **Nunca roda em produção.** É o que permite
 *    ver o sistema funcionando em trinta segundos, sem cadastrar nada à mão.
 *
 * Os dados de demonstração são explicitamente fictícios e a interface avisa
 * isso. Semear um "paciente de exemplo" que pareça real num sistema de
 * prontuário é pedir para alguém confundir os dois.
 */

import { eq } from 'drizzle-orm';
import { cifrar, codigoPseudonimo, derivarSenha, idadeEmAnos, indiceCego, type Anel } from '@cinesis/security';
import {
  aplicacoesTeste,
  consentimentos,
  definicoesTeste,
  exercicios,
  organizacoes,
  pacienteIdentificacao,
  pacientes,
  planos,
  prescricaoItens,
  prescricoes,
  profissionais,
  registros,
  registrosAdesao,
} from './schema.js';
import { CATALOGO_EXERCICIOS, CATALOGO_TESTES } from './catalogo.js';
import { conectar, aplicarSchema, semEscopoDeTenant, type Banco } from './conexao.js';
import { carregarConfig } from '../config.js';
import { codigoRegistro, novoId } from '../infra/ids.js';
import { calcularTeste } from '@cinesis/domain';
import type { DefinicaoTeste } from '@cinesis/shared';

/**
 * Insere o catálogo padrão, se ainda não existir.
 *
 * Idempotente: verifica antes de inserir cada item, então rodar de novo depois
 * de uma atualização acrescenta o que é novo sem duplicar o que já está lá.
 */
export async function semearCatalogo(db: Banco): Promise<{ testes: number; exercicios: number }> {
  let testes = 0;
  let exs = 0;

  for (const t of CATALOGO_TESTES) {
    const [existe] = await db
      .select({ id: definicoesTeste.id })
      .from(definicoesTeste)
      .where(eq(definicoesTeste.chave, t.chave))
      .limit(1);

    if (existe) continue;

    await db.insert(definicoesTeste).values({
      id: novoId(),
      // `null` = definição global, visível a todas as organizações. A EVA é a
      // mesma escala em qualquer clínica.
      organizacaoId: null,
      chave: t.chave,
      nome: t.nome,
      versao: t.versao,
      categoria: t.categoria,
      unidade: t.unidade,
      fonte: t.fonte,
      licenca: t.licenca,
      maiorEhPior: t.maiorEhPior,
      campos: t.campos,
      formula: t.formula,
      interpretacoes: t.interpretacoes,
    });
    testes++;
  }

  for (const e of CATALOGO_EXERCICIOS) {
    const [existe] = await db
      .select({ id: exercicios.id })
      .from(exercicios)
      .where(eq(exercicios.nome, e.nome))
      .limit(1);

    if (existe) continue;

    await db.insert(exercicios).values({
      id: novoId(),
      organizacaoId: null,
      nome: e.nome,
      categoria: e.categoria,
      regiao: e.regiao,
      orientacao: e.orientacao,
      status: e.status,
      versao: e.versao,
      autorId: null,
      revisorId: e.revisor,
      licenca: e.licenca,
    });
    exs++;
  }

  return { testes, exercicios: exs };
}

/**
 * Pacientes fictícios da demonstração.
 *
 * Três campos distintos de propósito, porque na tela do plano eles aparecem em
 * sequência e repetir o mesmo texto três vezes faria a demonstração parecer um
 * molde preenchido:
 *
 * - `queixa` — como o **paciente** descreve o problema. Vira o título do plano.
 * - `diagnostico` — a **hipótese clínica**, com lateralidade e classificação.
 * - `objetivo` — o que este tratamento específico pretende alcançar, em termos
 *   de função, não de exame.
 */
const PACIENTES_DEMO = [
  {
    nome: 'Marina Alencar',
    nascimento: '1989-04-12',
    queixa: 'Lombalgia mecânica crônica',
    diagnostico: 'Dor lombar inespecífica persistente, sem sinais de alerta',
    objetivo: 'Voltar a sentar 8 horas no trabalho sem dor que exija pausa.',
  },
  {
    nome: 'Rogério Tavares',
    nascimento: '1972-11-03',
    queixa: 'Pós-operatório de LCA — joelho direito',
    diagnostico: 'Reconstrução de LCA à direita, 6ª semana de pós-operatório',
    objetivo: 'Recuperar extensão completa e subir escada sem apoio no corrimão.',
  },
  {
    nome: 'Cláudia Bernardes',
    nascimento: '1958-07-25',
    queixa: 'Síndrome do manguito rotador',
    diagnostico: 'Tendinopatia do supraespinhal à direita, sem ruptura completa',
    objetivo: 'Alcançar a prateleira alta da cozinha e dormir sobre o lado direito.',
  },
  {
    nome: 'Ivo Nascimento',
    nascimento: '1994-01-30',
    queixa: 'Tendinopatia patelar',
    diagnostico: 'Tendinopatia patelar à esquerda, fase reativa',
    objetivo: 'Retomar corrida de 5 km sem dor no dia seguinte.',
  },
  {
    nome: 'Selma Prado',
    nascimento: '1966-09-18',
    queixa: 'Cervicalgia postural',
    diagnostico: 'Cervicalgia mecânica associada a postura mantida no trabalho',
    objetivo: 'Trabalhar o turno inteiro sem cefaleia no fim do dia.',
  },
];

/**
 * Semeia uma clínica de demonstração completa.
 *
 * O paciente 1 recebe uma **série longitudinal de 8 sessões** com melhora
 * progressiva e uma **correção versionada** — os dois casos que provam a tese
 * do produto e a imutabilidade do prontuário. É o que se quer ver numa
 * primeira execução.
 *
 * @returns Credenciais de acesso, para exibir no terminal.
 */
export async function semearDemonstracao(
  db: Banco,
  anel: Anel,
): Promise<{ email: string; senha: string; organizacaoId: string }> {
  const organizacaoId = novoId();
  const fisioId = novoId();
  const estagiarioId = novoId();
  const recepcaoId = novoId();

  // Senha longa e óbvia como senha de demonstração — nunca deve virar senha
  // real, e o `.env.example`/README dizem isso.
  const senha = 'demonstracao-cinesis-2026';
  const senhaHash = await derivarSenha(senha);

  await db.insert(organizacoes).values({
    id: organizacaoId,
    nome: 'Clínica Movimento (demonstração)',
    tipo: 'clinica',
    tcleVersao: 'v3',
  });

  await db.insert(profissionais).values([
    {
      id: fisioId,
      organizacaoId,
      nome: 'Helena Marques',
      email: 'fisio@cinesis.local',
      senhaHash,
      crefito: 'CREFITO-3 12345-F',
      papel: 'fisioterapeuta',
    },
    {
      id: recepcaoId,
      organizacaoId,
      nome: 'Recepção Movimento',
      email: 'recepcao@cinesis.local',
      senhaHash,
      crefito: null,
      papel: 'recepcao',
    },
    {
      id: estagiarioId,
      organizacaoId,
      nome: 'Estagiário Movimento',
      email: 'estagiario@cinesis.local',
      senhaHash,
      crefito: null,
      papel: 'estagiario',
      // O escopo restrito do estagiário é definido por este vínculo.
      supervisorId: fisioId,
    },
  ]);

  // Definições necessárias para calcular os escores da série.
  const defs = await db.select().from(definicoesTeste);
  const porChave = new Map(defs.map((d) => [d.chave, paraDefinicao(d)]));

  const publicados = await db
    .select()
    .from(exercicios)
    .where(eq(exercicios.status, 'published'));

  for (const [indice, dados] of PACIENTES_DEMO.entries()) {
    const pacienteId = novoId();
    const aad = `paciente:${pacienteId}`;

    await db.insert(pacientes).values({
      id: pacienteId,
      organizacaoId,
      codigo: codigoPseudonimo(anel, pacienteId),
      idade: idadeEmAnos(dados.nascimento),
      responsavelId: fisioId,
    });

    await db.insert(pacienteIdentificacao).values({
      id: pacienteId,
      organizacaoId,
      nomeCifrado: cifrar(anel, dados.nome, aad),
      nascimentoCifrado: cifrar(anel, dados.nascimento, aad),
      emailCifrado: null,
      telefoneCifrado: null,
      documentoCifrado: null,
      emailIndice: null,
      telefoneIndice: null,
      documentoIndice: indiceCego(anel, `0000000000${indice}`, 'documento'),
    });

    await db.insert(consentimentos).values({
      id: novoId(),
      organizacaoId,
      pacienteId,
      tipo: 'tratamento_dados',
      versao: 'v3',
      aceitoEm: new Date('2026-06-12T10:00:00Z'),
    });

    // Consentimento de telessaúde só para quem tem HEP prescrito.
    if (indice < 3) {
      await db.insert(consentimentos).values({
        id: novoId(),
        organizacaoId,
        pacienteId,
        tipo: 'telessaude',
        versao: 'v3',
        aceitoEm: new Date('2026-06-12T10:05:00Z'),
      });
    }

    const planoId = novoId();
    await db.insert(planos).values({
      id: planoId,
      organizacaoId,
      pacienteId,
      profissionalId: fisioId,
      titulo: dados.queixa,
      diagnostico: dados.diagnostico,
      objetivo: dados.objetivo,
      status: 'ativo',
      fase: indice === 0 ? 'Fase 2 — fortalecimento' : 'Fase 1 — controle de sintomas',
      sessoesPrevistas: 12,
      // O primeiro paciente tem reavaliação vencida, para o sinal aparecer.
      reavaliacaoEm: indice === 0 ? '2026-08-20' : '2026-10-15',
    });

    // --- Série longitudinal ---------------------------------------------------
    // O paciente 0 recebe 8 sessões com melhora clara; os demais, 3 sessões
    // estáveis (para que o sinal de estagnação também apareça na tela Hoje).
    const sessoesDoPlano = indice === 0 ? 8 : 3;
    const evaSerie = indice === 0 ? [7, 7, 6, 6, 5, 5, 4, 2] : [5, 5, 5];
    const oswSerie = indice === 0 ? [62, 60, 56, 51, 45, 42, 37, 18] : [40, 40, 39];

    let registroAnteriorId: string | null = null;

    for (let s = 0; s < sessoesDoPlano; s++) {
      const registroId = novoId();
      const data = new Date(Date.UTC(2026, 6, 5 + s * 7, 14, 0));

      await db.insert(registros).values({
        id: registroId,
        organizacaoId,
        planoId,
        tipo: s === 0 ? 'avaliacao' : 'evolucao',
        codigo: codigoRegistro(s === 0 ? 'avaliacao' : 'evolucao'),
        eva: evaSerie[s] ?? 5,
        conduta:
          s === 0
            ? 'Avaliação inicial: anamnese, testes funcionais e definição do plano.'
            : 'Terapia manual, exercício terapêutico supervisionado e progressão de carga.',
        resposta:
          s === 0
            ? 'Paciente relata limitação nas atividades de vida diária.'
            : 'Boa tolerância ao exercício, sem intercorrências.',
        ocorridoEm: data,
        // Todas as sessões passadas já estão seladas — é o estado normal.
        finalizadoEm: data,
        assinadoPorId: fisioId,
      });

      // Aplica EVA e Oswestry em cada sessão, calculando o escore de verdade.
      for (const [chave, valores] of [
        ['eva', { dor: evaSerie[s] ?? 5 }],
        [
          'oswestry',
          Object.fromEntries(
            // Distribui o percentual-alvo pelas 10 seções de 0 a 5.
            Array.from({ length: 10 }, (_, i) => [
              `s${i + 1}`,
              Math.round(((oswSerie[s] ?? 40) / 100) * 5),
            ]),
          ),
        ],
      ] as const) {
        const definicao = porChave.get(chave);
        if (!definicao) continue;

        const resultado = calcularTeste(definicao, valores as Record<string, number>);

        await db.insert(aplicacoesTeste).values({
          id: novoId(),
          organizacaoId,
          registroId,
          definicaoChave: definicao.chave,
          definicaoVersao: resultado.versaoUsada,
          valores: valores as Record<string, number>,
          escore: resultado.escore,
          interpretacao: resultado.interpretacao,
          tom: resultado.tom,
          aplicadoEm: data,
        });
      }

      registroAnteriorId = registroId;
    }

    // --- Uma correção versionada, no paciente 0 -------------------------------
    // Demonstra a regra da COFFITO 415/2012 na prática: a v1 continua na linha
    // do tempo, selada e assinada, e a v2 existe ao lado dela.
    if (indice === 0 && registroAnteriorId) {
      const correcaoId = novoId();
      const dataCorrecao = new Date(Date.UTC(2026, 7, 23, 15, 0));

      await db.insert(registros).values({
        id: correcaoId,
        organizacaoId,
        planoId,
        tipo: 'evolucao',
        codigo: codigoRegistro('evolucao'),
        eva: 2,
        conduta:
          'Correção de registro: o valor de amplitude havia sido anotado com a unidade trocada.',
        resposta: 'Sem alteração no quadro clínico. Registro corrigido em nova versão.',
        ocorridoEm: dataCorrecao,
        finalizadoEm: new Date(Date.UTC(2026, 7, 23, 15, 30)),
        assinadoPorId: fisioId,
        versao: 2,
        substituiId: registroAnteriorId,
        motivoVersao: 'Correção da unidade de medida da amplitude registrada na sessão anterior.',
      });

      // A versão nova precisa carregar os MESMOS testes da anterior.
      //
      // Sem isto, a v1 sai do gráfico (por ter sido substituída) e a v2 não
      // entra (por não ter teste aplicado) — a sessão inteira desapareceria da
      // comparação longitudinal, que é exatamente o que a correção não deve
      // provocar. Corrigir um registro nunca pode apagar a sessão do gráfico.
      for (const [chave, valores] of [
        ['eva', { dor: 2 }],
        [
          'oswestry',
          Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i + 1}`, 1])),
        ],
      ] as const) {
        const definicao = porChave.get(chave);
        if (!definicao) continue;

        const resultado = calcularTeste(definicao, valores as Record<string, number>);

        await db.insert(aplicacoesTeste).values({
          id: novoId(),
          organizacaoId,
          registroId: correcaoId,
          definicaoChave: definicao.chave,
          definicaoVersao: resultado.versaoUsada,
          valores: valores as Record<string, number>,
          escore: resultado.escore,
          interpretacao: resultado.interpretacao,
          tom: resultado.tom,
          aplicadoEm: dataCorrecao,
        });
      }
    }

    // --- Prescrição HEP e adesão ---------------------------------------------
    if (indice < 3 && publicados.length >= 3) {
      const prescricaoId = novoId();
      // A prescrição começa há 14 dias, alinhada à janela de registros abaixo.
      //
      // Se ela fosse mais antiga que os registros, o denominador do cálculo de
      // adesão contaria dias em que o paciente "deveria" ter feito e não há
      // registro nenhum — e os três perfis apareceriam achatados para baixo,
      // sem a distinção que a demonstração existe para mostrar.
      const inicioPrescricao = new Date(Date.now() - 14 * 86_400_000);

      await db.insert(prescricoes).values({
        id: prescricaoId,
        organizacaoId,
        planoId,
        metaSemanal: 5,
        ativa: true,
        criadaEm: inicioPrescricao,
      });

      const itens = publicados.slice(0, 4).map((ex, i) => ({
        id: novoId(),
        organizacaoId,
        prescricaoId,
        exercicioId: ex.id,
        // Congela a versão prescrita: editar o catálogo depois não muda isto.
        exercicioVersao: ex.versao,
        series: 3,
        repeticoes: 12 + i * 2,
        carga: i === 3 ? 'faixa vermelha' : 'peso corporal',
        frequenciaSemanal: 5,
        progressao: i === 0 ? 'unipodal na semana 3' : '+2 repetições por semana',
      }));

      await db.insert(prescricaoItens).values(itens);

      // Adesão dos últimos 14 dias, com três perfis distintos.
      //
      // O padrão é uma lista EXPLÍCITA por dia, não uma fórmula aritmética.
      // Duas razões: fica óbvio na leitura qual perfil cada paciente tem, e o
      // resultado é exatamente o pretendido — uma expressão do tipo
      // `(d * 7 + i) % 10` parece dar variedade e, depois de o cálculo agregar
      // por dia e limitar pela meta semanal, faz os três perfis colapsarem no
      // mesmo número.
      //
      // O padrão é decidido POR DIA porque `calcularAdesao` usa o dia como
      // unidade clínica e toma o melhor status do dia. Sortear item a item
      // marcaria quase todo dia como "fez" em qualquer perfil.
      //
      // Com meta de 5 dias/semana, 14 dias esperam 10 dias de execução:
      //   alta  → 8 "fez" + 1 parcial  = 8,5 / 10 ≈ 85%
      //   média → 6 "fez" + 1 parcial  = 6,5 / 10 ≈ 65%
      //   baixa → 2 "fez" + 1 parcial  = 2,5 / 10 ≈ 25%  (dispara o sinal)
      type StatusDia = 'fez' | 'parcial' | 'nao_fez';
      const F: StatusDia = 'fez';
      const P: StatusDia = 'parcial';
      const N: StatusDia = 'nao_fez';

      /**
       * Índice 0 = há 13 dias; índice 13 = hoje.
       *
       * Os padrões terminam de forma diferente de propósito: o perfil alto
       * fecha com dias consecutivos de execução (para a tela mostrar uma
       * sequência viva), e o baixo fecha sem execução (sequência interrompida).
       */
      const PERFIS: StatusDia[][] = [
        [N, F, N, F, P, N, F, N, F, N, F, F, F, F], // alta  — 8 fez, 1 parcial, sequência 4
        [N, F, N, F, N, P, N, F, N, N, F, N, F, F], // média — 6 fez, 1 parcial, sequência 2
        [N, N, F, N, N, N, P, N, N, N, N, F, N, N], // baixa — 2 fez, 1 parcial, sem sequência
      ];
      const padrao = PERFIS[indice] ?? (PERFIS[1] as StatusDia[]);

      /** Rebaixa um status um degrau: fez → parcial → não fez. */
      const rebaixar = (st: StatusDia): StatusDia =>
        st === 'fez' ? 'parcial' : st === 'parcial' ? 'nao_fez' : 'nao_fez';

      const hoje = new Date();
      for (let d = 13; d >= 0; d--) {
        const data = new Date(hoje.getTime() - d * 86_400_000).toISOString().slice(0, 10);
        const status = padrao[13 - d] ?? 'nao_fez';

        for (const [i, item] of itens.entries()) {
          // O PRIMEIRO exercício sempre recebe o status do dia. Como
          // `calcularAdesao` toma o melhor status do dia, isso preserva
          // exatamente o perfil de adesão do paciente.
          //
          // Os demais são rebaixados de forma determinística e com frequência
          // crescente pelo índice. É o que faz a agregação POR EXERCÍCIO
          // mostrar números diferentes — e é a informação que a tela existe
          // para dar: exercício com adesão baixa costuma ser problema de
          // prescrição, não de paciente.
          const statusDoItem = i > 0 && (d + i * 3) % (i + 2) !== 0 ? rebaixar(status) : status;

          await db.insert(registrosAdesao).values({
            id: novoId(),
            organizacaoId,
            pacienteId,
            prescricaoItemId: item.id,
            data,
            status: statusDoItem,
          });
        }
      }
    }
  }

  return { email: 'fisio@cinesis.local', senha, organizacaoId };
}

/** Converte a linha do banco no tipo de domínio. */
function paraDefinicao(linha: typeof definicoesTeste.$inferSelect): DefinicaoTeste {
  return {
    id: linha.id,
    chave: linha.chave,
    nome: linha.nome,
    versao: linha.versao,
    categoria: linha.categoria as DefinicaoTeste['categoria'],
    unidade: linha.unidade,
    fonte: linha.fonte,
    licenca: linha.licenca,
    maiorEhPior: linha.maiorEhPior,
    campos: linha.campos as DefinicaoTeste['campos'],
    formula: linha.formula as DefinicaoTeste['formula'],
    interpretacoes: linha.interpretacoes as DefinicaoTeste['interpretacoes'],
  };
}

/**
 * Executável: `npm run db:seed`.
 *
 * Recusa semear demonstração em produção. Não é paranoia — é o tipo de coisa
 * que alguém roda por engano na máquina errada às onze da noite.
 */
async function principal(): Promise<void> {
  const config = carregarConfig();
  const conexao = await conectar(config.ambiente.DATABASE_URL);
  await aplicarSchema(conexao);

  const catalogo = await semEscopoDeTenant(conexao.db, (d) => semearCatalogo(d));
  console.log(
    `Catálogo: ${catalogo.testes} testes funcionais e ${catalogo.exercicios} exercícios inseridos.`,
  );

  if (config.producao) {
    console.log('Ambiente de produção: dados de demonstração NÃO foram criados.');
    await conexao.encerrar();
    return;
  }

  const demo = await semEscopoDeTenant(conexao.db, (d) => semearDemonstracao(d, config.anel));

  console.log(`
Clínica de demonstração criada.

  Fisioterapeuta   ${demo.email}
  Recepção         recepcao@cinesis.local
  Estagiário       estagiario@cinesis.local
  Senha (todos)    ${demo.senha}

Troque de papel no cabeçalho para ver o RBAC agir: recepção não lê prontuário,
e estagiário vê os registros pelo código pseudonimizado, sem os nomes.
`);

  await conexao.encerrar();
}

if (process.argv[1]?.includes('semear')) {
  principal().catch((erro) => {
    console.error('Falha ao semear:', erro instanceof Error ? erro.message : erro);
    process.exit(1);
  });
}
