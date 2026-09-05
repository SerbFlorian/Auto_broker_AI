import { prisma } from '../db/prisma.js';
import type { Prisma } from '../generated/prisma/index.js';
import {
  normalizeBrand,
  normalizeModel,
  normalizeSpecToken,
  displayBrand,
  displayModel,
  isUsableModelLabel,
  resolveVersionTokens
} from '../utils/normalizer.js';
import { catalogModelLookupKeys } from '../utils/catalogModelAliases.js';
import {
  normalizeEngineKey
} from './engineCatalog.service.js';
import {
  cacheGetOrSet,
  cacheDelByPrefix,
  clearLocalCache,
  CacheKeys
} from './cache.service.js';
import {
  carMatchesDraftScope,
  type InventoryScopeExtras
} from './filterScope.js';

export type { InventoryScopeExtras };

const MIN_VEHICLES_PER_BRAND = 10;
const TTL_BRANDS = 15 * 60;
const TTL_MODELS = 10 * 60;
const TTL_VERSIONS = 10 * 60;
const TTL_CTX = 5 * 60;
/** Cap for in-memory scope (catalog specs + soft power) so Country/Fuel counts stay accurate. */
const SCOPE_SCAN_CAP = 8000;

export interface InventoryContextLimits {
  count: number;
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  minYear: number;
  maxYear: number;
  avgYear: number;
  minMileage: number;
  maxMileage: number;
  avgMileage: number;
  fuels: string[];
  engines: string[];
  minPower: number;
  maxPower: number;
  avgPower: number;
}

export interface FilterDefaultsTarget {
  brand?: string | null;
  model?: string | null;
  versions?: string[];
  maxPrice?: number | null;
  minYear?: number | null;
  maxMileageKm?: number | null;
  fuelTypes?: string[];
}

function roundPrice(value: number): number {
  if (value <= 0) return 0;
  return Math.ceil(value / 1000) * 1000;
}

function roundMileage(value: number): number {
  if (value <= 0) return 0;
  return Math.ceil(value / 5000) * 5000;
}

/**
 * Display stock counts: exact under 100; otherwise ~rounded (104→~100, 105→~110, 7829→~7.8k style).
 */
export function formatApproxCount(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 100) return String(v);
  if (v < 1000) return `~${Math.round(v / 10) * 10}`;
  if (v < 10_000) return `~${Math.round(v / 100) * 100}`;
  if (v < 100_000) {
    const k = Math.round(v / 1000);
    return `~${k}k`;
  }
  const k = Math.round(v / 10_000) * 10;
  return `~${k}k`;
}

/** Never treat year 0 / junk as real stock min. */
export function saneMinYear(y: number | null | undefined): number {
  const v = Number(y);
  if (!Number.isFinite(v) || v < 1970) return 1970;
  if (v > new Date().getFullYear() + 1) return new Date().getFullYear();
  return Math.floor(v);
}

export { roundPrice, roundMileage };

function sortedTokenKey(versions?: string[] | null): string {
  return (versions ?? [])
    .map(normalizeSpecToken)
    .filter(Boolean)
    .sort()
    .join('|');
}

/**
 * Weighted merge of multiple InventoryStats rows (multi-spec OR).
 * Averages are weighted by count so larger segments dominate.
 */
