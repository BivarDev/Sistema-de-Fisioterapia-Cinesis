/**
 * Rotas da aplicação profissional.
 *
 * ## Duas camadas de proteção, com papéis diferentes
 *
 * `RotaProtegida` impede que a tela **apareça** sem sessão — é conveniência de
 * navegação. Quem protege o dado é o servidor, que refaz a checagem de sessão
 * e de RBAC em cada endpoint. Trocar a rota no JavaScript do navegador mostra
 * uma tela vazia com 401 no console, não dado clínico.
 */

import { Navigate, Route, Routes } from 'react-router-dom';
import { Landing } from './telas/Landing.js';
import { Entrar } from './telas/Entrar.js';
import { Layout } from './componentes/Layout.js';
import { Hoje } from './telas/Hoje.js';
import { Pacientes } from './telas/Pacientes.js';
import { Plano } from './telas/Plano.js';
import { Avaliacao } from './telas/Avaliacao.js';
import { Prescricao } from './telas/Prescricao.js';
import { Adesao } from './telas/Adesao.js';
import { Biblioteca } from './telas/Biblioteca.js';
import { Seguranca } from './telas/Seguranca.js';
import { Configuracoes } from './telas/Configuracoes.js';
import { usarSessao } from './sessao.js';
import type { ReactNode } from 'react';

/** Envolve as rotas que exigem sessão. */
function RotaProtegida({ children }: { children: ReactNode }) {
  const { estado } = usarSessao();

  // Enquanto a sessão é restaurada, mostra um estado neutro. Redirecionar
  // aqui mandaria para o login todo mundo que aperta F5.
  if (estado === 'carregando') {
    return (
      <div
        style={{
          height: '100dvh',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ink3)',
          fontSize: 13,
        }}
      >
        Carregando…
      </div>
    );
  }

  if (estado === 'anonimo') return <Navigate to="/entrar" replace />;

  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      {/* Públicas. */}
      <Route path="/" element={<Landing />} />
      <Route path="/entrar" element={<Entrar />} />

      {/* Sistema. O `Layout` renderiza a sidebar e o `Outlet`. */}
      <Route
        path="/app"
        element={
          <RotaProtegida>
            <Layout />
          </RotaProtegida>
        }
      >
        <Route index element={<Navigate to="/app/hoje" replace />} />
        <Route path="hoje" element={<Hoje />} />
        <Route path="pacientes" element={<Pacientes />} />
        <Route path="planos/:id" element={<Plano />} />
        <Route path="planos/:id/avaliacao" element={<Avaliacao />} />
        <Route path="planos/:id/prescricao" element={<Prescricao />} />
        <Route path="adesao" element={<Adesao />} />
        <Route path="biblioteca" element={<Biblioteca />} />
        <Route path="seguranca" element={<Seguranca />} />
        <Route path="configuracoes" element={<Configuracoes />} />
      </Route>

      {/* Qualquer outra coisa volta para a apresentação. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
