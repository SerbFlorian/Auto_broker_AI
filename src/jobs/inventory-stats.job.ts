import cron from 'node-cron';
import { prisma } from '../db/prisma.js';
import { cacheDelByPrefix, cacheSet, CacheKeys } from '../services/cache.service.js';
import { normalizeEngineKey } from '../services/engineCatalog.service.js';

const MIN_TOKEN_COUNT = 3;
let isRefreshing = false;

interface BaseAggRow {
  brandNorm: string;
  modelNorm: string;
  count: bigint | number;
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  minYear: number;
  maxYear: number;
  avgYear: number;
  minMileage: number;
  maxMileage: number;
  avgMileage: number;
  minPower: number;
  maxPower: number;
  avgPower: number;
}

interface TokenAggRow {
  brandNorm: string;
  modelNorm: string;
  versionToken: string;
  count: bigint | number;
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  minYear: number;
  maxYear: number;
  avgYear: number;
  minMileage: number;
  maxMileage: number;
  avgMileage: number;
  minPower: number;
  maxPower: number;
  avgPower: number;
}

interface FuelRow {
  brandNorm: string;
  modelNorm: string;
  versionToken: string | null;
  fuelType: string;
}

interface EngineRow {
  brandNorm: string;
  modelNorm: string;
  engineNorm: string;
}

