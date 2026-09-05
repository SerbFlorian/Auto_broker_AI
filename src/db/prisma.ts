import { PrismaClient } from '../generated/prisma/index.js';
import {
  normalizeFuelType,
  normalizeTransmission,
  normalizeBrand,
  normalizeModel,
  extractVersionTokens
} from '../utils/normalizer.js';
import { resolveEngineFromVersion, normalizeEngineKey } from '../services/engineCatalog.service.js';
import { parsePowerCv } from '../utils/power.js';

export const prisma = new PrismaClient();

function applyListingNorms(data: any) {
  if (!data) return;

  if (typeof data.fuelType === 'string') {
    data.fuelType = normalizeFuelType(data.fuelType);
  } else if (data.fuelType && typeof data.fuelType.set === 'string') {
    data.fuelType.set = normalizeFuelType(data.fuelType.set);
  }

  if (typeof data.transmission === 'string') {
    data.transmission = normalizeTransmission(data.transmission);
  } else if (data.transmission && typeof data.transmission.set === 'string') {
    data.transmission.set = normalizeTransmission(data.transmission.set);
  }

  if (typeof data.brand === 'string') {
    data.brandNorm = normalizeBrand(data.brand);
  } else if (data.brand && typeof data.brand.set === 'string') {
    data.brandNorm = normalizeBrand(data.brand.set);
  }

  if (typeof data.model === 'string') {
    data.modelNorm = normalizeModel(data.model);
  } else if (data.model && typeof data.model.set === 'string') {
    data.modelNorm = normalizeModel(data.model.set);
  }

  if (typeof data.version === 'string') {
    data.versionTokens = extractVersionTokens(data.version);
  } else if (data.version && typeof data.version.set === 'string') {
    data.versionTokens = extractVersionTokens(data.version.set);
  } else if (data.version === null || data.version?.set === null) {
    data.versionTokens = [];
  }

  if (typeof data.engine === 'string' && data.engine.trim()) {
    data.engineNorm = normalizeEngineKey(data.engine);
  }

  // Derive engine + CV from version when the writer did not set them.
  const brand = typeof data.brand === 'string' ? data.brand : data.brandNorm;
  const model = typeof data.model === 'string' ? data.model : data.modelNorm;
  const version =
    typeof data.version === 'string'
      ? data.version
      : typeof data.version?.set === 'string'
        ? data.version.set
        : null;
  const needsEngine = !data.engineNorm && !data.engine;
  const rawPower =
    typeof data.powerHp === 'number'
      ? data.powerHp
      : typeof data.powerHp?.set === 'number'
        ? data.powerHp.set
        : null;
  const needsPower = !rawPower || rawPower <= 0;

  if ((needsEngine || needsPower) && brand && model) {
    const match = resolveEngineFromVersion({
      brand,
      model,
      version,
      existingPowerHp: rawPower
    });
    if (match) {
      if (needsEngine && match.engineNorm) {
        data.engine = match.engine;
        data.engineNorm = match.engineNorm;
      }
      if (needsPower) {
        const explicit = parsePowerCv(version);
        if (explicit) {
          data.powerHp = explicit;
        } else if (match.source === 'catalog' && match.powerCv) {
          data.powerHp = match.powerCv;
        }
      }
    }
  }

  if (typeof data.powerHp === 'number' && data.powerHp > 0) {
    // Normalise accidental kW-sized values left by old parsers (< 40 is rare as CV for cars we care about
    // but kW figures like 70 are common — if version says kW we already converted; leave as-is).
  }
}

prisma.$use(async (params: any, next: any) => {
  if (params.model === 'CarListing') {
    if (params.action === 'create' || params.action === 'update' || params.action === 'upsert') {
      if (params.action === 'create') {
        applyListingNorms(params.args.data);
      } else if (params.action === 'update') {
        applyListingNorms(params.args.data);
      } else if (params.action === 'upsert') {
        applyListingNorms(params.args.create);
        applyListingNorms(params.args.update);
      }
    }
  }
  return next(params);
});

