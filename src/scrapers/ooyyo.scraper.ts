import * as cheerio from "cheerio";
import { createHttpClient } from "../utils/httpClient.js";
import { randomDelay } from "../utils/delay.js";
import { prisma } from "../db/prisma.js";
import { getState, setState } from "../utils/state.manager.js";
import {
  validateAndEnrich,
  type RawVehicleData,
} from "../services/dataQualityPipeline.js";
import { parsePowerCv } from "../utils/power.js";
import { isOoyyoAggregatorUrl, normalizeExternalSellerUrl } from "../utils/listingUrl.js";
import { resolveOoyyoUrlForSave } from "../services/urlVerify.service.js";

const BASE_URL = "https://www.ooyyo.com";
const SCRAPER_ID = "ooyyo";

/** Official OOYYO EU/EEA market start URLs (no USA). Rotate when a country is exhausted. */
const COUNTRY_URLS: string[] = [
  "https://www.ooyyo.com/austria/used-cars-for-sale/c=CDA31D7114D3854F111B936FAA651453/",
  "https://www.ooyyo.com/belgium/used-cars-for-sale/c=CDA31D7114D3854F111BE36FAA651453/",
  "https://www.ooyyo.com/czech+republic/used-cars-for-sale/c=CDA31D7114D3854F111B976FAA651453/",
  "https://www.ooyyo.com/denmark/used-cars-for-sale/c=CDA31D7114D3854F111B9E6FAA651453/",
  "https://www.ooyyo.com/france/used-cars-for-sale/c=CDA31D7114D3854F111BFB6FAA651453/",
  "https://www.ooyyo.com/germany/used-cars-for-sale/c=CDA31D7114D3854F111BFE6FAA651453/",
  "https://www.ooyyo.com/italy/used-cars-for-sale/c=CDA31D7114D3854F111BF36FAA651453/",
  "https://www.ooyyo.com/netherlands/used-cars-for-sale/c=CDA31D7114D3854F111BFA6FAA651453/",
  "https://www.ooyyo.com/norway/used-cars-for-sale/c=CDA31D7114D3854F111B926FAA651453/",
  "https://www.ooyyo.com/poland/used-cars-for-sale/c=CDA31D7114D3854F111B956FAA651453/",
  "https://www.ooyyo.com/romania/used-cars-for-sale/c=CDA31D7114D3854F111B746FAA651453/",
  "https://www.ooyyo.com/spain/used-cars-for-sale/c=CDA31D7114D3854F111BE56FAA651453/",
  "https://www.ooyyo.com/sweden/used-cars-for-sale/c=CDA31D7114D3854F111BF26FAA651453/",
  "https://www.ooyyo.com/switzerland/used-cars-for-sale/c=CDA31D7114D3854F111BE86FAA651453/",
];

const PAGES_PER_RUN = Math.max(
  1,
  parseInt(process.env.OY_PAGES_PER_RUN || process.env.SCRAPER_PAGES || '10', 10) || 10,
);
/**
 * Only jump country after this many consecutive 0-new pages **and** no usable Next link.
 * While Next exists we keep paging the same market (Germany 1→2→3… then Italy).
 */
const EMPTY_PAGES_BEFORE_NEXT_COUNTRY = 8;

/** Open OOYYO detail for every NEW listing (seller link + basic-info). */
const FETCH_DETAILS =
  (process.env.OY_FETCH_DETAILS || "true").toLowerCase() !== "false";

/** Calm pace between detail pages (ms) — reduces 410/bot blocks. */
const DETAIL_DELAY_MIN = Math.max(
  1500,
  parseInt(process.env.OY_DETAIL_DELAY_MIN_MS || "2800", 10),
);
const DETAIL_DELAY_MAX = Math.max(
  DETAIL_DELAY_MIN,
  parseInt(process.env.OY_DETAIL_DELAY_MAX_MS || "4800", 10),
);
interface OoyyoState {
  countryIndex: number;
  pageUrl: string;
}

