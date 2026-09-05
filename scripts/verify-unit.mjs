/**
 * Minimal unit / pure-function regression suite for soft-launch integrity.
 *
 * Covers:
 *  - digest schedule window + clamp
 *  - Stripe VIP tier bands
 *  - carMatchesAlert (fuel/engine soft-fill + hard rejects)
 *  - engine key normalization
 *
 *   npm test
 *   npm run verify:unit
 */
import assert from 'node:assert/strict';
import {
  clampSchedulePrefs,
  isUserWithinDeliveryWindow,
  ALL_WEEKDAYS
} from '../src/services/digestSchedule.service.ts';
import { tierForVipCount } from '../src/services/vipCounter.service.ts';
import {
  carMatchesAlert
} from '../src/services/matchingRules.ts';
import {
  effectivePowerHp,
  carMatchesDraftScope
} from '../src/services/filterScope.ts';
import { normalizeEngineKey } from '../src/services/engineCatalog.service.ts';
import {
  resolveSearchBrandNorms,
  resolveSearchModelNorms,
  namesLooselyMatch,
  brandLooselyMatches,
  modelLooselyMatches
} from '../src/utils/fuzzyVehicleNames.ts';
import { normalizeBrand } from '../src/utils/normalizer.ts';

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(err);
  }
}

// ── Schedule ──────────────────────────────────────────────────────────────
check('clampSchedulePrefs: default-ish prefs stay 8–21 / 2h', () => {
  const p = clampSchedulePrefs({
    days: [...ALL_WEEKDAYS],
    startHour: 8,
    endHour: 21,
    intervalH: 2,
    paused: false
  });
  assert.equal(p.startHour, 8);
  assert.equal(p.endHour, 21);
  assert.equal(p.intervalH, 2);
  assert.deepEqual(p.days, [...ALL_WEEKDAYS]);
});

check('clampSchedulePrefs: rejects same start/end by bumping end', () => {
  const p = clampSchedulePrefs({
    days: [1, 2, 3],
    startHour: 8,
    endHour: 8,
    intervalH: 2,
    paused: false
  });
  assert.notEqual(p.startHour, p.endHour);
});

check('clampSchedulePrefs: interval clamped to 1–4', () => {
  assert.equal(clampSchedulePrefs({ intervalH: 0 }).intervalH, 2);
  assert.equal(clampSchedulePrefs({ intervalH: 9 }).intervalH, 2);
  assert.equal(clampSchedulePrefs({ intervalH: 3 }).intervalH, 3);
});

check('isUserWithinDeliveryWindow: returns boolean without throwing', () => {
  const prefs = clampSchedulePrefs({
    days: [...ALL_WEEKDAYS],
    startHour: 8,
    endHour: 21,
    intervalH: 2,
    paused: false
  });
  const d = new Date('2026-08-03T10:00:00');
  assert.equal(typeof isUserWithinDeliveryWindow(prefs, d), 'boolean');
});

check('isUserWithinDeliveryWindow: empty days treated as all week after clamp', () => {
  const p = clampSchedulePrefs({ days: [], startHour: 8, endHour: 21, intervalH: 2 });
  assert.ok(p.days.length >= 1);
});

// ── Stripe tiers ──────────────────────────────────────────────────────────
check('tierForVipCount: 0–200 → Tier 1', () => {
  assert.equal(tierForVipCount(0).index, 1);
  assert.equal(tierForVipCount(200).index, 1);
  assert.equal(tierForVipCount(200).envVar, 'STRIPE_PAYMENT_LINK_TIER1');
});

check('tierForVipCount: 201–500 → Tier 2', () => {
  assert.equal(tierForVipCount(201).index, 2);
  assert.equal(tierForVipCount(500).index, 2);
});

check('tierForVipCount: 501+ → Tier 3', () => {
  assert.equal(tierForVipCount(501).index, 3);
  assert.equal(tierForVipCount(9999).index, 3);
});

// ── Engine normalize ──────────────────────────────────────────────────────
check('normalizeEngineKey strips bogus 0 TFSI', () => {
  assert.equal(normalizeEngineKey('0 TFSI'), 'tfsi');
  assert.equal(normalizeEngineKey('30 TFSI'), '30 tfsi');
});

