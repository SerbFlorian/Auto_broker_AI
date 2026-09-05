/**
 * Regression guard for engine/CV detection (engineCatalog.service.ts).
 *
 * Locks in the exact before/after cases found while auditing empty `engine`
 * fields (2026-08-06): catalog-gap fallback to the heuristic parser, wider
 * V6/V8/V10/V12/W12/W16 cues, and the "never invent from a bare number"
 * guardrail. If a future change to the resolver/heuristic regresses any of
 * these, this script fails loudly instead of silently shipping empty/garbage
 * `engine` values again.
 *
 *   node scripts/verify-engine-heuristics.mjs
 *   npm run verify:engines
 */
import {
  resolveEngineFromVersion,
  extractEngineHeuristic,
  normalizeEngineKey
} from '../src/services/engineCatalog.service.ts';

let failed = 0;
function check(desc, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`✅ ${desc}`);
  } else {
    failed++;
    console.error(`❌ ${desc}\n   expected: ${b}\n   actual:   ${a}`);
  }
}

function resolved({ brand, model, version }) {
  const r = resolveEngineFromVersion({ brand, model, version });
  return r ? { engineNorm: r.engineNorm || null, source: r.source } : null;
}

function heuristicNorm(version) {
  const r = extractEngineHeuristic(version);
  return r ? r.engineNorm : null;
}

// ── 1) Catalog-gap fallback: a model IS in the catalog, but its templated
//    engine list doesn't cover this trim's real displacement. Must fall
//    through to the heuristic instead of returning empty. ──────────────────
check(
  'Chevrolet Corvette 6.2 V8 (catalog, fixed from generic 1.4/1.5/2.0 template)',
  resolved({ brand: 'Chevrolet', model: 'Corvette', version: 'Corvette Stingray 6.2 V8 automatico' }),
  { engineNorm: '6.2 v8', source: 'catalog' }
);
check(
  'Chevrolet Tahoe 5.3 V8 (catalog)',
  resolved({ brand: 'Chevrolet', model: 'Tahoe', version: 'Tahoe 5.3 V8 4x4' }),
  { engineNorm: '5.3 v8', source: 'catalog' }
);
check(
  'Chevrolet Silverado 1500 3.0 Diesel Duramax (catalog)',
  resolved({ brand: 'Chevrolet', model: 'Silverado 1500', version: 'Silverado 3.0 Diesel Duramax' }),
  { engineNorm: '3.0 diesel', source: 'catalog' }
);
check(
  'Chevrolet Bolt EUV electrico (fixed from mislabeled 1.4/1.5/2.0 Turbo)',
  resolved({ brand: 'Chevrolet', model: 'Bolt EUV', version: 'Bolt EUV LT electrico' }),
  { engineNorm: 'electric', source: 'catalog' }
);
check(
  'Chevrolet Colorado 2.7 turbo (fixed from mislabeled Electric)',
  resolved({ brand: 'Chevrolet', model: 'Colorado', version: 'Colorado ZR2 2.7 turbo' }),
  { engineNorm: '2.7 turbo', source: 'catalog' }
);
check(
  'Ford F-150 3.5 V6 EcoBoost (catalog curated for trucks)',
  resolved({ brand: 'Ford', model: 'F-150', version: 'F-150 3.5 V6 EcoBoost' }),
  { engineNorm: '3.5 ecoboost', source: 'catalog' }
);
check(
  'Toyota Land Cruiser 3.3 V6 Diesel (catalog curated)',
  resolved({ brand: 'Toyota', model: 'Land Cruiser', version: 'Land Cruiser 3.3 V6 Diesel' }),
  { engineNorm: '3.3 v6 diesel', source: 'catalog' }
);

// ── 2) Real-world "obvious" cases must resolve, never stay empty. ─────────
check(
  'Land Rover Range Rover Sport D300 3.0 (full pipeline hits the catalog "d300" alias)',
  resolved({
    brand: 'Land Rover',
    model: 'Range Rover Sport',
    version: 'Range Rover Sport D300 3.0 dynamic'
  }),
  { engineNorm: '3.0 diesel', source: 'catalog' }
);
check(
  'D300 3.0 — raw heuristic (no catalog available) still recognizes the JLR code',
  heuristicNorm('Range Rover Sport D300 3.0 dynamic'),
  'd300'
);
check('BMW 520d code (raw heuristic)', heuristicNorm('520d xDrive'), '520d');
check('Audi 40 TFSI marketing code (raw heuristic)', heuristicNorm('A4 40 TFSI quattro'), '40 tfsi');
check(
  'Volvo V60 2.0 D4 (catalog has literal "d4" alias)',
  resolved({ brand: 'Volvo', model: 'V60', version: '2.0 D4' }),
  { engineNorm: 'd4', source: 'catalog' }
);

// ── 3) Prudence guardrail: never invent an engine from a bare trim/number
//    or a pure trim name with zero engine-related signal. Empty is the
//    correct, safe answer here — inventing would pollute filters/matching. ─
check(
  'Mercedes trim name "AVANTGARDE" alone has no engine signal (raw heuristic)',
  heuristicNorm('AVANTGARDE'),
  null
);
check(
  'Mercedes trim name "AVANTGARDE" alone (full pipeline)',
  resolved({ brand: 'Mercedes-Benz', model: 'Clase C', version: 'AVANTGARDE' }),
  null
);
check(
  'Volvo XC70 3.2 — model retired/not in car-specifications.json, no catalog, no cue → stays empty',
  resolved({ brand: 'Volvo', model: 'XC70', version: '3.2' }),
  null
);
check(
  'Bare "1.2 allure" trim has no engine cue (raw heuristic never invents)',
  heuristicNorm('1.2 allure'),
  null
);
check(
  '"1.2 allure" on a real Seat Ibiza IS resolved via the catalog (single unambiguous 1.2 candidate), not the heuristic',
  resolved({ brand: 'Seat', model: 'Ibiza', version: '1.2 allure' }),
  { engineNorm: '1.2 tsi', source: 'catalog' }
);

// ── 4) normalizeEngineKey: "0 TFSI" bug must stay fixed. ───────────────────
check('normalizeEngineKey("0 TFSI") strips the bogus leading zero', normalizeEngineKey('0 TFSI'), 'tfsi');
check(
  'normalizeEngineKey("30 TFSI") must NOT be mistaken for "0 TFSI"',
  normalizeEngineKey('30 TFSI'),
  '30 tfsi'
);

// ── 5) False-positive guard: model codes that merely look like a V6/V8 cue
//    (e.g. Volvo "V60") must never trigger the new V-engine heuristic. ─────
check(
  'Volvo "V60" model name must not be misread as a V6 engine cue',
  heuristicNorm('Volvo V60 2.4'),
  null
);

if (failed) {
  console.error(`\n💥 ${failed} engine-heuristic check(s) failed`);
  process.exit(1);
}
console.log('\n✅ Engine heuristics coherent.');