export async function scrapeOoyyo(searchUrl?: string) {
  console.log(
    `🤖 Starting OOYYO scraper (${COUNTRY_URLS.length} EU markets, ${PAGES_PER_RUN} pages/run)` +
      (FETCH_DETAILS
        ? ` | details ON ~${DETAIL_DELAY_MIN}-${DETAIL_DELAY_MAX}ms | direct HTTP only (no Bright Data)`
        : " | details OFF (list-only) | direct HTTP only (no Bright Data)"),
  );

  const markets = searchUrl ? [searchUrl] : COUNTRY_URLS;

  try {
    let { countryIndex, pageUrl } = await loadOoyyoState(markets);
    let pagesScrapedThisRun = 0;
    let totalSaved = 0;
    let emptyStreak = 0;
    let countriesAdvancedThisRun = 0;
    const seenUrlsThisCountry = new Set<string>();

    console.log(
      `🧠 Resuming OOYYO: market #${countryIndex + 1}/${markets.length} → ${pageUrl}`,
    );

    while (pagesScrapedThisRun < PAGES_PER_RUN) {
      if (countryIndex >= markets.length) {
        console.log(
          "🏁 All OOYYO markets covered. Wrapping back to first country.",
        );
        countryIndex = 0;
        pageUrl = markets[0]!;
        await persistState(countryIndex, pageUrl);
        seenUrlsThisCountry.clear();
      }

      const marketLabel = countrySlugFromUrl(pageUrl) || `idx-${countryIndex}`;
      pagesScrapedThisRun++;
      console.log(
        `📄 Scraping OOYYO [${marketLabel}] [Page ${pagesScrapedThisRun}/${PAGES_PER_RUN}]: ${pageUrl}`,
      );

      if (seenUrlsThisCountry.has(pageUrl)) {
        console.log(
          `🏁 OOYYO pagination loop on ${marketLabel} → next country.`,
        );
        ({ countryIndex, pageUrl } = await advanceCountry(
          markets,
          countryIndex,
        ));
        countriesAdvancedThisRun++;
        emptyStreak = 0;
        seenUrlsThisCountry.clear();
        if (countriesAdvancedThisRun >= markets.length) break;
        continue;
      }
      seenUrlsThisCountry.add(pageUrl);

      const listHtml = await fetchOoyyoDirect(pageUrl);
      if (!listHtml) {
        console.warn(
          "⚠️ Could not retrieve HTML from the listing. Skipping to next market.",
        );
        ({ countryIndex, pageUrl } = await advanceCountry(
          markets,
          countryIndex,
        ));
        countriesAdvancedThisRun++;
        emptyStreak = 0;
        if (countriesAdvancedThisRun >= markets.length) break;
        continue;
      }

      const $ = cheerio.load(listHtml);
      const cardElements = $("a.car-card-1, a.car-card-3").toArray();

      console.log(
        `🔗 Found ${cardElements.length} vehicle listings on this page.`,
      );
      let newOnThisPage = 0;

      for (const element of cardElements) {
        const $card = $(element);
        const parsed = parseOoyyoListCard($, $card);
        if (!parsed) continue;

        const existing = await prisma.carListing.findUnique({
          where: { portalId: parsed.portalId },
          select: { id: true, fuelType: true, originalUrl: true },
        });

        const fuelMissing =
          !existing?.fuelType ||
          existing.fuelType === "Unknown" ||
          existing.fuelType === "unknown";

        // Already in DB with fuel → skip (list card is enough elsewhere via price jobs).
        if (existing && !fuelMissing) continue;

        // Already in DB but fuel pending → enrich from list-card spans (no detail HTTP).
        // Preserves seller originalUrl when we already swapped away from ooyyo.com.
        if (existing && fuelMissing) {
          if (parsed.fuelType) {
            await prisma.carListing.update({
              where: { id: existing.id },
              data: {
                fuelType: parsed.fuelType,
                transmission: parsed.transmission ?? undefined,
                price: parsed.price > 0 ? parsed.price : undefined,
                mileageKm: parsed.mileageKm > 0 ? parsed.mileageKm : undefined,
              },
            });
            console.log(
              `⛽ ENRICH fuel: ${parsed.brand} ${parsed.model} → ${parsed.fuelType} (${parsed.portalId})`,
            );
          }
          continue;
        }

        // List card baseline; open detail for every NEW ad (calm) → seller URL + precise specs
        let merged = { ...parsed, powerHp: null as number | null };
        let sellerUrl: string | null = null;
        const previewUrl = parsed.originalUrl;

        if (FETCH_DETAILS) {
          try {
            console.log(`🔎 OOYYO detail: ${parsed.originalUrl}`);
            const detailHtml = await fetchOoyyoDirect(parsed.originalUrl);
            const detail = detailHtml
              ? parseOoyyoDetailPage(detailHtml)
              : null;
            if (detail) {
              sellerUrl = detail.sellerUrl;
              merged = applyOoyyoDetail(merged, detail);
              if (detail.sellerUrl) {
                console.log(`🔗 Seller URL: ${detail.sellerUrl}`);
              } else {
                console.warn(
                  `⚠️ No Contact seller link — will try OOYYO preview for ${parsed.portalId}`,
                );
              }
            }
          } catch (err: any) {
            console.warn(
              `⚠️ OOYYO detail failed (${parsed.portalId}): ${err?.message || err} — keeping list-card data`,
            );
          }
          await randomDelay(DETAIL_DELAY_MIN, DETAIL_DELAY_MAX);
        }

        // Contact seller ONLY if probe OK; else verified OOYYO preview
        const live = await resolveOoyyoUrlForSave({ previewUrl, sellerUrl });
        if (!live) {
          console.warn(
            `⏭️ Skip ${merged.portalId}: Contact seller + OOYYO preview both dead/unreachable`,
          );
          continue;
        }
        merged.originalUrl = live.url;
        if (isOoyyoAggregatorUrl(live.url)) {
          console.log(
            `📎 ${merged.portalId}: saved OOYYO preview (seller missing or failed probe)`,
          );
        } else {
          console.log(
            `🔗 ${merged.portalId}: saved verified Contact seller link`,
          );
        }

        const rawData: RawVehicleData = {
          portalId: merged.portalId,
          sourcePortal: "ooyyo",
          brand: merged.brand,
          model: merged.model,
          version: merged.version,
          year: merged.year,
          mileageKm: merged.mileageKm,
          price: merged.price,
          powerHp: merged.powerHp && merged.powerHp > 0 ? merged.powerHp : 0,
          fuelType: merged.fuelType,
          transmission: merged.transmission,
          sellerType: "Professional",
          countryOfOrigin: merged.countryOfOrigin,
          originalUrl: merged.originalUrl,
        };

        if (
          !rawData.price ||
          rawData.price <= 0 ||
          !rawData.mileageKm ||
          rawData.mileageKm <= 0 ||
          rawData.year <= 0
        ) {
          continue;
        }

        const validated = await validateAndEnrich(rawData);
        if (!validated) {
          await randomDelay(700, 1400);
          continue;
        }

        try {
          const { saveListingIfNew } = await import(
            "../services/listingDedup.service.js"
          );
          const result = await saveListingIfNew({
            ...validated,
            urlVerifiedAt: live.verifiedAt,
          });
          if (result === "created") {
            totalSaved++;
            newOnThisPage++;
            console.log(
              `✨ NEW LISTING: ${validated.brand} ${validated.model} (${validated.year}) | ${validated.mileageKm} km | €${validated.price} | fuel=${validated.fuelType ?? 'pending'} | ${validated.originalUrl}`,
            );
          }
        } catch (err: any) {
          console.error(
            `❌ Error saving listing ${merged.portalId}:`,
            err.message,
          );
        }

        await randomDelay(400, 900);
      }

      console.log(`✅ Page processed: ${newOnThisPage} new listings saved.`);

      if (newOnThisPage === 0) {
        emptyStreak++;
      } else {
        emptyStreak = 0;
      }

      const nextUrl = resolveNextPageUrl($, pageUrl);
      // Stay on this country while Next works. Switch only when pagination ends / loops / no cards.
      // (emptyStreak alone does NOT switch — otherwise we never leave page 1 of each market.)
      const noNext =
        !nextUrl ||
        nextUrl === pageUrl ||
        seenUrlsThisCountry.has(nextUrl) ||
        cardElements.length === 0;

      if (noNext) {
        const reason = !nextUrl || nextUrl === pageUrl
          ? "no next page"
          : seenUrlsThisCountry.has(nextUrl || "")
            ? "pagination loop"
            : "no cards";
        console.log(
          `🏁 OOYYO market done (${marketLabel}): ${reason} → next country.`,
        );
        ({ countryIndex, pageUrl } = await advanceCountry(
          markets,
          countryIndex,
        ));
        countriesAdvancedThisRun++;
        emptyStreak = 0;
        seenUrlsThisCountry.clear();
        if (countriesAdvancedThisRun >= markets.length) {
          console.log(
            "🔁 Full OOYYO country rotation completed this run; stopping batch.",
          );
          break;
        }
        if (pagesScrapedThisRun < PAGES_PER_RUN) {
          await randomDelay(1500, 2500);
        }
        continue;
      }

      // Optional: if many empty pages mid-market but Next still works, keep paging
      // so we actually walk deep into AT/DE/… instead of hopping countries.
      if (emptyStreak >= EMPTY_PAGES_BEFORE_NEXT_COUNTRY) {
        console.log(
          `ℹ️ OOYYO ${marketLabel}: ${emptyStreak} empty pages but Next exists — continuing deeper in this market.`,
        );
      }

      pageUrl = nextUrl!;
      await persistState(countryIndex, pageUrl);
      console.log(`➡️ OOYYO next page within ${marketLabel}: ${pageUrl}`);

      if (pagesScrapedThisRun < PAGES_PER_RUN) {
        await randomDelay(2000, 3500);
      }
    }

    console.log(
      `✅ OOYYO batch finished: ${totalSaved} new. Next cycle resumes at market #${countryIndex + 1}: ${pageUrl}`,
    );
  } catch (error: any) {
    console.error(
      "❌ An unexpected error occurred in scrapeOoyyo:",
      error.message,
    );
  }
}

