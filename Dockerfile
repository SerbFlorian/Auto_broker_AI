FROM node:22-slim

# Official image already has user `node` (uid=1000). Do NOT create another UID 1000.
# Compose also sets user: "1000:1000" — same identity.
#
# WORKER_TARGET=app     → bot + Stripe + digests (NO Playwright browsers — slim image)
# WORKER_TARGET=scraper → Playwright Chromium for TheParking / browser scrapes
# WORKER_TARGET=all     → local monolith / fallback (installs browsers)

ARG WORKER_TARGET=all

WORKDIR /app

# Deps + Prisma schema first (postinstall runs `prisma generate`)
COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl postgresql-client unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install

ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright
RUN if [ "$WORKER_TARGET" = "scraper" ] || [ "$WORKER_TARGET" = "all" ]; then \
      npx playwright install-deps chromium \
      && npx playwright install chromium; \
    else \
      echo "Skipping Playwright browsers (WORKER_TARGET=$WORKER_TARGET)"; \
    fi

# App source
COPY . .
RUN npx prisma generate \
  && mkdir -p /app/data /app/.playwright \
  && chown -R node:node /app

USER node

EXPOSE 3003

# Boot: migrate helpers → schema sync (NO --accept-data-loss) → GIN → app
CMD sh -c 'set -e; \
  psql "$DATABASE_URL" -f prisma/sql/pre_push_migrate.sql || true; \
  npx tsx scripts/dedupe-listings.ts || true; \
  npx prisma db push; \
  psql "$DATABASE_URL" -f prisma/sql/gin_version_tokens.sql || true; \
  npx prisma generate; \
  npx tsx src/index.ts'
