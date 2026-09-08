/**
 * Ponto de entrada do portal do paciente.
 *
 * Sem roteador: o portal tem uma tela so. Adicionar `react-router` aqui seria
 * ~10 KB para gerenciar zero rotas — e o publico deste app costuma estar numa
 * rede movel ruim.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ProvedorPreferencias } from '@cinesis/ui';
import '@cinesis/ui/estilos.css';
import './estilos.css';
import { App } from './App.js';

const raiz = document.getElementById('raiz');
if (!raiz) throw new Error('Elemento #raiz nao encontrado no index.html.');

createRoot(raiz).render(
  <StrictMode>
    <ProvedorPreferencias>
      <App />
    </ProvedorPreferencias>
  </StrictMode>,
);