async function loadOoyyoState(markets: string[]): Promise<OoyyoState> {
  const raw = await getState<OoyyoState | string>(SCRAPER_ID);

  // Legacy: state was a plain Germany page URL string
  if (typeof raw === "string" && raw.length > 0) {
    const idx = findCountryIndex(markets, raw);
    return { countryIndex: idx >= 0 ? idx : 0, pageUrl: raw };
  }

  if (raw && typeof raw === "object" && raw.pageUrl) {
    const idx =
      typeof raw.countryIndex === "number" &&
      raw.countryIndex >= 0 &&
      raw.countryIndex < markets.length
        ? raw.countryIndex
        : Math.max(0, findCountryIndex(markets, raw.pageUrl));
    return {
      countryIndex: idx >= 0 ? idx : 0,
      pageUrl: raw.pageUrl || markets[idx >= 0 ? idx : 0]!,
    };
  }

  return { countryIndex: 0, pageUrl: markets[0]! };
}

function findCountryIndex(markets: string[], url: string): number {
  const slug = countrySlugFromUrl(url);
  if (!slug) return -1;
  return markets.findIndex((m) => countrySlugFromUrl(m) === slug);
}

function countrySlugFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname; // /germany/used-cars-...
    const seg = path.split("/").filter(Boolean)[0];
    return seg ? decodeURIComponent(seg).toLowerCase() : null;
  } catch {
    return null;
  }
}

