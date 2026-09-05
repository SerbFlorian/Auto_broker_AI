/**
 * One-shot / boot-safe cleanup of CarListing duplicates.
 *
 * 1) Exact originalUrl collisions (after normalize)
 * 2) Near-duplicates: same brand/model/year, ±1k km, ±5% price
 *
 * Keeps preferred source: clicars > ooyyo > theparking > wallapop.
 * SentListing rows cascade on delete.
 *
 * Usage: npx tsx scripts/dedupe-listings.ts
 * Boot:  Dockerfile runs this before `prisma db push` so @unique originalUrl can apply.
 */
import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import {
  areNearDuplicates,
  normalizeOriginalUrl,
  pickPreferredListing,
  type ListingLike
} from '../src/services/listingDedup.service.js';

type Row = ListingLike & {
  id: string;
  portalId: string;
  sourcePortal: string;
  updatedAt: Date;
};

async function main() {
  console.log('🧹 [Dedup] Loading listings…');
  const rows = (await prisma.carListing.findMany({
    select: {
      id: true,
      portalId: true,
      sourcePortal: true,
      brand: true,
      model: true,
      brandNorm: true,
      modelNorm: true,
      year: true,
      mileageKm: true,
      price: true,
      originalUrl: true,
      powerHp: true,
      updatedAt: true
    }
  })) as Row[];

  console.log(`🧹 [Dedup] Loaded ${rows.length} rows.`);

  const deleteIds = new Set<string>();
  const urlNormalizeUpdates: { id: string; originalUrl: string }[] = [];

  // ── 1) Normalize URLs + exact URL groups ──
  const byUrl = new Map<string, Row[]>();
  for (const row of rows) {
    const url = normalizeOriginalUrl(row.originalUrl);
    if (url !== row.originalUrl) {
      urlNormalizeUpdates.push({ id: row.id, originalUrl: url });
      row.originalUrl = url;
    }
    if (!url) continue;
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url)!.push(row);
  }

  let urlDupGroups = 0;
  for (const group of byUrl.values()) {
    if (group.length < 2) continue;
    urlDupGroups++;
    let keep = group[0]!;
    for (let i = 1; i < group.length; i++) {
      keep = pickPreferredListing(keep, group[i]!) as Row;
    }
    for (const r of group) {
      if (r.id !== keep.id) deleteIds.add(r.id);
    }
  }

  // ── 2) Near-dup greedy pass (skip already doomed) ──
  const survivors = rows.filter(r => !deleteIds.has(r.id));
  survivors.sort((a, b) => {
    const pref = pickPreferredListing(a, b);
    if (pref.id === a.id) return -1;
    if (pref.id === b.id) return 1;
    return 0;
  });

  const kept: Row[] = [];
  let nearDupCount = 0;
  for (const row of survivors) {
    const hit = kept.find(k => areNearDuplicates(k, row));
    if (hit) {
      const winner = pickPreferredListing(hit, row) as Row;
      if (winner.id === row.id) {
        deleteIds.add(hit.id);
        kept.splice(kept.indexOf(hit), 1);
        kept.push(row);
      } else {
        deleteIds.add(row.id);
      }
      nearDupCount++;
      continue;
    }
    kept.push(row);
  }

  // Apply URL normalizations for rows we keep (avoid unique clashes)
  let urlFixed = 0;
  for (const u of urlNormalizeUpdates) {
    if (deleteIds.has(u.id)) continue;
    // If another kept row already has this URL, drop this one instead
    const clash = kept.find(
      k => k.id !== u.id && normalizeOriginalUrl(k.originalUrl) === u.originalUrl
    );
    if (clash) {
      deleteIds.add(u.id);
      continue;
    }
    try {
      await prisma.carListing.update({
        where: { id: u.id },
        data: { originalUrl: u.originalUrl }
      });
      urlFixed++;
    } catch {
      deleteIds.add(u.id);
    }
  }

  const ids = Array.from(deleteIds);
  console.log(
    `🧹 [Dedup] URL dup groups=${urlDupGroups}, near-dup decisions=${nearDupCount}, ` +
      `URL normalized=${urlFixed}, deleting=${ids.length}`
  );

  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    await prisma.carListing.deleteMany({ where: { id: { in: slice } } });
  }

  const remaining = await prisma.carListing.count();
  console.log(`✅ [Dedup] Done. Remaining listings: ${remaining}`);
}

main()
  .catch(err => {
    console.error('❌ [Dedup] Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
