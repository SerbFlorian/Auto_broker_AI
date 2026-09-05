/**
 * "Is this actually a deal?" — the number a broker would look up before calling a seller.
 *
 * Baseline = median asking price of comparable rows already in our inventory
 * (same brand + model, year ±1, and — when the sample allows it — a similar mileage band).
 * Medians, not averages, so one absurd listing cannot move the reference.
 *
 * Everything is cached, so adding the score to a digest costs at most one query
 * per brand/model/year slice every 30 minutes.
 */
import { prisma } from '../db/prisma.js';
import { cacheGetOrSet } from './cache.service.js';
import { normalizeBrand, normalizeModel } from '../utils/normalizer.js';

const BASELINE_TTL_SECONDS = 30 * 60;
/** Below this many comparable listings the median is noise, so we stay silent. */
const MIN_SAMPLE = 6;
/** Ignore differences smaller than this — inside the noise of asking prices. */
const MIN_REPORTABLE_PCT = 5;

export interface MarketBaseline {
  median: number;
  sample: number;
}

export interface DealScore {
  /** Positive = cheaper than the market median, negative = more expensive. */
  pct: number;
  median: number;
  sample: number;
  label: string;
}

type ScoreInput = {
  brand: string;
  model: string;
  brandNorm?: string | null;
  modelNorm?: string | null;
  year: number;
  mileageKm: number;
  price: number;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export async function getMarketSample(
  brandNorm: string,
  modelNorm: string,
  year: number
): Promise<{ price: number; mileageKm: number }[]> {
  const key = `deal:sample:${brandNorm}:${modelNorm}:${year}`;
  return cacheGetOrSet(key, BASELINE_TTL_SECONDS, async () => {
    const rows = await prisma.carListing.findMany({
      where: {
        brandNorm,
        modelNorm,
        year: { gte: year - 1, lte: year + 1 },
        price: { gt: 0 }
      },
      select: { price: true, mileageKm: true },
      take: 300
    });
    return rows;
  });
}

export async function computeDealScore(car: ScoreInput): Promise<DealScore | null> {
  if (!car.price || car.price <= 0) return null;

  const brandNorm = car.brandNorm || normalizeBrand(car.brand);
  const modelNorm = car.modelNorm || normalizeModel(car.model);

  let sample: { price: number; mileageKm: number }[];
  try {
    sample = await getMarketSample(brandNorm, modelNorm, car.year);
  } catch {
    return null;
  }

  if (sample.length < MIN_SAMPLE) return null;

  // Prefer a mileage-comparable subset; fall back to the whole year slice.
  const band = Math.max(20_000, car.mileageKm * 0.25);
  const comparable = sample.filter((r) => Math.abs(r.mileageKm - car.mileageKm) <= band);
  const used = comparable.length >= MIN_SAMPLE ? comparable : sample;

  const ref = median(used.map((r) => r.price));
  if (ref <= 0) return null;

  const pct = Math.round(((ref - car.price) / ref) * 100);
  if (Math.abs(pct) < MIN_REPORTABLE_PCT) {
    return { pct, median: ref, sample: used.length, label: 'around market price' };
  }

  const label =
    pct > 0
      ? `${pct}% below market (${used.length} similar ads)`
      : `${Math.abs(pct)}% above market (${used.length} similar ads)`;

  return { pct, median: ref, sample: used.length, label };
}

/** One-line digest badge, or null when there is not enough data to be honest about it. */
export async function dealScoreBadge(car: ScoreInput): Promise<string | null> {
  const score = await computeDealScore(car);
  if (!score) return null;
  if (Math.abs(score.pct) < MIN_REPORTABLE_PCT) return `📊 Around market price`;
  if (score.pct >= 20) return `🔥 Deal score: ${score.label}`;
  if (score.pct > 0) return `📉 Deal score: ${score.label}`;
  return `📈 Deal score: ${score.label}`;
}
