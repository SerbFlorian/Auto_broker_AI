# Auto Broker AI — Architecture & Operations Handbook

> **Purpose of this document:** single source of truth for product decisions, system design, tools, crons, Redis/R2 strategy, scrapers, filters, matching, AI, and how to change things safely.  
> Keep this file updated when you change architecture or ops policy.

---

## 1. What this product is

**Auto Broker AI** is a Telegram Micro-SaaS that:

1. Scrapes European used-car listings into Postgres.
2. Lets VIP users configure a **24/7 radar** (filters).
3. Matches new inventory to VIP alerts and delivers **batched digests** (not spam).
4. Offers an **AI car advisor** (GPT-4o-mini) with inventory tools.
5. Monetizes via **Stripe Payment Links** (3 soft-launch tiers by VIP seat count).

**Deploy model today:** two Node roles in Compose — **`app`** (Telegram bot + Stripe webhook + digests + R2 backup) and **`scraper`** (Playwright/HTTP ingest + cleanup). Local/dev can use `WORKER_MODE=all` in one process. Postgres + Redis beside them. Both containers use **`TZ=Europe/Madrid`**.

**Schedule split (important):**

| Lane | When |
|------|------|
| **Scrapers** (new inventory) | **Mon–Fri** 08–20 Europe/Madrid |
| **Digests / radar delivery** | **Per VIP** via `/schedule` (days + hours + interval). Defaults: **Mon–Sun**, **08:00–20:59**, every **2h**. Hard floor **07–23** so nights stay free for cleanup/backup |
| System hard floor | `NOTIF_HARD_START_HOUR`–`NOTIF_HARD_END_HOUR` (default 7–23) — users cannot schedule outside this |

Matching still runs whenever listings are written; the user’s day/hour window only delays **Telegram sends**. Weekend digests reuse stock already in Postgres (no fresh portal ingest Sat–Sun).

**Target host (T0):** shared VPS ~4 vCPU / 8 GB where this stack uses ~2 vCPU / ~4.7 GB limits (Compose `deploy.resources` — enforced on Swarm; on plain `docker compose up` treat as sizing guidance). Soft launch / tens of thousands VIP / ~100k–500k cars — not 5M concurrent cars on this box.

**Soft-launch security posture (ops assumptions: Cloudflare + SSH keys-only + strong secrets):** ~**92–94%**. Product/ops ready ~**85%+** after Stripe/R2 smoke tests. See §14 and §16.


---

## Soft-launch improvements (product, UX, security)

Summary of hardening and UX work locked for launch:

### Security & isolation
| Item | Detail |
|------|--------|
| **Dual containers** | `app` ≠ `scraper` (`WORKER_MODE`). Chromium/Playwright only in scraper |
| **Secret surface** | Scraper has **no** `env_file` and **no `TELEGRAM_BOT_TOKEN`** — no Stripe / R2 / payment links / bot control in that process |
| **CRITICAL relay** | Tokenless containers `RPUSH` alerts to `ops:critical`; app forwards them to the admin chat every 60s (`ADMIN_RELAY_POLL_MS`) |
| **Fail-fast role** | An invalid `WORKER_MODE` aborts boot instead of silently falling back to `all` (which would double-poll Telegram) |
| **Non-root + caps** | `USER node` (uid 1000), `cap_drop: ALL` (app/scraper/postgres; Redis exception for AOF), `no-new-privileges`, Compose `deploy.resources.limits.pids` (Swarm-enforced) |
| **Network** | App bind `127.0.0.1:3003`; Postgres/Redis **no host ports**; scraper only on `internal` |
| **Redis auth** | `requirepass` via `REDIS_PASSWORD` |
| **HTTP surface** | `GET /health` (returns only `{"status":"ok"}` — no internal state) + Stripe `POST /webhook` (signed + rate-limit); everything else 404 |
| **Logs / CRITICAL** | `installRedactedConsole()` + `redactSecrets` on admin alerts |
| **Privacy** | `/delete_account` (Subastas-style copy when VIP still active); auto-purge after `DATA_PURGE_HOURS` (48h); Telegram ID kept to protect free-trial abuse |
| **Compose caps** | App forces `AI_VIP_DAILY_MAX=40`, `AI_VIP_WEEKLY_MAX=280`, DB lookups `3`, free `3` (overrides stale VPS `.env`) |
| **Timezone** | `TZ=Europe/Madrid` on app + scraper |

### Product & UX
| Item | Detail |
|------|--------|
| **Welcome** | Subastas-style HTML sections + blockquotes (Free / AI / VIP / commands). English. No public-channel button (all in this chat) |
| **Commands** | `/start`, `/filters`, `/schedule`, `/advisor`, `/status`, `/delete_account` — clickable plain commands in welcome; BotFather menu English. Subscribe via `/start` button (no `/vip` command) |
| **VIP welcome** | Same structure; radar + **`/schedule`** (days/hours/frequency, VIP-only); “Plus more AI advisor usage” (quotas in `/advisor`) |
| **`/advisor`** | HTML layout; Free 3×1 listing no link; VIP **40/day · 280/week**; radar digests ≤3 + **Listing found**; AI DB pulls ≤3/day × 1 listing |
| **Filters UI** | Uniform rows + pagination (brand 8×3; model/specs/motor/fuel/power 6×3; **country 6×2** with `Name (n)` labels). Summary order: **Brand → Model → Specs → Motor → Power → Fuel → Price → Year → Km → Country** |
| **Filter draft UX** | Each submenu: **Any/All** + **Back** (discard) + **Done** (commit draft). Panel **Done** alone writes `UserAlert` + Redis resync. Dashboard opens with a soft-launch note: quiet digests ≈ tighten/widen filters (inventory still growing), not a system fault |
| **Specs catalog** | Trims from `src/data/car-specifications.json` only (no AI-invented labels). Empty selection = **Any** (all ads). Matching maps listing `version`/`versionTokens` onto catalog labels (`carSpecs.catalog.ts`). Model aliases (`catalogModelAliases.ts`: Serie↔Series, Clase↔Class, …) |
| **Engine / CV catalog** | Motors + typical CV from `src/data/engine-catalog.json` (same brands/models as specs). Bare `"1.0"` → brand family (Audi → TFSI, …); bogus `"0 TFSI"` normalized to **`TFSI`**. Filter **Motor** multi-select + **Power** min CV |
| **Norms** | Accents folded (`León`→`leon`); empty `versionTokens` healed from `version` on read + boot backfill (`BACKFILL_NORMS` / `BACKFILL_VERSION_TOKENS`); engine/CV filled on write + every **2h** enrich job |
| **Stock counts** | Approximate display (`~390`, `~7.8k`) when ≥100; year never shows `>0`; max km only `< …` options |
| **Country** | Multi-select `countries String[]`; buttons `Country (count)` — **6 rows × 2 cols** (12/page) so names don’t truncate |
| **After save** | “Radar updated” + **Back to panel** → filters dashboard (`vip_filters`) |
| **Filter → Redis** | If fingerprint **changed**: clear `notif:q:*`, invalidate alert index, **reseed** ≤3 fresh cars (skip already-sent / near-dups) |
| **Dedup** | Matching + AI skip `SentListing` + near-dups; AI only re-sends if user explicitly asks (“again”, “el mismo”, …) |
| **Links** | HTML `<a href="…">Listing found</a>` (AI replies + digests) — never raw URLs; AI chat uses HTML escape to avoid Telegram Markdown entity errors |
| **Free `/start` buttons** | Subscribe · Status · Privacy (no “How the AI works” — use `/advisor`) |
| **Deal score** | Each digest car shows how its price compares to the **median** of comparable inventory (same brand+model, year ±1, similar km). Silent when the sample is < 6 ads |
| **Duplicate notice** | “Same car also listed on N other portals” so three near-identical results never read as three different cars |
| **Quiet hours / schedule** | Per-VIP `/schedule`: days + interval **1-4h** (default **2h**). Hours default 08-21, hard clamp 7-23; current UI limits start to **07-12** and end to **19-23**. `NOTIF_WINDOW_*` / `NOTIF_INTERVAL_HOURS` seed new users |
| **Warmup quota** | Post-filter-change digests capped at `NOTIF_WARMUP_MAX_PER_DAY` (2) so re-saving filters can’t farm alerts |

### Scrapers (schedule)
| Lane | Schedule |
|------|----------|
| **Fast** (Clicars, Ooyyo) | Every **30 min**, **Mon–Fri** 08–20 |
| **Slow** (TheParking) | Every **4 h** at 08/12/16/20, Mon–Fri |
| **Weekend** | Scrapers **off** (Sat+Sun). Digests still run per each VIP's /schedule from existing stock |


---

## 2. Tech stack & tools

