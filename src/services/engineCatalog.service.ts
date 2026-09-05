/**
 * Official engine catalog (displacement / family / typical CV) for enriching
 * CarListing.engine + powerHp from the free-text `version` field.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { normalizeBrand, stripDiacritics } from '../utils/normalizer.js';
import {
  catalogModelLookupKeys,
  expandCatalogModelAliases,
  softModelNorm
} from '../utils/catalogModelAliases.js';
import { parsePowerCv } from '../utils/power.js';

export interface EngineCatalogEntry {
  engine: string;
  aliases: string[];
  /** Typical official metric CV for this engine variant. */
  powerCv: number;
}

type RawCatalog = Record<string, Record<string, EngineCatalogEntry[]>>;

const __dirname = dirname(fileURLToPath(import.meta.url));

let raw: RawCatalog | null = null;
/** brandNorm → modelNorm → entries */
let index: Map<string, Map<string, EngineCatalogEntry[]>> | null = null;

function loadRaw(): RawCatalog {
  if (raw) return raw;
  const path = join(__dirname, '../data/engine-catalog.json');
  raw = JSON.parse(readFileSync(path, 'utf8')) as RawCatalog;
  return raw;
}

function buildIndex(): Map<string, Map<string, EngineCatalogEntry[]>> {
  if (index) return index;
  const catalog = loadRaw();
  const map = new Map<string, Map<string, EngineCatalogEntry[]>>();

  for (const [brand, models] of Object.entries(catalog)) {
    const b = normalizeBrand(brand);
    if (!b) continue;
    let modelMap = map.get(b);
    if (!modelMap) {
      modelMap = new Map();
      map.set(b, modelMap);
    }
    for (const [model, entries] of Object.entries(models)) {
      if (!Array.isArray(entries)) continue;
      const mapped = entries.map((e) => ({
        engine: e.engine,
        aliases: (e.aliases || []).map((a) => normText(a)).filter(Boolean),
        powerCv: e.powerCv
      }));
      const canonical = softModelNorm(model);
      if (!canonical) continue;
      for (const key of expandCatalogModelAliases(canonical)) {
        if (!modelMap.has(key)) {
          modelMap.set(key, mapped);
        }
      }
    }
  }

  index = map;
  return map;
}

