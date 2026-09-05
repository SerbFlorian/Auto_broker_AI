/** ISO country codes used on CarListing.countryOfOrigin → display labels. */
const COUNTRY_LABELS: Record<string, string> = {
  AT: 'Austria',
  BE: 'Belgium',
  BG: 'Bulgaria',
  CH: 'Switzerland',
  CZ: 'Czechia',
  DE: 'Germany',
  DK: 'Denmark',
  EE: 'Estonia',
  ES: 'Spain',
  FI: 'Finland',
  FR: 'France',
  GB: 'United Kingdom',
  GR: 'Greece',
  HR: 'Croatia',
  HU: 'Hungary',
  IE: 'Ireland',
  IT: 'Italy',
  LT: 'Lithuania',
  LU: 'Luxembourg',
  LV: 'Latvia',
  NL: 'Netherlands',
  NO: 'Norway',
  PL: 'Poland',
  PT: 'Portugal',
  RO: 'Romania',
  SE: 'Sweden',
  SI: 'Slovenia',
  SK: 'Slovakia',
  UK: 'United Kingdom'
};

export function countryLabel(code: string): string {
  const c = (code || '').trim().toUpperCase();
  if (!c) return 'Unknown';
  return COUNTRY_LABELS[c] || c;
}

export function normalizeCountryCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  return c === 'UK' ? 'GB' : c;
}

export function formatCountriesList(codes: string[] | null | undefined): string {
  if (!codes || codes.length === 0) return 'Any';
  return codes.map((c) => countryLabel(c)).join(', ');
}