| Layer | Tool | Why |
|-------|------|-----|
| Runtime | **Node 22** + **TypeScript (ESM)** + **tsx** | Simple Docker CMD, no separate build step required |
| Bot | **Telegraf** | Telegram bot + inline keyboards |
| HTTP API | **Express 5** | Stripe webhooks on `PORT` (compose: **3003**) |
| ORM / DB | **Prisma 5** + **PostgreSQL 15** | Typed schema; client generated to `src/generated/prisma` |
| Cache / queues | **Redis 7** + **ioredis** | Inventory cache, alert index, notification lists; memory fallback if Redis down |
| Scraping | **Cheerio**, **Axios**, **Playwright** (+ stealth / puppeteer-extra where used) | Fast portals via HTTP; TheParking via browser + detail fetch |
| Anti-bot | **Bright Data** (`PROXY_URL` / Web Unlocker vars) | Fallback on 403/429/Cloudflare |
| AI | **OpenAI** (`gpt-4o-mini`) | Chat advisor, missing field inference (not filter trim inventing) |
| Payments | **Stripe** (Payment Links + webhooks) | VIP upgrade / cancel / reactivate |
| Backups | **Cloudflare R2** (S3 API via `@aws-sdk/client-s3`) | Offsite `pg_dump` dumps; no dump files on Telegram |
| Scheduling | **node-cron** | Scrapers, cleanup, stats, backup, **engine/CV enrich** |
| Container | **Docker Compose** | `app` + `scraper` + `postgresql` + `redis` |

**npm scripts:**

```bash
npm run postinstall      # prisma generate
npm run typecheck        # tsc --noEmit
npm run verify:system    # DB / Redis / R2 / Stripe tier / env self-check
npm run verify:catalogs  # specs ↔ engine-catalog brand/model parity (+ CI)
npm run verify:engines   # engine-detection regression guard: fixed bugs + prudence cases (+ CI)
npm test                 # unit: schedule / Stripe tiers / matching / engine keys (+ CI)
npm run enrich:engines   # one-shot version → engineNorm + powerHp (CV)
npm run backup:now       # manual R2 backup
npm run restore:latest   # restore from R2 (needs CONFIRM_RESTORE=YES)
```

Regenerate engine catalog after editing specs (keeps curated models):

```bash
node scripts/generate-engine-catalog.mjs
```

---

## 3. Repository layout

```
Auto_broker_AI/
├── src/
│   ├── index.ts                 # Bootstrap by WORKER_MODE (app / scraper / all)
│   ├── db/prisma.ts             # PrismaClient + listing-norm middleware + backfill
│   ├── db/redis.ts              # Redis client (fail-open)
│   ├── generated/prisma/        # Generated client (gitignored; created by prisma generate)
│   ├── jobs/
│   │   ├── scraper.job.ts       # Fast + slow scrapers + wires cleanup + engine enrich (scraper role)
│   │   ├── engine-enrichment.job.ts  # Every 2h: version → engine / CV (no re-scrape)
│   │   ├── cleanup.job.ts       # 0km / age / privacy purge
│   │   ├── backup.job.ts        # Daily R2 backup (app role)
│   │   └── inventory-stats.job.ts
│   ├── scrapers/
│   │   ├── clicars.scraper.ts   # FAST
│   │   ├── ooyyo.scraper.ts     # FAST
│   │   ├── theparking.scraper.ts# SLOW
│   │   └── wallapop.scraper.ts  # Present but DISABLED in cron
│   ├── services/
│   │   ├── ai.service.ts
│   │   ├── matching.service.ts
│   │   ├── queue.service.ts            # Digest delivery loop (app role)
│   │   ├── digestSchedule.service.ts   # Per-user cadence/warmup keys + quiet hours
│   │   ├── dealScore.service.ts        # Price vs median of comparable inventory
│   │   ├── vipCounter.service.ts       # Live VIP box + Stripe tier bands
│   │   ├── engineCatalog.service.ts    # engine-catalog.json match + bare "1.0" → family
│   │   ├── engineEnrichment.service.ts # Backfill engineNorm / powerHp from version
│   │   ├── cache.service.ts
│   │   ├── inventory.service.ts
│   │   ├── privacy.service.ts
│   │   ├── listingDedup.service.ts
│   │   ├── dataQualityPipeline.ts
│   │   ├── r2.service.ts
│   │   └── stripe.service.ts
│   ├── middlewares/ratelimit.middleware.ts
│   ├── menus/filters.menu.ts    # VIP filter UX (Motor + Power CV)
│   ├── menus/schedule.menu.ts   # VIP /schedule (days, hours, interval)
│   ├── utils/                   # normalizer, power (kW→CV), httpClient, secrets, logger,
│   │                            # adminNotify, state.manager, telegramFormat, workerMode,
│   │                            # catalogModelAliases (Serie↔Series, Clase↔Class, …)
│   └── data/
│       ├── car-specifications.json   # Official trims (brand → model → specs[])
│       └── engine-catalog.json       # Official engines + typical CV (same brands/models)
├── prisma/
│   ├── schema.prisma
│   └── sql/
│       ├── pre_push_migrate.sql      # fuelType → fuelTypes[]; engine / power columns
│       └── gin_version_tokens.sql    # GIN on versionTokens
├── scripts/
│   ├── backup-now.ts
│   ├── restore-from-r2.ts
│   ├── dedupe-listings.ts
│   ├── backfill-fuel.ts
│   ├── enrich-engines.ts            # npm run enrich:engines
│   ├── generate-engine-catalog.mjs  # Keep engine-catalog in sync with specs
│   ├── verify-catalogs.mjs          # npm run verify:catalogs (CI)
│   ├── verify-engine-heuristics.mjs # npm run verify:engines — engine-detection regression guard (CI)
│   ├── verify-system.ts             # App-level self-check (DB/Redis/R2/env)
│   ├── verify-system.sh             # Host self-check (containers/disk) + the above
│   ├── verify-and-notify.sh         # Cron wrapper: alerts only on state changes
│   ├── monthly-admin-reminders.sh   # Monthly ops checklist to the admin chat
│   └── rotate-postgres-password.sh
├── .github/workflows/ci.yml         # Typecheck + compose validation + secret scan
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── README.md                    # this file
```

---

## 4. Data model (Prisma)

| Model | Role |
|-------|------|
| **User** | `telegramId`, `subscriptionStatus` (`free` \| `vip` \| `cancelling`), Stripe id, AI counters, **digest prefs** (`digestDays[]`, `digestStartHour`, `digestEndHour`, `digestIntervalH`), `becameFreeAt`, … |
| **CarListing** | Scraped ads + norms/tokens; **`engine` / `engineNorm`**, **`powerHp`** (metric **CV**); unique `portalId`/`originalUrl`; near-dup skip |
| **UserAlert** | VIP radar: brand/model norms, `versions[]`, **`engines[]`**, **`minPowerHp`** (min CV), `fuelTypes[]`, **`countries[]`**, maxPrice, minYear, maxMileageKm (one active alert per user in practice) |
| **InventoryStats** | Pre-aggregated filter UX stats by brand/model/(optional version token) — includes **`engines[]`**, **`minPower` / `maxPower` / `avgPower`** for Motor/Power menus |
| **SentListing** | Dedupes digests **and** AI pulls: unique `(userId, carId)` + fuzzy near-dup when checking |
| **AppMeta** | Ops key/value that must outlive restarts (currently `vip_counter_message_id` for the admin VIP box) |

**Design decisions:**

- **Norms** enable indexed matching (`@@index([brandNorm, modelNorm, …])`, also **`engineNorm`** / **`powerHp`**) instead of ILIKE on hot path.
- **`versionTokens`** + GIN index for multi-spec OR matching.
- **`fuelTypes` / `countries` / `engines` String[]** for multi-select filters (`pre_push_migrate.sql`).
- **`powerHp` stores metric CV** (same unit as the Power filter UI). Portals may send kW/HP; scrapers + enrich use `parsePowerCv` (`src/utils/power.ts`).
- Prisma client output path: `src/generated/prisma` (avoids IDE/type issues with default `.prisma` package resolution).

---

## 5. Runtime architecture (mental model)

```
┌────────────────┐                    ┌────────────────┐
│  scraper       │                    │  app           │
│ WORKER_MODE=   │                    │ WORKER_MODE=   │
│ scraper        │                    │ app            │
│ Clicars/Ooyyo/ │──writes───────────▶│ Bot + Express  │
│ TheParking     │   Postgres         │ /health+/webhook│
│ + cleanup      │◀──reads────────────│ Queue flusher  │
│ + engine enrich│   Redis notif:q    │ + R2 backup    │
│ + match enqueue│                    │                │
└────────────────┘                    └────────┬───────┘
                                               │ NPM / Cloudflare
                                               ▼
                                          Telegram users
```

Daily 06:00 (**app**): pg_dump → gzip → Cloudflare R2 (`pg-dumps/`)  
Admin Telegram: CRITICAL failures only (never dump files)

---

## 6. Cron & batch schedule (`TZ=Europe/Madrid`)

