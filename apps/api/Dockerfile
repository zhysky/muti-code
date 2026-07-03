FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps ./apps
COPY packages ./packages
COPY config ./config
COPY sample-project ./sample-project
COPY tsconfig.base.json tsconfig.check.json vitest.config.ts ./
RUN npm install
RUN npm install -g @openai/codex@0.142.5 opencode-ai@1.17.13

ENV NODE_ENV=demo
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@agent-gateway/api"]
