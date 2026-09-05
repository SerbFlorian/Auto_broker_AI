import { Telegraf, Markup } from 'telegraf';
import { prisma } from '../db/prisma.js';
import {
  getAvailableBrands,
  getAvailableModels,
  getInventoryContextLimits,
  getAvailableCountries,
  getAvailableVersions,
  roundPrice,
  roundMileage,
  formatApproxCount,
  saneMinYear,
  draftScope
} from '../services/inventory.service.js';
import { getCatalogSpecs } from '../services/carSpecs.catalog.js';
import { normalizeBrand, normalizeModel, isUsableModelLabel } from '../utils/normalizer.js';
import {
  resolveCatalogModelKey,
  softModelNorm
} from '../utils/catalogModelAliases.js';
import { countryLabel, formatCountriesList } from '../utils/countries.js';

interface FilterDraft {
  brand?: string | null;
  model?: string | null;
  versions?: string[];
  engines?: string[];
  minPowerHp?: number | null;
  maxPrice?: number | null;
  minYear?: number | null;
  maxMileageKm?: number | null;
  fuelTypes?: string[];
  countries?: string[];
  awaitingInputFor?: 'brand' | 'model' | 'version' | null;
  brandPage?: number;
  modelPage?: number;
  versionPage?: number;
  enginePage?: number;
  fuelPage?: number;
  countryPage?: number;
  powerPage?: number;
}

export type { FilterDraft };

export const userDrafts = new Map<number, FilterDraft>();

/** Snapshot when entering a submenu — Back restores; Done keeps draft changes. */
const draftSnapshots = new Map<number, FilterDraft>();

function cloneDraft(d: FilterDraft): FilterDraft {
  return {
    ...d,
    versions: [...(d.versions ?? [])],
    engines: [...(d.engines ?? [])],
    fuelTypes: [...(d.fuelTypes ?? [])],
    countries: [...(d.countries ?? [])]
  };
}

function snapshotDraft(telegramId: number) {
  const d = userDrafts.get(telegramId) || { versions: [], engines: [], fuelTypes: [], countries: [] };
  draftSnapshots.set(telegramId, cloneDraft(d));
}

function restoreDraftSnapshot(telegramId: number) {
  const snap = draftSnapshots.get(telegramId);
  if (snap) {
    userDrafts.set(telegramId, cloneDraft(snap));
  }
  draftSnapshots.delete(telegramId);
}

function commitDraftSnapshot(telegramId: number) {
  draftSnapshots.delete(telegramId);
}

/**
 * Cascade reset when an earlier filter changes.
 * Order: Brand → Model → Specs → Motor → Power → Fuel → Price → Year → Km → Country
 * Changing one step clears everything after it (back to Any) so stock counts never go stale.
 */
export type FilterCascadeFrom =
  | 'brand'
  | 'model'
  | 'specs'
  | 'engine'
  | 'power'
  | 'fuel'
  | 'price'
  | 'year'
  | 'km';

export function resetFiltersAfter(
  draft: FilterDraft,
  changed: FilterCascadeFrom
): void {
  const clearCountry = () => {
    draft.countries = [];
    draft.countryPage = 0;
  };

  if (changed === 'brand') {
    draft.model = null;
    draft.versions = [];
    draft.versionPage = 0;
    draft.engines = [];
    draft.enginePage = 0;
    draft.minPowerHp = null;
    draft.fuelTypes = [];
    draft.maxPrice = null;
    draft.minYear = null;
    draft.maxMileageKm = null;
    clearCountry();
    return;
  }
  if (changed === 'model') {
    draft.versions = [];
    draft.versionPage = 0;
    draft.engines = [];
    draft.enginePage = 0;
    draft.minPowerHp = null;
    draft.fuelTypes = [];
    draft.maxPrice = null;
    draft.minYear = null;
    draft.maxMileageKm = null;
    clearCountry();
    return;
  }
  if (changed === 'specs') {
    draft.engines = [];
    draft.enginePage = 0;
    draft.minPowerHp = null;
    draft.fuelTypes = [];
    draft.maxPrice = null;
    draft.minYear = null;
    draft.maxMileageKm = null;
    clearCountry();
    return;
  }
  if (changed === 'engine') {
    draft.minPowerHp = null;
    draft.fuelTypes = [];
    draft.maxPrice = null;
    draft.minYear = null;
    draft.maxMileageKm = null;
    clearCountry();
    return;
  }
  if (changed === 'power') {
    draft.fuelTypes = [];
    draft.maxPrice = null;
    draft.minYear = null;
    draft.maxMileageKm = null;
    clearCountry();
    return;
  }
  if (changed === 'fuel') {
    // Multi-select: only drop Country (stale ISO). Price/Year/Km stay until user changes them.
    clearCountry();
    return;
  }
  if (changed === 'price') {
    draft.minYear = null;
    draft.maxMileageKm = null;
    clearCountry();
    return;
  }
  if (changed === 'year') {
    draft.maxMileageKm = null;
    clearCountry();
    return;
  }
  if (changed === 'km') {
    clearCountry();
  }
}

/** @deprecated Use resetFiltersAfter — kept for any external imports. */
export function resetDependentFilters(
  draft: FilterDraft,
  opts: { clearModel: boolean }
): void {
  resetFiltersAfter(draft, opts.clearModel ? 'brand' : 'model');
}

/** Footer: Any/All + Back + Done (draft only; panel Done saves DB). */
function filterFooterRow(anyLabel: string, anyAction: string) {
  return [
    Markup.button.callback(anyLabel, anyAction),
    Markup.button.callback('🔙 Back', 'filter_back'),
    Markup.button.callback('✅ Done', 'filter_done')
  ];
}

const GRID_COLS = 3;
/** Brand: 8 rows × 3 cols */
const BRANDS_PER_PAGE = 8 * GRID_COLS; // 24
/** Model + Specs + Motor + Fuel + Power options: 6 rows × 3 cols */
const FILTERS_PER_PAGE = 6 * GRID_COLS; // 18
/** Country: wider buttons so names don't truncate — 6 rows × 2 cols */
const COUNTRY_COLS = 2;
const COUNTRY_PER_PAGE = 6 * COUNTRY_COLS; // 12

/** Pack compact callback buttons into side-by-side rows (Telegram inline keyboard). */
function chunkButtons<T>(items: T[], perRow: number = GRID_COLS): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += perRow) {
    rows.push(items.slice(i, i + perRow));
  }
  return rows;
}

function pageNavRow(
  page: number,
  totalPages: number,
  prefix: string
): ReturnType<typeof Markup.button.callback>[] {
  const nav: ReturnType<typeof Markup.button.callback>[] = [];
  if (page > 0) nav.push(Markup.button.callback('⬅️', `${prefix}${page - 1}`));
  if (totalPages > 1) {
    nav.push(Markup.button.callback(`· ${page + 1}/${totalPages} ·`, 'noop'));
  }
  if (page < totalPages - 1) nav.push(Markup.button.callback('➡️', `${prefix}${page + 1}`));
  return nav;
}

/** Merge Serie 1 / 1 Series into one button; keep the label with most stock (DB-safe). */
function dedupeModelOptions(
  models: { model: string; count: number }[]
): { model: string; count: number }[] {
  type Agg = { model: string; count: number; bestCount: number };
  const map = new Map<string, Agg>();
  for (const m of models) {
    if (!isUsableModelLabel(m.model)) continue;
    const key = resolveCatalogModelKey(m.model) || softModelNorm(m.model);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { model: m.model, count: m.count, bestCount: m.count });
    } else {
      prev.count += m.count;
      if (m.count > prev.bestCount) {
        prev.model = m.model;
        prev.bestCount = m.count;
      }
    }
  }
  return [...map.values()]
    .map(({ model, count }) => ({ model, count }))
    .sort((a, b) =>
      a.model.localeCompare(b.model, 'en', { numeric: true, sensitivity: 'base' })
    );
}

function isTelegramNotModifiedError(err: unknown): boolean {
  const desc =
    (err as any)?.response?.description ||
    (err as any)?.message ||
    '';
  return typeof desc === 'string' && desc.includes('message is not modified');
}

/** editMessageText that ignores no-op edits (same text + keyboard). */
async function safeEditMessageText(ctx: any, text: string, extra?: object) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (!isTelegramNotModifiedError(err)) throw err;
  }
}

