/**
 * Cleans a price string and returns a safe number, avoiding concatenation of disparate numbers (e.g., 24,000 and a phone number).
 */
export const parsePrice = (priceStr: string | undefined): number | null => {
  if (!priceStr) return null;
  // We extract only the first block that looks like a number (with dots or commas)
  const match = priceStr.match(/\d+([.,\s]\d+)*/);
  if (!match) return null;
  
  let str = match[0].replace(/\s/g, '');
  // If it has decimals (e.g., .50 or .00 at the end), we remove them to keep the integer
  if (str.length >= 3 && (str[str.length - 3] === ',' || str[str.length - 3] === '.')) {
    str = str.slice(0, -3);
  }
  
  const cleaned = str.replace(/[^\d]/g, '');
  const parsed = parseInt(cleaned, 10);
  return isNaN(parsed) ? null : parsed;
};

/**
 * Cleans a mileage string and returns a number.
 */
export const parseMileage = (mileageStr: string | undefined): number | null => {
  if (!mileageStr) return null;
  const match = mileageStr.match(/\d+([.,\s]\d+)*/);
  if (!match) return null;
  
  let str = match[0].replace(/\s/g, '');
  if (str.length >= 3 && (str[str.length - 3] === ',' || str[str.length - 3] === '.')) {
    str = str.slice(0, -3);
  }
  
  const cleaned = str.replace(/[^\d]/g, '');
  const parsed = parseInt(cleaned, 10);
  return isNaN(parsed) ? null : parsed;
};

/**
 * Cleans a year (e.g., "12/2018", "2018") and returns the numeric year.
 */
export const parseYear = (yearStr: string | undefined): number | null => {
  if (!yearStr) return null;
  // Search for 4 consecutive digits
  const match = yearStr.match(/\d{4}/);
  if (match) {
    return parseInt(match[0], 10);
  }
  return null;
};

/**
 * Strip accents/diacritics so "León" and "Leon" share one key.
 */
export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * Canonical lowercase brand key for indexed lookups (Mercedes/VW/BMW aliases).
 */
export function normalizeBrand(rawBrand: string | null | undefined): string {
  if (!rawBrand) return '';
  let brand = stripDiacritics(rawBrand.trim().toLowerCase()).replace(/\s+/g, ' ');
  if (!brand || brand === 'unknown') return '';

  // Compact form for "LandRover" / "MercedesBenz" / "AlfaRomeo"
  const compact = brand.replace(/[^a-z0-9]/g, '');

  if (brand === 'bmw') return 'bmw';
  if (brand === 'vw' || brand === 'volkswagen' || compact === 'volkswagen') {
    return 'volkswagen';
  }
  if (
    brand.includes('mercedes') ||
    brand === 'mercedes-benz' ||
    brand === 'mercedes benz' ||
    compact === 'mercedesbenz' ||
    compact === 'mercedes'
  ) {
    return 'mercedes-benz';
  }
  if (brand === 'alfa romeo' || compact === 'alfaromeo' || brand === 'alfa') {
    return 'alfa romeo';
  }
  if (brand === 'land rover' || compact === 'landrover') return 'land rover';
  if (brand === 'aston martin' || compact === 'astonmartin') return 'aston martin';
  if (brand === 'rolls-royce' || brand === 'rolls royce' || compact === 'rollsroyce') {
    return 'rolls-royce';
  }
  if (brand === 'seat') return 'seat';
  if (brand === 'skoda') return 'skoda';
  if (brand === 'cupra') return 'cupra';

  return brand;
}

/**
 * Display-friendly brand from a raw or normalized value.
 */
