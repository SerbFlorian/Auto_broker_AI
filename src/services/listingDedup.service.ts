import { prisma } from '../db/prisma.js';
import { normalizeBrand, normalizeModel } from '../utils/normalizer.js';

/** Mileage window for “same car” (± km). */
export const NEAR_DUP_MILEAGE_TOLERANCE = 1000;
/** Price window for “same car” (± fraction). */
export const NEAR_DUP_PRICE_TOLERANCE = 0.05;

const SOURCE_RANK: Record<string, number> = {
  clicars: 0,
  ooyyo: 1,
  theparking: 2,
  wallapop: 3
};

export type ListingLike = {
  id?: string;
  portalId?: string;
  sourcePortal?: string;
  brand: string;
  model: string;
  brandNorm?: string | null;
  modelNorm?: string | null;
  year: number;
  mileageKm: number;
  price: number;
  originalUrl: string;
  powerHp?: number | null;
  updatedAt?: Date;
};

export type SaveListingResult =
  | 'created'
  | 'updated'
  | 'skipped_portal'
  | 'skipped_url'
  | 'skipped_near';

/**
 * Canonical listing URL: strip tracking noise so the same ad maps to one key.
 */
export function normalizeOriginalUrl(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    const drop = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'msclkid'
    ];
    for (const k of drop) u.searchParams.delete(k);
    let path = u.pathname.replace(/\/+$/, '') || '/';
    u.pathname = path;
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    return u.toString();
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
}

export function listingNorms(car: ListingLike): { brandNorm: string; modelNorm: string } {
  return {
    brandNorm: car.brandNorm || normalizeBrand(car.brand),
    modelNorm: car.modelNorm || normalizeModel(car.model)
  };
}

/** True if two rows look like the same physical vehicle (cross-portal safe). */
export function areNearDuplicates(a: ListingLike, b: ListingLike): boolean {
  const na = listingNorms(a);
  const nb = listingNorms(b);
  if (na.brandNorm !== nb.brandNorm || na.modelNorm !== nb.modelNorm) return false;
  if (a.year !== b.year) return false;
  if (Math.abs(a.mileageKm - b.mileageKm) > NEAR_DUP_MILEAGE_TOLERANCE) return false;
  const mid = Math.max((a.price + b.price) / 2, 1);
  if (Math.abs(a.price - b.price) / mid > NEAR_DUP_PRICE_TOLERANCE) return false;
  return true;
}

/**
 * Keep first occurrence; drop later near-dups (and exact URL/portalId).
 * Prefer cheaper car when replacing within the kept set.
 */
export function dedupeListingsForDelivery<T extends ListingLike>(cars: T[]): T[] {
  const kept: T[] = [];
  const seenPortal = new Set<string>();
  const seenUrl = new Set<string>();

  for (const car of cars) {
    const url = normalizeOriginalUrl(car.originalUrl);
    if (car.portalId && seenPortal.has(car.portalId)) continue;
    if (url && seenUrl.has(url)) continue;

    const nearIdx = kept.findIndex(k => areNearDuplicates(k, car));
    if (nearIdx >= 0) {
      const existing = kept[nearIdx]!;
      if (car.price < existing.price) {
        kept[nearIdx] = car;
        if (existing.portalId) seenPortal.delete(existing.portalId);
        seenUrl.delete(normalizeOriginalUrl(existing.originalUrl));
        if (car.portalId) seenPortal.add(car.portalId);
        if (url) seenUrl.add(url);
      }
      continue;
    }

    kept.push(car);
    if (car.portalId) seenPortal.add(car.portalId);
    if (url) seenUrl.add(url);
  }

  return kept;
}

export async function findNearDuplicate(
  car: ListingLike,
  excludePortalId?: string
): Promise<{ id: string; portalId: string; originalUrl: string } | null> {
  const { brandNorm, modelNorm } = listingNorms(car);
  const priceMin = car.price * (1 - NEAR_DUP_PRICE_TOLERANCE);
  const priceMax = car.price * (1 + NEAR_DUP_PRICE_TOLERANCE);

  const candidates = await prisma.carListing.findMany({
    where: {
      brandNorm,
      modelNorm,
      year: car.year,
      mileageKm: {
        gte: car.mileageKm - NEAR_DUP_MILEAGE_TOLERANCE,
        lte: car.mileageKm + NEAR_DUP_MILEAGE_TOLERANCE
      },
      price: { gte: priceMin, lte: priceMax },
      ...(excludePortalId ? { NOT: { portalId: excludePortalId } } : {})
    },
    select: { id: true, portalId: true, originalUrl: true, brand: true, model: true, brandNorm: true, modelNorm: true, year: true, mileageKm: true, price: true },
    take: 8
  });

  for (const c of candidates) {
    if (areNearDuplicates(car, c)) {
      return { id: c.id, portalId: c.portalId, originalUrl: c.originalUrl };
    }
  }
  return null;
}

/**
 * How many OTHER rows look like the same physical car (typically the same ad
 * republished on another portal). Used to warn the user in digests so three
 * near-identical results never read as three different cars.
 */