function mergeStatsRows(
  rows: Array<{
    count: number;
    minPrice: number;
    maxPrice: number;
    avgPrice: number;
    minYear: number;
    maxYear: number;
    avgYear: number;
    minMileage: number;
    maxMileage: number;
    avgMileage: number;
    fuels: string[];
    engines?: string[];
    minPower?: number;
    maxPower?: number;
    avgPower?: number;
  }>
): InventoryContextLimits | null {
  if (rows.length === 0) return null;

  let count = 0;
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  let minYear = Infinity;
  let maxYear = -Infinity;
  let minMileage = Infinity;
  let maxMileage = -Infinity;
  let minPower = Infinity;
  let maxPower = -Infinity;
  let sumPrice = 0;
  let sumYear = 0;
  let sumMileage = 0;
  let sumPower = 0;
  let powerWeight = 0;
  const fuels = new Set<string>();
  const engines = new Set<string>();

  for (const r of rows) {
    if (r.count <= 0) continue;
    count += r.count;
    minPrice = Math.min(minPrice, r.minPrice);
    maxPrice = Math.max(maxPrice, r.maxPrice);
    minYear = Math.min(minYear, r.minYear);
    maxYear = Math.max(maxYear, r.maxYear);
    minMileage = Math.min(minMileage, r.minMileage);
    maxMileage = Math.max(maxMileage, r.maxMileage);
    sumPrice += r.avgPrice * r.count;
    sumYear += r.avgYear * r.count;
    sumMileage += r.avgMileage * r.count;
    for (const f of r.fuels) fuels.add(f);
    for (const e of r.engines ?? []) {
      const n = normalizeEngineKey(e);
      if (n) engines.add(n);
    }
    if ((r.minPower ?? 0) > 0) minPower = Math.min(minPower, r.minPower!);
    if ((r.maxPower ?? 0) > 0) maxPower = Math.max(maxPower, r.maxPower!);
    if ((r.avgPower ?? 0) > 0) {
      sumPower += r.avgPower! * r.count;
      powerWeight += r.count;
    }
  }

  if (count === 0) return null;

  return {
    count,
    minPrice: Number.isFinite(minPrice) ? minPrice : 0,
    maxPrice: Number.isFinite(maxPrice) ? maxPrice : 0,
    avgPrice: sumPrice / count,
    minYear: Number.isFinite(minYear) ? minYear : 0,
    maxYear: Number.isFinite(maxYear) ? maxYear : 0,
    avgYear: sumYear / count,
    minMileage: Number.isFinite(minMileage) ? minMileage : 0,
    maxMileage: Number.isFinite(maxMileage) ? maxMileage : 0,
    avgMileage: sumMileage / count,
    fuels: Array.from(fuels).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    engines: Array.from(engines).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    minPower: Number.isFinite(minPower) ? minPower : 0,
    maxPower: Number.isFinite(maxPower) ? maxPower : 0,
    avgPower: powerWeight > 0 ? sumPower / powerWeight : 0
  };
}

function hasScopeExtras(extras?: InventoryScopeExtras | null): boolean {
  if (!extras) return false;
  return (
    (extras.countries?.length ?? 0) > 0 ||
    (extras.fuelTypes?.length ?? 0) > 0 ||
    (extras.engines?.length ?? 0) > 0 ||
    (extras.minPowerHp != null && extras.minPowerHp > 0) ||
    extras.maxPrice != null ||
    extras.minYear != null ||
    (extras.maxMileageKm != null && extras.maxMileageKm < 9_999_999)
  );
}

/**
 * SQL prefilter only — brand/model + hard country/price/year/km.
 * Fuel / engine / power / specs stay OUT of SQL (soft-fill in carMatchesDraftScope),
 * so digests and stock counts never disagree on incomplete rows.
 */
export function buildInventoryWhereClause(
  brand?: string | null,
  model?: string | null,
  _versions?: string[] | null,
  extras?: InventoryScopeExtras | null
): Prisma.CarListingWhereInput {
  const where: Prisma.CarListingWhereInput = {};
  const brandNorm = brand ? normalizeBrand(brand) : '';
  const modelKeys = model ? catalogModelLookupKeys(model) : [];

  if (brandNorm) {
    where.brandNorm = { equals: brandNorm };
  }
  if (modelKeys.length === 1) {
    where.modelNorm = { equals: modelKeys[0] };
  } else if (modelKeys.length > 1) {
    where.modelNorm = { in: modelKeys };
  }

  if (extras?.countries && extras.countries.length > 0) {
    where.countryOfOrigin = { in: extras.countries };
  }
  if (extras?.maxPrice != null) {
    where.price = { lte: extras.maxPrice };
  }
  if (extras?.minYear != null) {
    where.year = { gte: extras.minYear };
  }
  if (extras?.maxMileageKm != null && extras.maxMileageKm < 9_999_999) {
    where.mileageKm = { lte: extras.maxMileageKm };
  }

  return where;
}

