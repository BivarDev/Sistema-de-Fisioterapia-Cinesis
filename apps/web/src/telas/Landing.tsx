/**
 * Apresentação pública do projeto.
 *
 * ## Propósito
 *
 * Explicar a **tese** antes de mostrar a ferramenta. É também a página de
 * projeto open source: quem chega pelo GitHub precisa entender em trinta
 * segundos o que o Cinesis resolve e por que ele existe.
 *
 * ## Onde as animações entram — e onde não entram
 *
 * Esta é a única tela do sistema com movimento elaborado: onda 3D no herói,
 * entrada palavra a palavra do título, contadores e revelação no scroll. É
 * deliberado. Dentro do sistema, onde o fisioterapeuta trabalha, movimento é
 * atrito; aqui, é o que comunica que o produto tem cuidado.
 *
 * Tudo respeita o modo reduzido, que some com a onda 3D inteira em vez de
 * apenas desacelerá-la.
 */

import { Link } from 'react-router-dom';
import {
  FundoOnda,
  TextoPorPalavra,
  TextoDesfocado,
  Contador,
  Cartao,
  Botao,
  Segmentado,
  usarPreferencias,
  usarScrollSuave,
  usarRevelacao,
} from '@cinesis/ui';

/** As nove etapas do ciclo — o coração da tese. */
const CICLO = [
  'Avaliação',
  'Plano de tratamento',
  'Sessões',
  'Evolução',
  'Exercício domiciliar',
  'Adesão',
  'Novos dados',
  'Reavaliação',
  'Comparação longitudinal',
];

/** Os quatro bounded contexts. */
const MODULOS = [
  {
    tag: 'clinical_core',
    cor: 'var(--pri)',
    titulo: 'Núcleo clínico',
    descricao:
      'O episódio de tratamento é o agregado principal — não o paciente. Um paciente tem vários episódios ao longo da vida, cada um com sua linha do tempo e seu desfecho.',
    entidades: ['PlanoTratamento', 'Avaliacao', 'Evolucao', 'Reavaliacao', 'ClinicalAssessmentDefinition'],
  },
  {
    tag: 'adherence',
    cor: 'var(--good)',
    titulo: 'Adesão',
    descricao:
      'O que acontece fora da sessão. Prescrição domiciliar, registro de execução pelo paciente e consolidação da adesão real.',
    entidades: ['Exercicio', 'PrescricaoExercicio', 'RegistroAdesao', 'PortalPaciente'],
  },
  {
    tag: 'operations',
    cor: 'var(--acc)',
    titulo: 'Operação',
    descricao:
      'Agenda recorrente, lembrete e cobrança simples. Importante — e deliberadamente não é o diferencial: o mercado já resolve isso bem.',
    entidades: ['SessaoAgenda', 'SerieRecorrencia', 'PacoteSessoes'],
  },
  {
    tag: 'platform',
    cor: 'var(--ink2)',
    titulo: 'Plataforma',
    descricao:
      'Multi-tenant, RBAC por escopo na query, sessão opaca revogável e auditoria imutável encadeada por hash. Fundação, não módulo.',
    entidades: ['Organizacao', 'Identity', 'RBAC', 'Consentimento', 'AuditoriaEvento'],
  },
];

