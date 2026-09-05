/**
 * Convert mislabeled local-currency prices to EUR for non-euro countries.
 *
 * For rows with priceNative IS NULL in a non-EUR country:
 * - If the number already looks like EUR → mark as EUR, do NOT convert.
 * - If it looks like local currency → convert to EUR and store the original.
 *
 * Also repairs earlier bad FX (priceNative set, price absurdly low, native looks like EUR).
 */
import { prisma } from '../db/prisma.js';
import {
  convertToEur,
  currencyForCountry,
  nonEurCountryCodes,
  PLAUSIBLE_EUR_MAX,
  PLAUSIBLE_EUR_MIN,
  priceLooksLikeAlreadyEur
} from '../utils/currency.js';
import { getEurFxRates } from './fx.service.js';
import { cacheDelByPrefix } from './cache.service.js';

export type PriceFxStats = {
  scanned: number;
  converted: number;
  alreadyEur: number;
  repaired: number;
  skipped: number;
  failed: number;
  fxDate: string;
};

const DEFAULT_LIMIT = 5000;

export async function runPriceFxCycle(options?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<PriceFxStats> {
  const limit = Math.max(
    1,
    options?.limit ??
      (parseInt(process.env.PRICE_FX_LIMIT || String(DEFAULT_LIMIT), 10) ||
        DEFAULT_LIMIT)
  );
  const dryRun = Boolean(options?.dryRun);
  const countries = nonEurCountryCodes();

  const ratesPayload = await getEurFxRates();
  const stats: PriceFxStats = {
    scanned: 0,
    converted: 0,
    alreadyEur: 0,
    repaired: 0,
    skipped: 0,
    failed: 0,
    fxDate: ratesPayload.date
  };

  // ── Repair previously over-converted rows (e.g. 13066 HUF → €36) ─────────
  const broken = await prisma.carListing.findMany({
    where: {
      countryOfOrigin: { in: countries },
      priceNative: { not: null },
      NOT: { priceCurrency: 'EUR' },
      price: { lt: PLAUSIBLE_EUR_MIN }
    },
    select: {
      id: true,
      price: true,
      priceNative: true,
      priceCurrency: true,
      brand: true,
      model: true,
      countryOfOrigin: true
    },
    take: limit
  });

  for (const row of broken) {
    const native = row.priceNative;
    if (native == null) continue;
    // Only restore when the stored native looks like a normal EUR sticker price
    if (native < PLAUSIBLE_EUR_MIN || native > PLAUSIBLE_EUR_MAX) continue;

    console.warn(
      `🔧 [PriceFX] Repair ${row.brand} ${row.model} (${row.countryOfOrigin}): ` +
        `€${row.price} ← restore €${Math.round(native)} (was marked ${row.priceCurrency})`
    );
    if (!dryRun) {
      await prisma.carListing.update({
        where: { id: row.id },
        data: {
          price: Math.round(native),
          priceNative: Math.round(native),
          priceCurrency: 'EUR'
        }
      });
    }
    stats.repaired++;
  }

  // ── Pending rows (never FX'd) ────────────────────────────────────────────
  const rows = await prisma.carListing.findMany({
    where: {
      countryOfOrigin: { in: countries },
      priceNative: null,
      price: { gt: 0 }
    },
    select: {
      id: true,
      price: true,
      countryOfOrigin: true,
      brand: true,
      model: true
    },
    take: limit,
    orderBy: { updatedAt: 'desc' }
  });

  stats.scanned = rows.length;
  if (rows.length === 0 && stats.repaired === 0) {
    console.log('💱 [PriceFX] No pending non-EUR rows to convert.');
    return stats;
  }

  if (rows.length > 0) {
    console.log(
      `💱 [PriceFX] Reviewing up to ${rows.length} listings (FX ${ratesPayload.date})${
        dryRun ? ' [dry-run]' : ''
      }...`
    );
  }

  for (const row of rows) {
    const ccy = currencyForCountry(row.countryOfOrigin);
    if (!ccy) {
      stats.skipped++;
      continue;
    }
    if (!(ccy in ratesPayload.rates) && ccy !== 'EUR') {
      stats.failed++;
      console.warn(
        `⚠️ [PriceFX] No rate for ${ccy} (${row.countryOfOrigin}) — skip ${row.id}`
      );
      continue;
    }

    // Already EUR on a non-euro country listing → mark only, do not convert
    if (priceLooksLikeAlreadyEur(row.price, ccy, ratesPayload.rates)) {
      if (!dryRun) {
        await prisma.carListing.update({
          where: { id: row.id },
          data: {
            priceNative: row.price,
            priceCurrency: 'EUR'
            // price unchanged
          }
        });
      }
      stats.alreadyEur++;
      continue;
    }

    const eur = convertToEur(row.price, ccy, ratesPayload.rates);
    if (eur == null || !Number.isFinite(eur) || eur <= 0) {
      stats.failed++;
      continue;
    }

    const priceEur = Math.round(eur);
    if (priceEur < PLAUSIBLE_EUR_MIN || priceEur > PLAUSIBLE_EUR_MAX) {
      // Safety net: treat as already EUR instead of writing garbage
      if (!dryRun) {
        await prisma.carListing.update({
          where: { id: row.id },
          data: {
            priceNative: row.price,
            priceCurrency: 'EUR'
          }
        });
      }
      stats.alreadyEur++;
      console.warn(
        `⚠️ [PriceFX] FX would yield €${priceEur} from ${row.price} ${ccy} ` +
          `(${row.brand} ${row.model}) — keeping as EUR.`
      );
      continue;
    }

    if (dryRun) {
      stats.converted++;
      continue;
    }

    try {
      await prisma.carListing.update({
        where: { id: row.id },
        data: {
          priceNative: row.price,
          priceCurrency: ccy,
          price: priceEur
        }
      });
      stats.converted++;
    } catch (err) {
      stats.failed++;
      console.warn(
        `⚠️ [PriceFX] Update failed ${row.id}: ${(err as Error).message}`
      );
    }
  }

  if (!dryRun && (stats.converted > 0 || stats.alreadyEur > 0 || stats.repaired > 0)) {
    try {
      await cacheDelByPrefix('inv:');
      await cacheDelByPrefix('deal:');
    } catch {
      /* ignore */
    }
  }

  console.log(
    `💱 [PriceFX] Done — scanned ${stats.scanned}, converted ${stats.converted}, ` +
      `already EUR ${stats.alreadyEur}, repaired ${stats.repaired}, ` +
      `skipped ${stats.skipped}, failed ${stats.failed} (FX ${stats.fxDate}).`
  );
  return stats;
}
