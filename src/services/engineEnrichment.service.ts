/**
 * Backfill CarListing.engine / engineNorm / powerHp from version text + engine-catalog.json.
 * Safe to re-run: never overwrites a good non-empty engineNorm or a positive powerHp.
 * Does rewrite bogus norms like "0 tfsi" (bad parse of "30 TFSI").
 */
import { prisma } from '../db/prisma.js';
import {
  formatEngineLabel,
  normalizeEngineKey,
  resolveEngineFromVersion
} from './engineCatalog.service.js';
import { parsePowerCv } from '../utils/power.js';

const BATCH = 200;

function isBogusZeroFamilyNorm(norm: string | null | undefined): boolean {
  if (!norm) return false;
  return /^0(?:\.0)?\s+\S/i.test(norm.trim());
}

export interface EnrichmentStats {
  scanned: number;
  engineSet: number;
  powerSet: number;
}

export async function enrichListingsFromVersion(opts?: {
  onlyMissingEngine?: boolean;
  fillPower?: boolean;
  limit?: number;
}): Promise<EnrichmentStats> {
  const onlyMissingEngine = opts?.onlyMissingEngine !== false;
  const fillPower = opts?.fillPower !== false;
  const limit = Math.max(1, opts?.limit ?? 5000);

  let scanned = 0;
  let engineSet = 0;
  let powerSet = 0;
  let cursor: string | undefined;

  while (scanned < limit) {
    const take = Math.min(BATCH, limit - scanned);
    const batch = await prisma.carListing.findMany({
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      where: onlyMissingEngine
        ? {
            OR: [
              { engineNorm: '' },
              { engineNorm: { startsWith: '0 ' } },
              { engineNorm: { startsWith: '0.0 ' } },
              { powerHp: null },
              { powerHp: 0 }
            ]
          }
        : undefined,
      select: {
        id: true,
        brand: true,
        model: true,
        version: true,
        engineNorm: true,
        powerHp: true
      }
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    for (const row of batch) {
      scanned++;
      const match = resolveEngineFromVersion({
        brand: row.brand,
        model: row.model,
        version: row.version,
        existingPowerHp: row.powerHp
      });

      const data: {
        engine?: string | null;
        engineNorm?: string;
        powerHp?: number | null;
      } = {};

      if (isBogusZeroFamilyNorm(row.engineNorm)) {
        if (match?.engineNorm && !isBogusZeroFamilyNorm(match.engineNorm)) {
          data.engine = match.engine;
          data.engineNorm = match.engineNorm;
        } else {
          data.engine = formatEngineLabel(row.engineNorm!);
          data.engineNorm = normalizeEngineKey(row.engineNorm!);
        }
        engineSet++;
      } else if (!row.engineNorm && match?.engineNorm) {
        data.engine = match.engine;
        data.engineNorm = match.engineNorm;
        engineSet++;
      }

      const needsPower = fillPower && (!row.powerHp || row.powerHp <= 0);
      if (needsPower) {
        const explicit = parsePowerCv(row.version);
        if (explicit) {
          data.powerHp = explicit;
          powerSet++;
        } else if (match?.source === 'catalog' && match.powerCv && match.powerCv > 0) {
          // Catalog CV is the official figure for that engine — good enough for filters.
          data.powerHp = match.powerCv;
          powerSet++;
        }
      }

      if (Object.keys(data).length === 0) continue;

      await prisma.carListing.update({
        where: { id: row.id },
        data
      });
    }
  }

  return { scanned, engineSet, powerSet };
}

export async function runEngineEnrichmentCycle(): Promise<void> {
  console.log('🔧 [EngineEnrich] Starting version → engine/CV pass...');
  try {
    const stats = await enrichListingsFromVersion({
      onlyMissingEngine: true,
      fillPower: true,
      limit: 8000
    });
    console.log(
      `🔧 [EngineEnrich] Done — scanned ${stats.scanned}, engine set ${stats.engineSet}, power set ${stats.powerSet}.`
    );
  } catch (err) {
    console.error('❌ [EngineEnrich] Failed:', err);
    try {
      const { notifyAdminCritical } = await import('../utils/adminNotify.js');
      await notifyAdminCritical(
        `⚠️ **Engine enrichment crash**\n\n${(err as Error).message || err}`
      );
    } catch {
      /* ignore */
    }
  }
}
