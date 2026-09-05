/**
 * Read-only production self-check. Run inside the app container:
 *   docker compose exec -T app npm run verify:system
 *
 * Exit code 0 = OK (warnings allowed), 1 = at least one FAIL.
 * Never prints secret values — only whether a variable is set.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { Redis } from 'ioredis';
import { createR2Client, getR2Bucket, listBackupObjects } from '../src/services/r2.service.js';

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  level: Level;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, level: Level, detail: string): void {
  checks.push({ name, level, detail });
}

function hoursSince(date: Date): number {
  return (Date.now() - date.getTime()) / 3_600_000;
}

const prisma = new PrismaClient();

async function checkDatabase(): Promise<void> {
  try {
    const [listings, vips, alerts, stats] = await Promise.all([
      prisma.carListing.count(),
      prisma.user.count({ where: { subscriptionStatus: { in: ['vip', 'cancelling'] } } }),
      prisma.userAlert.count(),
      prisma.inventoryStats.count()
    ]);

    record(
      'postgres',
      'ok',
      `${listings} listings · ${vips} VIP · ${alerts} radars · ${stats} stat rows`
    );

    const minListings = Number(process.env.VERIFY_MIN_LISTINGS || 200);
    if (listings < minListings) {
      record('inventory size', 'fail', `only ${listings} listings (expected ≥ ${minListings})`);
    } else {
      record('inventory size', 'ok', `${listings} listings`);
    }

    const newest = await prisma.carListing.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true }
    });
    if (!newest) {
      record('inventory freshness', 'fail', 'no listings at all');
    } else {
      const age = hoursSince(newest.updatedAt);
      const maxAge = Number(process.env.VERIFY_MAX_INGEST_AGE_HOURS || 24);
      record(
        'inventory freshness',
        age > maxAge ? 'fail' : age > maxAge / 2 ? 'warn' : 'ok',
        `last ingest ${age.toFixed(1)}h ago (limit ${maxAge}h)`
      );
    }

    if (stats === 0) {
      record('inventory stats', 'warn', 'InventoryStats empty — filter UX will feel slow');
    }

    // Soft-launch data quality: empty fuel / engineNorm silently zero VIP filters.
    const [missingFuel, missingEngine, total] = await Promise.all([
      prisma.carListing.count({
        where: {
          OR: [{ fuelType: null }, { fuelType: '' }, { fuelType: 'Unknown' }]
        }
      }),
      prisma.carListing.count({
        where: { engineNorm: '' }
      }),
      prisma.carListing.count()
    ]);
    if (total > 0) {
      const fuelPct = (missingFuel / total) * 100;
      const engPct = (missingEngine / total) * 100;
      record(
        'fuel coverage',
        fuelPct > 25 ? 'warn' : 'ok',
        `${(100 - fuelPct).toFixed(1)}% have fuel (${missingFuel} missing/Unknown) — run npm run backfill:fuel if high`
      );
      record(
        'engine coverage',
        engPct > 35 ? 'warn' : 'ok',
        `${(100 - engPct).toFixed(1)}% have engineNorm (${missingEngine} empty) — enrich cron / npm run enrich:engines`
      );
    }
  } catch (err) {
    record('postgres', 'fail', err instanceof Error ? err.message : String(err));
  }
}

async function checkRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    record('redis', 'warn', 'REDIS_URL not set — running on in-memory fallback');
    return;
  }

  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 4000,
    lazyConnect: true,
    retryStrategy: () => null
  });

  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== 'PONG') throw new Error(`unexpected PING reply: ${pong}`);

    let queues = 0;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'notif:q:*', 'COUNT', 200);
      cursor = next;
      queues += keys.length;
    } while (cursor !== '0');

    const relay = await redis.llen('ops:critical').catch(() => 0);
    record('redis', 'ok', `PONG · ${queues} pending digest queue(s)`);
    if (relay > 0) {
      record('critical relay', 'warn', `${relay} unforwarded scraper alert(s) in ops:critical`);
    }
  } catch (err) {
    record('redis', 'fail', err instanceof Error ? err.message : String(err));
  } finally {
    redis.disconnect();
  }
}

async function checkBackups(): Promise<void> {
  const client = createR2Client();
  const bucket = getR2Bucket();
  if (!client || !bucket) {
    record('r2 backups', 'fail', 'R2 credentials/bucket not configured');
    return;
  }

  try {
    const objects = await listBackupObjects(client, bucket);
    if (!objects.length) {
      record('r2 backups', 'fail', 'bucket has no dumps');
      return;
    }

    const latest = objects.reduce((a, b) =>
      (a.LastModified?.getTime() ?? 0) > (b.LastModified?.getTime() ?? 0) ? a : b
    );
    const when = latest.LastModified ?? new Date(0);
    const age = hoursSince(when);
    const maxAge = Number(process.env.VERIFY_MAX_BACKUP_AGE_HOURS || 36);
    const sizeMb = ((latest.Size ?? 0) / (1024 * 1024)).toFixed(2);

    record(
      'r2 backups',
      age > maxAge ? 'fail' : 'ok',
      `${objects.length} dump(s) · latest ${age.toFixed(1)}h old (${sizeMb} MB, limit ${maxAge}h)`
    );
  } catch (err) {
    record('r2 backups', 'fail', err instanceof Error ? err.message : String(err));
  }
}

function checkEnv(): void {
  const required = [
    'DATABASE_URL',
    'REDIS_URL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ADMIN_CHAT_ID',
    'TELEGRAM_ADMIN_USER_IDS',
    'OPENAI_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'R2_BUCKET'
  ];
  const missing = required.filter((key) => !process.env[key]?.trim());
  record(
    'env vars',
    missing.length ? 'fail' : 'ok',
    missing.length ? `missing: ${missing.join(', ')}` : `${required.length} required vars present`
  );

  const tiers = [1, 2, 3].filter(
    (n) => !process.env[`STRIPE_PAYMENT_LINK_TIER${n}`]?.trim()
  );
  if (tiers.length) {
    record('stripe tiers', 'warn', `no payment link for tier(s): ${tiers.join(', ')}`);
  } else {
    record('stripe tiers', 'ok', 'all 3 payment links set (0–200 / 201–500 / 501+)');
  }

  const hardStart = parseInt(process.env.NOTIF_HARD_START_HOUR || '7', 10);
  const hardEnd = parseInt(process.env.NOTIF_HARD_END_HOUR || '23', 10);
  const winStart = parseInt(process.env.NOTIF_WINDOW_START_HOUR || '8', 10);
  const winEnd = parseInt(process.env.NOTIF_WINDOW_END_HOUR || '21', 10);
  const interval = parseInt(process.env.NOTIF_INTERVAL_HOURS || '2', 10);
  if (
    !Number.isFinite(hardStart) ||
    !Number.isFinite(hardEnd) ||
    hardStart < 0 ||
    hardEnd > 24 ||
    hardStart >= hardEnd
  ) {
    record('digest hard window', 'fail', `invalid NOTIF_HARD_* (${hardStart}–${hardEnd})`);
  } else if (winStart < hardStart || winEnd > hardEnd || winStart >= winEnd) {
    record(
      'digest hard window',
      'warn',
      `defaults ${winStart}–${winEnd} outside hard ${hardStart}–${hardEnd}`
    );
  } else {
    record(
      'digest hard window',
      'ok',
      `hard ${hardStart}–${hardEnd} · defaults ${winStart}–${winEnd} · interval ${interval}h`
    );
  }
  if (![1, 2, 3, 4].includes(interval)) {
    record('digest interval default', 'warn', `NOTIF_INTERVAL_HOURS=${interval} (expected 1–4)`);
  }
}

async function checkDigestPrefsSchema(): Promise<void> {
  try {
    // Ensures prisma db push applied User.digest* columns
    await prisma.user.findFirst({
      select: {
        digestDays: true,
        digestStartHour: true,
        digestEndHour: true,
        digestIntervalH: true,
        digestPaused: true
      }
    });
    record('digest schedule schema', 'ok', 'User.digestDays/hours/interval/paused present');
  } catch (err) {
    record(
      'digest schedule schema',
      'fail',
      `missing digest columns — run prisma db push (${err instanceof Error ? err.message : err})`
    );
  }
}

async function checkAdminBox(): Promise<void> {
  try {
    const row = await prisma.appMeta.findUnique({ where: { key: 'vip_counter_message_id' } });
    record(
      'vip counter box',
      row ? 'ok' : 'warn',
      row ? `message id ${row.value}` : 'not posted yet — run /vip_count in the admin chat'
    );
  } catch {
    record('vip counter box', 'warn', 'AppMeta table not available yet');
  }
}

function icon(level: Level): string {
  return level === 'ok' ? '✅' : level === 'warn' ? '⚠️ ' : '❌';
}

async function main(): Promise<void> {
  console.log('🔎 AutoBroker AI — system verification\n');

  checkEnv();
  await checkDatabase();
  await checkDigestPrefsSchema();
  await checkRedis();
  await checkBackups();
  await checkAdminBox();

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${icon(c.level)} ${c.name.padEnd(width)}  ${c.detail}`);
  }

  const fails = checks.filter((c) => c.level === 'fail');
  const warns = checks.filter((c) => c.level === 'warn');
  console.log(
    `\n${fails.length ? '❌ FAIL' : '✅ OK'} — ${checks.length} checks, ${fails.length} failure(s), ${warns.length} warning(s).`
  );

  await prisma.$disconnect();
  process.exit(fails.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('❌ Verification crashed:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