const BACKFILL_BATCH = 500;

function sameTokenList(a: string[] | null | undefined, b: string[]): boolean {
  const left = [...(a ?? [])].map((t) => t.toLowerCase()).sort();
  const right = [...b].map((t) => t.toLowerCase()).sort();
  if (left.length !== right.length) return false;
  return left.every((t, i) => t === right[i]);
}

/**
 * Heals brandNorm / modelNorm / versionTokens.
 * - BACKFILL_NORMS=true: full re-normalize (folds accents e.g. León→leon)
 * - BACKFILL_VERSION_TOKENS≠false: heal empty versionTokens when version has text
 */
export async function backfillListingNorms(options?: {
  includeEmptyNorms?: boolean;
  includeEmptyTokens?: boolean;
}): Promise<number> {
  const includeEmptyNorms =
    options?.includeEmptyNorms ?? process.env.BACKFILL_NORMS === 'true';
  const includeEmptyTokens =
    options?.includeEmptyTokens ??
    process.env.BACKFILL_VERSION_TOKENS !== 'false';

  if (!includeEmptyNorms && !includeEmptyTokens) return 0;

  let updated = 0;
  let cursor: string | undefined;

  for (;;) {
    const batch = await prisma.carListing.findMany({
      take: BACKFILL_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        brand: true,
        model: true,
        version: true,
        brandNorm: true,
        modelNorm: true,
        versionTokens: true
      }
    });

    if (batch.length === 0) break;

    for (const row of batch) {
      const nextBrand = normalizeBrand(row.brand);
      const nextModel = normalizeModel(row.model);
      const nextTokens = extractVersionTokens(row.version);

      const normsOutOfDate =
        row.brandNorm !== nextBrand || row.modelNorm !== nextModel;
      // Full norm rewrite when BACKFILL_NORMS=true, or always when aliases/canonical keys drift
      const shouldWriteNorms = includeEmptyNorms || normsOutOfDate;
      const tokensChangedFull =
        includeEmptyNorms && !sameTokenList(row.versionTokens, nextTokens);
      const tokensEmptyHeal =
        includeEmptyTokens &&
        (row.versionTokens?.length ?? 0) === 0 &&
        !!row.version?.trim() &&
        nextTokens.length > 0;

      if (!shouldWriteNorms && !tokensChangedFull && !tokensEmptyHeal) continue;

      await prisma.carListing.update({
        where: { id: row.id },
        data: {
          ...(shouldWriteNorms
            ? { brandNorm: nextBrand, modelNorm: nextModel }
            : {}),
          ...(tokensChangedFull || tokensEmptyHeal
            ? { versionTokens: nextTokens }
            : {})
        }
      });
      updated++;
    }

    cursor = batch[batch.length - 1]!.id;
    if (batch.length < BACKFILL_BATCH) break;
  }

  if (includeEmptyNorms) {
    updated += await backfillAlertNorms();
  }

  return updated;
}

/** Fold accents on saved VIP alert brandNorm/modelNorm. */
async function backfillAlertNorms(): Promise<number> {
  const alerts = await prisma.userAlert.findMany({
    select: { id: true, brand: true, model: true, brandNorm: true, modelNorm: true }
  });
  let n = 0;
  for (const a of alerts) {
    const brandNorm = a.brand
      ? normalizeBrand(a.brand)
      : normalizeBrand(a.brandNorm) || '';
    const modelNorm = a.model
      ? normalizeModel(a.model)
      : normalizeModel(a.modelNorm) || '';
    const nextBrand = brandNorm || null;
    const nextModel = modelNorm || null;
    if (nextBrand === (a.brandNorm || null) && nextModel === (a.modelNorm || null)) {
      continue;
    }
    await prisma.userAlert.update({
      where: { id: a.id },
      data: {
        brandNorm: nextBrand,
        modelNorm: nextModel
      }
    });
    n++;
  }
  return n;
}
