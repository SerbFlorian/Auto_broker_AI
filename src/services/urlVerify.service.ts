/**
 * Listing URL verification — prefer live seller links; drop confirmed-dead pages.
 *
 * Flow:
 * 1) Direct HTTP from VPS (free).
 * 2) If not OK → Bright Data probe (when enabled).
 * 3) Still not OK after proxy → delete (safe: real dead / unreachable for users via proxy).
 * Soft limbo only if Bright Data is disabled (cannot decide).
 */
import { prisma } from '../db/prisma.js';
import { createHttpClient } from '../utils/httpClient.js';
import { isBrightDataEnabled } from '../utils/secrets.js';
import {
  absoluteTheParkingHref,
  isLikelyLiveListingUrl,
  isOoyyoAggregatorUrl,
  isTheParkingUrl,
  normalizeExternalSellerUrl
} from '../utils/listingUrl.js';
import { randomDelay } from '../utils/delay.js';
import { cacheDelByPrefix } from './cache.service.js';
import { incr } from '../utils/metrics.js';
import { getRedis, initRedis } from '../db/redis.js';
import {
  tryConsumeBrightDataBudget,
  getBrightDataBudgetStatus,
  type BrightDataPurpose
} from './brightDataBudget.service.js';

/** Redis ZSET: soft-failed listings (403/timeout) — probed before fresh pending. */
const SOFT_ZSET = 'urlverify:soft';
const SOFT_ZSET_LEGACY = 'urlverify:ooyyo:soft';

const PENDING_WHERE = {
  urlVerifiedAt: null as null
};

const ROW_SELECT = {
  id: true,
  portalId: true,
  originalUrl: true,
  brand: true,
  model: true,
  sourcePortal: true
} as const;

async function rememberSoftFailure(id: string): Promise<void> {
  try {
    await initRedis();
    const r = getRedis();
    if (!r) return;
    const exists = await r.zscore(SOFT_ZSET, id);
    if (exists == null) {
      await r.zadd(SOFT_ZSET, String(Date.now()), id);
    }
  } catch {
    /* ignore */
  }
}

async function clearSoftFailure(id: string): Promise<void> {
  try {
    await initRedis();
    const r = getRedis();
    if (!r) return;
    await r.zrem(SOFT_ZSET, id);
    await r.zrem(SOFT_ZSET_LEGACY, id);
  } catch {
    /* ignore */
  }
}

/**
 * Soft-failed IDs first (oldest soft first), then other unverified (oldest scrape first).
 * Covers every portal (OOYYO, TheParking, Clicars, …).
 */
async function loadVerifyBatch(limit: number) {
  type Row = {
    id: string;
    portalId: string;
    originalUrl: string;
    brand: string;
    model: string;
    sourcePortal: string;
  };

  let softIds: string[] = [];
  try {
    await initRedis();
    const r = getRedis();
    if (r) {
      const take = String(Math.max(limit * 2, 50) - 1);
      const [a, b] = await Promise.all([
        r.zrange(SOFT_ZSET, '0', take),
        r.zrange(SOFT_ZSET_LEGACY, '0', take)
      ]);
      softIds = [...new Set([...a, ...b])];
    }
  } catch {
    softIds = [];
  }

  const softRows: Row[] = [];
  if (softIds.length > 0) {
    const found = await prisma.carListing.findMany({
      where: {
        ...PENDING_WHERE,
        id: { in: softIds }
      },
      select: ROW_SELECT
    });
    const byId = new Map(found.map((r) => [r.id, r]));
    for (const id of softIds) {
      const row = byId.get(id);
      if (row) softRows.push(row);
      else await clearSoftFailure(id);
      if (softRows.length >= limit) break;
    }
  }

  const need = limit - softRows.length;
  const excludeIds = softRows.map((r) => r.id);
  const otherRows =
    need > 0
      ? await prisma.carListing.findMany({
          where: {
            ...PENDING_WHERE,
            ...(excludeIds.length ? { id: { notIn: excludeIds } } : {})
          },
          select: ROW_SELECT,
          take: need,
          orderBy: { updatedAt: 'asc' }
        })
      : [];

  return {
    rows: [...softRows, ...otherRows],
    softPriority: softRows.length,
    other: otherRows.length
  };
}
export type UrlProbeResult =
  | { status: 'ok'; finalUrl?: string }
  | { status: 'dead'; reason: string; finalUrl?: string }
  | { status: 'soft'; reason: string; finalUrl?: string };