export async function renderFiltersMenu(ctx: any, telegramIdNum: number, draft: FilterDraft, isEdit: boolean = true) {
  const selectedVersions = draft.versions && draft.versions.length > 0 ? draft.versions.join(', ') : 'Any';
  const selectedEngines =
    draft.engines && draft.engines.length > 0
      ? draft.engines
          .map((e) => {
            // Lazy: avoid top-level circular import; format for display only
            const n = e.replace(/^0(?:\.0)?\s+/i, '').trim();
            return n ? n.toUpperCase() : e;
          })
          .join(', ')
      : 'Any';
  const selectedFuels = draft.fuelTypes && draft.fuelTypes.length > 0 ? draft.fuelTypes.join(', ') : 'Any';
  const selectedCountries = formatCountriesList(draft.countries);
  
  const text = `⚙️ **VIP Dashboard - Your Filters**\n\n` +
    `⚠️ **No digests yet?** That is usually the filter — not a system error.\n` +
    `Inventory is still growing daily. If alerts are quiet, **widen** brand, model, specs, motor, power, fuel, price, year, km or country (or leave more on **Any**), then tap panel **Done**.\n\n` +
    `Your selected preferences:\n` +
    `🏷️ Brand: ${draft.brand || 'Any'}\n` +
    `🚗 Model: ${draft.model || 'Any'}\n` +
    `🔧 Specs: ${selectedVersions}\n` +
    `🛠 Motor: ${selectedEngines}\n` +
    `⚡ Power: ${draft.minPowerHp ? `≥ ${draft.minPowerHp} CV` : 'Any'}\n` +
    `⛽ Fuel: ${selectedFuels}\n` +
    `💰 Max Price: ${draft.maxPrice ? `≤ ${draft.maxPrice.toLocaleString()}€` : 'Any'}\n` +
    `📅 Min Year: ${draft.minYear ? `≥ ${draft.minYear}` : 'Any'}\n` +
    `🛣️ Max Mileage: ${draft.maxMileageKm ? (draft.maxMileageKm === 9999999 ? 'Any' : `≤ ${draft.maxMileageKm.toLocaleString()} km`) : 'Any'}\n` +
    `🌍 Country: ${selectedCountries}\n\n` +
    `*Each filter **Done** updates the draft. Panel **Done** saves to your radar (DB).*`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🏷️ Brand', 'filter_brand'), Markup.button.callback('🚗 Model', 'filter_model')],
    [Markup.button.callback('🔧 Specs', 'filter_specs'), Markup.button.callback('🛠 Motor', 'filter_engine')],
    [Markup.button.callback('⚡ Power', 'filter_power'), Markup.button.callback('⛽ Fuel', 'filter_fuel')],
    [Markup.button.callback('💰 Price', 'filter_price'), Markup.button.callback('📅 Year', 'filter_year')],
    [Markup.button.callback('🛣️ Km', 'filter_km'), Markup.button.callback('🌍 Country', 'filter_country')],
    [Markup.button.callback('🔄 Reset', 'filter_reset'), Markup.button.callback('✅ Done', 'filter_save')]
  ]);

  try {
    if (isEdit && ctx.updateType === 'callback_query') {
      await safeEditMessageText(ctx, text, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (e) {
    // If it fails, no need to crash
  }
}

async function buildBrandKeyboard(page: number = 0, selectedBrand?: string | null) {
  const allBrands = await getAvailableBrands();
  
  if (allBrands.length === 0) {
    return {
      keyboard: Markup.inlineKeyboard([
        filterFooterRow('🔄 Any brand', 'set_brand_null')
      ]),
      totalPages: 0,
      totalBrands: 0
    };
  }

  const totalPages = Math.max(1, Math.ceil(allBrands.length / BRANDS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const startIdx = safePage * BRANDS_PER_PAGE;
  const pageBrands = allBrands.slice(startIdx, startIdx + BRANDS_PER_PAGE);

  const rows: any[][] = chunkButtons(
    pageBrands.map((b) => {
      const prefix = selectedBrand && selectedBrand === b.brand ? '✅ ' : '';
      return Markup.button.callback(
        `${prefix}${b.brand} (${formatApproxCount(b.count)})`,
        `set_brand_${b.brand}`
      );
    }),
    GRID_COLS
  );

  const nav = pageNavRow(safePage, totalPages, 'brand_page_');
  if (nav.length) rows.push(nav);
  rows.push(filterFooterRow('🔄 All brands', 'set_brand_null'));

  return {
    keyboard: Markup.inlineKeyboard(rows),
    totalPages,
    totalBrands: allBrands.length
  };
}

async function buildModelKeyboard(
  brand: string,
  selectedModel?: string | null,
  page: number = 0
) {
  const raw = await getAvailableModels(brand);
  const models = dedupeModelOptions(raw);

  if (models.length === 0) {
    return Markup.inlineKeyboard([filterFooterRow('🔄 All models', 'set_model_null')]);
  }

  const totalPages = Math.max(1, Math.ceil(models.length / FILTERS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = models.slice(
    safePage * FILTERS_PER_PAGE,
    safePage * FILTERS_PER_PAGE + FILTERS_PER_PAGE
  );

  const rows: any[][] = chunkButtons(
    slice.map((m) => {
      const selected =
        selectedModel &&
        (selectedModel === m.model ||
          resolveCatalogModelKey(selectedModel) === resolveCatalogModelKey(m.model));
      const prefix = selected ? '✅ ' : '';
      return Markup.button.callback(
        `${prefix}${m.model} (${formatApproxCount(m.count)})`,
        `set_model_${m.model}`
      );
    }),
    GRID_COLS
  );

  const nav = pageNavRow(safePage, totalPages, 'model_page_');
  if (nav.length) rows.push(nav);
  rows.push(filterFooterRow('🔄 All models', 'set_model_null'));

  return Markup.inlineKeyboard(rows);
}

// Temporary map to avoid callbacks over 64 bytes when selecting specifications/versions.
const versionCallbackMap = new Map<string, string>();

// Temporary map to avoid callbacks over 64 bytes when selecting fuel types.
const fuelCallbackMap = new Map<string, string>();

// Short ids for country ISO codes in callbacks
const countryCallbackMap = new Map<string, string>();

async function buildCountryKeyboard(
  draft: FilterDraft,
  selected: string[],
  page: number = 0
) {
  const scope = draftScope(draft, ['countries']);
  const countries = await getAvailableCountries(
    draft.brand,
    draft.model,
    draft.versions,
    scope
  );

  const scopeHint = [
    draft.brand ? `Brand: ${draft.brand}` : null,
    draft.model ? `Model: ${draft.model}` : null,
    draft.versions?.length ? `Specs: ${draft.versions.join(', ')}` : null,
    draft.engines?.length ? `Motor: ${draft.engines.join(', ')}` : null,
    draft.minPowerHp != null ? `Power: ≥${draft.minPowerHp} CV` : null,
    draft.fuelTypes?.length ? `Fuel: ${draft.fuelTypes.join(', ')}` : null,
    draft.maxPrice != null ? `Price: ≤${draft.maxPrice}€` : null,
    draft.minYear != null ? `Year: ≥${draft.minYear}` : null,
    draft.maxMileageKm != null ? `Km: ≤${draft.maxMileageKm}` : null
  ]
    .filter(Boolean)
    .join(' · ');

  if (countries.length === 0) {
    return {
      keyboard: Markup.inlineKeyboard([
        filterFooterRow('🔄 Any country', 'clear_countries')
      ]),
      infoSuffix:
        '\n\n_No countries match your filters above — widen Power/Price/Year/Km or leave Country on **Any**._' +
        (scopeHint ? `\n_(Scoped: ${scopeHint})_` : ''),
      totalPages: 0
    };
  }

  const totalPages = Math.max(1, Math.ceil(countries.length / COUNTRY_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = countries.slice(
    safePage * COUNTRY_PER_PAGE,
    safePage * COUNTRY_PER_PAGE + COUNTRY_PER_PAGE
  );

  const rows: ReturnType<typeof Markup.button.callback>[][] = chunkButtons(
    slice.map(({ code, count }) => {
      const isSelected = selected.includes(code);
      const prefix = isSelected ? '✅ ' : '⬜ ';
      let shortId = Array.from(countryCallbackMap.entries()).find(([, val]) => val === code)?.[0];
      if (!shortId) {
        shortId = `c_${countryCallbackMap.size}`;
        countryCallbackMap.set(shortId, code);
      }
      return Markup.button.callback(
        `${prefix}${countryLabel(code)} (${formatApproxCount(count)})`,
        `toggle_country_${shortId}`
      );
    }),
    COUNTRY_COLS
  );

  const nav = pageNavRow(safePage, totalPages, 'country_page_');
  if (nav.length) rows.push(nav);

  rows.push(filterFooterRow('🔄 Any', 'clear_countries'));

  return {
    keyboard: Markup.inlineKeyboard(rows),
    infoSuffix:
      `\n\n_Page ${safePage + 1}/${totalPages}. Counts follow filters above` +
      `${scopeHint ? ` (${scopeHint})` : ''}. Empty = Any._`,
    totalPages
  };
}

async function buildFuelKeyboard(draft: FilterDraft, page: number = 0) {
  const selectedFuels = draft.fuelTypes ?? [];
  const scope = draftScope(draft, ['fuelTypes']);
  const limits = await getInventoryContextLimits(
    draft.brand,
    draft.model,
    draft.versions,
    scope
  );
  const activeFuels = limits?.fuels ?? [];
  const scopeHint = formatDraftScopeHint(draft, ['fuelTypes']);

  if (activeFuels.length === 0) {
    return {
      keyboard: Markup.inlineKeyboard([
        filterFooterRow('🔄 Any fuel', 'clear_fuels')
      ]),
      infoSuffix:
        '\n\n_No fuels in stock for filters above — **Any** keeps all fuel types._' +
        (scopeHint ? `\n_(Scoped: ${scopeHint})_` : '')
    };
  }

  const totalPages = Math.max(1, Math.ceil(activeFuels.length / FILTERS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = activeFuels.slice(
    safePage * FILTERS_PER_PAGE,
    safePage * FILTERS_PER_PAGE + FILTERS_PER_PAGE
  );

  const rows: ReturnType<typeof Markup.button.callback>[][] = chunkButtons(
    slice.map((fuel) => {
      const isSelected = selectedFuels.includes(fuel);
      const prefix = isSelected ? '✅ ' : '⬜ ';
      let shortId = Array.from(fuelCallbackMap.entries()).find(([, val]) => val === fuel)?.[0];
      if (!shortId) {
        shortId = `f_${fuelCallbackMap.size}`;
        fuelCallbackMap.set(shortId, fuel);
      }
      return Markup.button.callback(`${prefix}${fuel}`, `toggle_fuel_${shortId}`);
    }),
    GRID_COLS
  );

  const nav = pageNavRow(safePage, totalPages, 'fuel_page_');
  if (nav.length) rows.push(nav);
  rows.push(filterFooterRow('🔄 Any', 'clear_fuels'));

  return {
    keyboard: Markup.inlineKeyboard(rows),
    infoSuffix:
      `\n\n_Page ${safePage + 1}/${totalPages}. Fuels in stock for filters above` +
      `${scopeHint ? ` (${scopeHint})` : ''}. Empty = Any._`
  };
}

function formatDraftScopeHint(
  draft: FilterDraft,
  omit: Array<keyof FilterDraft> = []
): string {
  const skip = new Set(omit);
  return [
    !skip.has('brand') && draft.brand ? `Brand: ${draft.brand}` : null,
    !skip.has('model') && draft.model ? `Model: ${draft.model}` : null,
    !skip.has('versions') && draft.versions?.length
      ? `Specs: ${draft.versions.join(', ')}`
      : null,
    !skip.has('engines') && draft.engines?.length
      ? `Motor: ${draft.engines.join(', ')}`
      : null,
    !skip.has('minPowerHp') && draft.minPowerHp != null
      ? `Power: ≥${draft.minPowerHp} CV`
      : null,
    !skip.has('fuelTypes') && draft.fuelTypes?.length
      ? `Fuel: ${draft.fuelTypes.join(', ')}`
      : null,
    !skip.has('maxPrice') && draft.maxPrice != null
      ? `Price: ≤${draft.maxPrice}€`
      : null,
    !skip.has('minYear') && draft.minYear != null
      ? `Year: ≥${draft.minYear}`
      : null,
    !skip.has('maxMileageKm') && draft.maxMileageKm != null
      ? `Km: ≤${draft.maxMileageKm}`
      : null,
    !skip.has('countries') && draft.countries?.length
      ? `Country: ${draft.countries.join(',')}`
      : null
  ]
    .filter(Boolean)
    .join(' · ');
}

async function buildVersionKeyboard(brand: string, model: string, selectedVersions: string[], page: number = 0) {
  // Official trims from car-specifications.json (with EN↔ES model aliases)
  let versionsList = getCatalogSpecs(brand, model);
  let source: 'catalog' | 'stock' | 'empty' = versionsList.length ? 'catalog' : 'empty';

  // No catalog map for this model name → fall back to tokens seen in stock
  if (versionsList.length === 0) {
    const stock = await getAvailableVersions(brand, model);
    versionsList = stock.map((s) => s.version).filter(Boolean);
    source = versionsList.length ? 'stock' : 'empty';
  }

  if (versionsList.length === 0) {
    return {
      keyboard: Markup.inlineKeyboard([
        filterFooterRow('🔄 Any specification', 'clear_versions')
      ]),
      totalPages: 0,
      infoSuffix:
        '\n\n_No trims mapped for this model yet — keep **Any** (all ads). Motor/Power still work from stock._'
    };
  }

  const totalPages = Math.max(1, Math.ceil(versionsList.length / FILTERS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const startIdx = safePage * FILTERS_PER_PAGE;
  const pageVersions = versionsList.slice(startIdx, startIdx + FILTERS_PER_PAGE);

  const rows: any[][] = chunkButtons(
    pageVersions.map((v) => {
      const isSelected = selectedVersions.includes(v);
      const prefix = isSelected ? '✅ ' : '⬜ ';
      const cleanKey = v;
      let shortId = Array.from(versionCallbackMap.entries()).find(([_, val]) => val === cleanKey)?.[0];
      if (!shortId) {
        shortId = `v_${versionCallbackMap.size}`;
        versionCallbackMap.set(shortId, cleanKey);
      }
      return Markup.button.callback(`${prefix}${v}`, `toggle_version_${shortId}`);
    }),
    GRID_COLS
  );

  const nav = pageNavRow(safePage, totalPages, 'version_page_');
  if (nav.length) rows.push(nav);

  rows.push(filterFooterRow('🔄 Clear / Any', 'clear_versions'));

  return {
    keyboard: Markup.inlineKeyboard(rows),
    totalPages,
    infoSuffix:
      source === 'stock'
        ? `\n\n_Page ${safePage + 1}/${totalPages}. Showing **stock** version tokens. Empty = Any._`
        : `\n\n_Page ${safePage + 1}/${totalPages}. Official trims — select, then **Done**. Empty = Any._`
  };
}

const engineCallbackMap = new Map<string, string>();

/** Prefer stock engines that match diesel/petrol when Fuel is already set. */
function engineFitsFuel(engineLabel: string, fuelTypes?: string[] | null): boolean {
  if (!fuelTypes?.length) return true;
  const n = engineLabel.toLowerCase();
  const fuels = fuelTypes.map((f) => f.toLowerCase());
  const wantsDiesel = fuels.some((f) => f.includes('diesel'));
  const wantsPetrol = fuels.some(
    (f) => f.includes('petrol') || f.includes('gasoline') || f.includes('gasolina')
  );
  const wantsHybrid = fuels.some((f) => f.includes('hybrid'));
  const wantsElectric = fuels.some((f) => f.includes('electric') || f === 'ev');

  const isDiesel = /\b(tdi|tdci|dci|hdi|bluehdi|crdi|ecoblue|diesel)\b/.test(n);
  const isElectric = /\b(electric|e-tron|kwh|edrive)\b/.test(n);
  const isHybrid = /\bhybrid|e-tech|e-power|dm-i|etsi\b/.test(n);
  const isPetrol =
    /\b(tfsi|tsi|ecoboost|puretech|tce|sce|mpi|gdi|t-gdi|boosterjet|skyactiv)\b/.test(n) ||
    (!isDiesel && !isElectric && !isHybrid);

  if (wantsDiesel && !wantsPetrol) return isDiesel;
  if (wantsPetrol && !wantsDiesel) return isPetrol || isHybrid;
  if (wantsHybrid && !wantsPetrol && !wantsDiesel) return isHybrid;
  if (wantsElectric && !wantsPetrol && !wantsDiesel) return isElectric;
  return true;
}

/**
 * Motor options scoped by Brand + Model + Specs (+ Fuel/Price/Year/Km/Country draft).
 * Stock-first from DB; catalog fallback only when no stock engines and filtered by Fuel.
 */
async function buildEngineKeyboard(draft: FilterDraft, page: number = 0) {
  const brand = draft.brand || '';
  const model = draft.model || '';
  const selected = draft.engines || [];
  const versions = draft.versions || [];
  // Omit engines — this menu is choosing them; scope by Specs/Fuel/Price/…
  const scope = draftScope(draft, ['engines']);

  const {
    getCatalogEngines,
    normalizeEngineKey,
    formatEngineLabel
  } = await import('../services/engineCatalog.service.js');
  const limits = await getInventoryContextLimits(brand, model, versions, scope);
  const catalog = getCatalogEngines(brand, model);
  const catalogByNorm = new Map(
    catalog.map((e) => [normalizeEngineKey(e.engine), e.engine])
  );
  const selectedSet = new Set(selected.map((e) => normalizeEngineKey(e)));

  const stockNorms = (limits?.engines ?? []).filter((n) =>
    engineFitsFuel(
      catalogByNorm.get(normalizeEngineKey(n)) || formatEngineLabel(n),
      draft.fuelTypes
    )
  );
  const labels: { norm: string; label: string }[] = [];
  const seen = new Set<string>();

  for (const norm of stockNorms) {
    // "0 tfsi" → "tfsi" so the button shows TFSI, not "0 TFSI"
    const n = normalizeEngineKey(norm);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    labels.push({
      norm: n,
      label: catalogByNorm.get(n) || formatEngineLabel(n)
    });
  }

  // No stock for this Specs/Fuel slice → catalog filtered by fuel (never dump all model engines
  // when Specs or Fuel already narrow the search).
  if (labels.length === 0) {
    const scoped = versions.length > 0 || (draft.fuelTypes?.length ?? 0) > 0;
    const source = scoped
      ? catalog.filter((e) => engineFitsFuel(e.engine, draft.fuelTypes))
      : catalog;
    for (const e of source) {
      const n = normalizeEngineKey(e.engine);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      labels.push({ norm: n, label: e.engine });
    }
  }

  const scopeHint = formatDraftScopeHint(draft, ['engines']);

  if (labels.length === 0) {
    return {
      keyboard: Markup.inlineKeyboard([
        filterFooterRow('🔄 Any engine', 'clear_engines')
      ]),
      infoSuffix:
        `\n\n_No engines in stock${scopeHint ? ` for (${scopeHint})` : ''} yet — keep **Any** or wait for enrichment._`
    };
  }

  const totalPages = Math.max(1, Math.ceil(labels.length / FILTERS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = labels.slice(safePage * FILTERS_PER_PAGE, (safePage + 1) * FILTERS_PER_PAGE);

  const rows: ReturnType<typeof Markup.button.callback>[][] = chunkButtons(
    slice.map((item) => {
      const shortId = Math.random().toString(36).slice(2, 10);
      engineCallbackMap.set(shortId, item.norm);
      const mark = selectedSet.has(item.norm) ? '✅ ' : '';
      return Markup.button.callback(`${mark}${item.label}`, `toggle_engine_${shortId}`);
    }),
    GRID_COLS
  );

  const nav = pageNavRow(safePage, totalPages, 'engine_page_');
  if (nav.length) rows.push(nav);

  rows.push(filterFooterRow('🔄 Clear / Any', 'clear_engines'));

  const fromStock = (limits?.engines?.length ?? 0) > 0;
  return {
    keyboard: Markup.inlineKeyboard(rows),
    infoSuffix:
      `\n\n_Page ${safePage + 1}/${totalPages}. Multi-select${fromStock ? ' from stock' : ' (catalog)'}` +
      `${scopeHint ? ` · ${scopeHint}` : ''}. Empty = Any._`
  };
}

async function showPowerMenu(ctx: any, draft: FilterDraft) {
  const limits = await getInventoryContextLimits(
    draft.brand,
    draft.model,
    draft.versions,
    draftScope(draft, ['minPowerHp'])
  );

  const scopeHint = formatDraftScopeHint(draft, ['minPowerHp']);

  let infoText = '⚡ Select the **Min Power (CV)**:';
  if (draft.minPowerHp != null) {
    infoText += `\n_Selected: **≥ ${draft.minPowerHp} CV** — tap **Done**._`;
  } else {
    infoText += `\n_Selected: **Any** — tap **Done** to keep in draft._`;
  }
  if (scopeHint) {
    infoText += `\n_(Scoped: ${scopeHint})_`;
  }

  const optionBtns: ReturnType<typeof Markup.button.callback>[] = [];
  if (limits && limits.maxPower > 0) {
    infoText += `\n_(Stock: ${limits.minPower} - ${limits.maxPower} CV | Avg: ${Math.round(limits.avgPower)} CV)_`;

    // Min-power filter is powerHp >= N. Only offer N that still leave stock
    // (N <= maxPower). Never round UP past max — that empties the pool (e.g. 116 → 120).
    const maxP = limits.maxPower;
    const minP = limits.minPower > 0 ? limits.minPower : maxP;
    const avgP = limits.avgPower > 0 ? limits.avgPower : (minP + maxP) / 2;
    const floor10 = (n: number) => Math.floor(n / 10) * 10;
    const candidates = new Set<number>();

    for (const raw of [
      floor10(minP),
      floor10(minP) - 20,
      floor10(avgP),
      floor10(avgP) - 20,
      floor10(maxP),
      floor10(maxP) - 20,
      Math.max(50, floor10(minP) - 10)
    ]) {
      if (raw >= 40 && raw <= 800 && raw <= maxP) candidates.add(raw);
    }

    // Single-CV stock (e.g. all 116): keep 1–2 useful floors, not a dead "> max" button
    if (minP === maxP && candidates.size === 0) {
      const only = floor10(maxP);
      if (only >= 40 && only <= maxP) candidates.add(only);
      const softer = Math.max(50, only - 20);
      if (softer <= maxP) candidates.add(softer);
    }

    const options = [...candidates].sort((a, b) => a - b);
    for (const cv of options) {
      const mark = draft.minPowerHp === cv ? '✅ ' : '';
      optionBtns.push(Markup.button.callback(`${mark}≥ ${cv} CV`, `set_power_${cv}`));
    }
  } else {
    infoText += `\n_No CV in stock for this slice yet — pick a soft default or keep Any._`;
    for (const cv of [90, 110, 130, 150, 180, 220]) {
      const mark = draft.minPowerHp === cv ? '✅ ' : '';
      optionBtns.push(Markup.button.callback(`${mark}≥ ${cv} CV`, `set_power_${cv}`));
    }
  }

  const buttons: any[] = [...chunkButtons(optionBtns, GRID_COLS)];
  buttons.push(filterFooterRow('🔄 No limit', 'set_power_null'));

  await safeEditMessageText(ctx, infoText, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup
  });
}

async function showPriceMenu(ctx: any, draft: FilterDraft) {
  const limits = await getInventoryContextLimits(
    draft.brand,
    draft.model,
    draft.versions,
    draftScope(draft, ['maxPrice'])
  );

  let infoText = '💰 Select the **Max Price**:';
  if (draft.maxPrice != null) {
    infoText += `\n_Selected: **≤ ${draft.maxPrice.toLocaleString()}€** — tap **Done**._`;
  } else {
    infoText += `\n_Selected: **Any** — tap **Done** to keep in draft._`;
  }
  const optionBtns: ReturnType<typeof Markup.button.callback>[] = [];

  if (limits && limits.avgPrice > 0) {
    infoText += `\n_(Stock: ${limits.minPrice.toLocaleString()}€ - ${limits.maxPrice.toLocaleString()}€ | Avg: ${Math.round(limits.avgPrice).toLocaleString()}€)_`;

    const avg = roundPrice(limits.avgPrice);
    const minVal = roundPrice(limits.minPrice);
    const maxVal = roundPrice(limits.maxPrice);
    const belowAvg = roundPrice(limits.avgPrice * 0.85);
    const aboveAvg = roundPrice(limits.avgPrice * 1.15);

    const options = [...new Set([minVal, belowAvg, avg, aboveAvg, maxVal].filter(v => v > 0))].sort((a, b) => a - b);
    for (const p of options) {
      const mark = draft.maxPrice === p ? '✅ ' : '';
      optionBtns.push(Markup.button.callback(`${mark}≤ ${p.toLocaleString()}€`, `set_price_${p}`));
    }
  } else {
    for (const p of [20000, 30000, 50000, 100000]) {
      const mark = draft.maxPrice === p ? '✅ ' : '';
      optionBtns.push(Markup.button.callback(`${mark}≤ ${p.toLocaleString()}€`, `set_price_${p}`));
    }
  }

  const buttons = [
    ...chunkButtons(optionBtns, GRID_COLS),
    filterFooterRow('🔄 No limit', 'set_price_null')
  ];

  await safeEditMessageText(ctx, infoText, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup
  });
}

async function showYearMenu(ctx: any, draft: FilterDraft) {
  const limits = await getInventoryContextLimits(
    draft.brand,
    draft.model,
    draft.versions,
    draftScope(draft, ['minYear'])
  );

  let infoText = '📅 Select the **Min Year**:';
  if (draft.minYear != null) {
    infoText += `\n_Selected: **≥ ${draft.minYear}** — tap **Done**._`;
  } else {
    infoText += `\n_Selected: **Any** — tap **Done** to keep in draft._`;
  }
  const optionBtns: ReturnType<typeof Markup.button.callback>[] = [];

  if (limits && limits.avgYear > 0) {
    const minVal = saneMinYear(limits.minYear);
    const maxVal = Math.max(minVal, limits.maxYear || minVal);
    const avgYear = Math.max(minVal, Math.round(limits.avgYear));
    infoText += `\n_(Stock: ${minVal} - ${maxVal} | Avg: ${avgYear})_`;

    const options = [
      ...new Set(
        [minVal, avgYear - 2, avgYear, avgYear + 1, maxVal - 1, maxVal].filter(
          (y) => y >= minVal && y <= maxVal && y >= 1970
        )
      )
    ].sort((a, b) => a - b);
    for (const y of options) {
      const mark = draft.minYear === y ? '✅ ' : '';
      optionBtns.push(Markup.button.callback(`${mark}≥ ${y}`, `set_year_${y}`));
    }
  } else {
    for (const y of [2010, 2015, 2020]) {
      const mark = draft.minYear === y ? '✅ ' : '';
      optionBtns.push(Markup.button.callback(`${mark}≥ ${y}`, `set_year_${y}`));
    }
  }

  const buttons = [
    ...chunkButtons(optionBtns, GRID_COLS),
    filterFooterRow('🔄 No limit', 'set_year_null')
  ];

  await safeEditMessageText(ctx, infoText, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup
  });
}

async function showKmMenu(ctx: any, draft: FilterDraft) {
  const limits = await getInventoryContextLimits(
    draft.brand,
    draft.model,
    draft.versions,
    draftScope(draft, ['maxMileageKm'])
  );

  let infoText = '🛣️ Select the **Max Mileage**:';
  if (draft.maxMileageKm != null) {
    infoText += `\n_Selected: **≤ ${draft.maxMileageKm.toLocaleString()} km** — tap **Done**._`;
  } else {
    infoText += `\n_Selected: **Any** — tap **Done** to keep in draft._`;
  }
  const optionBtns: ReturnType<typeof Markup.button.callback>[] = [];

  if (limits && limits.avgMileage > 0) {
    const minVal = roundMileage(Math.max(0, limits.minMileage));
    const maxVal = Math.min(roundMileage(limits.maxMileage), 300_000);
    const avg = roundMileage(limits.avgMileage);
    const belowAvg = roundMileage(limits.avgMileage * 0.85);
    const aboveAvg = roundMileage(limits.avgMileage * 1.15);
    infoText += `\n_(Stock: ${limits.minMileage.toLocaleString()}km - ${Math.min(limits.maxMileage, 300000).toLocaleString()}km | Avg: ${Math.round(limits.avgMileage).toLocaleString()}km)_`;

    const options = [...new Set([minVal, belowAvg, avg, aboveAvg, maxVal].filter(v => v > 0 && v <= 300_000))].sort((a, b) => a - b);
    for (const k of options) {
      const mark = draft.maxMileageKm === k ? '✅ ' : '';
      optionBtns.push(Markup.button.callback(`${mark}≤ ${k.toLocaleString()} km`, `set_km_${k}`));
    }
  } else {
    for (const k of [50000, 100000, 150000, 200000]) {
      const mark = draft.maxMileageKm === k ? '✅ ' : '';
      optionBtns.push(Markup.button.callback(`${mark}≤ ${k.toLocaleString()} km`, `set_km_${k}`));
    }
  }

  const buttons = [
    ...chunkButtons(optionBtns, GRID_COLS),
    filterFooterRow('🔄 No limit', 'set_km_null')
  ];

  await safeEditMessageText(ctx, infoText, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup
  });
}

export function setupFiltersMenu(bot: Telegraf) {
  /** Open filters: load DB into draft only when no in-memory draft yet. */
  bot.action('vip_filters', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) }, include: { alerts: true } });
    if (!user || (user.subscriptionStatus !== 'vip' && user.subscriptionStatus !== 'cancelling')) {
      return ctx.answerCbQuery('Available for VIP users only.', { show_alert: true });
    }

    let draft = userDrafts.get(telegramId);
    if (!draft) {
      draft = { versions: [], engines: [], fuelTypes: [], countries: [] };
    if (user.alerts && user.alerts.length > 0) {
      const alert = user.alerts[0];
      if (alert) {
        draft = {
          brand: alert.brand,
          model: alert.model,
          versions: (alert as any).versions || [],
            engines: (alert as any).engines || [],
            minPowerHp: (alert as any).minPowerHp ?? null,
          maxPrice: alert.maxPrice,
          minYear: alert.minYear,
          maxMileageKm: alert.maxMileageKm,
            fuelTypes: (alert as { fuelTypes?: string[] }).fuelTypes ?? [],
            countries: (alert as { countries?: string[] }).countries ?? []
        };
      }
    }
    userDrafts.set(telegramId, draft);
    }
    
    await renderFiltersMenu(ctx, telegramId, draft, true);
    await ctx.answerCbQuery();
  });

  /** Confirm draft changes from a submenu (does NOT write DB). */
  bot.action('filter_done', async (ctx) => {
    const telegramId = ctx.from!.id;
    commitDraftSnapshot(telegramId);
    const draft = userDrafts.get(telegramId) || { versions: [], fuelTypes: [], countries: [] };
    userDrafts.set(telegramId, draft);
    await renderFiltersMenu(ctx, telegramId, draft, true);
    await ctx.answerCbQuery('Draft updated');
  });

  /** Discard submenu edits and return to panel. */
  bot.action('filter_back', async (ctx) => {
    const telegramId = ctx.from!.id;
    restoreDraftSnapshot(telegramId);
    const draft = userDrafts.get(telegramId) || { versions: [], fuelTypes: [], countries: [] };
    await renderFiltersMenu(ctx, telegramId, draft, true);
    await ctx.answerCbQuery();
  });

  /** Stay on current draft — never wipe from DB. */
  bot.action('filters_home', async (ctx) => {
    const telegramId = ctx.from!.id;
    commitDraftSnapshot(telegramId);
    const draft = userDrafts.get(telegramId) || { versions: [], fuelTypes: [], countries: [] };
    userDrafts.set(telegramId, draft);
    await renderFiltersMenu(ctx, telegramId, draft, true);
    await ctx.answerCbQuery();
  });

  // ── BRAND ──
  bot.action('filter_brand', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    snapshotDraft(telegramId);
    draft.awaitingInputFor = 'brand';
    draft.brandPage = 0;
    userDrafts.set(telegramId, draft);
    
    const { keyboard } = await buildBrandKeyboard(0, draft.brand);
    await safeEditMessageText(ctx,
      `🏷️ Select a **Brand**:\n\n_Pick one, then **Done** to keep it in your draft._`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^brand_page_(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]!, 10);
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    draft.brandPage = page;
    userDrafts.set(telegramId, draft);

    const { keyboard } = await buildBrandKeyboard(page, draft.brand);
    await safeEditMessageText(ctx,
      `🏷️ Select a **Brand** (Page ${page + 1}):\n\n_Then tap **Done**._`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^set_brand_(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const brand = ctx.match[1] || null;
    const draft = userDrafts.get(telegramId) || {};
    const nextBrand = brand === 'null' ? null : brand;
    const brandChanged = (draft.brand || null) !== nextBrand;

    draft.brand = nextBrand;
    if (brandChanged) {
      resetFiltersAfter(draft, 'brand');
    }
    draft.awaitingInputFor = 'brand';
    userDrafts.set(telegramId, draft);

    const page = draft.brandPage || 0;
    const { keyboard } = await buildBrandKeyboard(page, draft.brand);
    const label = draft.brand || 'Any';
    await safeEditMessageText(ctx,
      `🏷️ Select a **Brand**:\n\n_Selected: **${label}** — tap **Done** to keep in draft._` +
        (brandChanged ? `\n_Dependent filters reset to **Any**._` : ''),
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery(
      brandChanged
        ? (draft.brand ? `Brand: ${draft.brand} — filters cleared` : 'All brands — filters cleared')
        : (draft.brand ? `Brand: ${draft.brand}` : 'All brands')
    );
  });

  // ── MODEL ──
  bot.action('filter_model', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    snapshotDraft(telegramId);
    draft.awaitingInputFor = 'model';
    draft.modelPage = 0;
    userDrafts.set(telegramId, draft);
    
    if (draft.brand) {
      const keyboard = await buildModelKeyboard(draft.brand, draft.model, 0);
      await safeEditMessageText(ctx,
        `🚗 Select a **Model** for **${draft.brand}**:\n\n_Pick one, then **Done** to keep it in your draft._`,
        { parse_mode: 'Markdown', ...keyboard }
      );
    } else {
      const keyboard = Markup.inlineKeyboard([
        filterFooterRow('🔄 All models', 'set_model_null')
      ]);
      await safeEditMessageText(ctx,
        '✍️ Please select a **Brand** first to see available models.',
        { parse_mode: 'Markdown', ...keyboard }
      );
    }
    await ctx.answerCbQuery();
  });

  bot.action(/^set_model_(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const modelVal = ctx.match[1] || null;
    const draft = userDrafts.get(telegramId) || {};

    let nextModel: string | null = null;
    if (modelVal === 'null') {
      nextModel = null;
    } else if (!isUsableModelLabel(modelVal)) {
      await ctx.answerCbQuery('Invalid model');
      return;
    } else {
      nextModel = modelVal;
    }

    const modelChanged = (draft.model || null) !== nextModel;
    draft.model = nextModel;
    if (modelChanged) {
      resetFiltersAfter(draft, 'model');
    }
    draft.awaitingInputFor = 'model';
    userDrafts.set(telegramId, draft);

    if (draft.brand) {
      const page = draft.modelPage || 0;
      const keyboard = await buildModelKeyboard(draft.brand, draft.model, page);
      const label = draft.model || 'Any';
      await safeEditMessageText(ctx,
        `🚗 Select a **Model** for **${draft.brand}**:\n\n_Selected: **${label}** — tap **Done** to keep in draft._` +
          (modelChanged ? `\n_Dependent filters reset to **Any**._` : ''),
        { parse_mode: 'Markdown', ...keyboard }
      );
    } else {
    await renderFiltersMenu(ctx, telegramId, draft, true);
    }
    await ctx.answerCbQuery(
      modelChanged
        ? (draft.model ? `Model: ${draft.model} — filters cleared` : 'All models — filters cleared')
        : (draft.model ? `Model: ${draft.model}` : 'All models')
    );
  });

  bot.action(/^model_page_(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]!, 10);
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    if (!draft.brand) return ctx.answerCbQuery();
    draft.modelPage = page;
    userDrafts.set(telegramId, draft);
    const keyboard = await buildModelKeyboard(draft.brand, draft.model, page);
    await safeEditMessageText(ctx,
      `🚗 Select a **Model** for **${draft.brand}** (Page ${page + 1}):\n\n_Pick one, then **Done**._`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
  });

  // ── SPECIFICATIONS / VERSIONS (MULTI-SELECT) ──
  bot.action('filter_specs', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    snapshotDraft(telegramId);
    draft.versionPage = 0;
    userDrafts.set(telegramId, draft);

    if (draft.brand && draft.model) {
      const selected = draft.versions || [];
      const { keyboard, infoSuffix } = await buildVersionKeyboard(draft.brand, draft.model, selected, 0);
      await safeEditMessageText(ctx,
        `🔧 Select **Specifications** for **${draft.brand} ${draft.model}**:${infoSuffix || ''}\n_Then tap **Done**._`,
        { parse_mode: 'Markdown', ...keyboard }
      );
    } else {
      const keyboard = Markup.inlineKeyboard([
        filterFooterRow('🔄 Any specification', 'clear_versions')
      ]);
      await safeEditMessageText(ctx,
        '🔧 **Specifications**\n\n_Pick a brand and model first for trim options, or keep **Any** for all specs._',
        { parse_mode: 'Markdown', ...keyboard }
      );
    }
    await ctx.answerCbQuery();
  });

  bot.action(/^version_page_(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]!, 10);
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    draft.versionPage = page;
    userDrafts.set(telegramId, draft);

    if (draft.brand && draft.model) {
      const selected = draft.versions || [];
      const { keyboard, infoSuffix } = await buildVersionKeyboard(draft.brand, draft.model, selected, page);
      await safeEditMessageText(ctx,
        `🔧 Select **Specifications** (Page ${page + 1}):${infoSuffix || ''}`,
        { parse_mode: 'Markdown', ...keyboard }
      );
    }
    await ctx.answerCbQuery();
  });

  bot.action(/^toggle_version_(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const shortId = ctx.match[1]!;
    
    // Retrieve the real specification from the map using the short ID
    const versionVal = versionCallbackMap.get(shortId);
    if (!versionVal) {
      await ctx.answerCbQuery('Option expired — open Specs again.');
      return;
    }

    const draft = userDrafts.get(telegramId) || {};
    
    if (!draft.versions) {
      draft.versions = [];
    }

    const idx = draft.versions.indexOf(versionVal);
    if (idx > -1) {
      draft.versions.splice(idx, 1);
    } else {
      draft.versions.push(versionVal);
    }
    resetFiltersAfter(draft, 'specs');

    userDrafts.set(telegramId, draft);
    
    const page = draft.versionPage || 0;
    const { keyboard, infoSuffix } = await buildVersionKeyboard(draft.brand!, draft.model!, draft.versions, page);
    
    await safeEditMessageText(ctx,
      `🔧 Select **Specifications** for **${draft.brand} ${draft.model}**:${infoSuffix || ''}\n_Then tap **Done**._`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
  });

  bot.action('clear_versions', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    draft.versions = [];
    resetFiltersAfter(draft, 'specs');
    userDrafts.set(telegramId, draft);

    const page = draft.versionPage || 0;
    if (draft.brand && draft.model) {
      const { keyboard } = await buildVersionKeyboard(draft.brand, draft.model, [], page);
      await safeEditMessageText(ctx,
        `🔧 Select **Specifications** for **${draft.brand} ${draft.model}**:\n\n_Cleared — **Any** specs. Tap **Done** when ready._`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    } else {
      await renderFiltersMenu(ctx, telegramId, draft, true);
    }
    await ctx.answerCbQuery('Any specification');
  });

  bot.action('specs_done', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    userDrafts.set(telegramId, draft);
    await renderFiltersMenu(ctx, telegramId, draft, true);
    await ctx.answerCbQuery();
  });

  // ── ENGINE (MOTOR) ──
  bot.action('filter_engine', async (ctx) => {
    const telegramId = ctx.from!.id;
    snapshotDraft(telegramId);
    const draft = userDrafts.get(telegramId) || { engines: [] };
    if (!draft.brand || !draft.model) {
      await safeEditMessageText(
        ctx,
        '🛠 **Engine**\n\n_Pick a brand and model first._',
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            filterFooterRow('🔄 Any engine', 'clear_engines')
          ]).reply_markup
        }
      );
      return ctx.answerCbQuery();
    }
    draft.enginePage = 0;
    const { keyboard, infoSuffix } = await buildEngineKeyboard(draft, 0);
    await safeEditMessageText(
      ctx,
      `🛠 Select **Engine** (Multi-select):${infoSuffix}\n_Then tap **Done**._`,
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/engine_page_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match?.[1] || '0', 10);
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || { engines: [] };
    if (!draft.brand || !draft.model) return ctx.answerCbQuery();
    draft.enginePage = page;
    const { keyboard, infoSuffix } = await buildEngineKeyboard(draft, page);
    await safeEditMessageText(
      ctx,
      `🛠 Select **Engine** (Multi-select):${infoSuffix}`,
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/toggle_engine_(.+)/, async (ctx) => {
    const shortId = ctx.match?.[1] || '';
    const rawNorm = engineCallbackMap.get(shortId);
    if (!rawNorm) return ctx.answerCbQuery('Option expired — open Motor again.');
    const { normalizeEngineKey, formatEngineLabel } = await import(
      '../services/engineCatalog.service.js'
    );
    const norm = normalizeEngineKey(rawNorm);
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || { engines: [] };
    if (!draft.engines) draft.engines = [];
    // Canonicalize any legacy "0 tfsi" already in the draft
    draft.engines = draft.engines.map((e) => normalizeEngineKey(e)).filter(Boolean);
    const idx = draft.engines.indexOf(norm);
    if (idx >= 0) draft.engines.splice(idx, 1);
    else draft.engines.push(norm);
    resetFiltersAfter(draft, 'engine');
    userDrafts.set(telegramId, draft);
    const page = draft.enginePage || 0;
    const { keyboard, infoSuffix } = await buildEngineKeyboard(draft, page);
    await safeEditMessageText(
      ctx,
      `🛠 Select **Engine** (Multi-select):${infoSuffix}`,
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
    await ctx.answerCbQuery(idx >= 0 ? 'Removed' : `+ ${formatEngineLabel(norm)}`);
  });

  bot.action('clear_engines', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    draft.engines = [];
    resetFiltersAfter(draft, 'engine');
    userDrafts.set(telegramId, draft);
    if (draft.brand && draft.model) {
      const { keyboard, infoSuffix } = await buildEngineKeyboard(draft, 0);
      await safeEditMessageText(
        ctx,
        `🛠 Select **Engine** (Multi-select):${infoSuffix}`,
        { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
      );
    }
    await ctx.answerCbQuery('Any engine');
  });

  bot.action('engine_done', async (ctx) => {
    const telegramId = ctx.from!.id;
    commitDraftSnapshot(telegramId);
    const draft = userDrafts.get(telegramId) || {};
    await renderFiltersMenu(ctx, telegramId, draft, true);
    await ctx.answerCbQuery();
  });

  // ── POWER (CV) ──
  bot.action('filter_power', async (ctx) => {
    const telegramId = ctx.from!.id;
    snapshotDraft(telegramId);
    const draft = userDrafts.get(telegramId) || {};
    await showPowerMenu(ctx, draft);
    await ctx.answerCbQuery();
  });

  bot.action(/set_power_(.+)/, async (ctx) => {
    const val = ctx.match?.[1] || '';
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    const next = val === 'null' ? null : parseInt(val, 10);
    if (draft.minPowerHp !== next) {
      resetFiltersAfter(draft, 'power');
      draft.minPowerHp = next;
    }
    userDrafts.set(telegramId, draft);
    await showPowerMenu(ctx, draft);
    await ctx.answerCbQuery(
      draft.minPowerHp != null ? `Min ≥ ${draft.minPowerHp} CV` : 'No power limit'
    );
  });

  bot.action('power_done', async (ctx) => {
    const telegramId = ctx.from!.id;
    commitDraftSnapshot(telegramId);
    const draft = userDrafts.get(telegramId) || {};
    await renderFiltersMenu(ctx, telegramId, draft, true);
    await ctx.answerCbQuery();
  });

  // ── MAX PRICE ──
  bot.action('filter_price', async (ctx) => {
    const telegramId = ctx.from!.id;
    snapshotDraft(telegramId);
    const draft = userDrafts.get(telegramId) || {};
    await showPriceMenu(ctx, draft);
    await ctx.answerCbQuery();
  });

  bot.action(/set_price_(.+)/, async (ctx) => {
    const val = ctx.match?.[1] || '';
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    const next = val === 'null' ? null : parseInt(val, 10);
    if (draft.maxPrice !== next) {
      resetFiltersAfter(draft, 'price');
      draft.maxPrice = next;
    }
    userDrafts.set(telegramId, draft);
    await showPriceMenu(ctx, draft);
    await ctx.answerCbQuery(
      draft.maxPrice != null ? `Max ≤ ${draft.maxPrice.toLocaleString()}€` : 'No price limit'
    );
  });

  // ── MIN YEAR ──
  bot.action('filter_year', async (ctx) => {
    const telegramId = ctx.from!.id;
    snapshotDraft(telegramId);
    const draft = userDrafts.get(telegramId) || {};
    await showYearMenu(ctx, draft);
    await ctx.answerCbQuery();
  });

  bot.action(/set_year_(.+)/, async (ctx) => {
    const val = ctx.match?.[1] || '';
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    const next = val === 'null' ? null : parseInt(val, 10);
    if (draft.minYear !== next) {
      resetFiltersAfter(draft, 'year');
      draft.minYear = next;
    }
    userDrafts.set(telegramId, draft);
    await showYearMenu(ctx, draft);
    await ctx.answerCbQuery(
      draft.minYear != null ? `Min year ≥ ${draft.minYear}` : 'No year limit'
    );
  });

  // ── MAX MILEAGE (KM) ──
  bot.action('filter_km', async (ctx) => {
    const telegramId = ctx.from!.id;
    snapshotDraft(telegramId);
    const draft = userDrafts.get(telegramId) || {};
    await showKmMenu(ctx, draft);
    await ctx.answerCbQuery();
  });

  bot.action(/set_km_(.+)/, async (ctx) => {
    const val = ctx.match?.[1] || '';
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    const next = val === 'null' ? null : parseInt(val, 10);
    if (draft.maxMileageKm !== next) {
      resetFiltersAfter(draft, 'km');
      draft.maxMileageKm = next;
    }
    userDrafts.set(telegramId, draft);
    await showKmMenu(ctx, draft);
    await ctx.answerCbQuery(
      draft.maxMileageKm != null
        ? `Max ≤ ${draft.maxMileageKm.toLocaleString()} km`
        : 'No mileage limit'
    );
  });

  // ── FUEL TYPE (MULTI-SELECT) ──
  bot.action('filter_fuel', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    snapshotDraft(telegramId);
    draft.fuelPage = 0;
    const selected = draft.fuelTypes ?? [];

    if (!draft.brand || !draft.model) {
      const keyboard = Markup.inlineKeyboard([
        filterFooterRow('🔄 Any fuel', 'clear_fuels')
      ]);
      await safeEditMessageText(ctx,
        '⛽ **Fuel type**\n\n_Pick a brand and model first for stock fuels, or keep **Any** for all fuels._',
        { parse_mode: 'Markdown', ...keyboard }
      );
      return ctx.answerCbQuery();
    }

    const { keyboard, infoSuffix } = await buildFuelKeyboard(draft, 0);

    await safeEditMessageText(ctx,
      `⛽ Select **Fuel Types** (Multi-select):${infoSuffix}\n_Then tap **Done**._`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^toggle_fuel_(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const shortId = ctx.match[1]!;
    const fuelVal = fuelCallbackMap.get(shortId);

    if (!fuelVal) {
      await ctx.answerCbQuery('Option expired — open Fuel again.');
      return;
    }

    const draft = userDrafts.get(telegramId) || {};
    if (!draft.fuelTypes) {
      draft.fuelTypes = [];
    }

    const idx = draft.fuelTypes.indexOf(fuelVal);
    if (idx > -1) {
      draft.fuelTypes.splice(idx, 1);
    } else {
      draft.fuelTypes.push(fuelVal);
    }
    resetFiltersAfter(draft, 'fuel');

    userDrafts.set(telegramId, draft);

    const { keyboard, infoSuffix } = await buildFuelKeyboard(
      draft,
      draft.fuelPage || 0
    );

    await safeEditMessageText(ctx,
      `⛽ Select **Fuel Types** (Multi-select):${infoSuffix}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^fuel_page_(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]!, 10);
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    draft.fuelPage = page;
    userDrafts.set(telegramId, draft);
    const { keyboard, infoSuffix } = await buildFuelKeyboard(draft, page);
    await safeEditMessageText(ctx,
      `⛽ Select **Fuel Types** (Multi-select):${infoSuffix}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
  });

  bot.action('clear_fuels', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    draft.fuelTypes = [];
    resetFiltersAfter(draft, 'fuel');
    userDrafts.set(telegramId, draft);

    const { keyboard, infoSuffix } = await buildFuelKeyboard(draft, 0);

    await safeEditMessageText(ctx,
      `⛽ Select **Fuel Types** (Multi-select):${infoSuffix}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery('Any fuel type');
  });

  bot.action('fuel_done', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    userDrafts.set(telegramId, draft);
    await renderFiltersMenu(ctx, telegramId, draft, true);
    await ctx.answerCbQuery();
  });

  // ── COUNTRY (MULTI-SELECT) ──
  bot.action('filter_country', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    snapshotDraft(telegramId);
    draft.countryPage = 0;

    // Drop country picks that no longer exist under filters above
    const scoped = await getAvailableCountries(
      draft.brand,
      draft.model,
      draft.versions,
      draftScope(draft, ['countries'])
    );
    const valid = new Set(scoped.map((c) => c.code));
    if (draft.countries?.length) {
      draft.countries = draft.countries.filter((c) => valid.has(c));
    }
    userDrafts.set(telegramId, draft);
    const selected = draft.countries ?? [];

    const { keyboard, infoSuffix } = await buildCountryKeyboard(
      draft,
      selected,
      0
    );

    await safeEditMessageText(ctx,
      `🌍 Select **Countries** (Multi-select):${infoSuffix}\n_Then tap **Done**._`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^country_page_(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]!, 10);
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    draft.countryPage = page;
    userDrafts.set(telegramId, draft);

    const { keyboard, infoSuffix } = await buildCountryKeyboard(
      draft,
      draft.countries ?? [],
      page
    );
    await safeEditMessageText(ctx,
      `🌍 Select **Countries** (Multi-select):${infoSuffix}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^toggle_country_(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const shortId = ctx.match[1]!;
    const code = countryCallbackMap.get(shortId);
    if (!code) {
      await ctx.answerCbQuery('Option expired — open Country again.');
      return;
    }

    const draft = userDrafts.get(telegramId) || {};
    if (!draft.countries) draft.countries = [];
    const idx = draft.countries.indexOf(code);
    if (idx > -1) draft.countries.splice(idx, 1);
    else draft.countries.push(code);
    userDrafts.set(telegramId, draft);

    const page = draft.countryPage || 0;
    const { keyboard, infoSuffix } = await buildCountryKeyboard(
      draft,
      draft.countries,
      page
    );
    await safeEditMessageText(ctx,
      `🌍 Select **Countries** (Multi-select):${infoSuffix}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
  });

  bot.action('clear_countries', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    draft.countries = [];
    userDrafts.set(telegramId, draft);
    const page = draft.countryPage || 0;
    const { keyboard, infoSuffix } = await buildCountryKeyboard(
      draft,
      [],
      page
    );
    await safeEditMessageText(ctx,
      `🌍 Select **Countries** (Multi-select):${infoSuffix}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery('Any country');
  });

  bot.action('country_done', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId) || {};
    userDrafts.set(telegramId, draft);
    await renderFiltersMenu(ctx, telegramId, draft, true);
    await ctx.answerCbQuery();
  });

  // ── NOOP ──
  bot.action('noop', async (ctx) => {
    await ctx.answerCbQuery();
  });

  // ── RESET ──
  bot.action('filter_reset', async (ctx) => {
    const telegramId = ctx.from!.id;
    draftSnapshots.delete(telegramId);
    const empty: FilterDraft = { versions: [], engines: [], fuelTypes: [], countries: [] };
    userDrafts.set(telegramId, empty);
    await renderFiltersMenu(ctx, telegramId, empty, true);
    await ctx.answerCbQuery('Filters reset', { show_alert: false });
  });

  // ── SAVE ──
  bot.action('filter_save', async (ctx) => {
    const telegramId = ctx.from!.id;
    const draft = userDrafts.get(telegramId);
    if (!draft) return ctx.answerCbQuery('No filters to save.');

    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      include: { alerts: true }
    });
    if (!user) return ctx.answerCbQuery('User not found.');

    const previous = user.alerts[0]
      ? {
          brandNorm: user.alerts[0].brandNorm,
          modelNorm: user.alerts[0].modelNorm,
          versions: user.alerts[0].versions,
          maxPrice: user.alerts[0].maxPrice,
          minYear: user.alerts[0].minYear,
          maxMileageKm: user.alerts[0].maxMileageKm,
          fuelTypes: user.alerts[0].fuelTypes,
          countries: user.alerts[0].countries ?? [],
          engines: (user.alerts[0] as any).engines ?? [],
          minPowerHp: (user.alerts[0] as any).minPowerHp ?? null
        }
      : null;

    const brandNorm = draft.brand ? normalizeBrand(draft.brand) : null;
    const modelNorm = draft.model ? normalizeModel(draft.model) : null;

    // Final prune: never save countries/fuels with zero stock under the other filters
    if (draft.countries?.length) {
      const scopedCountries = await getAvailableCountries(
        draft.brand,
        draft.model,
        draft.versions,
        draftScope(draft, ['countries'])
      );
      const valid = new Set(scopedCountries.map((c) => c.code));
      draft.countries = draft.countries.filter((c) => valid.has(c));
    }
    if (draft.fuelTypes?.length && draft.brand && draft.model) {
      const fuelLimits = await getInventoryContextLimits(
        draft.brand,
        draft.model,
        draft.versions,
        draftScope(draft, ['fuelTypes'])
      );
      const validFuels = new Set(fuelLimits?.fuels ?? []);
      if (validFuels.size > 0) {
        draft.fuelTypes = draft.fuelTypes.filter((f) => validFuels.has(f));
      }
    }

    const { normalizeEngineKey } = await import('../services/engineCatalog.service.js');
    const next = {
      brandNorm,
      modelNorm,
      versions: draft.versions || [],
      maxPrice: draft.maxPrice ?? null,
      minYear: draft.minYear ?? null,
      maxMileageKm: draft.maxMileageKm ?? null,
      fuelTypes: draft.fuelTypes ?? [],
      countries: draft.countries ?? [],
      engines: (draft.engines ?? [])
        .map((e) => normalizeEngineKey(e))
        .filter(Boolean),
      minPowerHp: draft.minPowerHp ?? null
    };

    await prisma.userAlert.deleteMany({ where: { userId: user.id } });
    await prisma.userAlert.create({
      data: {
        userId: user.id,
        brand: draft.brand ?? null,
        model: draft.model ?? null,
        brandNorm: brandNorm || null,
        modelNorm: modelNorm || null,
        versions: next.versions,
        maxPrice: next.maxPrice,
        minYear: next.minYear,
        maxMileageKm: next.maxMileageKm,
        fuelTypes: next.fuelTypes,
        countries: next.countries,
        engines: next.engines,
        minPowerHp: next.minPowerHp
      }
    });

    const { MatchingService } = await import('../services/matching.service.js');
    const { changed } = await MatchingService.replaceFiltersAndResyncQueue({
      userId: user.id,
      telegramId,
      previous,
      next
    });

    await safeEditMessageText(ctx,
      '✅ **Radar updated**\n\nYour 24/7 VIP radar is active.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Back to panel', 'vip_filters')]
        ])
      }
    );

    userDrafts.delete(telegramId);
    await ctx.answerCbQuery(changed ? 'Filters updated — queue refreshed' : 'Filters saved');
  });
}

