/**
 * Pure matching rules (no Prisma / Redis / Telegram side effects).
 * Used by MatchingService and by `npm test` without booting the bot.
 */
import { normalizeBrand, normalizeFuelType } from '../utils/normalizer.js';
import { resolveCatalogModelKey } from '../utils/catalogModelAliases.js';
import { listingMatchesSelectedCatalogSpecs } from './carSpecs.catalog.js';
import {
  normalizeEngineKey,
  resolveEngineFromVersion
} from './engineCatalog.service.js';
import { parsePowerCv } from '../utils/power.js';

export interface MatchableCar {
  brand: string;
  model: string;
  brandNorm?: string | null;
  modelNorm?: string | null;
  fuelType?: string | null;
  version?: string | null;
  versionTokens?: string[] | null;
  countryOfOrigin?: string | null;
  engineNorm?: string | null;
  powerHp?: number | null;
  /** Hard numeric caps (same as VIP UI). Optional for callers that only check soft dims. */
  price?: number | null;
  year?: number | null;
  mileageKm?: number | null;
}

/** CV for filters: DB value, else version parse, else catalog engine typical CV. */
export function effectivePowerHp(car: MatchableCar): number | null {
  if (car.powerHp != null && car.powerHp > 0) return car.powerHp;
  const fromVersion = parsePowerCv(car.version || '', { allowBare: true });
  if (fromVersion && fromVersion > 0) return fromVersion;
  if (car.version) {
    const resolved = resolveEngineFromVersion({
      brand: car.brand,
      model: car.model,
      version: car.version,
      existingPowerHp: null
    });
    if (resolved?.powerCv && resolved.powerCv > 0) return resolved.powerCv;
  }
  return null;
}

export interface MatchableAlert {
  brandNorm: string | null;
  modelNorm: string | null;
  fuelTypes: string[];
  countries: string[];
  versions: string[];
  engines: string[];
  minPowerHp: number | null;
  /** Hard caps — identical to filter menu labels (≤ price, ≥ year, ≤ km). */
  maxPrice?: number | null;
  minYear?: number | null;
  maxMileageKm?: number | null;
}

export function carMatchesAlert(car: MatchableCar, alert: MatchableAlert): boolean {
  const carBrand = car.brandNorm || normalizeBrand(car.brand);
  const carModel = resolveCatalogModelKey(car.modelNorm || car.model);

  if (alert.brandNorm && normalizeBrand(alert.brandNorm) !== carBrand) return false;
  if (alert.modelNorm && resolveCatalogModelKey(alert.modelNorm) !== carModel) return false;

  if (alert.fuelTypes.length > 0) {
    let fuel = (car.fuelType || '').trim();
    // Soft-launch: infer fuel from version text when scrapers left it empty/Unknown
    // so VIP fuel filters don't silently zero-out against incomplete rows.
    if (!fuel || /^unknown$/i.test(fuel)) {
      const inferred = normalizeFuelType(car.version || '');
      if (inferred && !/^unknown$/i.test(inferred)) fuel = inferred;
    }
    if (!fuel || /^unknown$/i.test(fuel)) return false;
    const fuelLower = fuel.toLowerCase();
    if (!alert.fuelTypes.some((f) => fuelLower.includes(f.toLowerCase()))) return false;
  }

  if (alert.countries.length > 0) {
    const code = (car.countryOfOrigin || '').toUpperCase();
    if (!alert.countries.some((c) => c.toUpperCase() === code)) return false;
  }

  if (alert.versions.length > 0) {
    const ok = listingMatchesSelectedCatalogSpecs(
      car.brand,
      car.model,
      car.version,
      car.versionTokens,
      alert.versions
    );
    if (!ok) return false;
  }

  if (alert.engines.length > 0) {
    let eng = normalizeEngineKey(car.engineNorm || '');
    // Soft-launch: resolve engine on the fly from version when engineNorm was never enriched.
    if (!eng && car.version) {
      const resolved = resolveEngineFromVersion({
        brand: car.brand,
        model: car.model,
        version: car.version,
        existingPowerHp: car.powerHp ?? null
      });
      eng = normalizeEngineKey(resolved?.engineNorm || resolved?.engine || '');
    }
    if (
      !eng ||
      !alert.engines.some((e) => {
        const want = normalizeEngineKey(e);
        return eng === want || eng.includes(want) || want.includes(eng);
      })
    ) {
      return false;
    }
  }

  if (alert.minPowerHp != null && alert.minPowerHp > 0) {
    const hp = effectivePowerHp(car);
    if (hp == null || hp < alert.minPowerHp) return false;
  }

  // Hard numeric caps — UI counts, digests, and live match must agree (no soft overshoot).
  if (alert.maxPrice != null) {
    if (car.price == null || car.price > alert.maxPrice) return false;
  }
  if (alert.minYear != null) {
    if (car.year == null || car.year < alert.minYear) return false;
  }
  if (alert.maxMileageKm != null && alert.maxMileageKm < 9_999_999) {
    if (car.mileageKm == null || car.mileageKm > alert.maxMileageKm) return false;
  }

  return true;
}