export function normText(s: string): string {
  return stripDiacritics(String(s).toLowerCase())
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Canonical engineNorm for storage / matching.
 * Strips bogus leading "0 " / "0.0 " produced by bad parses of "30 TFSI" → "0 TFSI".
 * Result: "0 tfsi" → "tfsi", "1.0 tfsi" unchanged, "30 tfsi" unchanged.
 */
export function normalizeEngineKey(label: string): string {
  let s = normText(label);
  // Lone leading zero (not "10 tfsi" / "30 tfsi") before a family token
  s = s.replace(/^0(?:\.0)?(?=\s)/, '').replace(/^\s+/, '');
  return s.trim();
}

/** Pretty label for Telegram UI: "tfsi" → "TFSI", "1.0 tfsi" → "1.0 TFSI". */
export function formatEngineLabel(label: string): string {
  const n = normalizeEngineKey(label);
  if (!n) return '';
  return n
    .split(/\s+/)
    .map((part) => {
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      if (/^bluehdi$/i.test(part)) return 'BlueHDi';
      if (/^ecoboost$/i.test(part)) return 'EcoBoost';
      if (/^ecoblue$/i.test(part)) return 'EcoBlue';
      if (/^puretech$/i.test(part)) return 'PureTech';
      if (/^boosterjet$/i.test(part)) return 'Boosterjet';
      if (/^skyactiv$/i.test(part)) return 'Skyactiv';
      if (/^multijet$/i.test(part)) return 'MultiJet';
      if (/^twinpower$/i.test(part)) return 'TwinPower';
      if (/^e-tech$/i.test(part)) return 'E-Tech';
      if (/^t-gdi$/i.test(part)) return 'T-GDI';
      if (/^vvt-?i$/i.test(part)) return 'VVT-i';
      return part.toUpperCase();
    })
    .join(' ');
}

/**
 * Values to use in Prisma `engineNorm: { in: [...] }` so a filter of "tfsi"
 * still matches legacy rows stored as "0 tfsi".
 */
export function expandEngineNormQueryValues(engines: string[]): string[] {
  const out = new Set<string>();
  for (const raw of engines) {
    const n = normalizeEngineKey(raw);
    if (!n) continue;
    out.add(n);
    // Legacy bad norms from the old heuristic
    if (!/^\d/.test(n)) {
      out.add(`0 ${n}`);
      out.add(`0.0 ${n}`);
    }
  }
  return [...out];
}

function formatFamilyToken(code: string): string {
  return formatEngineLabel(code);
}

export function getCatalogEngines(
  brand?: string | null,
  model?: string | null
): EngineCatalogEntry[] {
  if (!brand || !model) return [];
  const idx = buildIndex();
  const brandMap = idx.get(normalizeBrand(brand));
  if (!brandMap) return [];

  for (const key of catalogModelLookupKeys(model)) {
    const hit = brandMap.get(key);
    if (hit?.length) return [...hit];
  }

  const soft = softModelNorm(model);
  let best: EngineCatalogEntry[] | null = null;
  let bestLen = -1;
  for (const [key, entries] of brandMap) {
    if (
      soft === key ||
      soft.startsWith(`${key} `) ||
      key.startsWith(`${soft} `)
    ) {
      if (key.length > bestLen) {
        bestLen = key.length;
        best = entries;
      }
    }
  }
  return best ? [...best] : [];
}

/** Family tokens we recognise next to a displacement (1.0 TFSI, 1.5 BlueHDi…). */
const ENGINE_FAMILY_RE =
  /tfsi|tdi|tsi|tdci|dci|hdi|bluehdi|ecoboost|ecoblue|puretech|tce|sce|gdi|mpi|vvt-?i|hybrid|etsi|boosterjet|skyactiv|multijet|firefly|twinpower|boxer|dig-t|crdi|t-gdi|e-tech/i;

/**
 * Preferred petrol/diesel family order when the listing only says "1.0" / "2.0".
 * First match among catalog candidates for that displacement wins.
 */
const BRAND_FAMILY_PREFS: Record<string, string[]> = {
  audi: ['tfsi', 'tdi', 'tsi'],
  volkswagen: ['tsi', 'tdi', 'etsi', 'mpi'],
  seat: ['tsi', 'tdi', 'mpi'],
  cupra: ['etsi', 'tsi', 'tdi'],
  skoda: ['tsi', 'tdi', 'mpi'],
  peugeot: ['puretech', 'bluehdi', 'hdi'],
  citroen: ['puretech', 'bluehdi', 'hdi'],
  'ds automobiles': ['puretech', 'bluehdi', 'hdi'],
  opel: ['turbo', 'diesel'],
  vauxhall: ['turbo', 'diesel'],
  renault: ['tce', 'sce', 'dci', 'e-tech', 'hybrid'],
  dacia: ['tce', 'sce', 'dci'],
  ford: ['ecoboost', 'ecoblue', 'tdci'],
  toyota: ['hybrid', 'vvt-i'],
  lexus: ['hybrid'],
  honda: ['vtec', 'hybrid'],
  hyundai: ['t-gdi', 'gdi', 'crdi', 'hybrid'],
  kia: ['t-gdi', 'gdi', 'crdi', 'hybrid'],
  nissan: ['dig-t', 'dci', 'e-power', 'hybrid'],
  mazda: ['skyactiv-g', 'skyactiv-d', 'skyactiv'],
  fiat: ['firefly', 'multijet', 'hybrid', 't-jet'],
  'alfa romeo': ['hybrid', 'multijet', 'turbo'],
  jeep: ['turbo', 'multijet'],
  suzuki: ['boosterjet', 'dualjet', 'hybrid'],
  mitsubishi: ['turbo', 'hybrid', 'diesel'],
  volvo: ['b3', 'b4', 'b5', 't5', 't6', 'd4'],
  mini: ['twinpower'],
  porsche: ['turbo'],
  mercedes: [],
  'mercedes-benz': [],
  bmw: []
};

const DEFAULT_FAMILY_PREFS = [
  'tfsi',
  'tsi',
  'etsi',
  'ecoboost',
  'puretech',
  'tce',
  't-gdi',
  'turbo',
  'hybrid',
  'tdi',
  'dci',
  'bluehdi',
  'ecoblue',
  'tdci',
  'mpi',
  'sce'
];

function isBareDisplacementToken(alias: string): boolean {
  return /^\d\.\d$/.test(alias);
}

function versionHasEngineFamily(hay: string): boolean {
  return new RegExp(`\\b\\d(?:\\.\\d)?\\s*(?:${ENGINE_FAMILY_RE.source})\\b`, 'i').test(
    hay
  );
}

/** Bare "1.0" / "2.0" in version when no family code is present. */
export function extractBareDisplacement(version?: string | null): string | null {
  if (!version) return null;
  const hay = normText(version);
  if (!hay || versionHasEngineFamily(hay)) return null;
  // Prefer explicit BMW / Merc codes over inventing displacement families
  if (/\b((?:a|c|e|gla|glb|glc|gle)\s?\d{2,3}\s?d?|[1-8]\d{2}[di])\b/i.test(hay)) {
    return null;
  }
  const m = hay.match(/\b(\d\.\d)\b/);
  return m?.[1] ?? null;
}

function familyTokenOf(engineLabel: string): string {
  const n = normalizeEngineKey(engineLabel);
  const m = n.match(ENGINE_FAMILY_RE);
  return m?.[0]?.toLowerCase().replace(/vvt-i/, 'vvt-i') ?? '';
}

function displacementOf(engineLabel: string): string | null {
  const m = normalizeEngineKey(engineLabel).match(/^(\d\.\d)\b/);
  return m?.[1] ?? null;
}

function catalogHitsForDisplacement(
  catalog: EngineCatalogEntry[],
  disp: string
): EngineCatalogEntry[] {
  return catalog.filter((entry) => {
    if (displacementOf(entry.engine) === disp) return true;
    return entry.aliases.some(
      (a) => a === disp || a.startsWith(`${disp} `) || displacementOf(a) === disp
    );
  });
}

/**
 * Map a lone displacement ("1.0") to the catalog engine that best fits the brand.
 * Audi 1.0 → 1.0 TFSI; VW 1.0 → 1.0 TSI (not MPI) when both exist.
 * If several families remain ambiguous and there is no CV hint → null (leave empty).
 */
export function resolveBareDisplacement(
  brand: string,
  catalog: EngineCatalogEntry[],
  disp: string,
  powerHint: number | null
): EngineCatalogEntry | null {
  const candidates = catalogHitsForDisplacement(catalog, disp);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0]!;

  if (powerHint && powerHint > 20) {
    let best = candidates[0]!;
    let bestDelta = Math.abs((best.powerCv || 0) - powerHint);
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i]!;
      const d = Math.abs((c.powerCv || 0) - powerHint);
      if (d < bestDelta) {
        best = c;
        bestDelta = d;
      }
    }
    return best;
  }

  const brandKey = normalizeBrand(brand);
  const prefs = [
    ...(BRAND_FAMILY_PREFS[brandKey] || []),
    ...DEFAULT_FAMILY_PREFS
  ];
  const seen = new Set<string>();
  for (const fam of prefs) {
    if (!fam || seen.has(fam)) continue;
    seen.add(fam);
    const hits = candidates.filter((c) => {
      const tok = familyTokenOf(c.engine);
      const label = normalizeEngineKey(c.engine);
      return tok === fam || label.includes(fam);
    });
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      // Same family, different CV variants (25/30 TFSI) — keep first catalog entry
      return hits[0]!;
    }
  }

  // All candidates share one family token?
  const families = new Set(
    candidates.map((c) => familyTokenOf(c.engine)).filter(Boolean)
  );
  if (families.size === 1) return candidates[0]!;

  return null;
}