// ── Matching ──────────────────────────────────────────────────────────────
function baseCar(over = {}) {
  return {
    portalId: 't1',
    sourcePortal: 'clicars',
    brand: 'Audi',
    model: 'A4',
    brandNorm: 'audi',
    modelNorm: 'a4',
    year: 2020,
    mileageKm: 50000,
    price: 20000,
    countryOfOrigin: 'ES',
    originalUrl: 'https://example.com/a',
    fuelType: 'Diesel',
    version: '2.0 TDI',
    engineNorm: '2.0 tdi',
    powerHp: 150,
    ...over
  };
}

function baseAlert(over = {}) {
  return {
    id: 'a1',
    userId: 'u1',
    telegramId: '1',
    brand: 'Audi',
    brandNorm: 'audi',
    model: 'A4',
    modelNorm: 'a4',
    versions: [],
    engines: [],
    minPowerHp: null,
    fuelTypes: [],
    countries: [],
    maxPrice: null,
    minYear: null,
    maxMileageKm: null,
    ...over
  };
}

check('carMatchesAlert: exact engine match', () => {
  assert.equal(
    carMatchesAlert(baseCar(), baseAlert({ engines: ['2.0 TDI'] })),
    true
  );
});

check('carMatchesAlert: resolves engine from version when engineNorm empty', () => {
  assert.equal(
    carMatchesAlert(
      baseCar({ engineNorm: '', version: 'A4 2.0 TDI S line' }),
      baseAlert({ engines: ['2.0 tdi'] })
    ),
    true
  );
});

check('carMatchesAlert: fuel filter rejects empty+uninferable fuel', () => {
  assert.equal(
    carMatchesAlert(
      baseCar({ fuelType: null, version: 'S line quattro' }),
      baseAlert({ fuelTypes: ['Diesel'] })
    ),
    false
  );
});

check('carMatchesAlert: fuel inferred from version when fuelType empty', () => {
  assert.equal(
    carMatchesAlert(
      baseCar({ fuelType: null, version: '2.0 TDI S line' }),
      baseAlert({ fuelTypes: ['Diesel'] })
    ),
    true
  );
});

check('carMatchesAlert: brand mismatch rejects', () => {
  assert.equal(
    carMatchesAlert(baseCar({ brand: 'BMW', brandNorm: 'bmw' }), baseAlert()),
    false
  );
});

// ── Fuzzy brand / model (AI search) ───────────────────────────────────────
check('fuzzy brand: typos and missing letters', () => {
  assert.deepEqual(resolveSearchBrandNorms(['Volkwagen']), ['volkswagen']);
  assert.deepEqual(resolveSearchBrandNorms(['Mercdes']), ['mercedes-benz']);
  assert.deepEqual(resolveSearchBrandNorms(['mercedez']), ['mercedes-benz']);
  assert.ok(resolveSearchBrandNorms(['Bmw']).includes('bmw'));
});

check('fuzzy brand: partial / compacted multi-word', () => {
  assert.deepEqual(resolveSearchBrandNorms(['Alfa']), ['alfa romeo']);
  assert.deepEqual(resolveSearchBrandNorms(['Landrover']), ['land rover']);
  assert.deepEqual(resolveSearchBrandNorms(['MercedesBenz']), ['mercedes-benz']);
  assert.equal(normalizeBrand('AlfaRomeo'), 'alfa romeo');
});

check('fuzzy brand: aliases', () => {
  assert.deepEqual(resolveSearchBrandNorms(['VW']), ['volkswagen']);
  assert.deepEqual(resolveSearchBrandNorms(['merc']), ['mercedes-benz']);
  assert.deepEqual(resolveSearchBrandNorms(['chevy']), ['chevrolet']);
});

check('fuzzy model: typo + missing intermediate token', () => {
  const brands = ['volkswagen'];
  const golf = resolveSearchModelNorms(['Golff'], brands);
  assert.ok(golf.some((m) => m === 'golf' || m.includes('golf')));

  assert.equal(namesLooselyMatch('Leon FR', 'leon'), true);
  assert.equal(namesLooselyMatch('golf gti', 'golf'), true);
  assert.equal(modelLooselyMatches('Clase A', 'clase a', ['mercedes-benz']), true);
  assert.equal(modelLooselyMatches('1 Series', 'serie 1', ['bmw']), true);
});

check('fuzzy brandLooselyMatches', () => {
  assert.equal(brandLooselyMatches('Volkwagen', 'volkswagen'), true);
  assert.equal(brandLooselyMatches('Alfa', 'alfa romeo'), true);
  assert.equal(brandLooselyMatches('Audi', 'bmw'), false);
});

import { aiReplyToTelegramHtml } from '../src/utils/telegramFormat.ts';