export type UrlVerifyStats = {
  scanned: number;
  verified: number;
  repaired: number;
  deleted: number;
  soft: number;
  failed: number;
  proxyProbes: number;
};

const DEFAULT_LIMIT = 30;

function looksLikeOoyyoDeadPage(html: string): boolean {
  return (
    /something went wrong/i.test(html) ||
    /please try again later/i.test(html)
  );
}

function looksLikeDeadListingPage(html: string): boolean {
  if (looksLikeOoyyoDeadPage(html)) return true;
  if (html.length < 200) return true;
  // Soft-404: HTTP 200 with a "page gone" body (common on IT/ES/FR portals)
  return (
    /page not found/i.test(html) ||
    /listing (has been )?removed/i.test(html) ||
    /anuncio no (encontrado|disponible)/i.test(html) ||
    /inserzione non (trovata|disponibile)/i.test(html) ||
    /annonce introuvable/i.test(html) ||
    /dieses angebot (ist )?nicht (mehr )?verf/i.test(html) ||
    /404 not found/i.test(html) ||
    // autosupermarket.it & similar Italian soft-404
    /pagina che stai cercando non esista/i.test(html) ||
    /oppure sia stata spostata/i.test(html) ||
    /sembra che la pagina/i.test(html) ||
    // ES / EN / FR soft-404
    /la p[aá]gina que (est[aá]s )?buscando no existe/i.test(html) ||
    /page you(?:'| a)?re looking for (does not|doesn't) exist/i.test(html) ||
    /cette page (n'existe pas|a [eé]t[eé] (d[eé]plac[eé]e|supprim[eé]e))/i.test(
      html
    ) ||
    /<h[1-3][^>]*>\s*404\s*<\/h[1-3]>/i.test(html)
  );
}

/** Exported for unit checks (soft-404 HTML sniff). */
export function htmlLooksLikeDeadListing(html: string): boolean {
  return looksLikeDeadListingPage(html);
}

function classifyHttpProbe(
  url: string,
  code: number,
  html: string,
  finalUrl?: string | null
): UrlProbeResult {
  if (code === 404 || code === 410 || code === 451) {
    return { status: 'dead', reason: `HTTP ${code}` };
  }
  if (code === 403 || code === 429 || code === 503) {
    return { status: 'soft', reason: `HTTP ${code}` };
  }
  if (code < 200 || code >= 400) {
    return { status: 'soft', reason: `HTTP ${code}` };
  }
  if (!isLikelyLiveListingUrl(url, finalUrl || url)) {
    return { status: 'dead', reason: 'redirect_to_homepage' };
  }
  if (isOoyyoAggregatorUrl(url) && looksLikeOoyyoDeadPage(html)) {
    return { status: 'dead', reason: 'ooyyo_error_page' };
  }
  if (!isOoyyoAggregatorUrl(url) && looksLikeDeadListingPage(html)) {
    return { status: 'dead', reason: 'seller_dead_page' };
  }
  return { status: 'ok' };
}

const PROBE_TIMEOUT_MS = Math.max(
  15_000,
  parseInt(process.env.URL_VERIFY_TIMEOUT_MS || '45000', 10) || 45_000
);
const PROBE_TIMEOUT_SLOW_MS = Math.max(
  PROBE_TIMEOUT_MS,
  parseInt(process.env.URL_VERIFY_TIMEOUT_SLOW_MS || '70000', 10) || 70_000
);

function isConfirmedDeadReason(reason: string): boolean {
  return (
    reason.startsWith('HTTP 404') ||
    reason.startsWith('HTTP 410') ||
    reason.startsWith('HTTP 451') ||
    reason === 'ooyyo_error_page' ||
    reason === 'seller_dead_page' ||
    reason === 'redirect_to_homepage' ||
    reason === 'empty'
  );
}

