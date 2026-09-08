# Imagem de produção do Cinesis.
#
# Build em vários estágios: as dependências de desenvolvimento e o código-fonte
# ficam no estágio de compilação e não entram na imagem final. O resultado é
# menor e tem menos coisa para dar errado.

# =============================================================================
# Estágio 1 — dependências
# =============================================================================
FROM node:22-alpine AS deps
WORKDIR /app

# Copia apenas os manifestos primeiro.
#
# É o que permite ao Docker reaproveitar a camada de `npm ci` quando só o código
# mudou — o caso de quase todo build. Copiar o projeto inteiro antes
# invalidaria o cache a cada alteração de uma linha.
COPY package.json package-lock.json ./
COPY packages/shared/package.json    packages/shared/
COPY packages/security/package.json  packages/security/
COPY packages/domain/package.json    packages/domain/
COPY packages/ui/package.json        packages/ui/
COPY apps/api/package.json           apps/api/
COPY apps/web/package.json           apps/web/
COPY apps/portal/package.json        apps/portal/

# `npm ci` e não `npm install`: instala exatamente o que está no lockfile e
# falha se ele estiver dessincronizado do package.json.
RUN npm ci

# =============================================================================
# Estágio 2 — compilação
# =============================================================================
FROM node:22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# API: TypeScript → JavaScript. Frontends: bundle estático.
RUN npm run build --workspace @cinesis/api \
 && npm run build --workspace @cinesis/web \
 && npm run build --workspace @cinesis/portal

# =============================================================================
# Estágio 3 — imagem final
# =============================================================================
FROM node:22-alpine AS producao
WORKDIR /app

ENV NODE_ENV=production

# `dumb-init` como PID 1.
#
# O Node não é um bom PID 1: ele não encaminha SIGTERM para os filhos nem
# recolhe processos zumbis. Sem isso, `docker compose down` esperaria o timeout
# em vez de desligar de forma graciosa — e o desligamento gracioso é o que
# impede transação pela metade.
RUN apk add --no-cache dumb-init

# Só as dependências de produção.
COPY package.json package-lock.json ./
COPY packages/shared/package.json    packages/shared/
COPY packages/security/package.json  packages/security/
COPY packages/domain/package.json    packages/domain/
COPY apps/api/package.json           apps/api/
RUN npm ci --omit=dev --workspace @cinesis/api --include-workspace-root \
 && npm cache clean --force

# Artefatos compilados.
COPY --from=build /app/packages/shared/dist   packages/shared/dist
COPY --from=build /app/packages/security/dist packages/security/dist
COPY --from=build /app/packages/domain/dist   packages/domain/dist
COPY --from=build /app/apps/api/dist          apps/api/dist
COPY --from=build /app/apps/web/dist          apps/web/dist
COPY --from=build /app/apps/portal/dist       apps/portal/dist

# Diretório de mídia, com dono correto antes de baixar o privilégio.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# Roda como usuário sem privilégio.
#
# O `node` já existe na imagem oficial. Rodar como root dentro do contêiner
# significa que uma falha de execução remota começa com root — e, dependendo da
# configuração do runtime, isso encurta bastante o caminho para fora.
USER node

EXPOSE 3333

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/servidor.js"]