const SCOPE_SELECT = {
  id: true,
  brand: true,
  model: true,
  brandNorm: true,
  modelNorm: true,
  version: true,
  versionTokens: true,
  fuelType: true,
  engineNorm: true,
  powerHp: true,
  price: true,
  year: true,
  mileageKm: true,
  countryOfOrigin: true
} as const;

async function loadScopedListings(
  brand?: string | null,
  model?: string | null,
  versions?: string[] | null,
  extras?: InventoryScopeExtras | null
) {
  // Broad SQL: omit fuel/engine so soft-fill rows remain candidates; hard caps stay in SQL.
  const sqlExtras: InventoryScopeExtras = {
    countries: extras?.countries,
    maxPrice: extras?.maxPrice,
    minYear: extras?.minYear,
    maxMileageKm: extras?.maxMileageKm
    // fuelTypes / engines / minPowerHp → in-memory (soft-fill)
  };
  const where = buildInventoryWhereClause(brand, model, null, sqlExtras);
  const rows = await prisma.carListing.findMany({
    where,
    select: SCOPE_SELECT,
    take: SCOPE_SCAN_CAP,
    orderBy: { updatedAt: 'desc' }
  });
  return rows.filter((row) =>
    carMatchesDraftScope(row, { brand, model, versions, extras })
  );
}

function needsAccurateScopeScan(
  versions?: string[] | null,
  extras?: InventoryScopeExtras | null
): boolean {
  return (
    (versions?.length ?? 0) > 0 ||
    (extras?.minPowerHp != null && extras.minPowerHp > 0) ||
    (extras?.fuelTypes?.length ?? 0) > 0 ||
    (extras?.engines?.length ?? 0) > 0
  );
}

async function fetchContextFromStats(
  brandNorm: string,
  modelNorm: string,
  versions?: string[] | null
): Promise<InventoryContextLimits | null> {
  const tokens = (versions ?? []).map(normalizeSpecToken).filter(Boolean);

  if (tokens.length === 0) {
    const base = await prisma.inventoryStats.findUnique({
      where: {
        brandNorm_modelNorm_versionToken: {
          brandNorm,
          modelNorm,
          versionToken: ''
        }
      }
    });
    if (!base) return null;
    return {
      count: base.count,
      minPrice: base.minPrice,
      maxPrice: base.maxPrice,
      avgPrice: base.avgPrice,
      minYear: base.minYear,
      maxYear: base.maxYear,
      avgYear: base.avgYear,
      minMileage: base.minMileage,
      maxMileage: base.maxMileage,
      avgMileage: base.avgMileage,
      fuels: base.fuels,
      engines: base.engines ?? [],
      minPower: base.minPower ?? 0,
      maxPower: base.maxPower ?? 0,
      avgPower: base.avgPower ?? 0
    };
  }

  const tokenRows = await prisma.inventoryStats.findMany({
    where: {
      brandNorm: { equals: brandNorm },
      modelNorm: { equals: modelNorm },
      versionToken: { in: tokens }
    }
  });

  if (tokenRows.length > 0) {
    return mergeStatsRows(tokenRows);
  }

  // Token stats missing — fall back to base brand+model stats
  const base = await prisma.inventoryStats.findUnique({
    where: {
      brandNorm_modelNorm_versionToken: {
        brandNorm,
        modelNorm,
        versionToken: ''
      }
    }
  });
  if (!base) return null;
  return {
    count: base.count,
    minPrice: base.minPrice,
    maxPrice: base.maxPrice,
    avgPrice: base.avgPrice,
    minYear: base.minYear,
    maxYear: base.maxYear,
    avgYear: base.avgYear,
    minMileage: base.minMileage,
    maxMileage: base.maxMileage,
    avgMileage: base.avgMileage,
    fuels: base.fuels,
    engines: base.engines ?? [],
    minPower: base.minPower ?? 0,
    maxPower: base.maxPower ?? 0,
    avgPower: base.avgPower ?? 0
  };
}