function isBillingOrAuthProxyFailure(reason: string): boolean {
  // Bright Data / proxy account problems — never treat as a dead listing
  return /HTTP 402/i.test(reason) || /HTTP 407/i.test(reason);
}

function isTimeoutOrNoResponse(reason: string): boolean {
  return (
    /timeout/i.test(reason) ||
    /ECONNABORTED/i.test(reason) ||
    /ETIMEDOUT/i.test(reason) ||
    /ECONNRESET/i.test(reason) ||
    /socket hang up/i.test(reason) ||
    /network/i.test(reason)
  );
}

/** Single-leg probe (direct or proxy). */
export async function probeListingUrl(
  url: string,
  options?: { useProxy?: boolean; timeoutMs?: number }
): Promise<UrlProbeResult> {
  if (!url?.trim()) return { status: 'dead', reason: 'empty' };
  const useProxy = Boolean(options?.useProxy);
  const timeoutMs = options?.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const client = createHttpClient(undefined, { useProxy });
    const res = await client.get(url, {
      timeout: timeoutMs,
      maxRedirects: 5,
      validateStatus: () => true
    });
    const html =
      typeof res.data === 'string' ? res.data : String(res.data ?? '');
    const finalUrl =
      (res.request as { res?: { responseUrl?: string }; responseURL?: string })
        ?.res?.responseUrl ||
      (res.request as { responseURL?: string })?.responseURL ||
      (typeof res.headers?.location === 'string' ? res.headers.location : null) ||
      url;
    return {
      ...classifyHttpProbe(url, res.status, html, finalUrl),
      finalUrl
    };
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404 || status === 410 || status === 451) {
      return { status: 'dead', reason: `HTTP ${status}` };
    }
    return { status: 'soft', reason: err?.message || 'network' };
  }
}

/**
 * Decisive probe: direct → Bright Data; slow retry on timeout; then decide.
 *
 * Delete only when:
 * - Clear dead (404/410/soft-404 HTML), or
 * - After a longer wait the page still does not respond (timeout / 502 flake).
 *
 * Never delete on Bright Data billing (HTTP 402).
 */
export async function probeListingUrlDecisive(
  url: string,
  options?: { purpose?: BrightDataPurpose }
): Promise<UrlProbeResult & { usedProxy?: boolean }> {
  const purpose = options?.purpose ?? 'scraper';
  const direct = await probeListingUrl(url, {
    useProxy: false,
    timeoutMs: PROBE_TIMEOUT_MS
  });
  if (direct.status === 'ok') return direct;

  if (direct.status === 'dead' && isConfirmedDeadReason(direct.reason)) {
    return direct;
  }

  if (!isBrightDataEnabled() || !(await tryConsumeBrightDataBudget(purpose))) {
    return direct.status === 'dead'
      ? direct
      : { status: 'soft', reason: `${direct.reason} (no Bright Data budget)` };
  }

  const budget = await getBrightDataBudgetStatus(purpose);
  console.warn(
    `🔗 [UrlVerify] Soft/blocked (${direct.reason}) — retry via Bright Data ` +
      `[${purpose} ${budget.purposeUses}/${budget.purposeMax}, global ${budget.globalUses}/${budget.globalMax}]: ` +
      `${url.slice(0, 80)}…`
  );
  incr('proxyFallbacks', 1);

  let viaProxy = await probeListingUrl(url, {
    useProxy: true,
    timeoutMs: PROBE_TIMEOUT_MS
  });

  const slowRetryEnabled =
    (process.env.BRIGHT_DATA_SLOW_RETRY || 'false').toLowerCase() === 'true';
  if (
    slowRetryEnabled &&
    viaProxy.status !== 'ok' &&
    !isConfirmedDeadReason(viaProxy.reason) &&
    (isTimeoutOrNoResponse(viaProxy.reason) ||
      /HTTP 502/i.test(viaProxy.reason) ||
      /HTTP 503/i.test(viaProxy.reason)) &&
    (await tryConsumeBrightDataBudget(purpose))
  ) {
    console.warn(
      `🔗 [UrlVerify] Slow/empty proxy response (${viaProxy.reason}) — waiting longer (${PROBE_TIMEOUT_SLOW_MS}ms)…`
    );
    await randomDelay(1500, 2500);
    viaProxy = await probeListingUrl(url, {
      useProxy: true,
      timeoutMs: PROBE_TIMEOUT_SLOW_MS
    });
  }

  if (viaProxy.status === 'ok') {
    return { ...viaProxy, usedProxy: true };
  }

  if (isConfirmedDeadReason(viaProxy.reason)) {
    return {
      status: 'dead',
      reason: `proxy:${viaProxy.reason}`,
      usedProxy: true,
      finalUrl: viaProxy.finalUrl
    };
  }

  if (isBillingOrAuthProxyFailure(viaProxy.reason)) {
    console.warn(
      `⚠️ [UrlVerify] Bright Data ${viaProxy.reason} (billing/auth) — leave unverified, do not delete`
    );
    return {
      status: 'soft',
      reason: `proxy:${viaProxy.reason}`,
      usedProxy: true,
      finalUrl: viaProxy.finalUrl
    };
  }

  // After extended wait: still no usable page → treat as dead (user request)
  if (
    isTimeoutOrNoResponse(viaProxy.reason) ||
    /HTTP 502/i.test(viaProxy.reason) ||
    /HTTP 503/i.test(viaProxy.reason)
  ) {
    console.warn(
      `🗑️ [UrlVerify] No response after slow retry (${viaProxy.reason}) — mark dead`
    );
    return {
      status: 'dead',
      reason: `proxy:slow:${viaProxy.reason}`,
      usedProxy: true,
      finalUrl: viaProxy.finalUrl
    };
  }

  // e.g. persistent 403 even via proxy — keep soft (site may block unlocker)
  return {
    status: 'soft',
    reason: `proxy:${viaProxy.reason}`,
    usedProxy: true,
    finalUrl: viaProxy.finalUrl
  };
}

