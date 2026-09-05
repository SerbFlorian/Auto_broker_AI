/**
 * Robust one-shot fuel backfill. NEVER deletes listings.
 *
 * ── Recommended for ~1300 false LPG ──
 *   1) Clear suspect LPG instantly → null (pending):
 *        npx tsx scripts/backfill-fuel.ts --mode=clear-lpg --apply
 *
 *   2) Re-fetch missing fuel (null / Unknown) from live pages:
 *        npx tsx scripts/backfill-fuel.ts --mode=refetch --target=missing --apply --fetchable-only
 *
 * Dry-run is the default (no --apply = no writes).
 *
 * Flags:
 *   --apply              Write changes
 *   --mode=clear-lpg|refetch
 *   --target=lpg|missing|all   (refetch only; default missing)
 *   --source=ooyyo|clicars|…   Optional portal filter
 *   --limit=N
 *   --delay-ms=3000
 *   --fetchable-only     Skip rows whose URL is not ooyyo/clicars
 *   --keep-on-fail       On HTTP/parse fail, leave row unchanged
 */
import 'dotenv/config';
import * as cheerio from 'cheerio';
import type { Prisma } from '../src/generated/prisma/index.js';
import { prisma } from '../src/db/prisma.js';
import { createHttpClient } from '../src/utils/httpClient.js';
import { normalizeFuelType } from '../src/utils/normalizer.js';
import { invalidateInventoryCache } from '../src/services/inventory.service.js';
import { refreshInventoryStats } from '../src/jobs/inventory-stats.job.js';

type Mode = 'clear-lpg' | 'refetch';
type Target = 'lpg' | 'missing' | 'all';