async function advanceCountry(
  markets: string[],
  currentIndex: number,
): Promise<OoyyoState> {
  const nextIndex = (currentIndex + 1) % markets.length;
  const pageUrl = markets[nextIndex]!;
  await persistState(nextIndex, pageUrl);
  console.log(
    `🌍 Switching OOYYO market → #${nextIndex + 1}/${markets.length}: ${countrySlugFromUrl(pageUrl)}`,
  );
  return { countryIndex: nextIndex, pageUrl };
}

async function persistState(countryIndex: number, pageUrl: string) {
  await setState<OoyyoState>(SCRAPER_ID, { countryIndex, pageUrl });
}

/**
 * OOYYO: direct VPS HTTP only — never Bright Data / proxy.
 */
async function fetchOoyyoDirect(url: string): Promise<string | null> {
  try {
    const client = createHttpClient(undefined, { useProxy: false });
    const res = await client.get(url);
    if (res.status >= 200 && res.status < 300 && res.data) {
      return typeof res.data === "string" ? res.data : String(res.data);
    }
    return null;
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = status ? `HTTP ${status}` : err?.message || String(err);
    throw new Error(msg);
  }
}

function looksLikeOoyyoDeadPage(html: string): boolean {
  return (
    /something went wrong/i.test(html) ||
    /please try again later/i.test(html)
  );
}