/** As camadas do modelo de segurança, na ordem em que agem. */
const CAMADAS = [
  {
    titulo: 'PII isolada e cifrada em repouso',
    texto:
      'Nome, CPF e telefone vivem numa tabela própria, cifrados com AES-256-GCM. O lado clínico nunca faz junção com ela por padrão. Um dump do banco é uma lista de códigos PC-4821.',
  },
  {
    titulo: 'RBAC por escopo aplicado na query',
    texto:
      'O filtro de organização entra no WHERE, nunca num if depois do SELECT. O dado de outra clínica não é lido nem para ser descartado.',
  },
  {
    titulo: 'Fora de escopo responde 404, não 403',
    texto:
      'Um 403 confirmaria que o recurso existe. Essa confirmação é o que permite mapear a base de outra organização por tentativa e erro.',
  },
  {
    titulo: 'Pseudonimização com HMAC de segredo isolado',
    texto:
      'A chave vive no ambiente do operador, nunca no banco. Reidentificar exige cargo autorizado, motivo escrito e fica registrado na auditoria.',
  },
  {
    titulo: 'Sessão opaca revogável, nunca JWT de vida longa',
    texto:
      'O servidor guarda o HMAC do token, não o token. Timeout duplo — inatividade e absoluto — e vínculo com o dispositivo. IP nunca em claro.',
  },
  {
    titulo: 'Prontuário imutável, em três camadas',
    texto:
      'Domínio, escrita condicional e gatilho no PostgreSQL. Correção cria nova versão; a v1 permanece intacta. Vale até para quem abre o psql.',
  },
  {
    titulo: 'Link mágico com garantias verificáveis',
    texto:
      'Expira em 15 minutos, uso único com consumo atômico, reemissão em vez de reuso, limite de 5 por hora. O token vai no path, nunca na query.',
  },
  {
    titulo: 'Log, métrica e telemetria sem PII',
    texto:
      'Redação por lista de permissão no serializador do logger: campo não classificado é redigido por padrão. Erra para o lado de perder informação de depuração.',
  },
];

/** As cinco fases de implementação. */
const FASES = [
  { letra: 'A', titulo: 'Núcleo clínico', texto: 'Organização, papéis, paciente com PII separada, plano, avaliação, evolução e comparação longitudinal.', atual: true },
  { letra: 'B', titulo: 'HEP + adesão', texto: 'Biblioteca curada, prescrição FITT, link mobile, registro de execução e painel de adesão.', atual: true },
  { letra: 'C', titulo: 'Agenda recorrente', texto: 'Motor de recorrência e lembretes com confirmação em um clique.', atual: false },
  { letra: 'D', titulo: 'Portal + pacotes', texto: 'Portal completo, pacotes de sessão com saldo e recibo em PDF.', atual: false },
  { letra: 'E', titulo: 'IA determinística', texto: 'Resumo por template e sinalização de estagnação por regra estatística. Explicitamente não é IA generativa sobre dado clínico.', atual: false },
];

