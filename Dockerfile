FROM node:22-bookworm-slim
WORKDIR /app

RUN corepack enable && pnpm config set minimum-release-age 0

COPY package.json pnpm-lock.yaml tsconfig.json vite.config.ts ./
RUN pnpm install --frozen-lockfile --config.minimum-release-age=0

COPY . .
RUN pnpm build

ENV PORT=10000
EXPOSE 10000

CMD ["pnpm", "start"]