/**
 * Re-open an OOYYO detail URL and return the external seller link, or null.
 * Used by repair scripts for rows that still store aggregator URLs.
 */
export async function resolveOoyyoSellerUrl(
  ooyyoDetailUrl: string,
): Promise<string | null> {
  if (!isOoyyoAggregatorUrl(ooyyoDetailUrl)) return null;
  let html: string | null;
  try {
    html = await fetchOoyyoDirect(ooyyoDetailUrl);
  } catch {
    return null;
  }
  if (!html || looksLikeOoyyoDeadPage(html)) return null;
  const detail = parseOoyyoDetailPage(html);
  return detail?.sellerUrl ?? null;
}

type OoyyoCardParsed = {
  portalId: string;
  originalUrl: string;
  brand: string;
  model: string;
  version: string;
  year: number;
  mileageKm: number;
  price: number;
  fuelType: string | null;
  transmission: string | null;
  countryOfOrigin: string;
};

/**
 * Parse one OOYYO result-list card (car-card-1 / car-card-3).
 * Fuel comes ONLY from `.description` spans (body, fuel, color) — never from full-card text.
 */
function parseOoyyoListCard(
  $: cheerio.CheerioAPI,
  $card: cheerio.Cheerio<any>,
): OoyyoCardParsed | null {
  const originalUrl = absoluteOoyyoUrl($card.attr("href") || "");
  if (!originalUrl) return null;

  const recordId =
    $card.find("[data-record]").first().attr("data-record") ||
    originalUrl.match(/\/(\d+)\.html/i)?.[1] ||
    null;
  if (!recordId || !/^-?\d+$/.test(recordId)) return null;
  const portalId = `oy-${recordId}`;

  const headingSpans = $card
    .find(".mob-heading span")
    .toArray()
    .map((el) => cleanText($(el).text()))
    .filter(Boolean);
  const h2Spans = $card
    .find("h2 span")
    .toArray()
    .map((el) => cleanText($(el).text()))
    .filter(Boolean);
  const spans = headingSpans.length >= 3 ? headingSpans : h2Spans;

  const year = parseInt(spans[0] || "", 10) || 0;
  const brand = normalizeName(spans[1] || "");
  const model = normalizeName(spans[2] || "");
  let version = normalizeName(spans[3] || "");
  if (!version || version === "Unknown") {
    // h2 often has version as a text node after the spans: "2.2 D"
    const h2 = cleanText($card.find("h2").first().text());
    const prefix = [spans[0], spans[1], spans[2]].filter(Boolean).join(" ");
    version = normalizeName(
      prefix && h2.toLowerCase().startsWith(prefix.toLowerCase())
        ? h2.slice(prefix.length)
        : "",
    );
  }
  if (!version || version === "Unknown") version = "Base";

  const priceAttr = parseInt($card.attr("data-price") || "0", 10);
  const priceText =
    cleanText($card.find("._js-hook-main-price").first().text()) ||
    cleanText($card.find(".price.lg strong, .price-info .price").first().text());
  const price = priceAttr > 0 ? priceAttr : parseMoney(priceText);

  const mileageKm = parseMileage(
    cleanText($card.find(".mileage strong").first().text()) ||
      cleanText($card.find(".mileage").first().text()),
  );

  const fuelType = fuelFromDescriptionSpans($, $card);
  const transmission = transmissionFromDescription($, $card);

  const locationText = cleanText(
    $card.find(".mob-location, .location .loc, .location").text(),
  );
  const countryOfOrigin = detectCountryFromText(originalUrl, locationText);

  if (!brand || brand === "Unknown" || !model || model === "Unknown") {
    return null;
  }

  return {
    portalId,
    originalUrl,
    brand,
    model,
    version,
    year,
    mileageKm,
    price,
    fuelType,
    transmission,
    countryOfOrigin,
  };
}