/**
 * Contact seller first — ONLY if the probe is OK.
 * Otherwise keep the OOYYO preview URL (if that opens).
 * Never persist a broken / weird seller link.
 */
export async function resolveOoyyoUrlForSave(params: {
  previewUrl: string;
  sellerUrl: string | null;
}): Promise<{ url: string; verifiedAt: Date } | null> {
  const preview = (params.previewUrl || '').trim();
  const seller = normalizeExternalSellerUrl(params.sellerUrl);

  if (seller) {
    const sellerProbe = await probeListingUrlDecisive(seller);
    if (sellerProbe.status === 'ok') {
      console.log(
        `🔗 [UrlVerify] Contact seller OK → ${seller.slice(0, 100)}`
      );
      return { url: seller, verifiedAt: new Date() };
    }
    console.warn(
      `⚠️ [UrlVerify] Contact seller rejected (${sellerProbe.reason}) — fallback to OOYYO preview. ` +
        `seller=${seller.slice(0, 90)}`
    );
  } else if (params.sellerUrl?.trim()) {
    console.warn(
      `⚠️ [UrlVerify] Contact seller href unusable (not external) — fallback to OOYYO preview`
    );
  }

  if (!preview || !isOoyyoAggregatorUrl(preview)) {
    console.warn(`🔗 [UrlVerify] No usable OOYYO preview URL`);
    return null;
  }

  const previewProbe = await probeListingUrlDecisive(preview);
  if (previewProbe.status === 'ok') {
    console.log(
      `📎 [UrlVerify] Using verified OOYYO preview (Contact seller missing/dead)`
    );
    return { url: preview, verifiedAt: new Date() };
  }

  console.warn(
    `🔗 [UrlVerify] OOYYO preview also failed (${previewProbe.reason}) — skip listing`
  );
  return null;
}

/**
 * TheParking: title link (`a.tag_f_titre` → /tools/…/L.html) is the outbound final URL.
 * Probe it; if OK save the resolved seller URL (or the tools link).
 * If not → keep the TheParking detail/preview URL when that opens.
 */
