/**
 * Flexible brand/model matching for AI free-text search.
 * Tolerates typos, missing letters, compacted multi-word names, and
 * extra/missing intermediate tokens (e.g. "Leon FR" ↔ "leon").
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { normalizeBrand, normalizeModel, stripDiacritics } from './normalizer.js';
import {
  resolveCatalogModelKey,
  softModelNorm
} from './catalogModelAliases.js';

type SpecCatalog = Record<string, Record<string, string[]>>;

const __dirname = dirname(fileURLToPath(import.meta.url));

let catalogCache: SpecCatalog | null = null;
let brandNormList: string[] | null = null;
/** brandNorm → unique soft model keys (canonical + aliases not needed; soft keys from JSON) */
let modelsByBrand: Map<string, string[]> | null = null;

/** Explicit short / slang aliases → brandNorm (after normalizeBrand). */
const BRAND_ALIASES: Record<string, string> = {
  vw: 'volkswagen',
  volk: 'volkswagen',
  volks: 'volkswagen',
  merc: 'mercedes-benz',
  benz: 'mercedes-benz',
  mb: 'mercedes-benz',
  chevy: 'chevrolet',
  alfa: 'alfa romeo',
  aston: 'aston martin',
  land: 'land rover',
  landrover: 'land rover',
  rover: 'land rover',
  'range rover': 'land rover',
  rangerover: 'land rover',
  rolls: 'rolls-royce',
  rr: 'rolls-royce',
  citroen: 'citroen',
  'ds': 'ds automobiles',
  dsautomobiles: 'ds automobiles',
  lynk: 'lynk & co',
  'lynk co': 'lynk & co',
  ssangyong: 'ssangyong / kgm',
  kgm: 'ssangyong / kgm',
  gwm: 'ora (gwm)',
  ora: 'ora (gwm)',
  mini: 'mini',
  bmw: 'bmw'
};

function loadCatalog(): SpecCatalog {
  if (catalogCache) return catalogCache;
  const path = join(__dirname, '../data/car-specifications.json');
  catalogCache = JSON.parse(readFileSync(path, 'utf8')) as SpecCatalog;
  return catalogCache;
}

function ensureIndexes(): void {
  if (brandNormList && modelsByBrand) return;
  const raw = loadCatalog();
  const brands: string[] = [];
  const byBrand = new Map<string, string[]>();
  for (const [brand, models] of Object.entries(raw)) {
    const bn = normalizeBrand(brand);
    if (!bn) continue;
    brands.push(bn);
    const keys = new Set<string>();
    for (const model of Object.keys(models)) {
      const soft = softModelNorm(model);
      const resolved = resolveCatalogModelKey(model);
      if (soft) keys.add(soft);
      if (resolved) keys.add(resolved);
    }
    byBrand.set(bn, [...keys]);
  }
  brandNormList = brands;
  modelsByBrand = byBrand;
}

export function compactName(s: string): string {
  return stripDiacritics(s.toLowerCase()).replace(/[^a-z0-9]/g, '');
}

export function nameTokens(s: string): string[] {
  return softModelNorm(s)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 1);
}

/** Classic Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = b.length + 1;
  const cols = a.length + 1;
  const prev = new Array<number>(cols);
  const cur = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    cur[0] = i;
    const bc = b.charCodeAt(i - 1);
    for (let j = 1; j < cols; j++) {
      const cost = a.charCodeAt(j - 1) === bc ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j < cols; j++) prev[j] = cur[j]!;
  }
  return prev[a.length]!;
}

function maxEditAllowed(len: number): number {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  return 3;
}

function tokensClose(a: string, b: string): boolean {
  if (a === b) return true;
  const ca = compactName(a);
  const cb = compactName(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  if (ca.length >= 3 && cb.length >= 3) {
    if (ca.startsWith(cb) || cb.startsWith(ca)) {
      // Avoid "a" matching everything — already gated by length
      const ratio = Math.min(ca.length, cb.length) / Math.max(ca.length, cb.length);
      if (ratio >= 0.7) return true;
    }
    const maxD = maxEditAllowed(Math.min(ca.length, cb.length));
    if (editDistance(ca, cb) <= maxD) return true;
  }
  return false;
}

/**
 * True when query and candidate refer to the same vehicle name loosely.
 */