type OoyyoDetailParsed = {
  sellerUrl: string | null;
  brand: string | null;
  model: string | null;
  version: string | null;
  year: number | null;
  mileageKm: number | null;
  price: number | null;
  fuelType: string | null;
  transmission: string | null;
  powerHp: number | null;
  cityCountry: string | null;
};

/**
 * Detail page: `ul.basic-info` + yellow **Contact seller** → official seller URL.
 * Falls back to null so the caller keeps the OOYYO list/preview href.
 */
function parseOoyyoDetailPage(html: string): OoyyoDetailParsed | null {
  if (!html || html.length < 200) return null;
  const $ = cheerio.load(html);

  const sellerHref =
    cleanText($("#contactSeller").attr("href") || "") ||
    cleanText($("a.btn-contact[href]").first().attr("href") || "") ||
    cleanText(
      $('a.btn-warning[href]')
        .filter((_, el) => /contact\s*seller/i.test($(el).text()))
        .first()
        .attr("href") || "",
    ) ||
    cleanText(
      $("a[href]")
        .filter((_, el) => /^contact\s*seller$/i.test(cleanText($(el).text())))
        .first()
        .attr("href") || "",
    );
  const sellerUrl = normalizeExternalSellerUrl(sellerHref, BASE_URL);

  const info = readBasicInfoMap($);
  if (!Object.keys(info).length && !sellerUrl) return null;

  const fuelRaw = info["fuel type"] || info["fuel"] || "";
  const fuelType = fuelRaw ? mapOoyyoFuelLabel(fuelRaw) : null;

  const transRaw = info["transmission"] || info["gearbox"] || "";
  let transmission: string | null = null;
  if (transRaw) {
    const t = transRaw.toLowerCase();
    if (/auto|dsg|tiptronic|cvt|pdk/.test(t)) transmission = "Automatic";
    else if (/manual|manuell|manuel/.test(t)) transmission = "Manual";
  }

  const powerHp = parsePowerHp(info["power"] || "");
  const year = parseInt(info["year"] || "", 10) || null;
  const mileageRaw = info["mi"] || info["mileage"] || "";
  const mileageKm = mileageRaw ? parseMileage(mileageRaw) : null;
  const price = info["price"] ? parseMoney(info["price"]) : null;

  const brand = info["make"] ? normalizeName(info["make"]) : null;
  const model = info["model"] ? normalizeName(info["model"]) : null;
  const version = info["trim"] ? normalizeName(info["trim"]) : null;
  const city = info["city"] || "";
  const country =
    cleanText($(".location").first().text()) ||
    cleanText($(".d-block.d-md-none").text());

  return {
    sellerUrl,
    brand: brand && brand !== "Unknown" ? brand : null,
    model: model && model !== "Unknown" ? model : null,
    version: version && version !== "Unknown" ? version : null,
    year: year && year > 1980 ? year : null,
    mileageKm: mileageKm && mileageKm > 0 ? mileageKm : null,
    price: price && price > 0 ? price : null,
    fuelType,
    transmission,
    powerHp,
    cityCountry: [city, country].filter(Boolean).join(" ") || null,
  };
}

