import { prisma } from '../db/prisma.js';
import { queueService } from './queue.service.js';
import { normalizeBrand, normalizeModel } from '../utils/normalizer.js';
import { expandCatalogModelAliases } from '../utils/catalogModelAliases.js';
import { cacheGetOrSet, CacheKeys } from './cache.service.js';
import {
  areNearDuplicates,
  dedupeListingsForDelivery
} from './listingDedup.service.js';
import { escapeHtml, htmlBold, htmlItalic, htmlLink } from '../utils/telegramFormat.js';
import type { Prisma } from '../generated/prisma/index.js';
import { carMatchesAlert } from './matchingRules.js';

export { carMatchesAlert } from './matchingRules.js';

export interface CarListing {
  id?: string;
  portalId: string;
  sourcePortal: string;
  brand: string;
  model: string;
  brandNorm?: string;
  modelNorm?: string;
  year: number;
  mileageKm: number;
  price: number;
  countryOfOrigin: string;
  originalUrl: string;
  fuelType?: string | null;
  powerHp?: number | null;
  engine?: string | null;
  engineNorm?: string | null;
  version?: string | null;
  versionTokens?: string[];
  sellerType?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  urlVerifiedAt?: Date | null;
}

export interface IndexedAlert {
  id: string;
  userId: string;
  telegramId: string;
  brand: string | null;
  model: string | null;
  brandNorm: string | null;
  modelNorm: string | null;
  minYear: number | null;
  maxMileageKm: number | null;
  maxPrice: number | null;
  countries: string[];
  fuelTypes: string[];
  versions: string[];
  engines: string[];
  minPowerHp: number | null;
}

const ALERT_IDX_TTL = 3 * 60; // 3 minutes

/**
 * One car block inside a VIP digest. Shared by live matches and by the seed after a
 * filter change so both messages always look identical.
 *
 * Extras are best-effort: if the deal score or the duplicate lookup fails, the block
 * still ships with price, km, origin and — most importantly — the link.
 */
async function renderCarBlock(
  car: CarListing,
  index: number,
  isPerfect: boolean
): Promise<string> {
  const fuzzyNotice = !isPerfect ? ` ${htmlItalic('(Flexible Match)')}` : '';

  let block = `🔹 ${htmlBold(`#${index + 1}: ${car.brand} ${car.model}`)} (${escapeHtml(String(car.year))})${fuzzyNotice}\n`;
  block += `💰 ${escapeHtml(String(car.price))} €\n`;
  block += `📍 ${escapeHtml(String(car.mileageKm))} km\n`;
  block += `🌍 Origin: ${escapeHtml(car.countryOfOrigin)}\n`;

  try {
    const { dealScoreBadge } = await import('./dealScore.service.js');
    const badge = await dealScoreBadge(car);
    if (badge) block += `${escapeHtml(badge)}\n`;
  } catch {
    /* pricing context is a bonus, never a blocker */
  }

  try {
    const { countNearDuplicates } = await import('./listingDedup.service.js');
    const dups = await countNearDuplicates(car, car.id);
    if (dups > 0) {
      block += `${htmlItalic(`🔁 Same car also listed on ${dups} other portal${dups > 1 ? 's' : ''}`)}\n`;
    }
  } catch {
    /* ignore */
  }

  block += `🔗 ${htmlLink('Listing found', car.originalUrl)}\n\n`;
  return block;
}

function mapAlert(a: {
  id: string;
  userId: string;
  brand: string | null;
  model: string | null;
  brandNorm: string | null;
  modelNorm: string | null;
  minYear: number | null;
  maxMileageKm: number | null;
  maxPrice: number | null;
  countries?: string[] | null;
  fuelTypes: string[];
  versions: string[];
  engines?: string[] | null;
  minPowerHp?: number | null;
  user: { telegramId: bigint };
}): IndexedAlert {
  return {
    id: a.id,
    userId: a.userId,
    telegramId: a.user.telegramId.toString(),
    brand: a.brand,
    model: a.model,
    brandNorm: a.brandNorm,
    modelNorm: a.modelNorm,
    minYear: a.minYear,
    maxMileageKm: a.maxMileageKm,
    maxPrice: a.maxPrice,
    countries: a.countries ?? [],
    fuelTypes: a.fuelTypes ?? [],
    versions: a.versions ?? [],
    engines: a.engines ?? [],
    minPowerHp: a.minPowerHp ?? null
  };
}

