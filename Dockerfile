# kanasante API — production image.
#
# Deploy-agnostic (12-factor): all config via environment variables, resolved
# and validated by varlock at process start against the committed .env.schema.
# APP_ENV defaults to prod here (fail-loud on missing secrets); the deploy
# compose file overrides it per stage (dev / staging / prod). See docs/deployment.md.
#
# Two targets share one build:
#   runtime (default) — lean, production deps only, runs the server.
#   migrate           — full deps (drizzle-kit is a devDependency), runs the
#                       committed migrations once. Same tag with a `-migrate`
#                       suffix; invoked as a one-shot release step before the
#                       new runtime container is started.

FROM oven/bun:1.3-slim AS deps-full
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim AS migrate
WORKDIR /app
ENV NODE_ENV=production
ENV APP_ENV=prod
COPY --from=deps-full /app/node_modules ./node_modules
COPY package.json .env.schema drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src/db ./src/db
USER bun
CMD ["bunx", "varlock", "run", "--", "drizzle-kit", "migrate"]

FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV APP_ENV=prod

COPY --from=deps /app/node_modules ./node_modules
COPY package.json .env.schema ./
COPY src ./src

USER bun
EXPOSE 3000

CMD ["bunx", "varlock", "run", "--", "bun", "src/server.ts"]