function readBasicInfoMap($: cheerio.CheerioAPI): Record<string, string> {
  const map: Record<string, string> = {};
  $("ul.basic-info > li").each((_, li) => {
    const kids = $(li).children("div");
    const key = cleanText(kids.eq(0).text()).toLowerCase();
    const val = cleanText(kids.eq(1).text());
    if (key && val) map[key] = val;
  });
  return map;
}

function parsePowerHp(raw: string): number | null {
  return parsePowerCv(raw, { allowBare: true });
}

function applyOoyyoDetail(
  base: OoyyoCardParsed & { powerHp: number | null },
  detail: OoyyoDetailParsed,
): OoyyoCardParsed & { powerHp: number | null } {
  // Never bake Contact seller into originalUrl here — resolveOoyyoUrlForSave
  // probes seller first and only then falls back to the OOYYO preview.
  const countryOfOrigin = detail.cityCountry
    ? detectCountryFromText(base.originalUrl, detail.cityCountry)
    : base.countryOfOrigin;

  return {
    ...base,
    brand: detail.brand || base.brand,
    model: detail.model || base.model,
    version: detail.version || base.version,
    year: detail.year || base.year,
    mileageKm: detail.mileageKm || base.mileageKm,
    price: detail.price || base.price,
    fuelType: detail.fuelType ?? base.fuelType,
    transmission: detail.transmission ?? base.transmission,
    powerHp: detail.powerHp ?? base.powerHp,
    countryOfOrigin,
  };
}

/** Absolute listing URL; keeps OOYYO path (+ trailing slash when present). */
function absoluteOoyyoUrl(href: string): string {
  if (!href?.trim()) return "";
  try {
    const u = new URL(href.trim(), BASE_URL);
    if (!/(^|\.)ooyyo\.com$/i.test(u.hostname)) return "";
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return "";
  }
}

/**
 * OOYYO card layout:
 *   <div class="description">
 *     <span>Crossover,&nbsp;</span>
 *     <span>Diesel,&nbsp;</span>
 *     <span>Blue</span>
 *     , abs, airbag, …
 *   </div>
 * Fuel is almost always the 2nd span — map only that token (or any span that is a fuel label).
 */
function fuelFromDescriptionSpans(
  $: cheerio.CheerioAPI,
  $card: cheerio.Cheerio<any>,
): string | null {
  const labels = $card
    .find(".description > span")
    .toArray()
    .map((el) =>
      cleanText($(el).text())
        .replace(/,/g, "")
        .trim(),
    )
    .filter(Boolean);

  // Prefer 2nd span (body, fuel, color)
  const ordered =
    labels.length >= 2
      ? [labels[1]!, ...labels.filter((_, i) => i !== 1)]
      : labels;

  for (const label of ordered) {
    const mapped = mapOoyyoFuelLabel(label);
    if (mapped) return mapped;
  }
  return null;
}

function mapOoyyoFuelLabel(raw: string): string | null {
  const t = raw.toLowerCase().trim();
  if (!t) return null;

  if (
    /^(diesel|di[eé]sel|gas[oó]leo|gasoleo|gasoil)$/i.test(t)
  ) {
    return "Diesel";
  }
  if (
    /^(petrol|gasoline|gasolina|benzin|benzine|essence|nafta)$/i.test(t)
  ) {
    return "Petrol";
  }
  if (
    /^(hybrid|h[ií]brid|h[ií]brido|phev|plug-?in)$/i.test(t) ||
    t.includes("hybrid")
  ) {
    return "Hybrid";
  }
  if (
    /^(electric|el[eé]ctric[oa]?|elektro|elektrisch|ev|bev)$/i.test(t)
  ) {
    return "Electric";
  }
  if (/^(lpg|gpl|autogas|cng|gnc)$/i.test(t)) {
    return "LPG";
  }
  return null;
}