/**
 * Heuristic engine label from version text when the catalog has no hit.
 * Captures patterns like "1.4 TFSI", "2.0 TDI", "1.5 BlueHDi".
 * Bare "1.0" alone is NOT invented here — use resolveBareDisplacement + catalog.
 *
 * Important: require a decimal displacement (`1.0 TFSI`). A looser `\d(?:\.\d)?`
 * matched the trailing `0` of Audi/VW codes (`30 TFSI` → bogus `0 TFSI`).
 */
export function extractEngineHeuristic(version?: string | null): {
  engine: string;
  engineNorm: string;
} | null {
  if (!version) return null;
  const hay = normText(version);

  const fam =
    'tfsi|tdi|tsi|tdci|dci|hdi|bluehdi|ecoboost|ecoblue|puretech|tce|sce|gdi|mpi|vvt-?i|hybrid|etsi';

  // Real displacement: "1.0 TFSI", "2.0 TDI", "1.5 BlueHDi"
  const withDisp = hay.match(new RegExp(`\\b(\\d\\.\\d)\\s*(${fam})\\b`, 'i'));
  if (withDisp) {
    const engine = `${withDisp[1]} ${formatFamilyToken(withDisp[2]!)}`;
    return { engine, engineNorm: normalizeEngineKey(engine) };
  }

  // Audi/VW marketing power codes: "30 TFSI", "40 TDI" (never leading 0)
  const marketing = hay.match(/\b([1-9]\d)\s*(tfsi|tdi|tsi|etsi)\b/i);
  if (marketing) {
    const engine = `${marketing[1]} ${formatFamilyToken(marketing[2]!)}`;
    return { engine, engineNorm: normalizeEngineKey(engine) };
  }

  // BMW / Mercedes / JLR-style codes when present (520d, C 220d, D300, P250)
  const codeName = hay.match(
    /\b((?:a|c|e|gla|glb|glc|gle)\s?\d{2,3}\s?d?|[1-8]\d{2}[di]|[dptbm]\d{2,3})\b/i
  );
  if (codeName?.[1]) {
    const label = codeName[1].replace(/\s+/g, ' ').trim().toUpperCase();
    if (label.length >= 3) {
      return { engine: label, engineNorm: normalizeEngineKey(label) };
    }
  }

  // Conservative fallback: keep only obvious displacement cases with extra cues.
  // Example accepted: "range rover sport d300 3.0" => "3.0".
  // Example rejected: "1.2 allure" (trim token only, no engine cue).
  const bareDisp = hay.match(/\b([1-9]\.\d)\b/);
  if (bareDisp) {
    const hasEngineCue =
      /\b(?:diesel|petrol|gasoline|hybrid|mhev|phev|hev|cdi|dci|tdi|tfsi|tsi|tce|gdi|crdi|hdi|bluehdi|turbo|boxer|v-?6|v-?8|v-?10|v-?12|w-?12|w-?16|[dptbm]\d{2,3})\b/i.test(
        hay
      );
    if (hasEngineCue) {
      const vEngine = hay.match(/\bv-?(6|8|10|12)\b/i);
      const wEngine = hay.match(/\bw-?(12|16)\b/i);
      const suffix = vEngine
        ? ` V${vEngine[1]}`
        : wEngine
          ? ` W${wEngine[1]}`
          : '';
      const engine = `${bareDisp[1]!}${suffix}`;
      return { engine, engineNorm: normalizeEngineKey(engine) };
    }
  }

  // Bare "V8" / "V6" style mention without a decimal displacement
  // ("corvette v8", "silverado v8 6.2l" already handled above).
  const bareV = hay.match(/\bv-?(6|8|10|12)\b/i);
  if (bareV) {
    const engine = `V${bareV[1]}`;
    return { engine, engineNorm: normalizeEngineKey(engine) };
  }

  return null;
}

