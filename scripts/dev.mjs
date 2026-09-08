/**
 * Sobe API, aplicacao profissional e portal do paciente juntos.
 *
 * Existe para que `npm run dev` seja UM comando, nao tres terminais. O
 * publico-alvo do projeto instala software raramente; a mesma logica que vale
 * para o deploy vale para quem contribui.
 */

import { spawn } from 'node:child_process';

/** Os tres processos, com uma cor de prefixo para distinguir a saida. */
const PROCESSOS = [
  { nome: 'api   ', cor: '\x1b[36m', args: ['run', 'dev', '-w', '@cinesis/api'] },
  { nome: 'web   ', cor: '\x1b[35m', args: ['run', 'dev', '-w', '@cinesis/web'] },
  { nome: 'portal', cor: '\x1b[33m', args: ['run', 'dev', '-w', '@cinesis/portal'] },
];

const filhos = PROCESSOS.map((p) => {
  // `shell: true` no Windows: `npm` e um `.cmd`, que o `spawn` nao executa direto.
  const filho = spawn('npm', p.args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

  /** Prefixa cada linha com o nome do processo. */
  const prefixar = (fluxo) => (dado) => {
    for (const linha of String(dado).split('\n')) {
      if (linha.trim()) fluxo.write(`${p.cor}${p.nome}\x1b[0m │ ${linha}\n`);
    }
  };

  filho.stdout.on('data', prefixar(process.stdout));
  filho.stderr.on('data', prefixar(process.stderr));

  return filho;
});

/** Derruba todos juntos: um Ctrl+C nao pode deixar processo orfao. */
const encerrar = () => {
  for (const f of filhos) f.kill();
  process.exit(0);
};

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

console.log(`
  Cinesis em desenvolvimento

  API      http://127.0.0.1:3333
  Sistema  http://localhost:5173
  Portal   http://localhost:5174

  Primeira vez? Rode  npm run db:seed  em outro terminal.
`);