export function displayBrand(rawBrand: string): string {
  const norm = normalizeBrand(rawBrand);
  if (norm === 'bmw') return 'BMW';
  if (norm === 'volkswagen') return 'Volkswagen';
  if (norm === 'mercedes-benz') return 'Mercedes-Benz';
  if (norm === 'seat') return 'Seat';
  if (!rawBrand.trim()) return rawBrand;
  const trimmed = rawBrand.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/**
 * Canonical lowercase model key for indexed lookups.
 * Folds accents ("León" → "leon"), hyphens, and EN/ES series/class aliases
 * so "4 Series" / "serie 4" / "4er" share one key.
 */
export function normalizeModel(rawModel: string | null | undefined): string {
  if (!rawModel) return '';
  const soft = stripDiacritics(String(rawModel).trim().toLowerCase())
    .replace(/[_/]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!soft || soft === 'unknown') return '';
  return canonicalizeModelKey(soft);
}

/**
 * Map EN/DE portal spellings onto a single catalog-style key (ES series/class).
 * Input must already be lowercase / soft-normalized.
 */
export function canonicalizeModelKey(n: string): string {
  if (!n) return '';

  const serieEn = n.match(/^(\d)\s*series$/) || n.match(/^series\s*(\d)$/);
  if (serieEn?.[1]) return `serie ${serieEn[1]}`;

  const serieEs = n.match(/^serie\s*(\d)$/);
  if (serieEs?.[1]) return `serie ${serieEs[1]}`;

  // German "1er" / "3er" / "4er"
  const er = n.match(/^(\d)\s*er$/);
  if (er?.[1]) return `serie ${er[1]}`;

  const cls =
    n.match(/^([a-z])\s+class$/) ||
    n.match(/^([a-z])\s+klasse$/) ||
    n.match(/^clase\s+([a-z])$/);
  if (cls?.[1]) return `clase ${cls[1]}`;

  if (n === 'g wagon' || n === 'gwagen' || n === 'g wagen') return 'clase g';

  return n;
}

/** Title-case display from a normalized model key. */
export function displayModel(rawModel: string | null | undefined): string {
  const norm = normalizeModel(rawModel);
  if (!norm) return '';
  return norm
    .split(' ')
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Reject junk model labels from scrapers (e.g. "-", "?", ".") that break filters UX. */
export function isUsableModelLabel(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const t = raw.trim();
  if (!t) return false;
  if (t === '-' || t === '—' || t === '–' || t === '.' || t === '?' || t === 'n/a' || t === 'na') {
    return false;
  }
  return /[a-z0-9]/i.test(t);
}

/** Transmission / generic words — not useful as trim/engine tokens. */
const VERSION_NOISE = new Set([
  's-tronic', 'stronic', 'dsg', 'manual', 'automatic', 'tiptronic', 'multitronic',
  'cvt', 'auto', 'getriebe', 'petrol', 'diesel', 'benzine', 'benzin', 'essence',
  'elektro', 'unknown', 'n/a', 'na'
]);

/**
 * Extracts searchable lowercase tokens from a free-text version/spec string.
 * Used for multi-spec OR matching without ILIKE on the hot path.
 *
 * Keeps engine family (tdi/tsi/…) and displacement (1.2, 2.0).
 * If filtering would leave nothing, falls back to the cleaned full version
 * so listings never sit with version text but empty versionTokens.
 */
export function extractVersionTokens(version: string | null | undefined): string[] {
  if (!version) return [];

  let cleaned = version
    .toLowerCase()
    // EU decimals: "1,2" / "2,0 TDI" → "1.2" / "2.0 tdi"
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/\d+\s*(cv|ch|hp|ps|kw|bhp)\b/gi, ' ')
    // Keep letters, digits, spaces, hyphens, and dots (displacements like 2.0)
    .replace(/[^\p{L}\p{N}\s.\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return [];

  const tokens = new Set<string>();
  const parts = cleaned.split(' ').filter(Boolean);

  for (const part of parts) {
    if (part.length < 2) continue;
    if (VERSION_NOISE.has(part)) continue;
    tokens.add(part);
  }

  // Useful bigrams (e.g. "s-line", "m sport") — skip if either side is pure noise
  for (let i = 0; i < parts.length - 1; i++) {
    const a = parts[i]!;
    const b = parts[i + 1]!;
    if (VERSION_NOISE.has(a) || VERSION_NOISE.has(b)) continue;
    if (a.length < 2 || b.length < 2) continue;
    const bigram = `${a} ${b}`;
    if (bigram.length <= 24) tokens.add(bigram);
  }

  // Never leave empty when version had real text (e.g. was only "1.2" / "2.0 tdi" before)
  if (tokens.size === 0) {
    tokens.add(cleaned);
  }

  return Array.from(tokens);
}

/**
 * Prefer stored versionTokens; if empty, derive from version text (legacy rows).
 * Use on read paths so empty [] does not hide usable version data.
 */
export function resolveVersionTokens(
  version: string | null | undefined,
  stored?: string[] | null
): string[] {
  if (stored && stored.length > 0) {
    return stored.map((t) => t.toLowerCase().trim()).filter(Boolean);
  }
  return extractVersionTokens(version);
}

/**
 * Normalize a user-selected spec string into a comparable token key.
 */
export function normalizeSpecToken(spec: string | null | undefined): string {
  if (!spec) return '';
  return spec.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalizes the fuel type to standard English values.
 * IMPORTANT: never map bare "gas" → LPG (Spanish "gasóleo", random "gas…" → false LPG).
 */
export function normalizeFuelType(rawFuel: string | null | undefined): string {
  if (!rawFuel) return 'Unknown';

  const fuel = rawFuel.toLowerCase().trim();

  // Diesel first (includes Spanish gasóleo / gasoil — contain "gas" but are NOT LPG)
  if (
    fuel.includes('diesel') ||
    fuel.includes('gasóleo') ||
    fuel.includes('gasoleo') ||
    fuel.includes('gasoil') ||
    fuel.includes('tdi') ||
    fuel.includes('hdi') ||
    fuel.includes('dci') ||
    fuel.includes('bluehdi')
  ) {
    return 'Diesel';
  }

  if (
    fuel.includes('hybrid') ||
    fuel.includes('híbrid') ||
    fuel.includes('electro/petrol') ||
    fuel.includes('electro/diesel') ||
    fuel.includes('plug-in') ||
    fuel.includes('phev')
  ) {
    return 'Hybrid';
  }

  if (
    fuel.includes('electric') ||
    fuel.includes('eléctrico') ||
    fuel.includes('electrico') ||
    fuel.includes('elektro') ||
    fuel.includes('elektrisch') ||
    fuel === 'ev' ||
    fuel.includes('bev')
  ) {
    return 'Electric';
  }

  // Petrol / gasoline (must stay BEFORE any LPG rule)
  if (
    fuel.includes('petrol') ||
    fuel.includes('gasoline') ||
    fuel.includes('gasolina') ||
    fuel.includes('benzin') ||
    fuel.includes('essence') ||
    fuel.includes('nafta') ||
    fuel.includes('otto') ||
    fuel === 'gas' // some UIs abbreviate gasoline as "Gas"
  ) {
    return 'Petrol';
  }

  // LPG / CNG — explicit tokens only (no bare "gas")
  if (
    fuel.includes('lpg') ||
    fuel.includes('gpl') ||
    fuel.includes('autogas') ||
    fuel.includes('auto-gas') ||
    fuel.includes('auto gas') ||
    fuel.includes('cng') ||
    fuel.includes('gnc') ||
    fuel.includes('glp')
  ) {
    return 'LPG';
  }

  return 'Unknown';
}

/**
 * Normalizes the transmission type to standard English values (Manual / Automatic).
 */
export function normalizeTransmission(rawTrans: string | null | undefined): string {
  if (!rawTrans) return 'Unknown';
  
  const trans = rawTrans.toLowerCase().trim();
  
  if (
    trans.includes('auto') ||
    trans.includes('dsg') ||
    trans.includes('pdks') ||
    trans.includes('tiptronic') ||
    trans.includes('steptronic') ||
    trans.includes('s-tronic')
  ) {
    return 'Automatic';
  }
  
  if (
    trans.includes('manual') ||
    trans.includes('manuell') ||
    trans.includes('manuelle') ||
    trans.includes('schalt') // Schaltgetriebe
  ) {
    return 'Manual';
  }
  
  return 'Unknown';
}

/**
 * Sanitizes a numeric price:
 * - If it is a single digit (1-9), it is interpreted as thousands (e.g., 5 → 5000).
 * - If it is absurdly large (> 5,000,000), it returns null (corrupt data like 2.4e+32).
 * - If it is 0 or negative, it returns null.
 */
export function sanitizePrice(price: number): number | null {
  if (!price || price <= 0 || !isFinite(price) || isNaN(price)) return null;
  
  // Only discard clearly corrupt data (e.g., 2.4e+32, phone numbers, etc.)
  // Luxury cars can be worth millions, so we don't set a low limit.
  // > 1 billion (1e9) is clearly a parsing error, not a real price.
  if (price > 1_000_000_000) return null;
  
  // Single digit (1-9) → interpret as thousands
  if (price >= 1 && price <= 9) {
    return price * 1000;
  }
  
  // Two digits that seem anomalous for a car (10-99) → interpret as thousands
  // E.g., 25 → 25000, 15 → 15000 (car prices are never 25€)
  if (price >= 10 && price <= 99) {
    return price * 1000;
  }
  
  // Three digits (100-999) → also suspicious, but could be legitimate for very cheap cars
  // We only multiply if it is <= 500 (500 → 500000 does not make sense, but 250 → 250€ neither)
  // We leave the three digits as they are (there may be cars at 500€, 999€)
  
  return price;
}

/**
 * Verifies that a listing has a valid brand and model.
 * Returns false if any are missing or have a placeholder value.
 */
export function isValidListing(brand: string | null | undefined, model: string | null | undefined): boolean {
  const invalidValues = new Set([
    '', 'unknown', 'n/a', 'na', 'null', 'undefined', '-', 'none'
  ]);
  
  if (!brand || invalidValues.has(brand.toLowerCase().trim())) return false;
  if (!model || invalidValues.has(model.toLowerCase().trim())) return false;
  
  return true;
}
