/**
 * Tela de login.
 *
 * ## O que ela deliberadamente não faz
 *
 * Não distingue "e-mail não existe" de "senha errada". A mensagem vem pronta do
 * servidor e é a mesma nos dois casos — dar mensagens diferentes entregaria a
 * lista de usuários do sistema a quem tentasse e-mails em sequência.
 *
 * Também não mostra "força da senha" nem exige composição no login: essa
 * política é aplicada no cadastro, e repeti-la aqui só atrapalharia quem já tem
 * uma senha válida.
 */

import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Botao, Cartao, TextoPorPalavra } from '@cinesis/ui';
import { ErroApi } from '../api.js';
import { usarSessao } from '../sessao.js';

export function Entrar() {
  const { entrar, estado } = usarSessao();
  const navegar = useNavigate();

  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [totp, setTotp] = useState('');
  const [precisaTotp, setPrecisaTotp] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  // Já autenticado (voltou pelo histórico, por exemplo): vai direto ao sistema.
  if (estado === 'autenticado') return <Navigate to="/app/hoje" replace />;

  async function submeter(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      await entrar(email, senha, totp || undefined);
      navegar('/app/hoje');
    } catch (err) {
      if (err instanceof ErroApi) {
        // O servidor pede o segundo fator: revela o campo em vez de só
        // repetir "credenciais inválidas", que confundiria quem tem MFA.
        if (err.mensagem.toLowerCase().includes('verificação')) setPrecisaTotp(true);
        setErro(err.mensagem);
      } else {
        setErro('Não foi possível falar com o servidor.');
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'var(--surface2)',
      }}
    >
      <div style={{ width: '100%', maxWidth: 420 }}>
        <Link to="/" style={{ color: 'var(--ink3)', fontSize: 12.5 }}>
          ← voltar
        </Link>

        <TextoPorPalavra
          como="h1"
          className="titulo-secao"
        >
          Entrar no Cinesis
        </TextoPorPalavra>

        <Cartao style={{ marginTop: 18 }}>
          <form onSubmit={submeter} style={{ display: 'grid', gap: 14 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>E-mail</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                // `username` ajuda o gerenciador de senhas a preencher os dois
                // campos juntos — o que faz as pessoas usarem senhas melhores.
                autoComplete="username"
                style={campo}
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>Senha</span>
              <input
                type="password"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                required
                autoComplete="current-password"
                style={campo}
              />
            </label>

            {precisaTotp && (
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>
                  Código de verificação
                </span>
                <input
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  // `one-time-code` deixa o iOS oferecer o código do app
                  // autenticador direto no teclado.
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={9}
                  placeholder="6 dígitos ou código de recuperação"
                  style={{ ...campo, fontFamily: 'var(--fonte-mono)' }}
                />
              </label>
            )}

            {erro && (
              <div
                // `role="alert"` faz o leitor de tela anunciar o erro assim que
                // ele aparece, sem o usuário precisar procurar.
                role="alert"
                style={{
                  background: 'var(--bad-soft)',
                  border: '1px solid var(--bad)',
                  color: 'var(--bad)',
                  borderRadius: 'var(--r-badge)',
                  padding: '10px 12px',
                  fontSize: 12.5,
                }}
              >
                {erro}
              </div>
            )}

            <Botao type="submit" tamanho="grande" disabled={enviando}>
              {enviando ? 'Entrando…' : 'Entrar'}
            </Botao>
          </form>
        </Cartao>

        <p className="mono" style={{ marginTop: 16, lineHeight: 1.7 }}>
          Instalação de demonstração? Rode <strong>npm run db:seed</strong> e entre com{' '}
          <strong>fisio@cinesis.local</strong>. As contas de recepção e estagiário usam a mesma
          senha — troque o papel para ver o RBAC agir.
        </p>
      </div>
    </div>
  );
}

/** Estilo compartilhado dos campos de formulário. */
const campo: React.CSSProperties = {
  padding: '11px 15px',
  borderRadius: 'var(--r-botao)',
  border: '1px solid var(--line2)',
  background: 'var(--surface2)',
  color: 'var(--ink)',
  fontSize: 14,
  fontFamily: 'inherit',
  // 44px de altura mínima: alvo de toque confortável também no celular.
  minHeight: 44,
};
