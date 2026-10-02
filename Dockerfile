# kanasante API — production image.
#
# Deploy-agnostic (12-factor): all config via environment variables, resolved
# and validated by varlock at process start against the committed .env.schema.
# APP_ENV defaults to prod here (fail-loud on missing secrets); the deploy
# compose file overrides it per stage (dev / staging / prod). See docs/deployment.md.
#
# One image serves both roles — the deploy runs migrations as a one-shot
# container from this same image before starting the server:
#   server:      bunx varlock run -- bun src/server.ts   (default CMD)
#   migrations:  bunx varlock run -- bun src/migrate.ts  (drizzle-orm migrator,
#                no drizzle-kit needed; reads the committed ./drizzle folder)

FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV APP_ENV=prod

COPY --from=deps /app/node_modules ./node_modules
# tsconfig.json is needed at runtime: Bun resolves the `@/` path alias from it.
COPY package.json tsconfig.json .env.schema ./
# The schema's TS-types codegen is a dev-time concern; inside the (read-only,
# non-root) container it would try to write env.d.ts and fail.
RUN sed -i '/@generateTsTypes/d' .env.schema
COPY drizzle ./drizzle
COPY src ./src
COPY scripts/backfill-delivery.ts ./scripts/backfill-delivery.ts

USER bun
EXPOSE 3000

CMD ["bunx", "varlock", "run", "--", "bun", "src/server.ts"]