check('aiReplyToTelegramHtml: strips # headers and **bold** into Telegram HTML', () => {
  const html = aiReplyToTelegramHtml(
    '### Reliability:\nBoth are solid.\n\n1. **Transmission**: check DSG\n2. **Brakes**: pads'
  );
  assert.equal(html.includes('###'), false);
  assert.equal(html.includes('**'), false);
  assert.ok(html.includes('<b>Reliability:</b>'));
  assert.ok(html.includes('<b>Transmission</b>'));
  assert.ok(html.includes('check DSG'));
});

import {
  listingMatchesRecoverIdentity,
  hardRecoverSpecs
} from '../src/services/ai.service.ts';

check('recover identity: rejects wrong brand/model', () => {
  const brands = resolveSearchBrandNorms(['Audi']);
  const models = resolveSearchModelNorms(['TT'], brands);
  assert.equal(
    listingMatchesRecoverIdentity(
      {
        brand: 'BMW',
        model: 'M4',
        brandNorm: 'bmw',
        modelNorm: 'm4',
        version: 'Competition'
      },
      ['Audi'],
      ['TT'],
      ['2.0 TFSI'],
      brands,
      models
    ),
    false
  );
  assert.equal(
    listingMatchesRecoverIdentity(
      {
        brand: 'Audi',
        model: 'TT',
        brandNorm: 'audi',
        modelNorm: 'tt',
        version: '2.0 TFSI quattro',
        engine: '2.0 TFSI'
      },
      ['Audi'],
      ['TT'],
      ['2.0 TFSI'],
      brands,
      models
    ),
    true
  );
});

check('recover identity: country codes are not hard specs', () => {
  assert.deepEqual(hardRecoverSpecs(['2.0 TFSI', 'Italy', 'BE']), ['2.0 TFSI']);
});

import { normalizeModel } from '../src/utils/normalizer.ts';
import { expandCatalogModelAliases } from '../src/utils/catalogModelAliases.ts';

check('normalizeModel unifies BMW 4 Series aliases', () => {
  assert.equal(normalizeModel('4 Series'), 'serie 4');
  assert.equal(normalizeModel('serie 4'), 'serie 4');
  assert.equal(normalizeModel('4er'), 'serie 4');
  assert.equal(normalizeModel('Series 4'), 'serie 4');
  // Must NOT collapse distinct BMW lines into serie 4
  assert.equal(normalizeModel('i4'), 'i4');
  assert.equal(normalizeModel('X4'), 'x4');
  assert.equal(normalizeModel('M4'), 'm4');
  assert.equal(normalizeModel('Z4'), 'z4');
});

check('normalizeModel unifies Mercedes class aliases', () => {
  assert.equal(normalizeModel('A-Class'), 'clase a');
  assert.equal(normalizeModel('Clase A'), 'clase a');
  assert.equal(normalizeModel('A Klasse'), 'clase a');
});

check('expandCatalogModelAliases covers EN+ES series keys', () => {
  const keys = expandCatalogModelAliases('serie 4');
  assert.ok(keys.includes('serie 4'));
  assert.ok(keys.includes('4 series'));
});

import {
  currencyForCountry,
  convertToEur,
  isEuroCountry
} from '../src/utils/currency.ts';

check('currency: SE is Sweden/SEK not euro; AT is euro', () => {
  assert.equal(isEuroCountry('SE'), false);
  assert.equal(currencyForCountry('SE'), 'SEK');
  assert.equal(isEuroCountry('AT'), true);
  assert.equal(currencyForCountry('AT'), null);
  assert.equal(currencyForCountry('RS'), 'RSD');
});

check('convertToEur: SEK via ECB-style rates', () => {
  // 1 EUR ≈ 11.5 SEK → 124000 SEK ≈ 10783 EUR
  const eur = convertToEur(124000, 'SEK', { SEK: 11.5 });
  assert.ok(eur != null);
  assert.ok(Math.abs(eur - 124000 / 11.5) < 0.01);
  assert.ok(eur > 10000 && eur < 12000);
});

import { priceLooksLikeAlreadyEur } from '../src/utils/currency.ts';

check('priceLooksLikeAlreadyEur: HUF sticker that is already EUR', () => {
  const rates = { HUF: 390, SEK: 11.5, RON: 5 };
  assert.equal(priceLooksLikeAlreadyEur(13066, 'HUF', rates), true);
  assert.equal(priceLooksLikeAlreadyEur(124000, 'SEK', rates), false);
  assert.equal(priceLooksLikeAlreadyEur(5_500_000, 'HUF', rates), false);
});

