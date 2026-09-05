/**
 * Listing URL helpers for OOYYO / TheParking aggregator vs external seller portals.
 *
 * Policy: prefer the outbound “final” link only when it probes OK.
 * Otherwise keep the aggregator preview/detail href.
 */

export function isOoyyoAggregatorUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false;
  try {
    return /(^|\.)ooyyo\.com$/i.test(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}

export function isTheParkingUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false;
  try {
    return /(^|\.)theparking\.eu$/i.test(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}

/** External (non-OOYYO) seller URL — preferred for Listing found when live. */
export function hasExternalSellerUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false;
  return !isOoyyoAggregatorUrl(url);
}

/**
 * Absolute https URL that is NOT ooyyo.com (Contact seller target).
 * Rejects javascript:, #, relative ooyyo paths, empty hosts.
 */
export function normalizeExternalSellerUrl(
  href: string | null | undefined,
  baseUrl = 'https://www.ooyyo.com'
): string | null {
  if (!href?.trim()) return null;
  const raw = href.trim();
  if (/^javascript:/i.test(raw) || raw === '#') return null;
  try {
    const u = new URL(raw, baseUrl);
    if (!/^https?:$/i.test(u.protocol)) return null;
    if (/(^|\.)ooyyo\.com$/i.test(u.hostname)) return null;
    if (!u.hostname || u.hostname.length < 3) return null;
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    if (path === '/' && !u.search) return null;
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/** Absolute TheParking title /tools/… outbound link (or absolute external). */
export function absoluteTheParkingHref(
  href: string | null | undefined,
  baseUrl = 'https://www.theparking.eu'
): string | null {
  if (!href?.trim()) return null;
  const raw = href.trim();
  if (/^javascript:/i.test(raw) || raw === '#') return null;
  try {
    const u = new URL(raw, baseUrl);
    if (!/^https?:$/i.test(u.protocol)) return null;
    if (!/(^|\.)theparking\.eu$/i.test(u.hostname)) {
      const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
      if (path === '/' && !u.search) return null;
      return `${u.origin}${u.pathname}${u.search}`;
    }
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/** After redirects: still a usable listing URL (not a dumped homepage). */
export function isLikelyLiveListingUrl(
  requestedUrl: string,
  finalUrl: string | null | undefined
): boolean {
  const final = (finalUrl || requestedUrl).trim();
  try {
    const u = new URL(final);
    if (/(^|\.)ooyyo\.com$/i.test(u.hostname)) {
      return true;
    }
    if (/(^|\.)theparking\.eu$/i.test(u.hostname)) {
      const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
      return path !== '/';
    }
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    if (path === '/' && !u.search) return false;
    return true;
  } catch {
    return false;
  }
}
