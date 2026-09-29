FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS builder
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter api build
RUN pnpm deploy --filter=api --prod /app/out

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3091

COPY --from=builder /app/out/dist ./dist
COPY --from=builder /app/out/node_modules ./node_modules
COPY --from=builder /app/out/package.json ./package.json
COPY --from=builder /app/apps/api/prisma ./prisma

EXPOSE 3091
CMD ["pnpm", "run", "start:prod"]
