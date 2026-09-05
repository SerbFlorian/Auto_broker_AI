/**
 * Shared VIP filter truth — UI stock counts, draft menus, and digests must agree.
 *
 * All dimensions go through carMatchesAlert (soft-fill fuel/engine/power from version;
 * hard price / year / km caps). This module only adapts draft extras → MatchableAlert.
 */
import { normalizeBrand } from '../utils/normalizer.js';
import { resolveCatalogModelKey } from '../utils/catalogModelAliases.js';
import {
  carMatchesAlert,
  effectivePowerHp,
  type MatchableAlert,
  type MatchableCar
} from './matchingRules.js';

/** Draft / inventory extras shared by menus and digests. */
export type InventoryScopeExtras = {
  countries?: string[] | null;
  fuelTypes?: string[] | null;
  engines?: string[] | null;
  minPowerHp?: number | null;
  maxPrice?: number | null;
  minYear?: number | null;
  maxMileageKm?: number | null;
};

export type ScopeCar = MatchableCar;

export { effectivePowerHp };

export function toMatchableAlert(params: {
  brand?: string | null;
  model?: string | null;
  versions?: string[] | null;
  extras?: InventoryScopeExtras | null;
}): MatchableAlert {
  const brandNorm = params.brand ? normalizeBrand(params.brand) : null;
  const modelNorm = params.model ? resolveCatalogModelKey(params.model) : null;
  const ex = params.extras;
  return {
    brandNorm: brandNorm || null,
    modelNorm: modelNorm || null,
    fuelTypes: ex?.fuelTypes?.length ? [...ex.fuelTypes] : [],
    countries: ex?.countries?.length ? [...ex.countries] : [],
    versions: params.versions?.length ? [...params.versions] : [],
    engines: ex?.engines?.length ? [...ex.engines] : [],
    minPowerHp: ex?.minPowerHp != null && ex.minPowerHp > 0 ? ex.minPowerHp : null,
    maxPrice: ex?.maxPrice ?? null,
    minYear: ex?.minYear ?? null,
    maxMileageKm: ex?.maxMileageKm ?? null
  };
}

/**
 * Does this listing match the current filter draft / alert scope?
 * Used for Country/Fuel/Motor stock counts AND digests.
 */
export function carMatchesDraftScope(
  car: ScopeCar,
  params: {
    brand?: string | null;
    model?: string | null;
    versions?: string[] | null;
    extras?: InventoryScopeExtras | null;
  }
): boolean {
  const enriched: MatchableCar = {
    ...car,
    powerHp: effectivePowerHp(car)
  };
  return carMatchesAlert(enriched, toMatchableAlert(params));
}