| Time / expr | Job | Notes |
|-------------|-----|--------|
| `*/30 8-20 * * 1-5` | **Fast scrapers** (Clicars, Ooyyo) | Mon–Fri, 08–20; ~10 pages/run; Ooyyo rotates 14 EU markets |
| `0 8-20/4 * * 1-5` | **Slow scrapers** (TheParking) | Mon–Fri at 08/12/16/20; **5 pages/run** (Bright Data budget ~≤$5/mo target) |
| `*/10 * * * *` | **InventoryStats refresh** | Also after scrape cycles; warm shortly after boot |
| `0 */2 * * *` | **Engine / CV enrich** (**scraper**) | Parse `version` → `engine` / `engineNorm` / `powerHp` via catalog (batch ≤8000). Boot pass ~90s after start |
| `0 3 * * *` | Cleanup: `mileageKm = 0` | Incomplete rows |
| `0 4 * * *` | Cleanup: stale ads | `updatedAt` older than **14 days** |
| `0 5 * * *` | Privacy purge | Ex-VIP personal data after `DATA_PURGE_HOURS` (default 48) |
| `0 6 * * *` | **Backup → R2** (**app** only) | After nightly cleanups |
| Digest queue | `setInterval` every **`NOTIF_TICK_MINUTES`** (default **5**) | Per-user spacing = `User.digestIntervalH` (1–4h, default **2**). First tick ~**60s** after boot. Filter Done → warmup **5–15 min** inside the user’s window/days. Skip if outside window. Hard floor 7–23 Europe/Madrid |

**Weekend:** scrapers off (Sat+Sun). Digests still deliver per each VIP’s `/schedule` from existing stock.  
**Guard:** `shouldRunScrapers()` mirrors scraper cron (**Mon–Fri** `1–5`, hours **08–20** inclusive).

Optional: `SCRAPER_ENABLE_MANUAL_TEST=true` runs one fast+slow cycle at boot (keep **false** in prod).

> **Note:** HTTP “URL still alive?” cleanup was **removed** — Ooyyo/VPS 410s wiped valid inventory.

---

## 7. Scraping strategy

### 7.1 Lanes

| Lane | Portals | Interval | Approach |
|------|---------|----------|----------|
| **FAST** | Clicars, Ooyyo | **30 min**, Mon–Fri 08–20 | Cheerio + direct HTTP; Clicars watches **pages 1–10 only** (full catalog already in DB); Ooyyo: **14 EU markets** |
| **SLOW** | TheParking | **4 h** (08/12/16/20), Mon–Fri 08–20 | Playwright + proxy; **5 pages/run**, max **8 details/page**; `pageNum` state resumes (1–5 → 6–10 → …) |
| Disabled | Wallapop | — | Code exists; cron import commented out |

**Bright Data cost target:** keep TheParking low so BD ≈ **≤ ~$5/mo**. Override with `TP_PAGES_PER_RUN`, `TP_MAX_DETAILS_PER_PAGE`.

### 7.2 Shared pipeline

1. Scrape raw fields (incl. power text when the portal exposes it).
2. **`validateAndEnrich`** (`dataQualityPipeline.ts`): validate brand/model, sanitize price, normalize fuel/transmission, optionally **GPT-4o-mini** for missing **transmission/HP only** (fuel never inferred by GPT).
3. Upsert `CarListing` — Prisma middleware fills **`brandNorm` / `modelNorm` / `versionTokens`**, and when missing derives **`engine` / `engineNorm` / `powerHp`** from `version` via `resolveEngineFromVersion` (`engineCatalog.service.ts` + `parsePowerCv`).
4. Refresh **InventoryStats** (engines + power ranges for filter UX).
5. **Matching** on recent `updatedAt` window (fast lookback **40m**, slow **240m**).

Power units: **kW → CV × 1.35962**; CV / HP / PS / CH stored as rounded metric CV (`src/utils/power.ts`).

### 7.3 HTTP / proxy

- `src/utils/httpClient.ts`: retries; on 403/429/timeout/Cloudflare may use Bright Data / `PROXY_URL`.
- Browser helper supports proxy session scoping (`PROXY_SESSION_*`).

### 7.4 State

Scrapers persist progress via `state.manager` (resume pages/categories) so restarts don’t always restart from page 1.

### 7.5 How to change scraping

| Goal | Where |
|------|--------|
| Hours / days | `src/jobs/scraper.job.ts` cron strings + `shouldRunScrapers` |
| Enable Wallapop | Uncomment import + call in `runSlowProxyCycle` |
| Pages per run | Env: `SCRAPER_PAGES`, `CLICARS_*`, `OY_PAGES_PER_RUN`, `TP_PAGES_PER_RUN` |
| TheParking concurrency | `TP_DETAIL_CONCURRENCY` |

---

## 8. Redis strategy

**Principle:** Redis is **acceleration + queue**, not source of truth. Postgres is source of truth. If Redis dies, app continues with **in-memory fallback** (single-process only).

### 8.1 Key namespaces

| Key pattern | Type | Purpose | Typical TTL |
|-------------|------|---------|-------------|
| `inv:brands` | string/JSON | Brand list for filters | ~15 min |
| `inv:models:{brandNorm}` | … | Models for brand | ~10 min |
| `inv:versions:{brand}:{model}` | … | Spec tokens | ~10 min |
| `inv:ctx:{brand}:{model}:{tokens}` | … | Price/year/km/fuel limits for UX | ~5 min |
| `inv:gen` | watermark | Bust inventory caches after stats refresh | — |
| `alerts:idx:{brand}:{model}` | … | VIP alerts for slice | **3 min** |
| `alerts:idx:any` | … | Catch-all alerts (`brandNorm` null) | **3 min** |
| `notif:q:{telegramId}` | **LIST** | Pending digest messages | until flush / clear |
| `digest:warmup:{telegramId}` | string | Epoch ms of the post-filter-change digest | dueAt + 1h |
| `digest:warmup_quota:{telegramId}` | counter | Warmups consumed in the rolling 24h | 24h |
| `digest:next:{telegramId}` | string | Epoch ms of the next regular digest | interval + 7d |
| `digest:lock:{telegramId}` | string | Send lock so overlapping ticks never double-send | 90s |
| `digest:prefs:{telegramId}` | JSON | Cached `User` digest schedule prefs | ~5 min |
| `deal:sample:{brand}:{model}:{year}` | JSON | Price sample for the deal score | 30 min |
| `ops:critical` | **LIST** | CRITICAL alerts relayed from the tokenless scraper | 24h |
| `ops:vipbox:msgid` | string | Message id of the admin VIP counter | — |

### 8.2 Notification queue

- Matching **`RPUSH`** digests; **`LTRIM`** keeps last `NOTIF_MAX_PENDING_PER_USER` (default 3).
- The scheduler ticks every `NOTIF_TICK_MINUTES` (default 5) and **`LPOP`s** up to `NOTIF_MAX_MESSAGES_PER_USER` (default 1) **only for users whose own clock is due** — each user has `digest:next:{id}` spaced by their **`digestIntervalH`** (1–4h, default **2** via `/schedule`).
- **After filter Done** (fingerprint changed): seed digest → `digest:warmup:{id}` in **`NOTIF_FIRST_DELAY_MIN_MINUTES`–`MAX`** (default **5–15** random) → that send starts the user cadence. Capped at `NOTIF_WARMUP_MAX_PER_DAY` (default 2) per rolling 24h. Warmups respect the user’s days/hours.
- All timers live in **Redis**, not in process memory: restarting `app` no longer resets cadence nor risks an immediate re-send burst.
- Delivery window is **per user** (`User.digestDays` / `digestStartHour` / `digestEndHour`). System hard floor: `NOTIF_HARD_START_HOUR`–`NOTIF_HARD_END_HOUR` (default **7–23**). `NOTIF_WINDOW_*` are defaults for new users only.
- Each message packs **≤ 3 cars**.
- Prefs cache: `digest:prefs:{telegramId}` (~5 min TTL), invalidated on `/schedule` save.

### 8.3 Filter change → Redis policy (important)

On VIP **Done** (`filter_save`) / `/alert` save:

1. Fingerprint old vs new filters (`alertFingerprint`).
2. Always overwrite `UserAlert` in Postgres.
3. If **changed**:
   - **`DEL notif:q:{telegramId}`** (+ in-memory queue) — drop stale digests.
   - Invalidate **all** `alerts:idx:*` caches.
   - **Seed** queue: ≤1 digest (≤3 cars) from current inventory under **new** rules; **skip** cars already in `SentListing` / near-dups. If only already-sent stock remains → short “Radar updated — watching for fresh matches” message. Else no-stock notice.
4. If **unchanged**: leave pending queue alone.

UX after save: “Radar updated” + button **Back to panel** → `vip_filters` (filters dashboard).

Code: `MatchingService.replaceFiltersAndResyncQueue` + `seedDigestForUser` + `queueService.clearUserQueue`.

### 8.4 Compose Redis limits (T0)

- `maxmemory 384mb`, `allkeys-lru`, AOF on.
- Container limit ~448 MB.

---

## 9. Filtering UX & matching

### 9.1 User flow (`filters.menu.ts`)