type Args = {
  apply: boolean;
  mode: Mode;
  target: Target;
  source: string | null;
  limit: number | null;
  delayMs: number;
  fetchableOnly: boolean;
  keepOnFail: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : undefined;
  };

  const modeRaw = (get('--mode') || 'refetch').toLowerCase();
  const mode: Mode = modeRaw === 'clear-lpg' ? 'clear-lpg' : 'refetch';

  const targetRaw = (get('--target') || 'missing').toLowerCase();
  const target: Target =
    targetRaw === 'lpg' || targetRaw === 'all' ? targetRaw : 'missing';

  const limitRaw = get('--limit');
  const delayRaw = get('--delay-ms');
  const sourceRaw = get('--source');

  return {
    apply: argv.includes('--apply'),
    mode,
    target,
    source: sourceRaw ? sourceRaw.trim().toLowerCase() : null,
    limit: limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 0) || null : null,
    delayMs: delayRaw ? Math.max(500, parseInt(delayRaw, 10) || 3000) : 3000,
    fetchableOnly: argv.includes('--fetchable-only'),
    keepOnFail: argv.includes('--keep-on-fail')
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isOoyyoUrl(url: string): boolean {
  try {
    return /(^|\.)ooyyo\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isClicarsUrl(url: string): boolean {
  try {
    return /(^|\.)clicars\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isFetchableUrl(url: string): boolean {
  return isOoyyoUrl(url) || isClicarsUrl(url);
}

function mapFuelLabel(raw: string): string | null {
  const t = raw.toLowerCase().trim().replace(/,/g, '');
  if (!t) return null;
  if (/diesel|di[eé]sel|gas[oó]leo|gasoleo|gasoil|tdi|hdi|dci/i.test(t)) return 'Diesel';
  if (/hybrid|h[ií]brid|phev|plug-?in/i.test(t)) return 'Hybrid';
  if (/electric|el[eé]ctric|elektro|elektrisch|\bev\b/i.test(t) || t === 'ev') {
    return 'Electric';
  }
  if (/petrol|gasoline|gasolina|benzin|essence|nafta|otto/i.test(t) || t === 'gas') {
    return 'Petrol';
  }
  if (
    /^(lpg|gpl|autogas|cng|gnc|glp)$/i.test(t) ||
    /\b(lpg|gpl|autogas|cng|gnc|glp)\b/i.test(t)
  ) {
    return 'LPG';
  }
  const n = normalizeFuelType(raw);
  return n === 'Unknown' ? null : n;
}

function fuelFromOoyyoHtml(html: string): string | null {
  if (!html || html.length < 200) return null;
  const $ = cheerio.load(html);
  const map: Record<string, string> = {};
  $('ul.basic-info > li').each((_, li) => {
    const kids = $(li).children('div');
    const key = kids.eq(0).text().replace(/\s+/g, ' ').trim().toLowerCase();
    const val = kids.eq(1).text().replace(/\s+/g, ' ').trim();
    if (key && val) map[key] = val;
  });
  const fuelRaw = map['fuel type'] || map['fuel'] || '';
  if (fuelRaw) return mapFuelLabel(fuelRaw);

  const spans = $('.description > span')
    .toArray()
    .map((el) =>
      $(el)
        .text()
        .replace(/,/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
  const ordered =
    spans.length >= 2 ? [spans[1]!, ...spans.filter((_, i) => i !== 1)] : spans;
  for (const label of ordered) {
    const mapped = mapFuelLabel(label);
    if (mapped) return mapped;
  }
  return null;
}

function fuelFromClicarsHtml(html: string): string | null {
  if (!html || html.length < 200) return null;
  const $ = cheerio.load(html);
  const fromClass =
    $('.fuelName').first().text().trim() ||
    $('[class*="fuel"]').first().text().trim();
  if (fromClass) return mapFuelLabel(fromClass);

  const meta =
    $('meta[property="product:fuel"]').attr('content') ||
    $('meta[name="fuel"]').attr('content') ||
    '';
  if (meta) return mapFuelLabel(meta);

  const body = $('body').text().replace(/\s+/g, ' ');
  const m = body.match(
    /combustible\s*[:\-]?\s*(gasolina|di[eé]sel|h[ií]brido|el[eé]ctrico|glp|gnc|gas)/i
  );
  if (m?.[1]) return mapFuelLabel(m[1]);
  return null;
}

async function fetchHtml(
  url: string
): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  try {
    const client = createHttpClient(undefined, { useProxy: false });
    const res = await client.get(url, {
      validateStatus: () => true,
      maxRedirects: 5,
      responseType: 'text',
      transformResponse: [(d) => d]
    });
    if (res.status >= 200 && res.status < 300 && res.data) {
      return {
        ok: true,
        html: typeof res.data === 'string' ? res.data : String(res.data)
      };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err: any) {
    const status = err?.response?.status;
    return {
      ok: false,
      error: status ? `HTTP ${status}` : err?.message || String(err)
    };
  }
}

function buildWhere(args: Args): Prisma.CarListingWhereInput {
  const parts: Prisma.CarListingWhereInput[] = [];

  if (args.mode === 'clear-lpg' || args.target === 'lpg') {
    parts.push({ fuelType: 'LPG' });
  } else if (args.target === 'missing') {
    parts.push({
      OR: [{ fuelType: null }, { fuelType: { in: ['Unknown', 'unknown'] } }]
    });
  } else {
    // all
    parts.push({
      OR: [
        { fuelType: 'LPG' },
        { fuelType: null },
        { fuelType: { in: ['Unknown', 'unknown'] } }
      ]
    });
  }

  if (args.source) {
    parts.push({ sourcePortal: args.source });
  }

  return parts.length === 1 ? parts[0]! : { AND: parts };
}

type Row = {
  id: string;
  sourcePortal: string;
  portalId: string;
  originalUrl: string;
  brand: string;
  model: string;
  year: number;
  fuelType: string | null;
};

type Outcome =
  | { action: 'keep'; reason: string }
  | { action: 'update'; fuel: string | null; reason: string }
  | { action: 'skip'; reason: string };

async function decideRefetch(row: Row, args: Args): Promise<Outcome> {
  const url = row.originalUrl;
  if (args.fetchableOnly && !isFetchableUrl(url)) {
    return { action: 'skip', reason: 'not-fetchable-url' };
  }

  if (isOoyyoUrl(url)) {
    const fetched = await fetchHtml(url);
    if (!fetched.ok) {
      if (args.keepOnFail) return { action: 'skip', reason: fetched.error };
      return { action: 'update', fuel: null, reason: `${fetched.error}→null` };
    }
    const fuel = fuelFromOoyyoHtml(fetched.html);
    if (!fuel) {
      if (args.keepOnFail) return { action: 'skip', reason: 'no-fuel-on-page' };
      return { action: 'update', fuel: null, reason: 'no-fuel-on-page→null' };
    }
    if (fuel === row.fuelType) return { action: 'keep', reason: `already-${fuel}` };
    return { action: 'update', fuel, reason: `ooyyo→${fuel}` };
  }

  if (isClicarsUrl(url)) {
    const fetched = await fetchHtml(url);
    if (!fetched.ok) {
      if (args.keepOnFail) return { action: 'skip', reason: fetched.error };
      return { action: 'update', fuel: null, reason: `${fetched.error}→null` };
    }
    const fuel = fuelFromClicarsHtml(fetched.html);
    if (!fuel) {
      if (args.keepOnFail) return { action: 'skip', reason: 'no-fuel-on-page' };
      return { action: 'update', fuel: null, reason: 'no-fuel-on-page→null' };
    }
    if (fuel === row.fuelType) return { action: 'keep', reason: `already-${fuel}` };
    return { action: 'update', fuel, reason: `clicars→${fuel}` };
  }

  // Seller / other portals — cannot parse reliably
  if (args.keepOnFail) return { action: 'skip', reason: 'unsupported-url' };
  // For missing target: already null/Unknown — nothing to clear
  if (!row.fuelType || row.fuelType.toLowerCase() === 'unknown') {
    return { action: 'skip', reason: 'unsupported-url-already-pending' };
  }
  // Suspect LPG (or other bad label) on seller URL → clear to pending
  return { action: 'update', fuel: null, reason: 'unsupported-url→null' };
}

async function printFuelAudit() {
  const groups = await prisma.carListing.groupBy({
    by: ['fuelType'],
    _count: { _all: true },
    orderBy: { _count: { fuelType: 'desc' } }
  });
  const total = await prisma.carListing.count();
  console.log(`📊 Fuel audit (${total} listings):`);
  for (const g of groups) {
    console.log(`   - ${g.fuelType ?? 'null'}: ${g._count._all}`);
  }
}

async function runClearLpg(args: Args) {
  const where = buildWhere({ ...args, mode: 'clear-lpg', target: 'lpg' });
  const count = await prisma.carListing.count({ where });
  console.log(`🧹 clear-lpg: ${count} rows with fuelType=LPG`);

  if (!args.apply) {
    console.log('💡 Dry-run. Re-run with --apply to set them all to null.');
    return;
  }

  // Bulk update — bypasses per-row HTTP. Middleware skips null (not a string).
  const result = await prisma.carListing.updateMany({
    where,
    data: { fuelType: null }
  });
  console.log(`✍️ Cleared ${result.count} LPG → null`);

  await invalidateInventoryCache();
  await refreshInventoryStats();
  console.log('♻️ Inventory cache + stats refreshed');
}

async function runRefetch(args: Args) {
  const where = buildWhere(args);
  const total = await prisma.carListing.count({ where });
  console.log(
    `🔎 refetch target=${args.target} matching=${total} ` +
      `fetchableOnly=${args.fetchableOnly} limit=${args.limit ?? '∞'}`
  );

  const rows = (await prisma.carListing.findMany({
    where,
    take: args.limit ?? undefined,
    orderBy: { updatedAt: 'asc' },
    select: {
      id: true,
      sourcePortal: true,
      portalId: true,
      originalUrl: true,
      brand: true,
      model: true,
      year: true,
      fuelType: true
    }
  })) as Row[];

  console.log(`▶️ Processing ${rows.length} rows…`);

  const stats = {
    updated: 0,
    kept: 0,
    skipped: 0,
    byFuel: {} as Record<string, number>
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const outcome = await decideRefetch(row, args);
    const label = `${row.brand} ${row.model} (${row.year}) [${row.fuelType ?? 'null'}]`;

    if (outcome.action === 'keep') {
      stats.kept++;
      console.log(`✅ KEEP  ${label} — ${outcome.reason}`);
    } else if (outcome.action === 'skip') {
      stats.skipped++;
      console.log(`⏭️ SKIP  ${label} — ${outcome.reason}`);
    } else {
      const fuelKey = outcome.fuel ?? 'null';
      stats.byFuel[fuelKey] = (stats.byFuel[fuelKey] || 0) + 1;
      if (args.apply) {
        await prisma.carListing.update({
          where: { id: row.id },
          data: { fuelType: outcome.fuel }
        });
        stats.updated++;
        console.log(`✍️ SET   ${label} → ${fuelKey} (${outcome.reason})`);
      } else {
        stats.updated++;
        console.log(`📝 WOULD ${label} → ${fuelKey} (${outcome.reason})`);
      }
    }

    const didHttp =
      isFetchableUrl(row.originalUrl) && outcome.reason !== 'not-fetchable-url';
    if (didHttp && i < rows.length - 1) {
      await sleep(args.delayMs);
    }

    if ((i + 1) % 25 === 0) {
      console.log(`… progress ${i + 1}/${rows.length}`);
    }
  }

  console.log('──────── summary ────────');
  console.log(`updated/would-update: ${stats.updated}`);
  console.log(`kept: ${stats.kept}`);
  console.log(`skipped: ${stats.skipped}`);
  console.log('fuel outcomes:', stats.byFuel);

  if (args.apply && stats.updated > 0) {
    await invalidateInventoryCache();
    await refreshInventoryStats();
    console.log('♻️ Inventory cache + stats refreshed');
  } else if (!args.apply) {
    console.log('💡 Dry-run only. Re-run with --apply to write changes.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `🔧 [backfill-fuel] mode=${args.mode} target=${args.target} ` +
      `apply=${args.apply} source=${args.source || 'all'} ` +
      `limit=${args.limit ?? '∞'} delayMs=${args.delayMs}`
  );

  await printFuelAudit();

  if (args.mode === 'clear-lpg') {
    await runClearLpg(args);
  } else {
    await runRefetch(args);
  }

  console.log('──────── after ────────');
  await printFuelAudit();
}

main()
  .catch((err) => {
    console.error('❌ [backfill-fuel] Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
