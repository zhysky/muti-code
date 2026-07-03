FROM node:20-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json tsconfig.check.json vitest.config.ts ./
RUN npm install
RUN npm run build -w @agent-gateway/web

FROM node:20-slim
WORKDIR /app
RUN npm install -g vite@7.0.0
COPY --from=build /app/apps/web/dist ./dist
COPY apps/web/vite.preview.config.mjs ./vite.preview.config.mjs
EXPOSE 5173
CMD ["vite", "preview", "--config", "vite.preview.config.mjs"]
