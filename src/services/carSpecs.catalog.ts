import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { normalizeBrand, stripDiacritics, resolveVersionTokens } from '../utils/normalizer.js';
import {
  catalogModelLookupKeys,
  expandCatalogModelAliases,
  softModelNorm
} from '../utils/catalogModelAliases.js';

type SpecCatalog = Record<string, Record<string, string[]>>;

const __dirname = dirname(fileURLToPath(import.meta.url));

let catalogRaw: SpecCatalog | null = null;
/** brandNorm → (modelNorm → canonical trim labels) */
let catalogIndex: Map<string, Map<string, string[]>> | null = null;

function loadCatalog(): SpecCatalog {
  if (catalogRaw) return catalogRaw;
  const path = join(__dirname, '../data/car-specifications.json');
  catalogRaw = JSON.parse(readFileSync(path, 'utf8')) as SpecCatalog;
  return catalogRaw;
}

function buildIndex(): Map<string, Map<string, string[]>> {
  if (catalogIndex) return catalogIndex;
  const raw = loadCatalog();
  const index = new Map<string, Map<string, string[]>>();

  for (const [brand, models] of Object.entries(raw)) {
    const brandNorm = normalizeBrand(brand);
    if (!brandNorm) continue;
    let modelMap = index.get(brandNorm);
    if (!modelMap) {
      modelMap = new Map();
      index.set(brandNorm, modelMap);
    }
    for (const [model, specs] of Object.entries(models)) {
      const labels = Array.isArray(specs)
        ? specs.map((s) => String(s).trim()).filter(Boolean)
        : [];
      if (!labels.length) continue;
      const canonical = softModelNorm(model);
      if (!canonical) continue;
      // Register ES catalog key + EN portal aliases (1 Series, A-Class, …)
      for (const key of expandCatalogModelAliases(canonical)) {
        if (!modelMap.has(key)) {
          modelMap.set(key, labels);
        }
      }
    }
  }

  catalogIndex = index;
  return index;
}

/**
 * Canonical trim list for a brand+model from car-specifications.json.
 * Empty if the pair is not in the catalog.
 */
export function getCatalogSpecs(
  brand?: string | null,
  model?: string | null
): string[] {
  if (!brand || !model) return [];
  const index = buildIndex();
  const brandMap = index.get(normalizeBrand(brand));
  if (!brandMap) return [];

  for (const key of catalogModelLookupKeys(model)) {
    const hit = brandMap.get(key);
    if (hit?.length) return [...hit];
  }

  // Longest catalog model that shares a prefix (Leon ↔ Leon Sportstourer)
  const soft = softModelNorm(model);
  let best: string[] | null = null;
  let bestLen = -1;
  for (const [key, specs] of brandMap) {
    if (
      soft === key ||
      soft.startsWith(`${key} `) ||
      key.startsWith(`${soft} `)
    ) {
      if (key.length > bestLen) {
        bestLen = key.length;
        best = specs;
      }
    }
  }
  return best ? [...best] : [];
}

function normHaystack(text: string): string {
  return stripDiacritics(text.toLowerCase())
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildHaystack(
  version?: string | null,
  versionTokens?: string[] | null
): string {
  const parts = [
    version || '',
    ...(versionTokens ?? []),
    ...resolveVersionTokens(version, versionTokens)
  ];
  return normHaystack(parts.join(' '));
}

/**
 * Does listing text match a catalog trim label?
 * Short labels (V, S, T, R…) require word boundaries so "V" ≠ "VZ".
 */
export function catalogSpecMatchesHaystack(spec: string, haystack: string): boolean {
  const needle = normHaystack(spec);
  if (!needle || !haystack) return false;

  // Hyphen/space variants: e-hybrid ↔ e hybrid ↔ ehybrid
  const compact = needle.replace(/[\s\-]+/g, '');
  const hayCompact = haystack.replace(/[\s\-]+/g, '');

  if (needle.length <= 2) {
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:[^a-z0-9]|$)`, 'i');
    return re.test(haystack);
  }

  if (haystack.includes(needle)) return true;
  if (compact.length >= 3 && hayCompact.includes(compact)) return true;
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which catalog specs does this listing belong to?
 * Unmatched (except Base default) → [] meaning "Any only".
 * Base: explicit "base" in text, or no other catalog trim matched.
 */
export function resolveListingCatalogSpecs(
  brand?: string | null,
  model?: string | null,
  version?: string | null,
  versionTokens?: string[] | null
): string[] {
  const catalog = getCatalogSpecs(brand, model);
  if (catalog.length === 0) return [];

  const haystack = buildHaystack(version, versionTokens);
  const nonBase = catalog.filter((s) => normHaystack(s) !== 'base');
  const matched = nonBase.filter((s) => catalogSpecMatchesHaystack(s, haystack));

  const hasBase = catalog.some((s) => normHaystack(s) === 'base');
  if (matched.length === 0 && hasBase) {
    // No trim signal → Base group (still searchable when user picks Base)
    return catalog.filter((s) => normHaystack(s) === 'base');
  }

  // Prefer more specific (longer) labels when several hit
  matched.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return matched;
}

/**
 * True if listing matches any of the user-selected catalog specs.
 * Empty selection → all listings (including unmapped / Any).
 */
export function listingMatchesSelectedCatalogSpecs(
  brand: string | null | undefined,
  model: string | null | undefined,
  version: string | null | undefined,
  versionTokens: string[] | null | undefined,
  selectedSpecs: string[]
): boolean {
  if (!selectedSpecs.length) return true;

  const haystack = buildHaystack(version, versionTokens);
  const catalog = getCatalogSpecs(brand, model);
  const selected = selectedSpecs.map((s) => s.trim()).filter(Boolean);
  if (selected.length === 0) return true;

  // Direct text match against selected labels
  if (selected.some((s) => catalogSpecMatchesHaystack(s, haystack))) {
    return true;
  }

  // Base special-case: no other catalog trim present
  const pickedBase = selected.some((s) => normHaystack(s) === 'base');
  if (pickedBase && catalog.length > 0) {
    const nonBase = catalog.filter((s) => normHaystack(s) !== 'base');
    const hitOther = nonBase.some((s) => catalogSpecMatchesHaystack(s, haystack));
    if (!hitOther) return true;
  }

  return false;
}