export function namesLooselyMatch(query: string, candidate: string): boolean {
  const q = softModelNorm(query);
  const c = softModelNorm(candidate);
  if (!q || !c) return false;
  if (q === c) return true;

  const qc = compactName(q);
  const cc = compactName(c);
  if (qc && cc && qc === cc) return true;

  if (qc.length >= 4 && cc.length >= 4) {
    const maxD = maxEditAllowed(Math.min(qc.length, cc.length));
    if (editDistance(qc, cc) <= maxD) return true;
  }

  const qt = nameTokens(q);
  const ct = nameTokens(c);
  if (qt.length === 0 || ct.length === 0) return false;

  // User omitted intermediate words: every query token appears in candidate
  if (qt.every((t) => ct.some((x) => tokensClose(t, x)))) return true;
  // User added trim/extra words: every candidate token appears in query
  if (ct.every((t) => qt.some((x) => tokensClose(t, x)))) return true;

  // Shared significant tokens (e.g. "golf gti performance" ↔ "golf gti")
  const significant = (t: string) => t.length >= 2;
  const qs = qt.filter(significant);
  const cs = ct.filter(significant);
  if (qs.length >= 1 && cs.length >= 1) {
    let shared = 0;
    for (const t of qs) {
      if (cs.some((x) => tokensClose(t, x))) shared++;
    }
    const need = Math.min(qs.length, cs.length);
    if (shared >= need && shared >= 1) return true;
    // Majority overlap for longer names
    if (qs.length >= 2 && shared / qs.length >= 0.6 && shared >= 1) return true;
  }

  return false;
}

function scoreBrandCandidate(query: string, candidateNorm: string): number {
  const qSoft = softModelNorm(query);
  const qCompact = compactName(query);
  const cCompact = compactName(candidateNorm);
  if (!qCompact || !cCompact) return -1;
  if (normalizeBrand(query) === candidateNorm) return 100;
  if (qCompact === cCompact) return 95;
  if (BRAND_ALIASES[qSoft] === candidateNorm || BRAND_ALIASES[qCompact] === candidateNorm) {
    return 92;
  }
  // Prefix of multi-word brand: "alfa" → "alfa romeo"
  const cTokens = nameTokens(candidateNorm);
  if (cTokens.length >= 2 && qSoft === cTokens[0] && qSoft.length >= 3) return 88;
  if (cCompact.startsWith(qCompact) && qCompact.length >= 4) return 80;
  if (qCompact.startsWith(cCompact) && cCompact.length >= 4) return 78;

  const dist = editDistance(qCompact, cCompact);
  const maxD = maxEditAllowed(Math.min(qCompact.length, cCompact.length));
  if (dist <= maxD) return 70 - dist;

  if (namesLooselyMatch(query, candidateNorm)) return 60;
  return -1;
}

/**
 * Resolve free-text brand(s) to canonical brandNorm keys.
 * Always includes a best-effort normalizeBrand fallback so unknown brands still query.
 */
export function resolveSearchBrandNorms(inputs: string[]): string[] {
  ensureIndexes();
  const out = new Set<string>();

  for (const raw of inputs) {
    if (!raw?.trim()) continue;
    const soft = softModelNorm(raw);
    const compact = compactName(raw);
    const aliased = BRAND_ALIASES[soft] || BRAND_ALIASES[compact];
    if (aliased) {
      out.add(aliased);
      continue;
    }

    const exact = normalizeBrand(raw);
    let best: string | null = null;
    let bestScore = -1;
    for (const bn of brandNormList!) {
      const score = scoreBrandCandidate(raw, bn);
      if (score > bestScore) {
        bestScore = score;
        best = bn;
      }
    }

    if (best && bestScore >= 60) {
      out.add(best);
    } else if (exact) {
      out.add(exact);
    }
  }

  return [...out];
}

