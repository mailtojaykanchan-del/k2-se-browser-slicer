FROM node:22-bookworm AS base

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787
CMD ["pnpm", "start"]