export interface EngineMatch {
  engine: string;
  engineNorm: string;
  powerCv: number | null;
  source: 'catalog' | 'heuristic';
}

function toCatalogMatch(
  entry: EngineCatalogEntry,
  powerCv: number | null
): EngineMatch {
  return {
    engine: entry.engine,
    engineNorm: normalizeEngineKey(entry.engine),
    powerCv: powerCv || entry.powerCv || null,
    source: 'catalog'
  };
}

/**
 * Match a listing's version text against the official engine catalog,
 * falling back to a heuristic parse. Also tries to read an explicit CV/kW
 * from the version string.
 *
 * Bare displacement ("1.0" without TFSI/TSI/…) is resolved via the catalog +
 * brand family prefs (Audi → TFSI, VW → TSI, …). If still ambiguous → empty.
 */
export function resolveEngineFromVersion(params: {
  brand: string;
  model: string;
  version?: string | null;
  existingPowerHp?: number | null;
}): EngineMatch | null {
  const hay = normText(params.version || '');
  const catalog = getCatalogEngines(params.brand, params.model);

  const parsedPower = parsePowerCv(params.version || '');
  const existing =
    params.existingPowerHp && params.existingPowerHp > 20
      ? params.existingPowerHp
      : null;
  const powerHint = existing || parsedPower;

  // 1) Strong aliases only (skip naked "1.0" — handled in step 2)
  let best: { entry: EngineCatalogEntry; aliasLen: number } | null = null;
  for (const entry of catalog) {
    for (const alias of entry.aliases) {
      if (!alias || alias.length < 2) continue;
      if (isBareDisplacementToken(alias)) continue;
      if (hay.includes(alias) && (!best || alias.length > best.aliasLen)) {
        best = { entry, aliasLen: alias.length };
      }
    }
    const engNorm = normalizeEngineKey(entry.engine);
    if (
      !isBareDisplacementToken(engNorm) &&
      hay.includes(engNorm) &&
      (!best || engNorm.length > best.aliasLen)
    ) {
      best = { entry, aliasLen: engNorm.length };
    }
  }

  if (best) {
    return toCatalogMatch(best.entry, powerHint);
  }

  // 2) Bare "1.0" → preferred family for this brand/model in the catalog
  const bareDisp = extractBareDisplacement(params.version);
  if (bareDisp && catalog.length) {
    const candidates = catalogHitsForDisplacement(catalog, bareDisp);
    if (candidates.length) {
      const resolved = resolveBareDisplacement(
        params.brand,
        catalog,
        bareDisp,
        powerHint
      );
      if (resolved) {
        return toCatalogMatch(resolved, powerHint);
      }
      // Genuinely ambiguous among real catalog candidates: better empty
      // than inventing a label (e.g. two 25/30-badge TFSI variants).
      if (powerHint) {
        return {
          engine: '',
          engineNorm: '',
          powerCv: powerHint,
          source: 'heuristic'
        };
      }
      return null;
    }
    // This displacement simply isn't covered by the (necessarily incomplete)
    // per-model catalog list — e.g. a V8/diesel trim not templated for this
    // model. Fall through to the generic heuristic below instead of
    // silently dropping a real, well-formed engine mention.
  }

  // 3) Heuristic with explicit family / BMW-Merc codes (never bare "1.0")
  const heur = extractEngineHeuristic(params.version);
  if (!heur) {
    if (powerHint) {
      return {
        engine: '',
        engineNorm: '',
        powerCv: powerHint,
        source: 'heuristic'
      };
    }
    return null;
  }

  return {
    engine: heur.engine,
    engineNorm: heur.engineNorm,
    powerCv: powerHint,
    source: 'heuristic'
  };
}
