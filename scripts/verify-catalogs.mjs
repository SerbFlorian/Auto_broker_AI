/**
 * Verify car-specifications.json ↔ engine-catalog.json coherence + EN/ES model aliases.
 *
 *   node scripts/verify-catalogs.mjs
 *   npm run verify:catalogs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  catalogModelLookupKeys,
  expandCatalogModelAliases,
  resolveCatalogModelKey,
  softModelNorm
} from '../src/utils/catalogModelAliases.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const specs = JSON.parse(
  fs.readFileSync(path.join(root, 'src/data/car-specifications.json'), 'utf8')
);
const engines = JSON.parse(
  fs.readFileSync(path.join(root, 'src/data/engine-catalog.json'), 'utf8')
);

let failed = 0;
function fail(msg) {
  failed++;
  console.error(`❌ ${msg}`);
}
function ok(msg) {
  console.log(`✅ ${msg}`);
}

// 1) Brand/model parity
const onlySpecs = [];
const onlyEng = [];
const emptyEngines = [];
for (const brand of new Set([...Object.keys(specs), ...Object.keys(engines)])) {
  const sm = new Set(Object.keys(specs[brand] || {}));
  const em = new Set(Object.keys(engines[brand] || {}));
  for (const m of sm) {
    if (!em.has(m)) onlySpecs.push(`${brand}/${m}`);
    const list = engines[brand]?.[m];
    if (em.has(m) && (!Array.isArray(list) || list.length === 0)) {
      emptyEngines.push(`${brand}/${m}`);
    }
  }
  for (const m of em) if (!sm.has(m)) onlyEng.push(`${brand}/${m}`);
}

if (onlySpecs.length || onlyEng.length || emptyEngines.length) {
  if (onlySpecs.length) fail(`models only in specs: ${onlySpecs.slice(0, 10).join(', ')}`);
  if (onlyEng.length) fail(`models only in engines: ${onlyEng.slice(0, 10).join(', ')}`);
  if (emptyEngines.length) fail(`empty engine lists: ${emptyEngines.slice(0, 10).join(', ')}`);
} else {
  ok(
    `parity OK — ${Object.keys(specs).length} brands, ${Object.values(specs).reduce((n, m) => n + Object.keys(m).length, 0)} models`
  );
}

// 2) Alias probes (portal EN → catalog ES)
const probes = [
  ['BMW', '1 Series', 'Serie 1'],
  ['BMW', '3-Series', 'Serie 3'],
  ['BMW', '5er', 'Serie 5'],
  ['Mercedes-Benz', 'A-Class', 'Clase A'],
  ['Mercedes-Benz', 'C Class', 'Clase C'],
  ['Mercedes-Benz', 'G-Class', 'Clase G'],
  ['Mercedes-Benz', 'E Klasse', 'Clase E']
];

let aliasOk = 0;
for (const [brand, portal, catalog] of probes) {
  const want = softModelNorm(catalog);
  const resolved = resolveCatalogModelKey(portal);
  const keys = catalogModelLookupKeys(portal);
  const catalogKeys = expandCatalogModelAliases(catalog);
  const hit =
    resolved === want ||
    keys.includes(want) ||
    catalogKeys.some((k) => keys.includes(k));
  if (!hit) {
    fail(`alias ${brand} "${portal}" → expected "${want}", got "${resolved}" keys=[${keys.join('|')}]`);
  } else {
    aliasOk++;
  }
}
ok(`alias probes ${aliasOk}/${probes.length}`);

// 3) Every Serie/Clase catalog row expands to EN aliases
let expandChecked = 0;
for (const [brand, models] of Object.entries(specs)) {
  for (const model of Object.keys(models)) {
    if (!/^Serie \d$|^Clase [A-Z]$/i.test(model)) continue;
    const aliases = expandCatalogModelAliases(model);
    const needSeries = /^Serie /i.test(model);
    const hasEn = needSeries
      ? aliases.some((a) => /\d series|series \d/.test(a))
      : aliases.some((a) => / class$/.test(a));
    if (!hasEn) fail(`${brand}/${model} missing EN aliases: ${aliases.join(', ')}`);
    else expandChecked++;
  }
}
ok(`Serie/Clase EN expansions ${expandChecked}`);

if (failed) {
  console.error(`\n💥 ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\n✅ Catalogs coherent.');