async function loadAlertsForSlice(
  brandNorm: string,
  modelNorm: string
): Promise<IndexedAlert[]> {
  const brandKey = normalizeBrand(brandNorm) || brandNorm;
  const modelKey = normalizeModel(modelNorm) || modelNorm;
  const modelAliases = [
    ...new Set([modelNorm, modelKey, ...expandCatalogModelAliases(modelKey)])
  ].filter(Boolean);
  const cacheKey = CacheKeys.alertsIdx(brandKey, modelKey);

  return cacheGetOrSet<IndexedAlert[]>(cacheKey, ALERT_IDX_TTL, async () => {
    const where: Prisma.UserAlertWhereInput = {
      user: { subscriptionStatus: { in: ['vip', 'cancelling'] } },
      AND: [
        {
          OR: [
            { brandNorm: { equals: brandKey } },
            { brandNorm: null },
            { brandNorm: '' }
          ]
        },
        {
          OR: [
            { modelNorm: { in: modelAliases } },
            { modelNorm: null },
            { modelNorm: '' }
          ]
        }
      ]
    };

    const alerts = await prisma.userAlert.findMany({
      where,
      include: { user: { select: { telegramId: true } } }
    });

    return alerts.map(mapAlert);
  });
}

async function loadCatchAllAlerts(): Promise<IndexedAlert[]> {
  return cacheGetOrSet<IndexedAlert[]>(CacheKeys.alertsAny(), ALERT_IDX_TTL, async () => {
    const where: Prisma.UserAlertWhereInput = {
      user: { subscriptionStatus: { in: ['vip', 'cancelling'] } },
      OR: [{ brandNorm: null }, { brandNorm: '' }]
    };

    const alerts = await prisma.userAlert.findMany({
      where,
      include: { user: { select: { telegramId: true } } }
    });

    return alerts.map(mapAlert);
  });
}

/**
 * Legacy soft-tolerance was removed: price/year/km are hard in carMatchesAlert.
 * Kept so digest rendering still receives isPerfect (always true for matched cars).
 */
function evaluateTolerance(
  _car: CarListing,
  _alert: IndexedAlert
): { isPerfect: boolean; isWithinTolerance: boolean } {
  return { isPerfect: true, isWithinTolerance: true };
}