export async function countNearDuplicates(
  car: ListingLike,
  excludeId?: string
): Promise<number> {
  const { brandNorm, modelNorm } = listingNorms(car);
  const priceMin = car.price * (1 - NEAR_DUP_PRICE_TOLERANCE);
  const priceMax = car.price * (1 + NEAR_DUP_PRICE_TOLERANCE);

  const candidates = await prisma.carListing.findMany({
    where: {
      brandNorm,
      modelNorm,
      year: car.year,
      mileageKm: {
        gte: car.mileageKm - NEAR_DUP_MILEAGE_TOLERANCE,
        lte: car.mileageKm + NEAR_DUP_MILEAGE_TOLERANCE
      },
      price: { gte: priceMin, lte: priceMax },
      ...(excludeId ? { NOT: { id: excludeId } } : {})
    },
    select: {
      id: true,
      brand: true,
      model: true,
      brandNorm: true,
      modelNorm: true,
      year: true,
      mileageKm: true,
      price: true,
      originalUrl: true,
      sourcePortal: true
    },
    take: 10
  });

  const portals = new Set<string>();
  for (const c of candidates) {
    if (areNearDuplicates(car, c)) portals.add(c.sourcePortal || c.id);
  }
  return portals.size;
}

/**
 * Single write path for scrapers: portalId / originalUrl / near-dup guards.
 * Same portalId → light price/km refresh. Cross-portal near-dup → skip.
 */
export async function saveListingIfNew(data: {
  portalId: string;
  sourcePortal: string;
  brand: string;
  model: string;
  version?: string | null;
  year: number;
  mileageKm: number;
  price: number;
  powerHp?: number | null;
  fuelType?: string | null;
  transmission?: string | null;
  sellerType?: string | null;
  countryOfOrigin: string;
  originalUrl: string;
  /** Set after a successful live URL probe. Omit / null → pending until UrlVerify cron. */
  urlVerifiedAt?: Date | null;
}): Promise<SaveListingResult> {
  const originalUrl = normalizeOriginalUrl(data.originalUrl);
  if (!originalUrl) return 'skipped_url';

  const verifiedAt =
    data.urlVerifiedAt !== undefined ? data.urlVerifiedAt : null;

  const existingPortal = await prisma.carListing.findUnique({
    where: { portalId: data.portalId },
    select: { id: true, originalUrl: true }
  });

  if (existingPortal) {
    const urlChanged = existingPortal.originalUrl !== originalUrl;
    await prisma.carListing.update({
      where: { id: existingPortal.id },
      data: {
        price: data.price,
        mileageKm: data.mileageKm,
        fuelType: data.fuelType ?? undefined,
        transmission: data.transmission ?? undefined,
        powerHp: data.powerHp ?? undefined,
        originalUrl,
        ...(data.urlVerifiedAt !== undefined
          ? { urlVerifiedAt: data.urlVerifiedAt }
          : urlChanged
            ? { urlVerifiedAt: null }
            : {})
      }
    });
    return 'updated';
  }

  const existingUrl = await prisma.carListing.findUnique({
    where: { originalUrl },
    select: { id: true, portalId: true }
  });
  if (existingUrl) {
    console.log(
      `🔁 [Dedup] Skip URL already in DB (${data.portalId} → kept ${existingUrl.portalId})`
    );
    return 'skipped_url';
  }

  const near = await findNearDuplicate({ ...data, originalUrl }, data.portalId);
  if (near) {
    console.log(
      `🔁 [Dedup] Skip near-duplicate ${data.brand} ${data.model} ${data.year} ` +
        `(${data.portalId} ≈ ${near.portalId})`
    );
    return 'skipped_near';
  }

  try {
    await prisma.carListing.create({
      data: {
        ...data,
        originalUrl,
        version: data.version ?? null,
        powerHp: data.powerHp ?? null,
        fuelType: data.fuelType ?? null,
        transmission: data.transmission ?? null,
        sellerType: data.sellerType ?? null,
        urlVerifiedAt: verifiedAt
      }
    });
    return 'created';
  } catch (err: any) {
    // Race on unique portalId / originalUrl
    if (err?.code === 'P2002') {
      console.log(`🔁 [Dedup] Unique race for ${data.portalId}: ${err.meta?.target}`);
      return 'skipped_url';
    }
    throw err;
  }
}

export function pickPreferredListing<T extends ListingLike>(a: T, b: T): T {
  const ra = SOURCE_RANK[a.sourcePortal || ''] ?? 99;
  const rb = SOURCE_RANK[b.sourcePortal || ''] ?? 99;
  if (ra !== rb) return ra < rb ? a : b;

  const pa = a.powerHp && a.powerHp > 0 ? 1 : 0;
  const pb = b.powerHp && b.powerHp > 0 ? 1 : 0;
  if (pa !== pb) return pa > pb ? a : b;

  if (a.price !== b.price) return a.price <= b.price ? a : b;

  const ta = a.updatedAt?.getTime() ?? 0;
  const tb = b.updatedAt?.getTime() ?? 0;
  return ta >= tb ? a : b;
}