function catalogModelsForBrands(brandNorms: string[]): string[] {
  ensureIndexes();
  if (brandNorms.length === 0) {
    const all = new Set<string>();
    for (const models of modelsByBrand!.values()) {
      for (const m of models) all.add(m);
    }
    return [...all];
  }
  const all = new Set<string>();
  for (const bn of brandNorms) {
    const list = modelsByBrand!.get(bn);
    if (list) for (const m of list) all.add(m);
  }
  return [...all];
}

function scoreModelCandidate(query: string, candidate: string): number {
  const q = softModelNorm(resolveCatalogModelKey(query) || query);
  const c = softModelNorm(resolveCatalogModelKey(candidate) || candidate);
  if (!q || !c) return -1;
  if (q === c) return 100;
  const qc = compactName(q);
  const cc = compactName(c);
  if (qc && cc && qc === cc) return 95;

  if (namesLooselyMatch(q, c)) {
    // Prefer closer length (avoid "a" matching "a4" via loose — namesLooselyMatch should block)
    const lenPenalty = Math.abs(qc.length - cc.length);
    return 80 - Math.min(lenPenalty, 20);
  }

  if (qc.length >= 3 && cc.length >= 3) {
    const dist = editDistance(qc, cc);
    const maxD = maxEditAllowed(Math.min(qc.length, cc.length));
    if (dist <= maxD) return 70 - dist;
  }

  // Prefix: user "leon sportstourer" → catalog "leon"
  if (q.startsWith(`${c} `) || c.startsWith(`${q} `)) {
    return 65 - Math.abs(q.length - c.length) * 0.1;
  }

  return -1;
}

/**
 * Resolve free-text model names to likely modelNorm keys (catalog-aware + raw fallbacks).
 */
export function resolveSearchModelNorms(
  inputs: string[],
  brandNorms: string[] = []
): string[] {
  ensureIndexes();
  const out = new Set<string>();
  const catalogModels = catalogModelsForBrands(brandNorms);

  for (const raw of inputs) {
    if (!raw?.trim()) continue;
    const exact = normalizeModel(raw);
    const resolved = softModelNorm(resolveCatalogModelKey(raw));
    if (resolved) out.add(resolved);
    if (exact) out.add(exact);

    let best: string | null = null;
    let bestScore = -1;
    for (const m of catalogModels) {
      const score = scoreModelCandidate(raw, m);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (best && bestScore >= 60) {
      out.add(best);
      // Also add normalizeModel form for DB keys that weren't soft-aliased
      out.add(normalizeModel(best));
    }

    // Drop trailing trim-like tokens and retry once ("golf gti" → also try "golf")
    const tokens = nameTokens(resolved || exact);
    if (tokens.length >= 2) {
      const head = tokens.slice(0, -1).join(' ');
      for (const m of catalogModels) {
        const score = scoreModelCandidate(head, m);
        if (score >= 80) {
          out.add(m);
          out.add(normalizeModel(m));
        }
      }
    }
  }

  return [...out].filter(Boolean);
}

/**
 * Brand match for in-memory filters (history / post-query).
 */
export function brandLooselyMatches(
  queryBrand: string,
  candidateBrand: string
): boolean {
  const qn = resolveSearchBrandNorms([queryBrand]);
  const cn = normalizeBrand(candidateBrand);
  if (!cn) return false;
  if (qn.includes(cn)) return true;
  return namesLooselyMatch(normalizeBrand(queryBrand) || queryBrand, cn);
}

/**
 * Model match for in-memory filters when SQL equality is too strict.
 */
export function modelLooselyMatches(
  queryModel: string,
  candidateModel: string,
  brandNorms: string[] = []
): boolean {
  const resolved = resolveSearchModelNorms([queryModel], brandNorms);
  const cn = softModelNorm(resolveCatalogModelKey(candidateModel) || candidateModel);
  const cnNorm = normalizeModel(candidateModel);
  if (resolved.some((r) => r === cn || r === cnNorm || softModelNorm(r) === cn)) {
    return true;
  }
  return namesLooselyMatch(queryModel, candidateModel);
}
