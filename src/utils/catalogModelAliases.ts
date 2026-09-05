/**
 * Catalog model key coherence: portals often use EN names ("1 Series", "A-Class")
 * while car-specifications.json / engine-catalog.json use ES ("Serie 1", "Clase A").
 *
 * Strategy:
 * 1. softNorm — lowercase, strip accents, collapse spaces/hyphens
 * 2. resolveCatalogModelKey / normalizeModel — map EN → ES canonical key
 * 3. expandCatalogModelAliases — every key a catalog entry should be registered under
 *    so both index build and lookups stay coherent without renaming JSON.
 */
import { canonicalizeModelKey, normalizeModel, stripDiacritics } from './normalizer.js';

/** Lowercase + accents off + hyphens → spaces (portal-friendly). */
export function softModelNorm(raw: string | null | undefined): string {
  if (!raw) return '';
  return stripDiacritics(String(raw).trim().toLowerCase())
    .replace(/[_/]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Map portal / EN model names onto canonical catalog keys (same as normalizeModel).
 * Used by matching, specs catalog, and AI fuzzy search.
 */
export function resolveCatalogModelKey(rawModel: string | null | undefined): string {
  return normalizeModel(rawModel);
}

/**
 * All index keys that should point to the same catalog row as `canonical`
 * (already soft-normalized catalog JSON key, e.g. "serie 1" / "clase a").
 */
export function expandCatalogModelAliases(canonicalRaw: string): string[] {
  const soft = softModelNorm(canonicalRaw);
  const canonical = canonicalizeModelKey(soft) || soft;
  if (!canonical) return [];

  const keys = new Set<string>([canonical, soft, normalizeModel(canonicalRaw)]);

  const serie = canonical.match(/^serie\s+(\d)$/);
  if (serie?.[1]) {
    const d = serie[1];
    keys.add(`serie ${d}`);
    keys.add(`${d} series`);
    keys.add(`series ${d}`);
    keys.add(`${d}er`);
    keys.add(`${d} er`);
  }

  const clase = canonical.match(/^clase\s+([a-z])$/);
  if (clase?.[1]) {
    const l = clase[1];
    keys.add(`clase ${l}`);
    keys.add(`${l} class`);
    keys.add(`${l} klasse`);
    keys.add(`class ${l}`);
    if (l === 'g') {
      keys.add('g wagon');
      keys.add('gwagen');
      keys.add('g wagen');
    }
  }

  // If catalog were ever stored in EN form, still expand
  const seriesEn = soft.match(/^(\d)\s+series$/) || soft.match(/^series\s+(\d)$/);
  if (seriesEn?.[1]) {
    const d = seriesEn[1];
    keys.add(`serie ${d}`);
    keys.add(`${d} series`);
    keys.add(`series ${d}`);
  }

  const classEn = soft.match(/^([a-z])\s+class$/);
  if (classEn?.[1]) {
    keys.add(`clase ${classEn[1]}`);
    keys.add(`${classEn[1]} class`);
    keys.add(`${classEn[1]} klasse`);
  }

  return [...keys].filter(Boolean);
}

/**
 * Keys to try when looking up a user/portal model against a catalog index.
 */
export function catalogModelLookupKeys(rawModel: string | null | undefined): string[] {
  const soft = softModelNorm(rawModel);
  const resolved = resolveCatalogModelKey(rawModel);
  const keys = new Set<string>([
    soft,
    resolved,
    normalizeModel(rawModel || ''),
    ...expandCatalogModelAliases(resolved),
    ...expandCatalogModelAliases(soft)
  ]);
  return [...keys].filter(Boolean);
}