/** Transmission is rarely on the card; only accept explicit tokens in `.description`. */
function transmissionFromDescription(
  $: cheerio.CheerioAPI,
  $card: cheerio.Cheerio<any>,
): string | null {
  const text = cleanText($card.find(".description").text()).toLowerCase();
  if (!text) return null;
  if (/\b(automatic|automatik|automatique|autom[aá]tic[oa]?)\b/i.test(text)) {
    return "Automatic";
  }
  if (/\b(manual|manuell|manuel)\b/i.test(text)) {
    return "Manual";
  }
  // DSG / tiptronic often imply automatic when listed as equipment/version cue in description
  if (/\b(dsg|tiptronic|cvt|pdk)\b/i.test(text)) {
    return "Automatic";
  }
  return null;
}

function cleanText(value: string): string {
  return (value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoney(value: string): number {
  if (!value) return 0;
  const match = value.replace(/\s/g, "").match(/([\d.,]+)/);
  return match && match[1]
    ? parseInt(match[1].replace(/[.,]/g, ""), 10) || 0
    : 0;
}

function parseMileage(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[^\d,.]/g, "").replace(",", ".");
  return parseInt(cleaned.replace(/[.,]/g, ""), 10) || 0;
}

function normalizeName(value: string): string {
  const t = cleanText(value);
  return t || "Unknown";
}

function detectCountryFromText(originalUrl: string, text: string): string {
  const normalized = `${originalUrl} ${text}`.toLowerCase();
  if (normalized.includes("germany") || normalized.includes("deutschland"))
    return "DE";
  if (normalized.includes("spain") || normalized.includes("españa"))
    return "ES";
  if (normalized.includes("france") || normalized.includes("francia"))
    return "FR";
  if (normalized.includes("italy") || normalized.includes("italia"))
    return "IT";
  if (normalized.includes("austria") || normalized.includes("österreich"))
    return "AT";
  if (normalized.includes("belgium") || normalized.includes("belgi"))
    return "BE";
  if (
    normalized.includes("czech") ||
    normalized.includes("czechia") ||
    normalized.includes("česk")
  )
    return "CZ";
  if (normalized.includes("denmark") || normalized.includes("danmark"))
    return "DK";
  if (
    normalized.includes("netherlands") ||
    normalized.includes("holland") ||
    normalized.includes("nederland")
  )
    return "NL";
  if (normalized.includes("norway") || normalized.includes("norge"))
    return "NO";
  if (normalized.includes("poland") || normalized.includes("polska"))
    return "PL";
  if (normalized.includes("romania") || normalized.includes("românia"))
    return "RO";
  if (normalized.includes("sweden") || normalized.includes("sverige"))
    return "SE";
  if (normalized.includes("switzerland") || normalized.includes("schweiz"))
    return "CH";
  return "EU";
}

function resolveNextPageUrl(
  $: cheerio.CheerioAPI,
  currentUrl: string,
): string | null {
  // OOYYO uses big buttons: "Next" (btn-warning) / "More Results" (btn-success)
  // — not classic .pagination. The c=… token in the path advances the page.
  const country = countrySlugFromUrl(currentUrl);
  const candidates: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const text = $(el).text().replace(/\s+/g, " ").trim().toLowerCase();
    const isNext =
      text === "next" ||
      text === "more results" ||
      text.includes("more results");
    if (!isNext) return;
    candidates.push(href);
  });

  for (const href of candidates) {
    const absolute = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    try {
      const cur = new URL(currentUrl);
      const next = new URL(absolute);
      const nextCountry = countrySlugFromUrl(absolute);
      if (country && nextCountry && country !== nextCountry) continue;
      // Stay on the all-cars listing, not brand/body filter side-links
      if (!next.pathname.includes("/used-cars-for-sale/")) continue;
      if (next.pathname.split("/").filter(Boolean).length > 3) continue;
      if (absolute === currentUrl) continue;
      // Ignore "View More" brand expanders that keep the same listing token family differently
      if (absolute.replace(/\/$/, "") === currentUrl.replace(/\/$/, "")) continue;
      return absolute;
    } catch {
      continue;
    }
  }

  return null;
}
