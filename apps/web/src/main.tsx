/**
 * Ponto de entrada da aplicação profissional.
 *
 * A ordem dos provedores importa: `ProvedorPreferencias` precisa envolver tudo
 * porque tema e modo de animação valem inclusive na tela de login e na
 * landing — que ficam fora do `ProvedorSessao`.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ProvedorPreferencias } from '@cinesis/ui';
import '@cinesis/ui/estilos.css';
import './estilos.css';
import { App } from './App.js';
import { ProvedorSessao } from './sessao.js';

const raiz = document.getElementById('raiz');
if (!raiz) throw new Error('Elemento #raiz não encontrado no index.html.');

createRoot(raiz).render(
  // `StrictMode` monta e desmonta cada efeito duas vezes em desenvolvimento.
  // É desconfortável, e é justamente o que revela vazamento de listener e de
  // contexto WebGL — os dois erros que um fundo 3D convida.
  <StrictMode>
    <ProvedorPreferencias>
      <BrowserRouter>
        <ProvedorSessao>
          <App />
        </ProvedorSessao>
      </BrowserRouter>
    </ProvedorPreferencias>
  </StrictMode>,
);