export class MatchingService {
  /**
   * Processes new listings against VIP alerts using indexed brand/model lookup
   * (O(unique brand+model slices × alerts-in-slice), not O(cars × all alerts)).
   */
  static async processNewListings(newCars: CarListing[]) {
    // Newest first so the ≤3-per-user cap prefers fresh scrape touches
    const uniqueNew = dedupeListingsForDelivery(newCars).sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });
    console.log(
      `⚙️ [Matching] Processing ${uniqueNew.length} listings` +
        (uniqueNew.length !== newCars.length
          ? ` (${newCars.length - uniqueNew.length} near-dups dropped in batch)`
          : '') +
        ` against indexed alerts...`
    );

    // Group cars by canonical brandNorm+modelNorm (unifies "4 series" / "serie 4")
    const bySlice = new Map<string, CarListing[]>();
    for (const car of uniqueNew) {
      const brandNorm = normalizeBrand(car.brandNorm || car.brand);
      const modelNorm = normalizeModel(car.modelNorm || car.model);
      const key = `${brandNorm}::${modelNorm}`;
      if (!bySlice.has(key)) bySlice.set(key, []);
      bySlice.get(key)!.push(car);
    }

    const catchAll = await loadCatchAllAlerts();
    const userAlertMatches = new Map<
      string,
      { telegramId: number; cars: CarListing[]; alertId: string; isPerfect: boolean[] }
    >();

    for (const [sliceKey, cars] of bySlice.entries()) {
      const [brandNorm, modelNorm] = sliceKey.split('::') as [string, string];
      const sliceAlerts = brandNorm && modelNorm
        ? await loadAlertsForSlice(brandNorm, modelNorm)
        : [];

      // Deduplicate alerts (slice query already includes null brand/model; catch-all for empty norms)
      const alertMap = new Map<string, IndexedAlert>();
      for (const a of sliceAlerts) alertMap.set(a.id, a);
      for (const a of catchAll) alertMap.set(a.id, a);
      const candidates = Array.from(alertMap.values());

      if (candidates.length === 0) continue;

      for (const car of cars) {
        for (const alert of candidates) {
          if (!carMatchesAlert(car, alert)) continue;

          // Never deliver until URL probe set urlVerifiedAt (any portal)
          if (!car.urlVerifiedAt) continue;

          const { isPerfect, isWithinTolerance } = evaluateTolerance(car, alert);
          if (!isWithinTolerance) continue;

          const carId = (car as any).id as string | undefined;
          if (carId) {
            const alreadySent = await prisma.sentListing.findFirst({
              where: {
                userId: alert.userId,
                OR: [
                  { carId },
                  {
                    carListing: {
                      brandNorm: car.brandNorm || normalizeBrand(car.brand),
                      modelNorm: car.modelNorm || normalizeModel(car.model),
                      year: car.year,
                      mileageKm: {
                        gte: car.mileageKm - 2000,
                        lte: car.mileageKm + 2000
                      }
                    }
                  }
                ]
              }
            });
            if (alreadySent) continue;

            await prisma.sentListing
              .create({ data: { userId: alert.userId, carId } })
              .catch(() => {});
          }

          const currentGroup = userAlertMatches.get(alert.userId) || {
            telegramId: Number(alert.telegramId),
            cars: [],
            alertId: alert.id,
            isPerfect: []
          };

          if (currentGroup.cars.some(c => areNearDuplicates(c, car))) {
            continue;
          }

          if (currentGroup.cars.length < 3) {
            currentGroup.cars.push(car);
            currentGroup.isPerfect.push(isPerfect);
            userAlertMatches.set(alert.userId, currentGroup);
          }
        }
      }
    }

    for (const [userId, group] of userAlertMatches.entries()) {
      try {
        let msg = `🚨 ${htmlBold('New Listings Found!')} 🚨\n\n`;

        for (let index = 0; index < group.cars.length; index++) {
          const car = group.cars[index]!;
          msg += await renderCarBlock(car, index, group.isPerfect[index] === true);
        }

        msg += `💡 You can ask me to analyze or compare these deals for you in the chat!`;

        await queueService.enqueue(group.telegramId, msg);
        console.log(`✅ [Matching] Batch of ${group.cars.length} alerts queued for user ${group.telegramId}`);
      } catch (err: any) {
        console.error(`❌ Error notifying batch to user ${userId}:`, err.message);
      }
    }
  }

  static async sendNoStockNotice(telegramId: number, brand: string | null, model: string | null) {
    const brandName = brand || 'any brand';
    const modelName = model ? ` ${model}` : '';
    const msg =
      `ℹ️ ${htmlBold('Radar Activated')}\n\n` +
      `We couldn't find an exact match for ${htmlBold(`${brandName}${modelName}`)} in our current inventory.\n\n` +
      `👍 Your 24/7 radar is now active! I'll notify you here the second our system finds a compatible offer.\n\n` +
      `🤖 ${htmlItalic('In the meantime, feel free to use the chat to ask our AI for comparisons with other models or for mechanical advice.')}`;
    await queueService.enqueue(telegramId, msg);
  }

  /**
   * After VIP filters are saved: if they changed vs previous alert, wipe this user's
   * pending Redis digests and seed the queue from current inventory with the new rules.
   */
  static async replaceFiltersAndResyncQueue(params: {
    userId: string;
    telegramId: number;
    previous: AlertFingerprintInput | null;
    next: AlertFingerprintInput;
  }): Promise<{ changed: boolean }> {
    const { invalidateAlertIndexCache } = await import('./inventory.service.js');
    await invalidateAlertIndexCache();

    const changed =
      !params.previous ||
      alertFingerprint(params.previous) !== alertFingerprint(params.next);

    if (!changed) {
      console.log(
        `ℹ️ [Matching] Filters unchanged for user ${params.telegramId} — Redis queue kept.`
      );
      return { changed: false };
    }

    await queueService.clearUserQueue(params.telegramId);
    console.log(
      `🧹 [Matching] Filters changed for user ${params.telegramId} — Redis queue cleared.`
    );

    await this.seedDigestForUser(params.userId, params.telegramId);
    await queueService.scheduleFirstDeliveryAfterFilterChange(params.telegramId);
    return { changed: true };
  }

  /**
   * Pull matching inventory for a user, newest (`updatedAt`) first, then older.
   *
   * Refill mode (scheduled digests):
   *   1) Unsent matches (new stock first).
   *   2) If fewer than 3 — recycle already-sent matches (oldest last-sent first)
   *      so the radar never goes silent while inventory still matches filters.
   *
   * Filter-change mode: unsent only (same as before).
   */
  static async seedDigestForUser(
    userId: string,
    telegramId: number,
    options?: { mode?: 'filter-change' | 'refill' }
  ): Promise<{ enqueued: boolean; cars: number }> {
    const mode = options?.mode ?? 'filter-change';
    const alertRow = await prisma.userAlert.findFirst({
      where: { userId },
      include: { user: { select: { telegramId: true } } }
    });
    if (!alertRow) return { enqueued: false, cars: 0 };

    const alert = mapAlert(alertRow);
    const { buildInventoryWhereClause } = await import('./inventory.service.js');

    // Specs matched in-memory via catalog (same as digests) — not raw SQL tokens
    const where = buildInventoryWhereClause(alert.brand, alert.model, null);
    // Hard numeric / country only in SQL (same caps as UI). Fuel/engine/power/specs → carMatchesAlert.
    if (alert.countries.length > 0) {
      (where as any).countryOfOrigin = { in: alert.countries };
    }
    if (alert.maxPrice != null) {
      (where as any).price = { lte: alert.maxPrice };
    }
    if (alert.minYear != null) {
      (where as any).year = { gte: alert.minYear };
    }
    if (alert.maxMileageKm != null) {
      (where as any).mileageKm = { lte: alert.maxMileageKm };
    }

    const defaultScan = mode === 'refill' ? 500 : alert.versions.length > 0 ? 120 : 80;
    const scanLimit = Math.min(
      2000,
      Math.max(50, parseInt(process.env.DIGEST_INVENTORY_SCAN || String(defaultScan), 10) || defaultScan)
    );

    const picked: { car: CarListing; isPerfect: boolean; recycled: boolean }[] = [];
    let skippedAsSent = 0;

    const tryPick = (car: CarListing, opts: { allowSent: boolean; recycled: boolean }) => {
      if (picked.length >= 3) return;
      if (!carMatchesAlert(car, alert)) return;
      // Never deliver until URL probe set urlVerifiedAt (any portal)
      if (!car.urlVerifiedAt) return;
      const { isPerfect, isWithinTolerance } = evaluateTolerance(car, alert);
      if (!isWithinTolerance) return;
      if (picked.some((p) => areNearDuplicates(p.car, car))) return;
      if (picked.some((p) => p.car.id && car.id && p.car.id === car.id)) return;
      picked.push({ car, isPerfect, recycled: opts.recycled });
    };

    // ── Pass 1: never-sent, newest first ────────────────────────────────────
    const fresh = await prisma.carListing.findMany({
      where: {
        ...where,
        NOT: { sentListings: { some: { userId } } }
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: scanLimit
    });

    for (const car of fresh) {
      const carId = car.id as string | undefined;
      if (carId) {
        const nearSent = await prisma.sentListing.findFirst({
          where: {
            userId,
            carListing: {
              brandNorm: car.brandNorm || normalizeBrand(car.brand),
              modelNorm: car.modelNorm || normalizeModel(car.model),
              year: car.year,
              mileageKm: {
                gte: car.mileageKm - 2000,
                lte: car.mileageKm + 2000
              }
            }
          }
        });
        if (nearSent) {
          skippedAsSent += 1;
          continue;
        }
      }
      tryPick(car, { allowSent: false, recycled: false });
      if (picked.length >= 3) break;
    }

    // ── Pass 2 (refill only): recycle already-sent so digests never stall ───
    let recycledCount = 0;
    if (mode === 'refill' && picked.length < 3) {
      const previouslySent = await prisma.sentListing.findMany({
        where: {
          userId,
          carListing: where
        },
        orderBy: { sentAt: 'asc' },
        take: scanLimit,
        include: { carListing: true }
      });

      for (const row of previouslySent) {
        tryPick(row.carListing as CarListing, { allowSent: true, recycled: true });
        if (picked.length >= 3) break;
      }
      recycledCount = picked.filter((p) => p.recycled).length;
    }

    if (picked.length === 0) {
      if (mode === 'refill') {
        return { enqueued: false, cars: 0 };
      }
      if (skippedAsSent > 0) {
        await queueService.enqueue(
          telegramId,
          `✅ ${htmlBold('Radar updated')}\n\nYour new filters are active. I'll alert you when <b>fresh</b> matching listings appear (skipping ads you already received).`
        );
        return { enqueued: true, cars: 0 };
      }
      await this.sendNoStockNotice(telegramId, alert.brand, alert.model);
      return { enqueued: true, cars: 0 };
    }

    const allRecycled = recycledCount > 0 && recycledCount === picked.length;
    let msg = allRecycled
      ? `🔁 ${htmlBold('Matching listings (from your radar stock)')} 🔁\n\n`
      : `🚨 ${htmlBold('New Listings Found!')} 🚨\n\n`;

    for (let index = 0; index < picked.length; index++) {
      const { car, isPerfect } = picked[index]!;
      msg += await renderCarBlock(car, index, isPerfect);

      if (car.id) {
        await prisma.sentListing
          .upsert({
            where: {
              userId_carId: { userId, carId: car.id }
            },
            create: { userId, carId: car.id },
            update: { sentAt: new Date() }
          })
          .catch(() => {});
      }
    }
    msg += `💡 You can ask me to analyze or compare these deals for you in the chat!`;

    await queueService.enqueue(telegramId, msg);
    console.log(
      `✅ [Matching] ${mode === 'refill' ? 'Refilled' : 'Seeded'} ${picked.length} car(s) ` +
        `for user ${telegramId} (fresh first` +
        (recycledCount ? `, recycled ${recycledCount}` : '') +
        `).`
    );
    return { enqueued: true, cars: picked.length };
  }

  /** When a digest is due and Redis has nothing: fresh unsent first, then recycle sent. */
  static async refillDigestFromInventory(telegramId: number): Promise<boolean> {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true }
    });
    if (!user) return false;
    const result = await this.seedDigestForUser(user.id, telegramId, { mode: 'refill' });
    return result.enqueued && result.cars > 0;
  }
}

export type AlertFingerprintInput = {
  brandNorm?: string | null;
  modelNorm?: string | null;
  versions?: string[] | null;
  maxPrice?: number | null;
  minYear?: number | null;
  maxMileageKm?: number | null;
  fuelTypes?: string[] | null;
  countries?: string[] | null;
  engines?: string[] | null;
  minPowerHp?: number | null;
};

export function alertFingerprint(a: AlertFingerprintInput): string {
  return JSON.stringify({
    b: a.brandNorm ?? null,
    m: a.modelNorm ?? null,
    v: [...(a.versions ?? [])].map(s => s.toLowerCase()).sort(),
    p: a.maxPrice ?? null,
    y: a.minYear ?? null,
    k: a.maxMileageKm ?? null,
    f: [...(a.fuelTypes ?? [])].map(s => s.toLowerCase()).sort(),
    c: [...(a.countries ?? [])].map(s => s.toUpperCase()).sort(),
    e: [...(a.engines ?? [])].map(s => s.toLowerCase()).sort(),
    hp: a.minPowerHp ?? null
  });
}