1. VIP opens filters (`/filters` or **Configure VIP Filters**) → load existing `UserAlert` into in-memory `userDrafts` (keep draft across Back; do not wipe from DB on every open).
2. Pick **Brand / Model** (paginated from inventory). Junk models like `-` filtered via `isUsableModelLabel`. Accents folded (`León` = `Leon`).
3. **Specs** multi-select from **`car-specifications.json`** only (`getCatalogSpecs` / `carSpecs.catalog.ts`). No GPT inventing trims. **Any** = no trim filter (all stock for that brand/model, including unmapped versions).
4. **Motor** multi-select from stock `engineNorm` values (fallback: full `engine-catalog.json` for that brand/model). Empty = Any.
5. **Power** — minimum metric **CV** (`minPowerHp`); buttons from InventoryStats min/avg/max for the current slice.
6. **Fuel** multi-select from stock fuels for current context (friendly **Any** if empty — never a hard error).
7. **Price / Year / Km** buttons from inventory context (scoped to prior draft filters). Counts use `formatApproxCount`. Year min never `0`; max km only upper bounds (`< … km`).
8. **Country** multi-select (`countries[]`): label `Name (stock)` only — **6×2** grid (12/page) with ⬅️/➡️.
9. Each submenu footer: **Any/All** · **Back** (restore snapshot) · **Done** (keep draft). Panel summary order: **Brand → Model → Specs → Motor → Power → Fuel → Price → Year → Km → Country**.
10. Panel **Done** → replace `UserAlert` + Redis resync (section 8.3) → short confirmation + **Back to panel**.

### 9.2 Engine & CV catalog

| Piece | Role |
|-------|------|
| `src/data/car-specifications.json` | Official **trims** (Specs filter) |
| `src/data/engine-catalog.json` | Official **engines** + typical **CV** — **same 71 brands / 601 models** as specs |
| `scripts/generate-engine-catalog.mjs` | Rebuild catalog after specs change (keeps hand-curated popular models) |
| `engineCatalog.service.ts` | Match `version` text → catalog entry; **`resolveBareDisplacement`**: lone `"1.0"` → preferred family for the brand (Audi TFSI, VW/Seat/Skoda TSI, Ford EcoBoost, …). If several **real catalog candidates** for that displacement remain ambiguous and there is no CV hint → **leave empty** (better than inventing). If the displacement simply isn't templated for that model (e.g. a V8/diesel trim not in the brand-default list) → falls through to the heuristic parser instead of forcing empty. Heuristic requires decimal displacement (`1.0 TFSI`) or marketing codes (`30 TFSI`), BMW/Merc/JLR codes (`520d`, `D300`), or a bare displacement + explicit engine cue (`diesel`, `hybrid`, `turbo`, `V6`/`V8`/`V10`/`V12`, `W12`/`W16`, …); never invents `"0 TFSI"` — those canonicalize to family-only (`tfsi`) |
| `engineEnrichment.service.ts` | Backfill rows missing `engineNorm` / `powerHp`; also rewrites bogus `"0 …"` family norms |
| Cron `0 */2 * * *` | Scraper role; batch ≤8000; first pass ~90s after boot |
| `npm run enrich:engines` | Manual / one-shot (`ENRICH_LIMIT`, default 20000) |
| `npm run verify:catalogs` | Specs ↔ engine-catalog brand/model parity (CI) |
| `npm run verify:engines` | Engine-detection **regression guard** — see 9.2.1 (CI) |

#### 9.2.1 Engine-detection robustness audit (2026-08-06)

`verify:catalogs` only proves every brand/model has a *non-empty* engine list — it can't catch a list that is **present but wrong**, or **real but incomplete**. Both were found and fixed:

**Bug 1 — templated data, not just missing data.** `generate-engine-catalog.mjs` fills any model without a hand-curated or model-specific entry from a **per-brand default list** (documented, intentional simplification — see P1 backlog). For most brands this default is harmless because the whole lineup shares the same class of engine (e.g. Ferrari = V8/V12 across every model). For **Chevrolet** it wasn't: the brand spans city cars, sports cars and full-size V8 trucks, so the shared "1.4/1.5/2.0 Turbo" default was applied to the **Corvette, Camaro, Tahoe, Suburban and Silverado** — all of which are V6/V8 vehicles that never came with those displacements. Worse, **Colorado** had been hand-edited at some point to literally copy the **Bolt EV**'s `Electric` entry (`aliases: ["electric", "bolt", "kwh"]`) even though Colorado is a diesel/gas pickup, and its EV sibling **Bolt EUV** had drifted the other way and inherited the generic Turbo template instead of `Electric`.
  - *Fix:* added a `Chevrolet` branch to `modelSpecific()` in `generate-engine-catalog.mjs` with the real engine lineup per model (Spark 1.0/1.4 NA, Camaro/Corvette 2.0T-3.6 V6-6.2 V8, Tahoe/Suburban/Silverado 5.3/6.2 V8 + 3.0 Duramax diesel, Colorado 2.7T/3.6 V6/2.8 diesel, Bolt EV **and** Bolt EUV as `Electric`), and taught `isLikelyEv()` to recognize `\bbolt\b` so a future full regen can't drift Bolt EUV back to a gas engine. Verified by re-running `node scripts/generate-engine-catalog.mjs` end-to-end: the diff touched **only** the Chevrolet block (338 lines), proving the fix is durable against regeneration, not a one-off hand-edit that the next regen would silently undo.

**Bug 2 — a "no match" in the catalog was treated the same as "ambiguous", so it gave up instead of trying harder.** In `resolveEngineFromVersion`, when a listing only states a bare displacement (`"6.2"`, not `"6.2 V8"`), the code resolves it against that model's catalog list. The old logic: if no catalog entry matched that displacement, it assumed the case was *ambiguous* and returned an **empty** engine on purpose ("better empty than inventing"). That reasoning is correct when the catalog genuinely has 2+ competing candidates for the same displacement — but it was wrongly also applied when the catalog had **zero** candidates for that displacement, i.e. the model's engine list simply doesn't cover that trim (any V8 truck/SUV whose catalog default only lists small turbo fours, per Bug 1 — and this recurs for **any** brand with an incomplete per-model list, e.g. Ford/Toyota/Nissan trucks, not only Chevrolet).
  - *Fix:* `resolveEngineFromVersion` now checks whether the catalog actually produced **any** candidates for that displacement (`catalogHitsForDisplacement`). Zero candidates → fall through to the free-text heuristic parser instead of forcing empty. Real ambiguity (2+ candidates, no CV hint to break the tie) still correctly returns empty — that guardrail is untouched.
  - Companion fix: the heuristic parser's engine-cue whitelist only recognized diesel/hybrid/family badges (`tdi`, `tfsi`, …), not raw cylinder-layout mentions. Added `turbo`, `boxer`, `V6`/`V8`/`V10`/`V12`, `W12`/`W16` as recognized cues (with a false-positive guard so a Volvo **model name** like `V60`/`V90` can never be misread as a `V6` engine — verified by `verify:engines`). This is what lets `"F-150 3.5 V6 EcoBoost"` resolve to `3.5 V6` instead of empty, even though Ford's brand-default catalog only lists 1.0–2.0 EcoBoost.