export function Landing() {
  const { tema, temaEfetivo, definirTema, movimento, definirMovimento } =
    usarPreferencias();

  // Rolagem suave só aqui. Dentro do sistema ela atrapalha: o profissional
  // quer que a lista pare onde ele soltou.
  usarScrollSuave(true);
  usarRevelacao();

  return (
    <div style={{ minHeight: '100vh' }}>
      {/* --- Cabeçalho ------------------------------------------------------ */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          // `color-mix` com transparência + blur: o conteúdo passa por baixo
          // sem sumir, e o texto do cabeçalho continua legível.
          background: 'color-mix(in oklab, var(--bg) 84%, transparent)',
          backdropFilter: 'blur(16px)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            padding: '14px 30px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 20,
          }}
        >
          <span style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 24, letterSpacing: '-0.02em' }}>
            Cinesis
          </span>

          <nav style={{ display: 'flex', gap: 22, fontSize: 13, alignItems: 'center' }}>
            <a href="#ciclo" style={{ color: 'var(--ink2)' }}>O ciclo</a>
            <a href="#modulos" style={{ color: 'var(--ink2)' }}>Módulos</a>
            <a href="#seguranca" style={{ color: 'var(--ink2)' }}>Segurança</a>
            <a href="#fases" style={{ color: 'var(--ink2)' }}>Fases</a>
          </nav>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {/* Os dois seletores exigidos pelo produto, disponíveis já na
                landing — antes mesmo de o visitante entrar no sistema. */}
            <Segmentado
              rotulo="Animações"
              valor={movimento}
              aoMudar={definirMovimento}
              opcoes={[
                { valor: 'completas', rotulo: 'Completas' },
                { valor: 'reduzidas', rotulo: 'Reduzidas' },
              ]}
            />
            <Segmentado
              rotulo="Tema"
              // Quando o tema segue o sistema, o seletor mostra o tema
              // EFETIVO — nao 'claro' por padrao. Marcar "Claro" numa tela
              // escura faz o usuario achar que o botao esta quebrado.
              valor={tema === 'sistema' ? temaEfetivo : tema}
              aoMudar={definirTema}
              opcoes={[
                { valor: 'claro', rotulo: 'Claro' },
                { valor: 'escuro', rotulo: 'Noturno' },
              ]}
            />
            <Link to="/entrar">
              <Botao>Entrar no sistema</Botao>
            </Link>
          </div>
        </div>
      </header>

      {/* --- Herói ---------------------------------------------------------- */}
      <section
        style={{
          position: 'relative',
          overflow: 'hidden',
          padding: 'clamp(70px, 9vw, 130px) 30px clamp(60px, 7vw, 104px)',
        }}
      >
        {/* Onda 3D. Some por completo no modo reduzido. */}
        <FundoOnda />

        {/* Gradientes suaves + grade vertical, sob o conteúdo. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: `
              radial-gradient(60% 50% at 20% 15%, color-mix(in oklab, var(--pri) 12%, transparent), transparent 70%),
              radial-gradient(55% 45% at 82% 30%, color-mix(in oklab, var(--acc) 10%, transparent), transparent 70%),
              repeating-linear-gradient(90deg, color-mix(in oklab, var(--line) 50%, transparent) 0 1px, transparent 1px 78px)
            `,
            animation: 'deriva 24s ease-in-out infinite',
          }}
        />

        <div style={{ position: 'relative', zIndex: 1, maxWidth: 1200, margin: '0 auto' }}>
          {/* Selo com as três garantias que definem o projeto. */}
          <div
            style={{
              display: 'inline-flex',
              gap: 8,
              alignItems: 'center',
              padding: '6px 14px',
              borderRadius: 'var(--r-pill)',
              border: '1px solid var(--line2)',
              background: 'color-mix(in oklab, var(--surface) 70%, transparent)',
              marginBottom: 26,
            }}
          >
            <span className="mono" style={{ fontSize: 10.5 }}>
              Software livre · LGPD Art. 11 · COFFITO 415/2012 · MIT
            </span>
          </div>

          <TextoPorPalavra
            como="h1"
            className="titulo-heroi"
            atraso={100}
          >
            Fisioterapia não é uma sequência de consultas isoladas.
          </TextoPorPalavra>

          <h2
            style={{
              fontFamily: 'var(--fonte-titulo)',
              fontSize: 'clamp(28px, 4.2vw, 56px)',
              lineHeight: 1.05,
              margin: '2px 0 26px',
              fontWeight: 400,
              letterSpacing: '-0.02em',
            }}
          >
            É uma{' '}
            <em style={{ color: 'var(--pri)', fontStyle: 'italic' }}>linha do tempo</em>{' '}
            mensurável.
          </h2>

          <TextoDesfocado
            atraso={500}
            className="subtitulo-heroi"
          >
            O Cinesis conecta avaliação, sessões, evolução, exercício domiciliar e adesão do
            paciente num ciclo único e comparável. Gratuito, de código aberto, e com o padrão de
            segurança que dado de saúde exige — não como módulo futuro, mas como fundação.
          </TextoDesfocado>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 30 }}>
            <Link to="/entrar">
              <Botao tamanho="grande">Abrir painel do fisioterapeuta</Botao>
            </Link>
            <a href="#ciclo">
              <Botao variante="secundario" tamanho="grande">
                Entender o ciclo
              </Botao>
            </a>
          </div>

          {/* Faixa de contadores. Animam ao entrar na tela. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 1,
              marginTop: 54,
              background: 'var(--line)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--r-cartao)',
              overflow: 'hidden',
            }}
          >
            {[
              { n: 11, r: 'módulos', nota: 'clínico + adesão + operação' },
              { n: 4, r: 'bounded contexts', nota: 'monólito modular' },
              { n: 5, r: 'fases', nota: 'cada uma entrega algo usável' },
              { n: 0, r: 'telemetria de terceiros', nota: 'analytics é opt-in' },
            ].map((m) => (
              <div key={m.r} style={{ background: 'var(--bg)', padding: '22px 20px' }}>
                <div style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 38, lineHeight: 1 }}>
                  <Contador valor={m.n} />
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 6 }}>{m.r}</div>
                <div className="mono" style={{ fontSize: 10, marginTop: 3 }}>
                  {m.nota}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --- O ciclo -------------------------------------------------------- */}
      <section
        id="ciclo"
        style={{ background: 'var(--surface2)', padding: 'clamp(60px, 7vw, 104px) 30px' }}
      >
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <h2 className="titulo-secao" data-reveal>
            O ciclo que o sistema mede
          </h2>
          <p
            data-reveal
            style={{ maxWidth: '62ch', color: 'var(--ink2)', fontSize: 15, marginBottom: 38 }}
          >
            Toda decisão de escopo é testada contra este ciclo. Funcionalidade administrativa que
            não o reforça é candidata a fase posterior — não à v1.
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'stretch' }}>
            {CICLO.map((etapa, i) => (
              <div
                key={etapa}
                data-reveal
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  // Defasagem: os cartões entram em sequência, sugerindo o
                  // próprio movimento do ciclo.
                  transitionDelay: `${i * 60}ms`,
                }}
              >
                <div
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--line)',
                    borderRadius: 'var(--r-cartao)',
                    padding: '14px 18px',
                    minWidth: 150,
                  }}
                >
                  <span className="mono" style={{ fontSize: 10 }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 4 }}>{etapa}</div>
                </div>
                <span aria-hidden="true" style={{ color: 'var(--ink3)', fontSize: 18 }}>
                  →
                </span>
              </div>
            ))}

            <div
              data-reveal
              style={{
                border: '1px dashed var(--line2)',
                borderRadius: 'var(--r-cartao)',
                padding: '14px 18px',
                display: 'grid',
                placeItems: 'center',
                minWidth: 150,
                color: 'var(--ink3)',
                fontSize: 12.5,
                transitionDelay: '560ms',
              }}
            >
              volta ao início
            </div>
          </div>
        </div>
      </section>

      {/* --- Módulos -------------------------------------------------------- */}
      <section id="modulos" style={{ padding: 'clamp(60px, 7vw, 104px) 30px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <h2 className="titulo-secao" data-reveal>
            Quatro contextos, um deploy
          </h2>
          <p
            data-reveal
            style={{ maxWidth: '62ch', color: 'var(--ink2)', fontSize: 15, marginBottom: 38 }}
          >
            Monólito modular, não microsserviços. A modularidade é de fronteira de código, não de
            processo — projeto pequeno, equipe de uma pessoa, domínio ainda em descoberta e forte
            necessidade de consistência transacional.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 18,
            }}
          >
            {MODULOS.map((m, i) => (
              <div key={m.tag} data-reveal style={{ transitionDelay: `${i * 80}ms` }}>
                <Cartao interativo style={{ height: '100%' }}>
                  <div
                    aria-hidden="true"
                    style={{ width: 22, height: 22, borderRadius: 6, background: m.cor }}
                  />
                  <div className="mono" style={{ marginTop: 14, fontSize: 10.5 }}>
                    {m.tag}
                  </div>
                  <h3 style={{ margin: '6px 0 8px', fontSize: 16, fontWeight: 800 }}>{m.titulo}</h3>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--ink2)', lineHeight: 1.6 }}>
                    {m.descricao}
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
                    {m.entidades.map((e) => (
                      <span
                        key={e}
                        className="mono"
                        style={{
                          fontSize: 10,
                          padding: '3px 8px',
                          borderRadius: 'var(--r-chip)',
                          background: 'var(--surface2)',
                          border: '1px solid var(--line)',
                        }}
                      >
                        {e}
                      </span>
                    ))}
                  </div>
                </Cartao>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --- Segurança ------------------------------------------------------ */}
      <section
        id="seguranca"
        style={{ background: 'var(--surface2)', padding: 'clamp(60px, 7vw, 104px) 30px' }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 0.85fr) minmax(0, 1.15fr)',
            gap: 50,
          }}
          className="grade-seguranca"
        >
          <div data-reveal>
            <h2 className="titulo-secao">Segurança não é módulo. É fundação.</h2>
            <p style={{ color: 'var(--ink2)', fontSize: 15, lineHeight: 1.65 }}>
              Dado de saúde é dado pessoal sensível (LGPD Art. 11). Toda entidade que carrega dado
              clínico nasce com pseudonimização, trilha de auditoria e controle de acesso por
              escopo. Não existe fase posterior para isso — cada entidade criada sem essas três
              coisas é dívida que só cresce.
            </p>
            <p style={{ color: 'var(--ink2)', fontSize: 15, lineHeight: 1.65 }}>
              Quem hospeda é o <strong>controlador e operador</strong> dos dados dos próprios
              pacientes. A licença diz &quot;como está&quot;, e o README diz o mesmo, sem
              ambiguidade.
            </p>

            <Cartao tom="pri" style={{ marginTop: 24 }}>
              <div className="mono" style={{ fontSize: 10.5, marginBottom: 8 }}>
                verificável, não prometido
              </div>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                Cada uma das camadas ao lado tem teste automatizado correspondente — inclusive as
                que dependem do banco: o isolamento entre clínicas é testado contra um PostgreSQL
                real, com RLS ativa, e a imutabilidade do prontuário é testada tentando alterar a
                linha por fora da aplicação.
              </p>
            </Cartao>
          </div>

          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {CAMADAS.map((c, i) => (
              <li
                key={c.titulo}
                data-reveal
                style={{
                  padding: '18px 0',
                  borderBottom: i < CAMADAS.length - 1 ? '1px solid var(--line)' : 'none',
                  transitionDelay: `${i * 55}ms`,
                }}
              >
                <div style={{ display: 'flex', gap: 14 }}>
                  <span
                    className="mono"
                    style={{ color: 'var(--pri)', fontSize: 12, paddingTop: 2, minWidth: 22 }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{c.titulo}</div>
                    <p
                      style={{
                        margin: '5px 0 0',
                        fontSize: 13,
                        color: 'var(--ink2)',
                        lineHeight: 1.6,
                      }}
                    >
                      {c.texto}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* --- Fases ---------------------------------------------------------- */}
      <section id="fases" style={{ padding: 'clamp(60px, 7vw, 104px) 30px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <h2 className="titulo-secao" data-reveal>
            Cada fase entrega um sistema usável
          </h2>
          <p
            data-reveal
            style={{ maxWidth: '62ch', color: 'var(--ink2)', fontSize: 15, marginBottom: 38 }}
          >
            Não um andaime. As fases A e B já estão implementadas — inclusive a comparação
            longitudinal, que é o que prova a tese.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
              gap: 16,
            }}
          >
            {FASES.map((f, i) => (
              <div key={f.letra} data-reveal style={{ transitionDelay: `${i * 70}ms` }}>
                <Cartao tom={f.atual ? 'pri' : undefined} style={{ height: '100%' }}>
                  <div
                    style={{
                      fontFamily: 'var(--fonte-titulo)',
                      fontSize: 34,
                      lineHeight: 1,
                      color: f.atual ? 'var(--pri-on-soft)' : 'var(--ink3)',
                    }}
                  >
                    {f.letra}
                  </div>
                  <h3 style={{ margin: '10px 0 6px', fontSize: 14.5, fontWeight: 800 }}>
                    {f.titulo}
                  </h3>
                  <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink2)', lineHeight: 1.55 }}>
                    {f.texto}
                  </p>
                  {f.atual && (
                    <div className="mono" style={{ marginTop: 12, fontSize: 10, color: 'var(--pri-on-soft)' }}>
                      implementada
                    </div>
                  )}
                </Cartao>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --- Rodapé --------------------------------------------------------- */}
      <footer
        style={{
          borderTop: '1px solid var(--line)',
          padding: '44px 30px',
          background: 'var(--surface2)',
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 22 }}>Cinesis</div>
            <div className="mono" style={{ marginTop: 6 }}>
              Especificação v1.1 · BivarDev · licença MIT · sem garantia
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Link to="/entrar">
              <Botao variante="secundario">Entrar no sistema</Botao>
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