function num(v: bigint | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

/**
 * Rebuilds InventoryStats from CarListing aggregates.
 * Base rows use versionToken='' (whole brand+model).
 * Popular version tokens get their own rows for multi-spec filter UX.
 */
export async function refreshInventoryStats(): Promise<void> {
  if (isRefreshing) {
    console.log('📊 [InventoryStats] Refresh already running, skipping.');
    return;
  }
  isRefreshing = true;
  const watermark = new Date();

  try {
    console.log('📊 [InventoryStats] Refresh started...');

    const baseRows = await prisma.$queryRaw<BaseAggRow[]>`
      SELECT
        "brandNorm",
        "modelNorm",
        COUNT(*)::int AS count,
        MIN(price) AS "minPrice",
        MAX(price) AS "maxPrice",
        AVG(price) AS "avgPrice",
        MIN(year)::int AS "minYear",
        MAX(year)::int AS "maxYear",
        AVG(year) AS "avgYear",
        MIN("mileageKm")::int AS "minMileage",
        MAX("mileageKm")::int AS "maxMileage",
        AVG("mileageKm") AS "avgMileage",
        COALESCE(MIN("powerHp") FILTER (WHERE "powerHp" IS NOT NULL AND "powerHp" > 0), 0)::int AS "minPower",
        COALESCE(MAX("powerHp") FILTER (WHERE "powerHp" IS NOT NULL AND "powerHp" > 0), 0)::int AS "maxPower",
        COALESCE(AVG("powerHp") FILTER (WHERE "powerHp" IS NOT NULL AND "powerHp" > 0), 0) AS "avgPower"
      FROM "CarListing"
      WHERE "brandNorm" <> ''
        AND "modelNorm" <> ''
        AND "modelNorm" NOT IN ('-', '—', '–', '.', '?', 'n/a', 'na')
        AND "modelNorm" ~ '[a-zA-Z0-9]'
      GROUP BY "brandNorm", "modelNorm"
      HAVING COUNT(*) >= 1
    `;

    const tokenRows = await prisma.$queryRaw<TokenAggRow[]>`
      SELECT
        c."brandNorm",
        c."modelNorm",
        t.token AS "versionToken",
        COUNT(*)::int AS count,
        MIN(c.price) AS "minPrice",
        MAX(c.price) AS "maxPrice",
        AVG(c.price) AS "avgPrice",
        MIN(c.year)::int AS "minYear",
        MAX(c.year)::int AS "maxYear",
        AVG(c.year) AS "avgYear",
        MIN(c."mileageKm")::int AS "minMileage",
        MAX(c."mileageKm")::int AS "maxMileage",
        AVG(c."mileageKm") AS "avgMileage",
        COALESCE(MIN(c."powerHp") FILTER (WHERE c."powerHp" IS NOT NULL AND c."powerHp" > 0), 0)::int AS "minPower",
        COALESCE(MAX(c."powerHp") FILTER (WHERE c."powerHp" IS NOT NULL AND c."powerHp" > 0), 0)::int AS "maxPower",
        COALESCE(AVG(c."powerHp") FILTER (WHERE c."powerHp" IS NOT NULL AND c."powerHp" > 0), 0) AS "avgPower"
      FROM "CarListing" c
      CROSS JOIN LATERAL unnest(c."versionTokens") AS t(token)
      WHERE c."brandNorm" <> ''
        AND c."modelNorm" <> ''
        AND c."modelNorm" NOT IN ('-', '—', '–', '.', '?', 'n/a', 'na')
        AND c."modelNorm" ~ '[a-zA-Z0-9]'
        AND t.token <> ''
      GROUP BY c."brandNorm", c."modelNorm", t.token
      HAVING COUNT(*) >= ${MIN_TOKEN_COUNT}
    `;

    const baseFuels = await prisma.$queryRaw<FuelRow[]>`
      SELECT
        "brandNorm",
        "modelNorm",
        ''::text AS "versionToken",
        "fuelType"
      FROM "CarListing"
      WHERE "brandNorm" <> ''
        AND "modelNorm" <> ''
        AND "modelNorm" NOT IN ('-', '—', '–', '.', '?', 'n/a', 'na')
        AND "modelNorm" ~ '[a-zA-Z0-9]'
        AND "fuelType" IS NOT NULL
        AND "fuelType" NOT IN ('Unknown', 'unknown')
      GROUP BY "brandNorm", "modelNorm", "fuelType"
    `;

    const tokenFuels = await prisma.$queryRaw<FuelRow[]>`
      SELECT
        c."brandNorm",
        c."modelNorm",
        t.token AS "versionToken",
        c."fuelType"
      FROM "CarListing" c
      CROSS JOIN LATERAL unnest(c."versionTokens") AS t(token)
      WHERE c."brandNorm" <> ''
        AND c."modelNorm" <> ''
        AND c."modelNorm" NOT IN ('-', '—', '–', '.', '?', 'n/a', 'na')
        AND c."modelNorm" ~ '[a-zA-Z0-9]'
        AND t.token <> ''
        AND c."fuelType" IS NOT NULL
        AND c."fuelType" NOT IN ('Unknown', 'unknown')
      GROUP BY c."brandNorm", c."modelNorm", t.token, c."fuelType"
    `;

    const baseEngines = await prisma.$queryRaw<EngineRow[]>`
      SELECT
        "brandNorm",
        "modelNorm",
        "engineNorm"
      FROM "CarListing"
      WHERE "brandNorm" <> ''
        AND "modelNorm" <> ''
        AND "engineNorm" <> ''
      GROUP BY "brandNorm", "modelNorm", "engineNorm"
    `;

    const fuelsMap = new Map<string, Set<string>>();
    const enginesMap = new Map<string, Set<string>>();
    const fuelKey = (b: string, m: string, v: string) => `${b}::${m}::${v}`;
    const engineKey = (b: string, m: string) => `${b}::${m}`;

    for (const f of [...baseFuels, ...tokenFuels]) {
      if (!f.fuelType) continue;
      const key = fuelKey(f.brandNorm, f.modelNorm, f.versionToken || '');
      if (!fuelsMap.has(key)) fuelsMap.set(key, new Set());
      fuelsMap.get(key)!.add(f.fuelType);
    }

    for (const e of baseEngines) {
      if (!e.engineNorm) continue;
      const key = engineKey(e.brandNorm, e.modelNorm);
      if (!enginesMap.has(key)) enginesMap.set(key, new Set());
      // Canonicalize so "0 tfsi" and "tfsi" collapse in InventoryStats
      const n = normalizeEngineKey(e.engineNorm);
      if (n) enginesMap.get(key)!.add(n);
    }

    const upserts: Promise<unknown>[] = [];

    for (const row of baseRows) {
      const key = fuelKey(row.brandNorm, row.modelNorm, '');
      const fuels = Array.from(fuelsMap.get(key) || []).sort();
      const engines = Array.from(
        enginesMap.get(engineKey(row.brandNorm, row.modelNorm)) || []
      ).sort();
      upserts.push(
        prisma.inventoryStats.upsert({
          where: {
            brandNorm_modelNorm_versionToken: {
              brandNorm: row.brandNorm,
              modelNorm: row.modelNorm,
              versionToken: ''
            }
          },
          create: {
            brandNorm: row.brandNorm,
            modelNorm: row.modelNorm,
            versionToken: '',
            count: num(row.count),
            minPrice: num(row.minPrice),
            maxPrice: num(row.maxPrice),
            avgPrice: num(row.avgPrice),
            minYear: num(row.minYear),
            maxYear: num(row.maxYear),
            avgYear: num(row.avgYear),
            minMileage: num(row.minMileage),
            maxMileage: num(row.maxMileage),
            avgMileage: num(row.avgMileage),
            fuels,
            engines,
            minPower: num(row.minPower),
            maxPower: num(row.maxPower),
            avgPower: num(row.avgPower)
          },
          update: {
            count: num(row.count),
            minPrice: num(row.minPrice),
            maxPrice: num(row.maxPrice),
            avgPrice: num(row.avgPrice),
            minYear: num(row.minYear),
            maxYear: num(row.maxYear),
            avgYear: num(row.avgYear),
            minMileage: num(row.minMileage),
            maxMileage: num(row.maxMileage),
            avgMileage: num(row.avgMileage),
            fuels,
            engines,
            minPower: num(row.minPower),
            maxPower: num(row.maxPower),
            avgPower: num(row.avgPower),
            updatedAt: watermark
          }
        })
      );
    }

    for (const row of tokenRows) {
      const key = fuelKey(row.brandNorm, row.modelNorm, row.versionToken);
      const fuels = Array.from(fuelsMap.get(key) || []).sort();
      const engines = Array.from(
        enginesMap.get(engineKey(row.brandNorm, row.modelNorm)) || []
      ).sort();
      upserts.push(
        prisma.inventoryStats.upsert({
          where: {
            brandNorm_modelNorm_versionToken: {
              brandNorm: row.brandNorm,
              modelNorm: row.modelNorm,
              versionToken: row.versionToken
            }
          },
          create: {
            brandNorm: row.brandNorm,
            modelNorm: row.modelNorm,
            versionToken: row.versionToken,
            count: num(row.count),
            minPrice: num(row.minPrice),
            maxPrice: num(row.maxPrice),
            avgPrice: num(row.avgPrice),
            minYear: num(row.minYear),
            maxYear: num(row.maxYear),
            avgYear: num(row.avgYear),
            minMileage: num(row.minMileage),
            maxMileage: num(row.maxMileage),
            avgMileage: num(row.avgMileage),
            fuels,
            engines,
            minPower: num(row.minPower),
            maxPower: num(row.maxPower),
            avgPower: num(row.avgPower)
          },
          update: {
            count: num(row.count),
            minPrice: num(row.minPrice),
            maxPrice: num(row.maxPrice),
            avgPrice: num(row.avgPrice),
            minYear: num(row.minYear),
            maxYear: num(row.maxYear),
            avgYear: num(row.avgYear),
            minMileage: num(row.minMileage),
            maxMileage: num(row.maxMileage),
            avgMileage: num(row.avgMileage),
            fuels,
            engines,
            minPower: num(row.minPower),
            maxPower: num(row.maxPower),
            avgPower: num(row.avgPower),
            updatedAt: watermark
          }
        })
      );
    }

    // Upsert in chunks to avoid huge Promise.all
    const CHUNK = 100;
    for (let i = 0; i < upserts.length; i += CHUNK) {
      await Promise.all(upserts.slice(i, i + CHUNK));
    }

    const deleted = await prisma.inventoryStats.deleteMany({
      where: { updatedAt: { lt: watermark } }
    });

    await cacheDelByPrefix('inv:');
    await cacheSet(CacheKeys.invGen(), String(watermark.getTime()), 60 * 60 * 24);

    console.log(
      `📊 [InventoryStats] Refresh done: ${baseRows.length} base, ${tokenRows.length} token rows, deleted ${deleted.count} stale.`
    );
  } catch (error) {
    console.error('❌ [InventoryStats] Refresh failed:', error);
  } finally {
    isRefreshing = false;
  }
}

export function startInventoryStatsCron(): void {
  cron.schedule('*/10 * * * *', () => {
    refreshInventoryStats().catch((e) =>
      console.error('❌ [InventoryStats] Cron error:', e)
    );
  });
  console.log('📊 InventoryStats cron scheduled every 10 minutes.');

  // Warm on boot (non-blocking)
  setTimeout(() => {
    refreshInventoryStats().catch(() => {});
  }, 15_000);
}