**Confirmed prudence boundaries — kept as-is, on purpose.** Three cases stay empty, and that is the *correct*, safe answer, not a remaining bug:
  - A pure **trim/package name with zero engine signal** (Mercedes `"AVANTGARDE"`) — there is nothing in the text that denotes an engine, so inventing one would just be guessing.
  - A **bare number with no cue on a model outside the catalog** (Volvo `XC70` — discontinued, not tracked in `car-specifications.json`, so there's no brand/model catalog to disambiguate a lone `"3.2"`, which could just as easily be a trim digit as a real displacement).
  - A **bare number with no cue at all** (`"1.2 allure"`) — `allure` is a trim name, not an engine family; the heuristic requires an explicit cue (family badge, diesel/hybrid/turbo word, or cylinder count) before it will turn a bare number into an engine label. Note this is heuristic-layer behavior only: on a model that *is* in the catalog and has exactly one engine at that displacement (e.g. Seat Ibiza only ships one `1.2`), the catalog layer still resolves it unambiguously — the prudence rule exists specifically for the free-text fallback, where there's no catalog to disambiguate against.

**Regression guard.** `scripts/verify-engine-heuristics.mjs` (`npm run verify:engines`, wired into CI) encodes all of the above as hard assertions — both fixed cases (must resolve) and prudence cases (must stay empty). Any future change to `engineCatalog.service.ts` or the generated catalog that regresses either direction fails the build immediately instead of silently reintroducing empty/garbage `engine` values.

CV fill order: explicit figure in version / portal field → else catalog `powerCv` on match → else empty.

### 9.3 Matching algorithm (`matching.service.ts`)

1. Group new cars by `brandNorm::modelNorm`.
2. Load alerts for that slice (brand/model match **or** null) + catch-all (`brandNorm` null).
3. Hard filters: brand/model norms (accent-folded), fuels, **countries**, **engines** (`engineNorm` ∈ alert.engines), **min CV** (`powerHp` ≥ `minPowerHp`), **catalog specs** via `listingMatchesSelectedCatalogSpecs` (maps `version` / `versionTokens` onto JSON trims; short labels like `V` use word boundaries so they do not match `VZ`).
4. Soft tolerances (“Flexible Match”):
   - Price: +min(10%, €3000)
   - Year: −2 years
   - Mileage: +min(15%, 30 000 km)
5. Dedupe with **SentListing** (`carId` **or** fuzzy brand/model/year/km) + **near-dup** (±1k km / ±5% price) so digests never pack the same physical car twice.
6. Cap **3 cars** per digest → enqueue as **HTML** with clickable **Listing found** links (`queue.service` `parse_mode: HTML`).

**Do not** send one Telegram message per car in real time — that was an explicit product decision.

### 9.4 Digest schedule (`/schedule`, `schedule.menu.ts`)

VIP-only. Prefs live on **`User`** (survive filter Reset/Done):

| Field | Default | Notes |
|-------|---------|--------|
| `digestDays` | Mon–Sun (1…7 ISO) | Multi-select; Weekdays / All week shortcuts |
| `digestStartHour` / `digestEndHour` | 8 / 21 | Europe/Madrid. **Start** UI: **07–12** only. **End** UI: **19–23** only. Start and end can never be equal |
| `digestIntervalH` | **2** | Buttons 1h · 2h · 3h · 4h |

**Hard floor** (env): `NOTIF_HARD_START_HOUR=7` … `NOTIF_HARD_END_HOUR=23`. Clamp + UI reject same-hour windows (e.g. 23→23) and mid-afternoon hours outside the slots.

**UX:** panel (days / hours / every) → Days · Hours · Interval · **Done** (writes DB + invalidates prefs cache). Each subsection now confirms with its own **Done** to keep parity with /filters. After save, the confirmation card keeps only **Edit schedule** (the extra **VIP Filters** button was removed to avoid redundant navigation from schedule context).

Entrypoints: `/schedule`, VIP panel **Digest schedule**, `/status` shortcut.

---

## 10. AI (GPT-4o-mini) — where and why

| Use | File | Behavior |
|-----|------|----------|
| **Chat advisor** | `ai.service.ts` | Support role: advice, comparisons, light stock lookup |
| **Inventory tool** | `search_inventory` | **Only** brand + model + optional **specs**. Returns **1 listing**. No year / km / fuel / price in the tool (radar owns those) |
| **DB pull cap (VIP)** | `dailyAiDbLookups` | Max **`AI_VIP_DB_LOOKUPS_MAX`** (default **3**/day). 4th pull → friendly limit; chat advice still allowed |
| **Chat cap (VIP)** | `dailyAiRequests` / weekly | **40/day**, **280/week** (40×7) — Compose forces these on `app` |
| **Free** | `freeSearchesUsed` | **3** interactions; **1** listing; **no link** |
| **Anti-dup** | `SentListing` + near-dup | Skip already-sent unless user explicitly asks to re-show |
| **Telegram format** | `telegramFormat.ts` | AI replies sent as **HTML** (escaped) + `<a>Listing found</a>` — avoids Markdown entity 400s |
| **Data enrichment** | `dataQualityPipeline.ts` | Fill missing **transmission/HP** (**not** fuel via GPT) |
| **Specs catalog** | `car-specifications.json` + `carSpecs.catalog.ts` | Official trims for filter UX + matching (not GPT grouping) |
| **Engine catalog** | `engine-catalog.json` + `engineCatalog.service.ts` | Official motors + typical CV; bare displacement → brand family |

**Product split:** VIP radar + Redis digests own year/km/fuel/price/country/**engine/CV** and send up to **3** ads. AI must not re-implement the full filter engine.

**Cost control:** mini model only; enrichment cached in-process; chat history trimmed (~6 messages); tool returns one listing after excluding sent IDs.

---

## 11. Monetization (Stripe)

- **Payment Links** tiered by current VIP(+cancelling) count:
  - 0–200 → TIER1 · 201–500 → TIER2 · 501+ → TIER3
- Soft-launch amounts live in Stripe Dashboard (~30 / ~60 / ~100 €).
- `client_reference_id` = Telegram user id.
- Webhook events set `vip` / `cancelling` / `free`.
- **Product rule:** never hardcode € price in bot copy (tiers may differ).
- **Ops:** Tier1 must be a **live** link in production (not `test_…`).

Portal: `STRIPE_PORTAL_LINK`.

---

## 12. Backup & disaster recovery (Cloudflare R2)

### 12.1 Why R2 (not Telegram dumps)

- Telegram Bot API ~50 MB file cap — dumps will outgrow it.
- R2 free tier: **~10 GB storage**, generous Class A/B ops, **$0 egress**.
- Dumps stay private; Telegram admin chat = **alerts only**.

### 12.2 Backup flow (daily 06:00 + `npm run backup:now`)

1. `pg_dump` → `.sql`
2. gzip → `.sql.gz`
3. Upload `pg-dumps/backup-{ISO}.sql.gz` to bucket `R2_BUCKET`
4. Prune objects older than `BACKUP_RETENTION_DAYS` (default **7**)
5. Success → logs only; failure → `notifyAdminCritical`

### 12.3 Restore (manual only — never auto-wipe)

`CONFIRM_RESTORE=YES` is required. The restore script **drops `public` CASCADE**, recreates the schema, then applies the dump. **Do not** `docker compose down` (that stops Postgres). Keep **postgresql** (and usually **app**) up; stop **scraper** so it does not write mid-restore.

### 12.3.1 Full runbook — backup → stop scraper → restore latest → start scraper

Run from the project root on the VPS (`~/Auto_broker_AI`).

```bash
# 0) Optional: confirm R2 is visible on app only
docker compose exec app printenv R2_BUCKET

# 1) Manual backup → Cloudflare R2
docker compose exec app npm run backup:now
# Expect: ✅ Backup on R2: pg-dumps/backup-….sql.gz
# Optional: check the object in the R2 dashboard under pg-dumps/

# 2) Stop writers (scraper). Leave postgresql + app running.
docker compose stop scraper

# 3) Restore LATEST dump from R2 (destructive)
docker compose exec -e CONFIRM_RESTORE=YES app npm run restore:latest
# Expect:
#   ☁️ Downloading R2 object: pg-dumps/backup-….sql.gz
#   🗄️ Wiping public schema, then applying dump...
#   🗄️ Restoring SQL dump via psql...
#   ✅ Restore complete from pg-dumps/backup-….sql.gz

# 3b) OR restore a SPECIFIC object (use the real key from step 1 / R2 UI)
# docker compose exec -e CONFIRM_RESTORE=YES \
#   -e BACKUP_KEY=pg-dumps/backup-2026-08-03T16-50-57-108Z.sql.gz \
#   app npm run restore:latest

# 4) Bring scraper back
docker compose start scraper

# 5) Sanity check
docker compose ps
# Bot: /status  — or spot-check a known user/listing in DB
```

Local (no Docker), same idea:

```bash
npm run backup:now
CONFIRM_RESTORE=YES npm run restore:latest
# or: CONFIRM_RESTORE=YES BACKUP_KEY=pg-dumps/backup-….sql.gz npm run restore:latest
```

**Notes**

- Daily automatic backup: **06:00** Europe/Madrid on **app** only (`backup.job.ts`).
- New dumps use `pg_dump --clean --if-exists`; restore still wipes `public` first so older dumps also apply cleanly.
- Never paste dump files to Telegram; admin chat = failure alerts only.

### 12.4 Size intuition (gzipped, order of magnitude)

| Live cars in DB | ~1 dump | 7 dumps |
|-----------------|---------|---------|
| 10k | 2–4 MB | ~20–30 MB |
| 100k | 20–40 MB | ~200 MB |
| 1M | 200–400 MB | ~2–3 GB |
| 5M live | ~1–2 GB | may exceed 10 GB free |

With **14-day** listing purge, free tier usually OK unless you keep millions of rows live **and** long retention.

### 12.5 R2 env (names only)

`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, optional `R2_ENDPOINT`, `BACKUP_RETENTION_DAYS`.

### 12.6 DR smoke / re-prove after infra change

R2 backup + restore was proven on the soft-launch VPS (§19). Re-run this checklist after changing R2 credentials, bucket, host, or restore scripts — treat as **ops hygiene**, not a soft-launch blocker.

| Step | Action | Pass criteria |
|------|--------|----------------|
| 1 | Confirm `R2_*` on **app** only (scraper must not see them) | `docker compose exec app printenv R2_BUCKET` works; scraper has no `R2_*` |
| 2 | Manual backup | `docker compose exec app npm run backup:now` → success log; object appears in R2 under `pg-dumps/` |
| 3 | Note a known row | e.g. one `User` / listing id you can re-check after restore |
| 4 | Restore latest (destructive) | Follow **§12.3.1**: stop scraper → `CONFIRM_RESTORE=YES` restore → start scraper. Log shows wipe + `✅ Restore complete` |
| 5 | Verify data | Known row present; bot `/status` or Prisma still healthy; app restarts clean |
| 6 | Optional key restore | `CONFIRM_RESTORE=YES BACKUP_KEY=pg-dumps/backup-….sql.gz` works for a specific object |

---

## 13. Admin Telegram policy

| Variable | Uso |
|----------|-----|
| `TELEGRAM_ADMIN_CHAT_ID` | Chat/grupo CRITICAL |
| `TELEGRAM_ADMIN_USER_IDS` | User id(s) numéricos (coma-separados) para comandos admin ocultos |
| `TELEGRAM_ADMIN_TOPIC_ID` | Opcional: topic del grupo foro donde publicar la cajita VIP |
| `ADMIN_ALERT_COOLDOWN_MS` | Anti-spam (default **900000** = 15 min) |
| `ADMIN_RELAY_POLL_MS` | Cada cuánto la app reenvía CRITICALs del scraper (default **60000**) |
| `ADMIN_ALERTS_DISABLED` | `true` = nunca notificar al chat admin (útil en scripts locales; auto-off también con DB localhost fuera de Docker) |
| `VIP_COUNTER_PIN` | `true` → fija la cajita VIP en el chat admin (el bot debe ser admin del grupo) |

`notifyAdminCritical` **solo** para:

- Fallo de arranque
- `uncaughtException` / `unhandledRejection`
- Crash de scrapers / cleanup
- Fallos de backup / restore R2

Texto **redactado** (`redactSecrets`) antes de enviar/loguear. **Nunca** dumps de BD a Telegram.

**Relay CRITICAL:** el contenedor `scraper` no lleva `TELEGRAM_BOT_TOKEN`. Sus alertas van a la lista Redis `ops:critical` (máx. 50, TTL 24h) y el rol `app` las reenvía al chat admin cada `ADMIN_RELAY_POLL_MS`, prefijadas con `🛰️ [scraper]`. Si Redis está caído, la alerta queda solo en logs.

**Anti false-positive (local):** `notifyAdminCritical` **no pagina Telegram** cuando:
- `ADMIN_ALERTS_DISABLED=true`, o
- `NODE_ENV=test`, o
- `DATABASE_URL` apunta a `localhost` / `127.0.0.1` **y** el proceso no corre dentro de Docker (`/.dockerenv` ausente).

Compose siempre inyecta `DATABASE_URL=…@postgresql:5432/…`, así que los CRITICALs reales del VPS siguen saliendo. El falso `App startup FAILED (all) … 127.0.0.1:5435` venía de arrancar/importar `index.ts` en el host con el `.env` local (Prisma en `:5435`) usando el bot token real — ya no ocurre: `bootstrap()` solo corre si el entrypoint es `src/index.ts`, y las alertas locales se suprimen.

### 13.1 Comandos admin ocultos

Solo responden si `ctx.from.id` ∈ `TELEGRAM_ADMIN_USER_IDS`; para cualquier otro usuario es **silencio total** (sin pista de que existen). En el chat admin se registran además con `setMyCommands` con scope de chat, así que aparecen en el menú **solo ahí**.

| Comando | Qué hace |
|---------|----------|
| `/get_topic_id` | Devuelve `chat.id`, tipo y `message_thread_id` (para configurar `TELEGRAM_ADMIN_TOPIC_ID`) |
| `/vip_count` | Publica una **cajita VIP** nueva con el número de VIP activos y el tier de precio vigente |

**Cajita VIP en vivo:** un único mensaje que se **edita** en lugar de spamear el chat. Se refresca al arrancar la app (12s después del boot) y en cada evento de Stripe (alta, cancelación, reactivación, expiración). El `message_id` se persiste en memoria → Redis (`ops:vipbox:msgid`) → Postgres (`AppMeta`), así que ni un reinicio ni un flush de Redis lo dejan huérfano. Si el mensaje se borró, se publica uno nuevo automáticamente.

```
🏛️ AutoBroker AI
💎 Active VIPs

┌─────┐
│  1  │
└─────┘

Current price: Tier 1 (0–200)
05/08/2026, 20:05:42
```

Tramos en `tierForVipCount` (`vipCounter.service.ts`): Tier 1 **0–200** · Tier 2 **201–500** · Tier 3 **501+**. `getDynamicPaymentLink` usa esa misma función.

---

## 14. Docker / security / VPS sizing

| Service | CPU | RAM | Notes |
|---------|-----|-----|--------|
| **app** | 0.40 | 640M | Bot + Stripe webhook + digests + R2 backup. `WORKER_MODE=app`. Bind `127.0.0.1:3003`. **No Playwright.** |
| **scraper** | 0.55 | 1100M | Playwright/HTTP ingest + cleanup + **engine/CV enrich**. `WORKER_MODE=scraper`. **No host ports**, no NPM network. **No `env_file`** — only ingest vars (no Stripe/R2). |
| postgresql | 0.90 | 2560M | **No host ports**; caps mínimas de init |
| redis | 0.25 | 448M | **No host ports**; `requirepass` via `REDIS_PASSWORD` |

### 14.1 Why split app / scraper

Chromium runs only in `scraper`. An RCE or crash there does **not** share the Node process with the Telegram bot or Stripe webhook. The scraper service does **not** load `.env` wholesale — Compose injects only DB/Redis, OpenAI (listing enrichment), Bright Data, and scrape knobs. Stripe, R2 and the **bot token** never enter that container: whoever owns the scraper cannot send a single Telegram message as the bot, only push text into the `ops:critical` relay that the app forwards to the admin chat. The scraper still needs DB + Redis write access to ingest listings (expected).

`WORKER_MODE`:
- `app` — bot polling, Express `/health` + `/webhook`, notification queue, R2 backup
- `scraper` — scrapers + cleanup/privacy cron + inventory stats (no `bot.launch`, no HTTP listen)
- `all` — monolith for local/dev single process

Migrations (`prisma db push`) run only in the **app** image CMD. Scraper overrides `command` to `npx tsx src/index.ts` and waits until `app` is healthy.

### 14.2 Hardening checklist

| Capa | Política |
|------|----------|
| App bind | `127.0.0.1:3003` — NPM Destination = `auto_broker_ai_app:3003` |
| Postgres / Redis | Sin `ports:` — solo red Docker `internal` |
| Scraper network | Solo `internal` (egress OK for portals / Bright Data / Telegram admin notify) |
| Non-root | Dockerfile `USER node` (uid 1000) + compose `user: "1000:1000"` |
| Privileges | `cap_drop: ALL` (app + scraper), postgres caps mínimas, redis sin `cap_drop: ALL` (AOF) |
| Boot schema | `prisma db push` **sin** `--accept-data-loss` (app only) |
| Bright Data | `BRIGHTDATA_ENABLED` on scraper; default false in `.env.example` |
| HTTP | `GET /health` mínimo; `POST /webhook` Stripe firmado + rate-limit; resto 404 |
| Logs | `installRedactedConsole()` + CRITICAL redactado |
| Privacy | `/delete_account` — if VIP/cancelling: Subastas-style English notice (active until Stripe end date + 48h auto-purge). If free: purge PII/radars/`sentListing`, keep `telegramId` + free counters |
| AI caps | Compose overrides on **app**: 40 / 280 / 3 DB / 3 free |
| Timezone | `TZ=Europe/Madrid` on app + scraper |
| `.env` | `chmod 600`; ver `.env.example` |

### 14.3 Acceso DB/Redis sin ports (Prisma Studio)

```bash
# Desde el VPS: Studio en loopback del contenedor app + túnel SSH
docker compose exec -e DATABASE_URL=… app npx prisma studio --hostname 127.0.0.1 --port 5555
# En Windows: ssh -L 5555:127.0.0.1:5555 …  (o publica temporalmente un puerto debug)
```

### 14.4 Verificación rápida

```bash
docker compose exec app id                         # uid=1000(node)
docker compose exec scraper id                     # uid=1000(node)
docker compose logs -f app scraper                 # WORKER_MODE=app / scraper
curl -sS http://127.0.0.1:3003/health
sudo ss -tulpn | grep 3003                         # 127.0.0.1:3003 only (app)
# scraper must NOT publish ports; Postgres/Redis must NOT listen on host
```

**Boot (app):** `pre_push_migrate.sql` → dedupe → `prisma db push` → GIN → `tsx src/index.ts`.

**Boot (scraper):** waits for healthy app → `tsx src/index.ts` only.

---

## 15. Environment variables (checklist)

Document names only — values live in `.env` (see `.env.example`).

**Core:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_ADMIN_USER_IDS`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD` (**required**), `OPENAI_API_KEY`, `PORT`

**Stripe:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PAYMENT_LINK_TIER1`…`TIER3`, `STRIPE_PORTAL_LINK`

**Proxy / Bright Data:** `BRIGHTDATA_ENABLED` (default false), `PROXY_URL`, `BRIGHTDATA_API_KEY`, `BRIGHTDATA_ZONE`, `BRIGHTDATA_COUNTRY`

**AI caps (Compose forces on app):** `AI_VIP_DAILY_MAX`, `AI_VIP_WEEKLY_MAX` (**280**), `AI_VIP_DB_LOOKUPS_MAX`, `AI_FREE_SEARCHES_MAX`

**Norms / privacy / admin:** `BACKFILL_NORMS=true`, `BACKFILL_VERSION_TOKENS=true` (heal empty `versionTokens` from `version`), `DATA_PURGE_HOURS`, `ADMIN_ALERT_COOLDOWN_MS`, `ADMIN_RELAY_POLL_MS`, `ADMIN_ALERTS_DISABLED`, `TELEGRAM_ADMIN_TOPIC_ID`, `VIP_COUNTER_PIN`

**Engine enrich:** `ENRICH_LIMIT` (manual `npm run enrich:engines` batch size, default 20000)

**Notifications:** `NOTIF_INTERVAL_HOURS` (default interval for new users / Reset, **2**), `NOTIF_TICK_MINUTES`, `NOTIF_FIRST_DELAY_*`, `NOTIF_WARMUP_MAX_PER_DAY`, `NOTIF_MAX_MESSAGES_PER_USER`, `NOTIF_SEND_DELAY_MS`, `NOTIF_MAX_PENDING_PER_USER`, `NOTIF_WINDOW_START_HOUR` / `NOTIF_WINDOW_END_HOUR` (defaults 8–21), `NOTIF_HARD_START_HOUR` / `NOTIF_HARD_END_HOUR` (clamp 7–23). VIP overrides via `/schedule`.

**Self-check (`npm run verify:system`):** `VERIFY_MIN_LISTINGS`, `VERIFY_MAX_INGEST_AGE_HOURS`, `VERIFY_MAX_BACKUP_AGE_HOURS`, `VERIFY_STATE_FILE`

**Scrapers:** `SCRAPER_PAGES`, `SCRAPER_STEADY_PAGES`, `CLICARS_MAX_PAGE`, `CLICARS_PAGES_PER_RUN`, `OY_PAGES_PER_RUN`, `TP_PAGES_PER_RUN`, `TP_MAX_DETAILS_PER_PAGE`, `OY_FETCH_DETAILS`, `OY_DETAIL_DELAY_*`

**R2 (app only via env_file):** `R2_*`, `BACKUP_RETENTION_DAYS`; restore: `CONFIRM_RESTORE`, optional `BACKUP_KEY`

**Optional:** `SCRAPER_ENABLE_MANUAL_TEST` (**false** in prod), `WORKER_MODE` (Compose sets per service), `NPM_NETWORK`, `TZ`

---

## 16. Product / UX decisions (locked)

| Decision | Rationale |
|----------|-----------|
| Digests every ~**2h** by default (1–4 via `/schedule`), 1 msg, ≤3 cars | Pleasant VIP UX; user-controlled cadence |
| First digest **5–15 min** after filter Done | Fast feedback; then user interval from that send |
| Warmup capped at **2 / 24h** | Re-saving filters must not become a way to farm digests |
| Per-user schedule **7–23 hard / 8–21 default**, Europe/Madrid | Night free for cleanup 03–05 + backup 06:00; `/schedule` for days/hours/interval |
| Deal score only with **≥6 comparables** | A median from 2 ads is a guess, not a signal |
| Fuel/fields quality at scrape time | Fix parsers (esp. Ooyyo list cards); no post-hoc HTTP full-review worker |
| No hardcoded VIP price in copy | Tiered Payment Links |
| Free: 3 interactions, 1 listing, no link, no radar | Clear upgrade funnel |
| VIP chat: **40/day · 280/week** | Honest 40×7 weekly safety net |
| AI inventory pulls: **3/day × 1 listing** | Radar digests own the 3-ad batches |
| Welcome VIP copy: “more AI usage” only | Quotas live in `/advisor` + `/status` |
| Listing links: **Listing found** (HTML `<a>`) | Professional; never raw URLs |
| AI replies: HTML + escape | Avoids Telegram Markdown entity parse errors |
| Filter Done → clear Redis if changed + reseed fresh | No stale digests; no re-spam of already-sent |
| Specs = catalog JSON only; Any = all trims | Predictable UX; no invented Navi/Pano labels |
| Motor / Power = catalog + stock CV | Engines from `engine-catalog.json`; Power filter in metric **CV**; bare `"1.0"` → brand family, never invent ambiguous labels |
| Soft-launch Stripe: **3 tiers** (0–200 / 201–500 / 501+) | ~30 / ~60 / ~100 € in Stripe Dashboard; expand later if needed |
| Submenu Done = draft; panel Done = DB | Users can explore without writing radar until final Done |
| AI skips already-sent unless user asks again | No duplicate ads in chat |
| Age purge on `updatedAt` 14d | Stock rotates; scrapers refresh seen ads |
| R2 not Telegram for backups | Professional, scalable, secure |
| Commands English only | Soft-launch language locked |
| No “How the AI works” button on free start | `/advisor` is enough |

---

## 17. Common change recipes

### Change digest frequency / hours / days

VIP: `/schedule` (or **Digest schedule** on the VIP panel). Saves to `User.digest*` fields.  
Ops defaults / hard floor: `.env` → `NOTIF_INTERVAL_HOURS`, `NOTIF_WINDOW_*`, `NOTIF_HARD_*` → rebuild/restart app.

### Change scraper window

Edit cron + `shouldRunScrapers` in `src/jobs/scraper.job.ts`.

### Add a portal

1. New file under `src/scrapers/`.
2. Run through `validateAndEnrich` before write.
3. Hook into fast or slow cycle in `scraper.job.ts`.
4. Prefer norms via middleware (don’t hand-roll unless needed).

### Change filter defaults / button layout

`src/menus/filters.menu.ts` + `inventory.service.ts` (stats-backed limits) + `src/data/car-specifications.json` (official trims) + `src/data/engine-catalog.json` (official engines/CV) + `carSpecs.catalog.ts` / `engineCatalog.service.ts` (match helpers).

### Add / edit official trims

Edit `src/data/car-specifications.json` (brand → model → trim array). Then sync engines:

```bash
node scripts/generate-engine-catalog.mjs
```

Redeploy app + scraper; no DB migration for JSON-only changes. Matching uses the new labels immediately.

### Backfill engines / CV on existing inventory

```bash
docker compose exec -T scraper npm run enrich:engines
# or: ENRICH_LIMIT=5000 docker compose exec -T scraper npm run enrich:engines
```

Cron also runs every 2h on the scraper. After schema push: `docker compose exec app npx prisma db push`.

### Tighten matching

`carMatchesAlert` / `evaluateTolerance` in `matching.service.ts`.

### Schema change

1. Edit `prisma/schema.prisma`.
2. `npx prisma generate` (Docker CMD / postinstall also generate).
3. `db push` (prod: **without** `--accept-data-loss`; use `prisma/sql/pre_push_migrate.sql` for safe renames).
4. Add raw SQL under `prisma/sql/` for indexes Prisma can’t express (e.g. GIN).

### After filter bugs (“wrong brand alerts”)

1. Confirm `UserAlert` row in DB.
2. `DEL notif:q:{telegramId}` or save filters again (auto-clear if fingerprint changed).
3. Check `alerts:idx:*` TTL / invalidation.

---

## 18. Ops cheat sheet

```bash
# Deploy (app + scraper + db + redis)
docker compose up --build -d

# Status / health
docker compose ps
curl -sS http://127.0.0.1:3003/health
docker compose exec app printenv R2_BUCKET          # R2 on app
docker compose exec scraper printenv R2_BUCKET || true  # should be empty / error
docker compose exec scraper printenv TELEGRAM_BOT_TOKEN || true  # must be empty

# Full self-check (containers + disk + DB + Redis + R2 backup age + env)
./scripts/verify-system.sh
# Application-only checks (inside the container)
docker compose exec -T app npm run verify:system

# Logs — confirm WORKER_MODE=app vs scraper
docker compose logs -f app scraper
docker compose logs --tail=100 app
docker compose logs --tail=100 scraper

# Restart one role (no full down)
docker compose restart app
docker compose restart scraper

# Manual backup → R2
docker compose exec app npm run backup:now

# One-shot engine / CV enrich (scraper has DB access)
docker compose exec -T scraper npm run enrich:engines

# After editing car-specifications.json — regenerate engines then redeploy
node scripts/generate-engine-catalog.mjs
docker compose up --build -d

# DR cycle: stop scraper → restore latest → start scraper
# (full steps: README §12.3.1)
docker compose stop scraper
docker compose exec -e CONFIRM_RESTORE=YES app npm run restore:latest
docker compose start scraper

# Restore a specific R2 key
# docker compose exec -e CONFIRM_RESTORE=YES \
#   -e BACKUP_KEY=pg-dumps/backup-….sql.gz \
#   app npm run restore:latest

# Prisma inside app container
docker compose exec app npx prisma db push
docker compose exec app npx prisma generate

# Prisma Studio (bind localhost only; on VPS use SSH tunnel → http://127.0.0.1:5555)
docker compose run --rm -p 127.0.0.1:5555:5555 app \
  npx prisma studio --hostname 0.0.0.0 --port 5555

# Disk / Docker usage
docker system df
df -h

# ── Docker disk cleanup (destructive — review before -a) ──
# Safe-ish: unused containers/networks/dangling images + build cache
docker system prune
# Unused images only (not just dangling)
docker image prune -a
# Aggressive: ALL unused images + stopped containers + unused networks + build cache
# Does NOT remove named volumes (Postgres/Redis data) unless you add --volumes
docker system prune -a

# ── Avoid unless you really mean it ──
# docker compose down          # stops stack (Postgres too) — OK for maintenance
# docker compose down -v       # ALSO deletes named volumes → WIPES DB/Redis
```

### 18.1 Host cron (VPS)

```bash
chmod +x scripts/*.sh
crontab -e
```

```cron
# Daily self-check at 08:00 — alerts the admin chat only on OK→FAIL and FAIL→OK
0 8 * * * /home/florian/Auto_broker_AI/scripts/verify-and-notify.sh >> /var/log/autobroker-verify.log 2>&1

# Monthly ops checklist on the 1st at 09:00 (restore drill, key rotation, spend review)
0 9 1 * * /home/florian/Auto_broker_AI/scripts/monthly-admin-reminders.sh >> /var/log/autobroker-reminders.log 2>&1
```

`verify-and-notify.sh` keeps its last result in `/tmp/autobroker-verify.state`, so a persistent failure is reported **once** and you also get an explicit “recovered” message when it clears.

---

## 19. Known gaps / future work

### Done (soft-launch locked)

- ~~`WORKER_MODE` app/scraper split~~ — done.
- ~~Scraper schedule Mon–Fri 30m / 4h + `TZ=Europe/Madrid`~~ — done.
- ~~Welcome /advisor HTML · Listing found · anti-dup AI/radar~~ — done.
- ~~Filter draft/Done UX · catalog specs · accent norms · approx counts~~ — done.
- ~~Motor + Power (CV) filters · `engine-catalog.json` · bare displacement → brand family · enrich cron~~ — done.
- ~~Stripe soft-launch 3 tiers (0–200 / 201–500 / 501+)~~ — done.
- ~~Fail-fast on unknown `WORKER_MODE`~~ — done (boot aborts with a clear error).
- ~~Scraper without `TELEGRAM_BOT_TOKEN` + CRITICAL relay~~ — done (`ops:critical`).
- ~~Digest cadence persisted per user (survives restarts) + quiet hours + warmup quota~~ — done.
- ~~Quiet hours default 08–21 Mon–Sun (exclusive end hour)~~ — superseded by **per-user `/schedule`** (defaults still 08–21 / 2h; hard floor 7–23).
- ~~Per-user digest schedule (`/schedule`: days, hours, interval 1–4h default 2)~~ — done.
- ~~Live VIP counter in the admin chat (`/vip_count`)~~ — done.
- ~~Automated self-check + CI + `verify:catalogs`~~ — done.
- ~~R2 backup + restore proven on VPS~~ — done (§12.6 re-prove after infra changes).

### P0 — integrity

- ~~**Wallapop** scraper disabled; TypeScript errors~~ — archived under `src/scrapers/_archived/` and excluded from `tsconfig` / typecheck.
- Keep `verify:catalogs` + `verify:engines` + `verify:unit` (`npm test`) + `verify:system` green on every deploy.

### Soft-launch hardening (2026-08-06)

| Fix | Why |
|-----|-----|
| Warmup quota only after a **successful** send; empty queue retries in 5 min without burning the slot | VIP no longer loses the post-`/filters` seed when inventory is still seeding |
| Matching soft-fills empty `fuel` / `engineNorm` from `version` at match time (`matchingRules.ts`) | Fuel/Motor VIP filters stop silently zeroing against incomplete rows |
| Ford / Toyota / Nissan trucks+sports curated in `generate-engine-catalog.mjs` | Motor menu no longer shows city-car defaults on F-150 / Land Cruiser / Navara / etc. |
| `/health` checks Postgres + Redis → **503** if either is down | Compose `depends_on: healthy` no longer starts scraper against a half-dead app |
| `/schedule` shows **Unsaved changes** until **Done** | Users don't think taps alone persist prefs |
| `npm test` / `verify:unit` (schedule · Stripe tiers · matching · engine keys) in CI | Regressions fail the build before deploy |
| App image build arg `WORKER_TARGET=app` skips Playwright browsers | Slimmer app container; scraper still installs Chromium |
| Dropped unused `@supabase/supabase-js` | Less attack surface / install noise |
| Advisor tool results include **dealScore** when sample allows | Same market signal digests already show |
| `verify:system` warns on low fuel / engineNorm coverage | Ops can run `backfill:fuel` / `enrich:engines` before VIPs complain |
| `src/index.ts` boots **only** as entrypoint (`src/index.ts` in argv); imports of `{ bot }` stay inert | Accidental local/test imports no longer run `bootstrap()` |
| `notifyAdminCritical` suppresses local false pages (`adminNotify.ts`) | No more Telegram `App startup FAILED … 127.0.0.1:5435` when host `.env` points at localhost outside Docker |

### CI / CD recommendation (soft-launch)

**CI: yes, keep and expand (already done).** Gate every push/PR on typecheck + `npm test` + catalog/engine verifies + compose config. That is the safety net while v2 is months away.

**CD: yes, but gated — not auto-deploy on every push yet.** Prefer:
1. CI green on `main`
2. Manual `workflow_dispatch` (or SSH after green CI) → `docker compose up -d --build` on the VPS
3. Post-deploy `docker compose exec -T app npm run verify:system`

Auto-CD to production without a human click is fine later; for soft-launch the risk of a bad push wiping digests/Stripe outweighs the convenience. Wire SSH secrets when you want the optional job uncommented in `.github/workflows/ci.yml`.

### P1 — product & reliability

- Real automated tests for quiet hours, Stripe tier bands, `carMatchesAlert` (engines/CV), deal-score thresholds, `alertFingerprint`.
- Compose `deploy.resources` (CPU/RAM/pids) are **Swarm-oriented** — document or enforce with Compose-native limits if not on Swarm.
- ~~Hand-curate Ford/Toyota/Nissan truck engines~~ — done (Chevrolet + Ford/Toyota/Nissan). Keep expanding as stock shows gaps.
- Optional Saturday light scrape lane if weekend `VERIFY_MAX_INGEST_AGE_HOURS` freshness becomes noisy.

### P2 — polish

- ~~Re-enable Wallapop properly **or** archive~~ — archived for soft-launch.
- ~~Deal score inside AI advisor replies~~ — done (tool facts include `dealScore`).
- Finish Markdown → HTML for remaining Stripe DMs / admin paths.
- ~~Slim **app** image without Playwright browsers~~ — done via `WORKER_TARGET=app`.
- ~~Drop unused `@supabase/supabase-js`~~ — done.

### Soft-launch smoke (re-check anytime)

- Stripe live Payment Link → webhook VIP; `/advisor` shows **280/week**; Cupra Leon Specs + Motor menus show catalog values; `npm run enrich:engines` fills empty / bogus `engineNorm`.

---

## 20. Glossary

| Term | Meaning |
|------|---------|
| **Norm** | Canonical lowercase brand/model key for indexes (accents stripped) |
| **engineNorm** | Canonical engine key (e.g. `1.0 tfsi`) for filters + matching |
| **CV** | Metric horsepower stored in `powerHp` / shown in the Power filter (kW converted via `parsePowerCv`) |
| **Digest** | One Telegram message with ≤3 matched cars |
| **Slice** | `brandNorm::modelNorm` grouping for matching |
| **InventoryStats** | Precomputed aggregates for filter UX (incl. engines + power ranges) |
| **Catalog trim** | Official spec label from `car-specifications.json` |
| **Engine catalog** | Official motor + typical CV from `engine-catalog.json` (parity with specs) |
| **Bare displacement** | Version text like `"1.0"` with no TFSI/TSI/… — resolved by brand family prefs |
| **Flexible Match** | Within soft price/year/km tolerance |
| **Listing found** | Clickable HTML link label (never raw URL) |
| **WORKER_MODE** | `app` \| `scraper` \| `all` process role |
| **T0/T1/T2** | VPS sizing tiers in `docker-compose.yml` |
| **Warmup** | The extra digest sent 5–15 min after a filter change (max 2 per 24h), inside the user’s `/schedule` window |
| **Digest schedule** | Per-VIP days + hours + interval (`/schedule`); hard floor 7–23 Europe/Madrid |
| **Deal score** | Price gap vs the median of comparable inventory (brand+model, year ±1, similar km) |
| **CRITICAL relay** | `ops:critical` Redis list the tokenless scraper uses to reach the admin chat. Local host runs with `DATABASE_URL` → localhost are **not** paged (see § admin CRITICAL anti false-positive) |
| **VIP box** | The single admin message with the live VIP seat count and Stripe tier |

---

*Last updated: false CRITICAL suppression (entrypoint-only bootstrap + local DB/admin alert guards) · soft-launch hardening (warmup · fuel/engine soft-fill · truck catalog · /health · /schedule unsaved · npm test in CI · slim app · Wallapop archived · dealScore in advisor · gated CD) · `/schedule` · `verify:engines`.*
erify:catalogs.*
erify:catalogs.*
