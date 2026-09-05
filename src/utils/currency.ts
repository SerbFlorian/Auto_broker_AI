/**
 * Eurozone vs non-EUR markets we scrape.
 * SE = Sweden (SEK), not Serbia (RS).
 * BG joined EUR in 2026; HR already EUR.
 */
export const EUR_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK',
  'AD', 'MC', 'SM', 'VA'
]);

/** ISO country → local currency when the portal price is NOT euros. */
export const NON_EUR_COUNTRY_CURRENCY: Record<string, string> = {
  SE: 'SEK', // Sweden
  DK: 'DKK', // Denmark
  NO: 'NOK', // Norway
  IS: 'ISK', // Iceland
  CH: 'CHF', // Switzerland
  GB: 'GBP', // United Kingdom
  UK: 'GBP',
  PL: 'PLN', // Poland
  CZ: 'CZK', // Czechia
  HU: 'HUF', // Hungary
  RO: 'RON', // Romania
  RS: 'RSD', // Serbia
  BA: 'BAM', // Bosnia
  MK: 'MKD', // North Macedonia
  AL: 'ALL', // Albania
  TR: 'TRY', // Turkey
  UA: 'UAH', // Ukraine
  MD: 'MDL' // Moldova
};

export function isEuroCountry(code: string | null | undefined): boolean {
  const c = (code || '').trim().toUpperCase();
  if (!c) return true; // unknown → do not FX-convert
  if (c === 'UK') return false;
  return EUR_COUNTRY_CODES.has(c);
}

export function currencyForCountry(code: string | null | undefined): string | null {
  const c = (code || '').trim().toUpperCase();
  if (!c || isEuroCountry(c)) return null;
  return NON_EUR_COUNTRY_CURRENCY[c] || null;
}

export function nonEurCountryCodes(): string[] {
  return Object.keys(NON_EUR_COUNTRY_CURRENCY).filter((c) => c !== 'UK');
}

/**
 * Frankfurter / ECB style: rates[ccy] = units of ccy per 1 EUR.
 * nativeAmount in ccy → EUR = nativeAmount / rates[ccy]
 */
export function convertToEur(
  nativeAmount: number,
  currency: string,
  ratesPerEur: Record<string, number>
): number | null {
  if (!Number.isFinite(nativeAmount) || nativeAmount <= 0) return null;
  const ccy = currency.toUpperCase();
  if (ccy === 'EUR') return nativeAmount;
  const rate = ratesPerEur[ccy];
  if (!rate || !Number.isFinite(rate) || rate <= 0) return null;
  return nativeAmount / rate;
}

/** Plausible used-car asking price in EUR (soft-launch EU market). */
export const PLAUSIBLE_EUR_MIN = 800;
export const PLAUSIBLE_EUR_MAX = 800_000;

/**
 * High-denomination currencies: a real car price is usually huge.
 * Below this floor, the stored number is almost certainly already EUR.
 */
const LOCAL_MIN_IF_NATIVE: Record<string, number> = {
  HUF: 400_000, // ~€1k+
  CZK: 40_000,
  ISK: 200_000,
  RSD: 100_000,
  UAH: 40_000,
  MKD: 50_000,
  ALL: 100_000,
  MDL: 20_000,
  TRY: 50_000
};

/**
 * Decide if `amount` is already EUR (do not FX) vs local currency for `currency`.
 * Used when portals list EUR even though countryOfOrigin is SE/PL/HU/…
 */
export function priceLooksLikeAlreadyEur(
  amount: number,
  currency: string,
  ratesPerEur: Record<string, number>
): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return true;
  const ccy = currency.toUpperCase();
  if (ccy === 'EUR') return true;

  // High-denomination: tiny numbers cannot be native car prices
  const localFloor = LOCAL_MIN_IF_NATIVE[ccy];
  if (localFloor != null && amount < localFloor) return true;

  const asLocalEur = convertToEur(amount, ccy, ratesPerEur);
  if (asLocalEur == null) return false;

  const rounded = Math.round(asLocalEur);

  // Converting would yield a nonsense car price → treat original as EUR
  if (rounded < PLAUSIBLE_EUR_MIN || rounded > PLAUSIBLE_EUR_MAX) return true;

  // High-denom only: amount sits in a normal EUR band but FX collapses it
  // (e.g. 13_066 "HUF" → €36). Do NOT apply to SEK/PLN/RON — real local
  // stickers often look like mid EUR amounts (124_000 SEK ≈ €11k).
  if (
    localFloor != null &&
    amount >= PLAUSIBLE_EUR_MIN &&
    amount <= PLAUSIBLE_EUR_MAX &&
    rounded < amount * 0.35
  ) {
    return true;
  }

  return false;
}