import {
  hasExternalSellerUrl,
  isOoyyoAggregatorUrl
} from '../src/utils/listingUrl.ts';

check('ooyyo aggregator vs external seller URLs', () => {
  assert.equal(
    isOoyyoAggregatorUrl(
      'https://www.ooyyo.com/belgium/c=ABC/-8620991960874936470.html'
    ),
    true
  );
  assert.equal(
    hasExternalSellerUrl(
      'https://www.ooyyo.com/belgium/c=ABC/-8620991960874936470.html'
    ),
    false
  );
  assert.equal(
    hasExternalSellerUrl('https://www.autoscout24.es/oferta/123'),
    true
  );
});

import {
  normalizeExternalSellerUrl,
  isLikelyLiveListingUrl
} from '../src/utils/listingUrl.ts';

check('normalizeExternalSellerUrl rejects ooyyo and bare homepages', () => {
  assert.equal(
    normalizeExternalSellerUrl('https://www.ooyyo.com/out?x=1'),
    null
  );
  assert.equal(normalizeExternalSellerUrl('https://www.km77.com/'), null);
  assert.ok(
    normalizeExternalSellerUrl(
      'https://coches.km77.com/detalle/foo-bar-123'
    )
  );
  assert.equal(isLikelyLiveListingUrl('https://a.com/x', 'https://a.com/'), false);
  assert.equal(
    isLikelyLiveListingUrl('https://a.com/x', 'https://a.com/listing/1'),
    true
  );
});

import { absoluteTheParkingHref, isTheParkingUrl } from '../src/utils/listingUrl.ts';

check('absoluteTheParkingHref resolves title /tools/ link', () => {
  const abs = absoluteTheParkingHref('/tools/I9VFBJMH/0/L.html');
  assert.equal(abs, 'https://www.theparking.eu/tools/I9VFBJMH/0/L.html');
  assert.equal(isTheParkingUrl(abs), true);
  assert.equal(
    isTheParkingUrl(
      'https://www.theparking.eu/used-cars-detail/nissan-gt-r/x/I9VFR3MH.html'
    ),
    true
  );
});

import { htmlLooksLikeDeadListing } from '../src/services/urlVerify.service.ts';

check('soft-404 HTML (autosupermarket.it style) is dead', () => {
  const html = `
    <html><body>
    <h1>404</h1>
    <p>Sembra che la pagina che stai cercando non esista, oppure sia stata spostata.</p>
    <a>Cerca un'auto</a>
    <p>Ecco delle pagine che ti potrebbero aiutare.</p>
    </body></html>
  `;
  assert.equal(htmlLooksLikeDeadListing(html), true);
  const live = `<html><body><h1>Fiat Grande Panda Hybrid</h1>
    <p>Prezzo 18900 euro. Chilometraggio 12000 km. Anno 2024. Benzina ibrida.</p>
    <p>Contatta il venditore per questo annuncio completo di optional e garanzia.</p>
    <div>${'x'.repeat(80)}</div>
    </body></html>`;
  assert.equal(htmlLooksLikeDeadListing(live), false);
});

check('effectivePowerHp + hard price match via draft scope', () => {
  const car = {
    brand: 'Dacia',
    model: 'Duster',
    powerHp: null,
    version: '1.5 dCi 115 CV',
    price: 15000,
    year: 2020,
    mileageKm: 80000,
    countryOfOrigin: 'ES'
  };
  assert.ok((effectivePowerHp(car) ?? 0) >= 100);
  assert.equal(
    carMatchesDraftScope(car, {
      brand: 'Dacia',
      extras: { minPowerHp: 110, maxPrice: 16000, minYear: 2018, maxMileageKm: 105000 }
    }),
    true
  );
  assert.equal(
    carMatchesDraftScope(car, {
      brand: 'Dacia',
      extras: { maxPrice: 14000 }
    }),
    false
  );
  assert.equal(
    carMatchesAlert(
      car,
      baseAlert({
        brandNorm: 'dacia',
        modelNorm: null,
        brand: 'Dacia',
        model: null,
        minPowerHp: 110,
        maxPrice: 16000
      })
    ),
    true
  );
});

if (failed) {
  console.error(`\n💥 ${failed} unit check(s) failed`);
  process.exit(1);
}
console.log('\n✅ Unit checks coherent.');