/** Live aggregate — accurate path uses same matcher as digests (catalog specs + soft power). */
async function fetchContextLive(
  brand?: string | null,
  model?: string | null,
  versions?: string[] | null,
  extras?: InventoryScopeExtras | null
): Promise<InventoryContextLimits | null> {
  if (needsAccurateScopeScan(versions, extras) || hasScopeExtras(extras) || (versions?.length ?? 0) > 0) {
    const rows = await loadScopedListings(brand, model, versions, extras);
    if (rows.length === 0) return null;
    const { effectivePowerHp } = await import('./filterScope.js');
    const { normalizeFuelType } = await import('../utils/normalizer.js');
    const { resolveEngineFromVersion } = await import('./engineCatalog.service.js');
    let sumPrice = 0;
    let sumYear = 0;
    let sumMileage = 0;
    let sumPower = 0;
    let powerWeight = 0;
    let minPrice = Infinity;
    let maxPrice = 0;
    let minYear = Infinity;
    let maxYear = 0;
    let minMileage = Infinity;
    let maxMileage = 0;
    let minPower = Infinity;
    let maxPower = 0;
    const fuels = new Set<string>();
    const engines = new Set<string>();
    for (const r of rows) {
      const price = r.price ?? 0;
      const year = r.year ?? 0;
      const km = r.mileageKm ?? 0;
      sumPrice += price;
      sumYear += year;
      sumMileage += km;
      if (price < minPrice) minPrice = price;
      if (price > maxPrice) maxPrice = price;
      if (year < minYear) minYear = year;
      if (year > maxYear) maxYear = year;
      if (km < minMileage) minMileage = km;
      if (km > maxMileage) maxMileage = km;
      const hp = effectivePowerHp(r);
      if (hp != null && hp > 0) {
        sumPower += hp;
        powerWeight += 1;
        if (hp < minPower) minPower = hp;
        if (hp > maxPower) maxPower = hp;
      }
      // Soft-fill fuel/engine so menu options match digests on incomplete rows
      let fuel = (r.fuelType || '').trim();
      if (!fuel || /^unknown$/i.test(fuel)) {
        const inferred = normalizeFuelType(r.version || '');
        if (inferred && !/^unknown$/i.test(inferred)) fuel = inferred;
      }
      if (fuel && !/^unknown$/i.test(fuel)) fuels.add(fuel);
      let eng = normalizeEngineKey(r.engineNorm || '');
      if (!eng && r.version) {
        const resolved = resolveEngineFromVersion({
          brand: r.brand,
          model: r.model,
          version: r.version,
          existingPowerHp: r.powerHp ?? null
        });
        eng = normalizeEngineKey(resolved?.engineNorm || resolved?.engine || '');
      }
      if (eng) engines.add(eng);
    }
    const count = rows.length;
    return {
      count,
      minPrice: Number.isFinite(minPrice) ? minPrice : 0,
      maxPrice,
      avgPrice: sumPrice / count,
      minYear: Number.isFinite(minYear) ? minYear : 0,
      maxYear,
      avgYear: sumYear / count,
      minMileage: Number.isFinite(minMileage) ? minMileage : 0,
      maxMileage,
      avgMileage: sumMileage / count,
      fuels: Array.from(fuels).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
      engines: Array.from(engines).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
      minPower: Number.isFinite(minPower) ? minPower : 0,
      maxPower: Number.isFinite(maxPower) ? maxPower : 0,
      avgPower: powerWeight > 0 ? sumPower / powerWeight : 0
    };
  }

  const where = buildInventoryWhereClause(brand, model, null, extras);

  const [aggregates, fuelGroups, engineGroups] = await Promise.all([
    prisma.carListing.aggregate({
      where,
      _count: { _all: true },
      _avg: { price: true, year: true, mileageKm: true, powerHp: true },
      _min: { price: true, year: true, mileageKm: true, powerHp: true },
      _max: { price: true, year: true, mileageKm: true, powerHp: true }
    }),
    prisma.carListing.groupBy({
      by: ['fuelType'],
      where: {
        ...where,
        fuelType: { not: null, notIn: ['Unknown', 'unknown'] }
      },
      _count: { fuelType: true }
    }),
    prisma.carListing.groupBy({
      by: ['engineNorm'],
      where: {
        ...where,
        engineNorm: { not: '' }
      },
      _count: { engineNorm: true }
    })
  ]);

  const count = aggregates._count._all;
  if (count === 0) return null;

  return {
    count,
    minPrice: aggregates._min.price ?? 0,
    maxPrice: aggregates._max.price ?? 0,
    avgPrice: aggregates._avg.price ?? 0,
    minYear: aggregates._min.year ?? 0,
    maxYear: aggregates._max.year ?? 0,
    avgYear: aggregates._avg.year ?? 0,
    minMileage: aggregates._min.mileageKm ?? 0,
    maxMileage: aggregates._max.mileageKm ?? 0,
    avgMileage: aggregates._avg.mileageKm ?? 0,
    fuels: fuelGroups
      .map((g) => g.fuelType!)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    engines: [
      ...new Set(
        engineGroups
          .map((g) => normalizeEngineKey(g.engineNorm))
          .filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    minPower:
      aggregates._min.powerHp && aggregates._min.powerHp > 0
        ? aggregates._min.powerHp
        : 0,
    maxPower:
      aggregates._max.powerHp && aggregates._max.powerHp > 0
        ? aggregates._max.powerHp
        : 0,
    avgPower: aggregates._avg.powerHp ?? 0
  };
}

export async function getInventoryContextLimits(
  brand?: string | null,
  model?: string | null,
  versions?: string[] | null,
  extras?: InventoryScopeExtras | null
): Promise<InventoryContextLimits | null> {
  // Extra draft filters or catalog trim labels need a live scoped query
  // (InventoryStats tokens are raw versionTokens, not catalog names like "VZ Cup").
  if (!brand || !model || hasScopeExtras(extras) || (versions && versions.length > 0)) {
    return fetchContextLive(brand, model, versions, extras);
  }

  const brandNorm = normalizeBrand(brand);
  const modelNorm = normalizeModel(model);
  const tokenKey = sortedTokenKey(versions);
  const cacheKey = CacheKeys.ctx(brandNorm, modelNorm, tokenKey);

  try {
    return await cacheGetOrSet(cacheKey, TTL_CTX, async () => {
      const fromStats = await fetchContextFromStats(brandNorm, modelNorm, versions);
      if (fromStats) return fromStats;
      return fetchContextLive(brand, model, versions);
    });
  } catch (error) {
    console.error('❌ Error getting dynamic inventory limits:', error);
    return null;
  }
}

/** Scope helpers for filter menus — omit the dimension currently being edited. */
export function draftScope(
  draft: InventoryScopeExtras & {
    countries?: string[] | null;
    fuelTypes?: string[] | null;
    engines?: string[] | null;
  },
  omit?: Array<keyof InventoryScopeExtras>
): InventoryScopeExtras {
  const skip = new Set(omit ?? []);
  return {
    countries: skip.has('countries') ? undefined : draft.countries,
    fuelTypes: skip.has('fuelTypes') ? undefined : draft.fuelTypes,
    engines: skip.has('engines') ? undefined : draft.engines,
    minPowerHp: skip.has('minPowerHp') ? undefined : draft.minPowerHp,
    maxPrice: skip.has('maxPrice') ? undefined : draft.maxPrice,
    minYear: skip.has('minYear') ? undefined : draft.minYear,
    maxMileageKm: skip.has('maxMileageKm') ? undefined : draft.maxMileageKm
  };
}

export async function applyInventoryContextDefaults(
  target: FilterDefaultsTarget
): Promise<InventoryContextLimits | null> {
  if (!target.brand || !target.model) {
    return null;
  }

  const limits = await getInventoryContextLimits(target.brand, target.model, target.versions);
  if (!limits || limits.count === 0) {
    return null;
  }

  if (limits.avgPrice > 0 && (target.maxPrice == null || target.maxPrice === undefined)) {
    target.maxPrice = roundPrice(limits.avgPrice);
  }
  if (limits.avgYear > 0 && (target.minYear == null || target.minYear === undefined)) {
    target.minYear = Math.round(limits.avgYear);
  }
  if (limits.avgMileage > 0 && (target.maxMileageKm == null || target.maxMileageKm === undefined)) {
    target.maxMileageKm = roundMileage(limits.avgMileage);
  }
  if (target.fuelTypes && target.fuelTypes.length > 0) {
    target.fuelTypes = target.fuelTypes.filter(f => limits.fuels.includes(f));
  }

  return limits;
}

export async function getAvailableBrands(): Promise<{ brand: string; count: number }[]> {
  return cacheGetOrSet(CacheKeys.brands(), TTL_BRANDS, async () => {
    const rows = await prisma.inventoryStats.findMany({
      where: { versionToken: '' },
      select: { brandNorm: true, count: true }
    });

    if (rows.length === 0) {
      // Cold stats — fall back to live groupBy
      const brandGroups = await prisma.carListing.groupBy({
        by: ['brandNorm'],
        _count: { _all: true },
        where: { brandNorm: { not: '' } }
      });
      return brandGroups
        .filter(g => g._count._all >= MIN_VEHICLES_PER_BRAND && g.brandNorm)
        .map(g => ({ brand: displayBrand(g.brandNorm), count: g._count._all }))
        .sort((a, b) => a.brand.localeCompare(b.brand, 'en', { sensitivity: 'base' }));
    }

    const map = new Map<string, number>();
    for (const r of rows) {
      if (!r.brandNorm) continue;
      map.set(r.brandNorm, (map.get(r.brandNorm) || 0) + r.count);
    }

    return Array.from(map.entries())
      .filter(([, count]) => count >= MIN_VEHICLES_PER_BRAND)
      .map(([brandNorm, count]) => ({ brand: displayBrand(brandNorm), count }))
      .sort((a, b) => a.brand.localeCompare(b.brand, 'en', { sensitivity: 'base' }));
  });
}

export async function getAvailableFuelTypes(): Promise<{ fuelType: string; count: number }[]> {
  const brands = await getAvailableBrands();
  // Derive global fuels from base stats (cheap); not critical hot path
  const rows = await prisma.inventoryStats.findMany({
    where: { versionToken: '' },
    select: { fuels: true, count: true }
  });
  const map = new Map<string, number>();
  for (const r of rows) {
    for (const f of r.fuels) {
      map.set(f, (map.get(f) || 0) + r.count);
    }
  }
  if (map.size === 0 && brands.length === 0) return [];
  return Array.from(map.entries())
    .map(([fuelType, count]) => ({ fuelType, count }))
    .sort((a, b) => a.fuelType.localeCompare(b.fuelType, 'en', { sensitivity: 'base' }));
}

/** Countries in stock scoped by brand/model/specs + draft filters above Country. */
export async function getAvailableCountries(
  brand?: string | null,
  model?: string | null,
  versions?: string[] | null,
  extras?: InventoryScopeExtras | null
): Promise<{ code: string; count: number }[]> {
  const scope: InventoryScopeExtras = {
    fuelTypes: extras?.fuelTypes,
    engines: extras?.engines,
    minPowerHp: extras?.minPowerHp,
    maxPrice: extras?.maxPrice,
    minYear: extras?.minYear,
    maxMileageKm: extras?.maxMileageKm
  };

  // Same matcher as digests (catalog specs + soft power) — never inflate Country counts
  const rows = await loadScopedListings(brand, model, versions, scope);
  const map = new Map<string, number>();
  for (const r of rows) {
    const code = (r.countryOfOrigin || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) continue;
    map.set(code, (map.get(code) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function getAvailableModels(brand: string): Promise<{ model: string; count: number }[]> {
  const brandNorm = normalizeBrand(brand);
  return cacheGetOrSet(CacheKeys.models(brandNorm), TTL_MODELS, async () => {
    const rows = await prisma.inventoryStats.findMany({
      where: { brandNorm: { equals: brandNorm }, versionToken: '' },
      select: { modelNorm: true, count: true }
    });

    const map = new Map<string, number>();

    if (rows.length === 0) {
      const modelGroups = await prisma.carListing.groupBy({
        by: ['modelNorm'],
        where: { brandNorm: { equals: brandNorm } },
        _count: { _all: true }
      });
      for (const g of modelGroups) {
        const key = normalizeModel(g.modelNorm);
        if (!isUsableModelLabel(key) || g._count._all < 1) continue;
        map.set(key, (map.get(key) || 0) + g._count._all);
      }
    } else {
      for (const r of rows) {
        const key = normalizeModel(r.modelNorm);
        if (!isUsableModelLabel(key)) continue;
        map.set(key, (map.get(key) || 0) + r.count);
      }
    }

    return Array.from(map.entries())
      .filter(([, count]) => count >= 3)
      .map(([modelNorm, count]) => ({
        model: displayModel(modelNorm),
        count
      }))
      .sort((a, b) =>
        a.model.localeCompare(b.model, 'en', { numeric: true, sensitivity: 'base' })
      );
  });
}

export async function getAvailableVersions(
  brand: string,
  model: string
): Promise<{ version: string; count: number }[]> {
  const brandNorm = normalizeBrand(brand);
  const modelNorm = normalizeModel(model);

  return cacheGetOrSet(CacheKeys.versions(brandNorm, modelNorm), TTL_VERSIONS, async () => {
    const tokenRows = await prisma.inventoryStats.findMany({
      where: {
        brandNorm: { equals: brandNorm },
        modelNorm: { equals: modelNorm },
        versionToken: { not: '' }
      },
      select: { versionToken: true, count: true },
      orderBy: { count: 'desc' },
      take: 80
    });

    if (tokenRows.length > 0) {
      return tokenRows.map((r: { versionToken: string; count: number }) => ({
        version: r.versionToken
          .split(' ')
          .map((w: string) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
          .join(' '),
        count: r.count
      }));
    }

    // Fallback: distinct version tokens from listings (heal empty [] via version text)
    const listings = await prisma.carListing.findMany({
      where: {
        brandNorm: { equals: brandNorm },
        modelNorm: { equals: modelNorm }
      },
      select: { versionTokens: true, version: true },
      take: 2000
    });
    const map = new Map<string, number>();
    for (const l of listings) {
      for (const t of resolveVersionTokens(l.version, l.versionTokens)) {
        map.set(t, (map.get(t) || 0) + 1);
      }
    }
    return Array.from(map.entries())
      .filter(([, c]) => c >= 1)
      .map(([version, count]) => ({
        version: version
          .split(' ')
          .map(w => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
          .join(' '),
        count
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 80);
  });
}

export async function invalidateInventoryCache(): Promise<void> {
  clearLocalCache();
  await cacheDelByPrefix('inv:');
}

export async function invalidateAlertIndexCache(
  _brandNorm?: string | null,
  _modelNorm?: string | null
): Promise<void> {
  // Drop every alert index slice — old brand caches must not keep a replaced VIP alert.
  clearLocalCache();
  await cacheDelByPrefix('alerts:idx:');
}
