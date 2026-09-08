/**
 * Configurações.
 *
 * ## Duas seções, dois propósitos
 *
 * **Aparência e movimento** — os dois seletores exigidos pelo produto,
 * repetidos aqui além do cabeçalho porque é onde as pessoas procuram por eles.
 *
 * **Dados, consentimento e licença** — o painel de responsabilidade do
 * operador. Ele precisa ver, sem ler documentação, qual termo está vigente, que
 * a telemetria está desligada, e o que ainda está pendente de confirmação
 * regulatória.
 *
 * ## A pendência declarada em vez de escondida
 *
 * O prazo de guarda do prontuário aparece marcado como "a confirmar no texto
 * oficial do COFFITO". A alternativa — escolher um número plausível e exibi-lo
 * como se fosse certo — seria pior: quem instala tomaria uma decisão de
 * retenção baseada num palpite nosso.
 */

import { useState } from 'react';
import { Cartao, Pill, Segmentado, TituloSecao, usarPreferencias } from '@cinesis/ui';
import { enviar, ErroApi } from '../api.js';
import { usarSessao } from '../sessao.js';

export function Configuracoes() {
  const { tema, definirTema, movimento, definirMovimento } = usarPreferencias();
  const { profissional, recarregar } = usarSessao();

  const [mfa, setMfa] = useState<{ uri: string; segredo: string; codigos: string[] } | null>(null);
  const [codigoTotp, setCodigoTotp] = useState('');
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  /** Passo 1 do MFA: gera o segredo, sem ativar nada ainda. */
  async function prepararMfa() {
    setErro(null);
    try {
      const r = await enviar<{ uri: string; segredo: string; codigosRecuperacao: string[] }>(
        '/auth/mfa/preparar',
      );
      setMfa({ uri: r.uri, segredo: r.segredo, codigos: r.codigosRecuperacao });
    } catch (e) {
      setErro(e instanceof ErroApi ? e.mensagem : 'Falha ao preparar o segundo fator.');
    }
  }

  /** Passo 2: confirma com um código válido. Só aqui o MFA é ativado. */
  async function ativarMfa() {
    setErro(null);
    try {
      await enviar('/auth/mfa/ativar', { totp: codigoTotp });
      setMensagem('Segundo fator ativado.');
      setMfa(null);
      setCodigoTotp('');
      await recarregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.mensagem : 'Código inválido.');
    }
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 style={{ fontFamily: 'var(--fonte-titulo)', fontSize: 27, margin: '0 0 22px' }}>
        Configurações
      </h1>

      {/* --- Aparência e movimento -------------------------------------------- */}
      <Cartao style={{ marginBottom: 20 }}>
        <TituloSecao titulo="Aparência e movimento" />

        <div style={{ display: 'grid', gap: 20 }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>Animações</div>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--ink2)' }}>
              Reduzidas mantêm exatamente a mesma informação na tela — só o caminho até ela é
              instantâneo. O fundo animado da apresentação também é desligado.
            </p>
            <Segmentado
              rotulo="Animações"
              valor={movimento}
              aoMudar={definirMovimento}
              opcoes={[
                { valor: 'completas', rotulo: 'Completas' },
                { valor: 'reduzidas', rotulo: 'Reduzidas' },
              ]}
            />
          </div>

          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>Tema</div>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--ink2)' }}>
              O modo noturno usa a mesma paleta com outras luminosidades, não uma inversão de
              cores — os tons de alerta continuam significando a mesma coisa.
            </p>
            <Segmentado
              rotulo="Tema"
              valor={tema}
              aoMudar={definirTema}
              opcoes={[
                { valor: 'claro', rotulo: 'Claro' },
                { valor: 'escuro', rotulo: 'Noturno' },
                { valor: 'sistema', rotulo: 'Seguir o sistema' },
              ]}
            />
          </div>
        </div>

        <p className="mono" style={{ marginTop: 16, fontSize: 10.5, lineHeight: 1.7 }}>
          Preferência gravada neste dispositivo. Sem escolha salva, o sistema respeita
          `prefers-reduced-motion` e `prefers-color-scheme` do seu sistema operacional.
        </p>
      </Cartao>

      {/* --- Segundo fator ------------------------------------------------------ */}
      <Cartao style={{ marginBottom: 20 }}>
        <TituloSecao
          titulo="Segundo fator (TOTP)"
          subtitulo="Recomendado para quem pode reidentificar pacientes. O vetor mais provável de comprometimento não é uma falha do sistema: é reuso de senha num site que vazou."
          acao={
            <Pill tom={profissional?.mfaAtivo ? 'good' : 'acc'}>
              {profissional?.mfaAtivo ? 'Ativo' : 'Desligado'}
            </Pill>
          }
        />

        {!profissional?.mfaAtivo && !mfa && (
          <button
            onClick={() => void prepararMfa()}
            style={{
              padding: '10px 18px',
              borderRadius: 'var(--r-botao)',
              border: '1px solid var(--pri)',
              background: 'var(--pri)',
              color: 'var(--pri-ink)',
              fontSize: 13.5,
              fontWeight: 700,
            }}
          >
            Configurar segundo fator
          </button>
        )}

        {mfa && (
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <div className="rotulo">1. Cadastre no seu app autenticador</div>
              <div
                className="mono"
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: 'var(--surface2)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-badge)',
                  fontSize: 11,
                  wordBreak: 'break-all',
                }}
              >
                {mfa.segredo}
              </div>
            </div>

            <div>
              <div className="rotulo">2. Guarde os códigos de recuperação</div>
              <p style={{ margin: '6px 0 8px', fontSize: 12.5, color: 'var(--ink2)' }}>
                Eles aparecem <strong>uma única vez</strong>. Cada um funciona uma vez só, e
                servem para entrar se você perder o celular.
              </p>
              <div
                className="mono"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
                  gap: 6,
                  fontSize: 11,
                }}
              >
                {mfa.codigos.map((c) => (
                  <span
                    key={c}
                    style={{
                      padding: '6px 8px',
                      background: 'var(--surface2)',
                      border: '1px solid var(--line)',
                      borderRadius: 'var(--r-chip)',
                      textAlign: 'center',
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <div className="rotulo">3. Confirme com um código do app</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                <input
                  value={codigoTotp}
                  onChange={(e) => setCodigoTotp(e.target.value)}
                  placeholder="000000"
                  inputMode="numeric"
                  maxLength={6}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 'var(--r-botao)',
                    border: '1px solid var(--line2)',
                    background: 'var(--surface2)',
                    color: 'var(--ink)',
                    fontFamily: 'var(--fonte-mono)',
                    fontSize: 14,
                    width: 120,
                  }}
                />
                <button
                  onClick={() => void ativarMfa()}
                  disabled={codigoTotp.length !== 6}
                  style={{
                    padding: '10px 18px',
                    borderRadius: 'var(--r-botao)',
                    border: '1px solid var(--pri)',
                    background: 'var(--pri)',
                    color: 'var(--pri-ink)',
                    fontSize: 13.5,
                    fontWeight: 700,
                    opacity: codigoTotp.length !== 6 ? 0.5 : 1,
                  }}
                >
                  Ativar
                </button>
              </div>
              <p className="mono" style={{ marginTop: 8, fontSize: 10.5 }}>
                O segredo só é gravado depois desta confirmação — ativar antes trancaria você fora
                da conta se o cadastro no app tivesse falhado.
              </p>
            </div>
          </div>
        )}

        {mensagem && (
          <p style={{ marginTop: 12, fontSize: 13, color: 'var(--good)' }} role="status">
            {mensagem}
          </p>
        )}
        {erro && (
          <p style={{ marginTop: 12, fontSize: 13, color: 'var(--bad)' }} role="alert">
            {erro}
          </p>
        )}
      </Cartao>

      {/* --- Dados, consentimento e licença ------------------------------------- */}
      <Cartao>
        <TituloSecao titulo="Dados, consentimento e licença" />

        <div style={{ display: 'grid', gap: 1, background: 'var(--line)' }}>
          <Linha
            rotulo="TCLE vigente"
            valor="v1"
            nota="publicar um termo novo invalida os aceites anteriores"
          />
          <Linha
            rotulo="Retenção de prontuário"
            valor="a confirmar"
            nota="confirmar o prazo no texto oficial do COFFITO antes de implementar a política"
            atencao
          />
          <Linha
            rotulo="Telemetria de terceiros"
            valor="desligada"
            nota="analytics é opt-in, agregado e anônimo — nunca dado clínico"
          />
          <Linha
            rotulo="Licença"
            valor="MIT"
            nota="sem garantia · quem hospeda é o controlador e o operador dos dados"
          />
        </div>

        <p style={{ marginTop: 16, fontSize: 12.5, color: 'var(--ink2)', lineHeight: 1.7 }}>
          Logs técnicos, métricas e telemetria de aplicação não carregam PII nem dado clínico. Isso
          não depende da disciplina de quem escreve o log: o serializador do logger passa todo
          objeto por um redator que funciona por <strong>lista de permissão</strong> — campo não
          classificado é redigido por padrão, e endereços IP nunca aparecem em claro.
        </p>
      </Cartao>
    </div>
  );
}

/** Uma linha da tabela de conformidade. */
function Linha({
  rotulo,
  valor,
  nota,
  atencao = false,
}: {
  rotulo: string;
  valor: string;
  nota: string;
  atencao?: boolean;
}) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        padding: '14px 4px',
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 190, fontSize: 13.5, fontWeight: 700 }}>{rotulo}</div>
      <div style={{ minWidth: 110 }}>
        <span
          className="mono"
          style={{ fontSize: 11.5, color: atencao ? 'var(--acc)' : 'var(--ink)' }}
        >
          {valor}
        </span>
      </div>
      <div style={{ flex: 1, minWidth: 220, fontSize: 12, color: 'var(--ink2)' }}>{nota}</div>
    </div>
  );
}