export async function resolveTheParkingUrlForSave(params: {
  previewUrl: string;
  titleHref: string | null;
}): Promise<{ url: string; verifiedAt: Date } | null> {
  const preview = (params.previewUrl || '').trim();
  const titleLink = absoluteTheParkingHref(params.titleHref);

  if (titleLink) {
    const titleProbe = await probeListingUrlDecisive(titleLink);
    if (titleProbe.status === 'ok') {
      const final = (titleProbe.finalUrl || titleLink).trim();
      // Prefer the real seller destination after redirects (e.g. coches.net)
      const saveUrl =
        final &&
        !isTheParkingUrl(final) &&
        isLikelyLiveListingUrl(titleLink, final)
          ? final
          : titleLink;
      console.log(
        `🔗 [UrlVerify] TheParking title link OK → ${saveUrl.slice(0, 100)}`
      );
      return { url: saveUrl, verifiedAt: new Date() };
    }
    console.warn(
      `⚠️ [UrlVerify] TheParking title link rejected (${titleProbe.reason}) — fallback to preview. ` +
        `title=${titleLink.slice(0, 90)}`
    );
  } else if (params.titleHref?.trim()) {
    console.warn(
      `⚠️ [UrlVerify] TheParking title href unusable — fallback to preview`
    );
  }

  if (!preview || !isTheParkingUrl(preview)) {
    console.warn(`🔗 [UrlVerify] No usable TheParking preview URL`);
    return null;
  }

  const previewProbe = await probeListingUrlDecisive(preview);
  if (previewProbe.status === 'ok') {
    console.log(
      `📎 [UrlVerify] Using verified TheParking preview (title link missing/dead)`
    );
    return { url: preview, verifiedAt: new Date() };
  }

  console.warn(
    `🔗 [UrlVerify] TheParking preview also failed (${previewProbe.reason}) — skip listing`
  );
  return null;
}

async function markVerified(id: string, originalUrl?: string): Promise<void> {
  try {
    await prisma.carListing.update({
      where: { id },
      data: {
        urlVerifiedAt: new Date(),
        ...(originalUrl ? { originalUrl } : {})
      }
    });
  } catch (err: any) {
    // Parallel verify/cron may have removed the row already
    if (err?.code === 'P2025') return;
    throw err;
  }
}

/** Idempotent delete — parallel cron+script must not throw if row is already gone. */
async function deleteListingIfExists(id: string): Promise<boolean> {
  const result = await prisma.carListing.deleteMany({ where: { id } });
  return result.count > 0;
}

/**
 * Process rows with urlVerifiedAt IS NULL (any portal).
 * Never re-checks verified rows. Softs prioritized via Redis.
 */
export async function runUrlVerifyCycle(options?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<UrlVerifyStats> {
  const limit = Math.max(
    1,
    options?.limit ??
      (parseInt(process.env.URL_VERIFY_LIMIT || String(DEFAULT_LIMIT), 10) ||
        DEFAULT_LIMIT)
  );
  const dryRun = Boolean(options?.dryRun);
  const delayMin = Math.max(
    800,
    parseInt(process.env.URL_VERIFY_DELAY_MIN_MS || '1500', 10) || 1500
  );
  const delayMax = Math.max(
    delayMin,
    parseInt(process.env.URL_VERIFY_DELAY_MAX_MS || '2800', 10) || 2800
  );

  const stats: UrlVerifyStats = {
    scanned: 0,
    verified: 0,
    repaired: 0,
    deleted: 0,
    soft: 0,
    failed: 0,
    proxyProbes: 0
  };

  if (!isBrightDataEnabled()) {
    console.warn(
      '⚠️ [UrlVerify] BRIGHTDATA_ENABLED is off — softs stay unverified (no delete). Enable it for decisive purge.'
    );
  } else {
    const budget = await getBrightDataBudgetStatus('urlverify');
    console.log(
      `💸 [BrightData] urlverify today: ${budget.purposeUses}/${budget.purposeMax} | global ${budget.globalUses}/${budget.globalMax}`
    );
  }

  const { rows, softPriority, other } = await loadVerifyBatch(limit);

  stats.scanned = rows.length;
  if (rows.length === 0) {
    console.log('🔗 [UrlVerify] No pending URLs (all verified or empty).');
    return stats;
  }

  console.log(
    `🔗 [UrlVerify] Checking ${rows.length} unverified listing(s)` +
      ` (priority softs: ${softPriority}, other backlog: ${other})` +
      (dryRun ? ' [dry-run]' : '') +
      (isBrightDataEnabled() ? ' (direct→Bright Data→delete)' : ' (direct only)') +
      '...'
  );

  for (const row of rows) {
    try {
      let url = row.originalUrl;
      let probe = await probeListingUrlDecisive(url, { purpose: 'urlverify' });
      if (probe.usedProxy) stats.proxyProbes++;

      // OOYYO soft/dead: try Contact seller once, then decisive re-probe
      if (probe.status !== 'ok' && isOoyyoAggregatorUrl(url)) {
        const { resolveOoyyoSellerUrl } = await import(
          '../scrapers/ooyyo.scraper.js'
        );
        const seller = await resolveOoyyoSellerUrl(url).catch(() => null);
        const sellerNorm = seller
          ? (await import('../utils/listingUrl.js')).normalizeExternalSellerUrl(
              seller
            )
          : null;
        if (sellerNorm) {
          const sellerProbe = await probeListingUrlDecisive(sellerNorm, {
            purpose: 'urlverify'
          });
          if (sellerProbe.usedProxy) stats.proxyProbes++;
          if (sellerProbe.status === 'ok') {
            console.log(
              `✅ [UrlVerify] Repair ${row.portalId} → ${sellerNorm}`
            );
            if (!dryRun) {
              const clash = await prisma.carListing.findFirst({
                where: { originalUrl: sellerNorm, NOT: { id: row.id } },
                select: { id: true }
              });
              if (clash) {
                await deleteListingIfExists(row.id);
                stats.deleted++;
              } else {
                await markVerified(row.id, sellerNorm);
                stats.repaired++;
                stats.verified++;
              }
              await clearSoftFailure(row.id);
            } else {
              stats.repaired++;
              stats.verified++;
            }
            await randomDelay(delayMin, delayMax);
            continue;
          }
          console.warn(
            `⚠️ [UrlVerify] Repair seller failed (${sellerProbe.reason}) — keep evaluating preview`
          );
        }
      }

      if (probe.status === 'ok') {
        console.log(
          `✅ [UrlVerify] OK ${row.portalId}` +
            (probe.usedProxy ? ' (via Bright Data)' : '')
        );
        if (!dryRun) {
          await markVerified(row.id);
          await clearSoftFailure(row.id);
        }
        stats.verified++;
      } else if (probe.status === 'dead') {
        console.log(
          `🗑️ [UrlVerify] Dead ${row.brand} ${row.model} (${row.portalId}): ${probe.reason}`
        );
        if (!dryRun) {
          await deleteListingIfExists(row.id);
          await clearSoftFailure(row.id);
        }
        stats.deleted++;
      } else {
        console.warn(
          `⏳ [UrlVerify] Soft ${row.portalId}: ${probe.reason} — leave unverified (queued for priority retry)`
        );
        if (!dryRun) await rememberSoftFailure(row.id);
        stats.soft++;
      }
    } catch (err: any) {
      stats.failed++;
      console.warn(
        `⚠️ [UrlVerify] Failed ${row.portalId}: ${err?.message || err}`
      );
      if (!dryRun) await rememberSoftFailure(row.id);
    }

    await randomDelay(delayMin, delayMax);
  }

  if (
    !dryRun &&
    (stats.verified > 0 || stats.repaired > 0 || stats.deleted > 0)
  ) {
    try {
      await cacheDelByPrefix('inv:');
      await cacheDelByPrefix('deal:');
    } catch {
      /* ignore */
    }
  }

  console.log(
    `🔗 [UrlVerify] Done — scanned ${stats.scanned}, verified ${stats.verified}, ` +
      `repaired ${stats.repaired}, deleted ${stats.deleted}, soft ${stats.soft}, ` +
      `proxyProbes ${stats.proxyProbes}, failed ${stats.failed}`
  );
  return stats;
}
