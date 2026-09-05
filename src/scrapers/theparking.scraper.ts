import * as cheerio from "cheerio";
import { randomDelay } from "../utils/delay.js";
import { prisma } from "../db/prisma.js";
import { getBrowserPage } from "../utils/browser.js";
import { fetchWithFallback } from "../utils/httpClient.js";
import { incr } from "../utils/metrics.js";
import {
  normalizeFuelType,
  normalizeTransmission,
} from "../utils/normalizer.js";
import {
  validateAndEnrich,
  type RawVehicleData,
} from "../services/dataQualityPipeline.js";
import { getState, setState } from "../utils/state.manager.js";
import { parsePowerCv } from "../utils/power.js";

const DEFAULT_CATEGORY_URLS = [
  "https://www.theparking.eu/used-cars/Supercar.html",
  "https://www.theparking.eu/used-cars/SUV.html",
  "https://www.theparking.eu/used-cars/collection.html",
  "https://www.theparking.eu/used-cars/4-door-coupe.html",
];

const EUROPEAN_COUNTRIES = new Set([
  "ES",
  "DE",
  "FR",
  "IT",
  "NL",
  "BE",
  "GB",
  "SE",
  "AT",
  "PT",
  "CH",
  "PL",
  "DK",
  "NO",
  "FI",
  "IE",
  "CZ",
  "HU",
  "RO",
  "GR",
  "HR",
  "SK",
  "SI",
  "LU",
  "LI",
  "MC",
  "AD",
  "SM",
  "IS",
  "CY",
  "MT",
  "EE",
  "LV",
  "LT",
  "BG",
  "RS",
  "BA",
  "ME",
  "MK",
  "AL",
  "EU",
]);

// Country map to ISO code
const COUNTRY_TEXT_MAP: Record<string, string> = {
  spain: "ES",
  espagne: "ES",
  germany: "DE",
  allemagne: "DE",
  deutschland: "DE",
  france: "FR",
  italy: "IT",
  italie: "IT",
  netherlands: "NL",
  "pays-bas": "NL",
  belgium: "BE",
  belgique: "BE",
  "united kingdom": "GB",
  "royaume-uni": "GB",
  sweden: "SE",
  suède: "SE",
  austria: "AT",
  autriche: "AT",
  portugal: "PT",
  switzerland: "CH",
  suisse: "CH",
  poland: "PL",
  pologne: "PL",
  denmark: "DK",
  danemark: "DK",
  norway: "NO",
  norvège: "NO",
  finland: "FI",
  finlande: "FI",
  ireland: "IE",
  irlande: "IE",
  "czech republic": "CZ",
  tchéquie: "CZ",
  czechia: "CZ",
  hungary: "HU",
  hongrie: "HU",
  romania: "RO",
  roumanie: "RO",
  greece: "GR",
  grèce: "GR",
  croatia: "HR",
  croatie: "HR",
  slovakia: "SK",
  slovaquie: "SK",
  slovenia: "SI",
  slovénie: "SI",
  luxembourg: "LU",
  serbia: "RS",
  serbie: "RS",
  bosnia: "BA",
  bosnie: "BA",
  montenegro: "ME",
  monténégro: "ME",
  bulgaria: "BG",
  bulgarie: "BG",
  estonia: "EE",
  estonie: "EE",
  latvia: "LV",
  lettonie: "LV",
  lithuania: "LT",
  lituanie: "LT",
  cyprus: "CY",
  chypre: "CY",
  malta: "MT",
  malte: "MT",
  iceland: "IS",
  islande: "IS",
};

// ── MEMORY AND BATCH CONFIGURATION (Bright Data budget) ──
// State resumes pageNum across runs: 1→5, next cron 6→10, etc. Does NOT restart at 1 each time.
const SCRAPER_ID = "theparking";
const PAGES_PER_RUN = Math.max(
  1,
  parseInt(process.env.TP_PAGES_PER_RUN || "5", 10),
);
/** Cap new detail fetches per list page (biggest BD cost after list navigations). */
const MAX_DETAILS_PER_PAGE = Math.max(
  1,
  parseInt(process.env.TP_MAX_DETAILS_PER_PAGE || "8", 10),
);

interface TheParkingState {
  categoryIndex: number;
  pageNum: number;
}

export async function scrapeTheParking(searchUrl?: string) {
  console.log(
    `🤖 Starting TheParking scraper (${PAGES_PER_RUN} pages/run, max ${MAX_DETAILS_PER_PAGE} details/page)...`,
  );
  const urlsToScrape = searchUrl ? [searchUrl] : DEFAULT_CATEGORY_URLS;

  let browserInstance;

  try {
    const browserCtx = await getBrowserPage();
    browserInstance = browserCtx.browser;
    const page = browserCtx.page;

    let pagesScrapedThisRun = 0;
    let totalSavedThisRun = 0;

    const savedState = await getState<TheParkingState>(SCRAPER_ID);
    let currentCategoryIndex = savedState?.categoryIndex ?? 0;
    let currentPageNum = savedState?.pageNum ?? 1;
    let noNewCarsCounter = 0;

    console.log(
      `🧠 Resuming from state: Category #${currentCategoryIndex + 1}, Page #${currentPageNum}`,
    );

    while (pagesScrapedThisRun < PAGES_PER_RUN) {
      if (currentCategoryIndex >= urlsToScrape.length) {
        console.log(
          "🏁 All TheParking categories have been processed. Resetting to initial state.",
        );
        await setState<TheParkingState>(SCRAPER_ID, {
          categoryIndex: 0,
          pageNum: 1,
        });
        break;
      }

      const catUrl = urlsToScrape[currentCategoryIndex];
      if (!catUrl) break;

      const separator = catUrl.includes("?") ? "&" : "?";
      const currentUrl = `${catUrl}${separator}tri=date&page=${currentPageNum}`;

      pagesScrapedThisRun++;
      console.log(
        `📄 Scraping TheParking [Category ${currentCategoryIndex + 1}/${urlsToScrape.length} - Page ${currentPageNum}]: ${currentUrl}`,
      );

      try {
        // HTTP-first listing fetch via the site's AJAX endpoint to save browser/proxy credits
        let $: cheerio.CheerioAPI | null = null;
        try {
          const postUrl = "https://www.theparking.eu/index.php";
          const ajaxObj: any = {
            tab_id: "t0",
            cur_page: currentPageNum,
            cur_trie: "date",
            query: "",
            critere: {},
            sliders: {},
            req_num: 0,
            nb_results: 0,
            current_location_distance: -1,
            html5_geolocation: {},
          };

          const form = `ajax=${encodeURIComponent(JSON.stringify(ajaxObj))}&tabs=${encodeURIComponent(JSON.stringify(["t0"]))}`;
          let listResponse: string | null = null;

          // First attempt: POST via axios client without proxy
          try {
            const { createHttpClient } = await import("../utils/httpClient.js");
            const axiosClient = createHttpClient({}, {
              useProxy: false,
            } as any);
            const resp = await axiosClient.post(postUrl, form, {
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              timeout: 30000,
            });
            listResponse =
              typeof resp.data === "string"
                ? resp.data
                : JSON.stringify(resp.data);
          } catch (postErr) {
            listResponse = null;
          }

          // Second attempt: use Playwright request (shares cookies/context)
          if (!listResponse) {
            try {
              incr("playwrightRequests", 1);
              const resp = await page.request.post(postUrl, {
                data: form,
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                timeout: 30000 as any,
              });
              listResponse = await resp.text();
            } catch (pwErr) {
              listResponse = null;
            }
          }

          // Parse response if any
          if (listResponse) {
            try {
              let parsed: any = listResponse;
              try {
                parsed = JSON.parse(listResponse);
              } catch (_) {}
              if (typeof parsed === "object") parsed = JSON.stringify(parsed);
              if (
                typeof parsed === "string" &&
                parsed.startsWith('"') &&
                parsed.endsWith('"')
              ) {
                try {
                  parsed = JSON.parse(parsed);
                } catch (_) {}
              }
              $ = cheerio.load(parsed as string);
            } catch (parseErr) {
              $ = null;
            }
          }
        } catch (ajaxErr) {
          $ = null;
        }

        // If HTTP listing fetch failed or returned no results, fallback to browser navigation
        if (!$ || $(".li-result").length === 0) {
          if (currentPageNum === 1) {
            await page
              .goto(catUrl, { waitUntil: "networkidle", timeout: 60000 })
              .catch(() => {});
            await page
              .waitForSelector(".li-result", { timeout: 30000 })
              .catch(() => {});
          } else {
            try {
              await page
                .goto(catUrl, { waitUntil: "networkidle", timeout: 60000 })
                .catch(() => {});
              await page.waitForTimeout(500);
              const pageButton = page.locator(
                `.pagination a:has-text("${currentPageNum}")`,
              );
              if ((await pageButton.count()) > 0) {
                await pageButton
                  .first()
                  .click({ timeout: 10000 })
                  .catch(() => {});
                await page
                  .waitForSelector(".li-result", { timeout: 30000 })
                  .catch(() => {});
              } else {
                const separator = catUrl.includes("?") ? "&" : "?";
                const fallback = `${catUrl}${separator}tri=date&page=${currentPageNum}`;
                await page
                  .goto(fallback, { waitUntil: "networkidle", timeout: 60000 })
                  .catch(() => {});
                await page
                  .waitForSelector(".li-result", { timeout: 30000 })
                  .catch(() => {});
              }
            } catch (navErr) {
              const separator = catUrl.includes("?") ? "&" : "?";
              const fallback = `${catUrl}${separator}tri=date&page=${currentPageNum}`;
              await page
                .goto(fallback, { waitUntil: "networkidle", timeout: 60000 })
                .catch(() => {});
              await page
                .waitForSelector(".li-result", { timeout: 30000 })
                .catch(() => {});
            }
          }
          const data = await page.content();
          $ = cheerio.load(data);
        }

        const cardElements = $(".li-result").toArray();
        if (cardElements.length === 0) {
          console.log(
            `⚠️ No listings found on page ${currentPageNum}. Moving to the next category...`,
          );
          currentCategoryIndex++;
          currentPageNum = 1;
          noNewCarsCounter = 0;
          await setState<TheParkingState>(SCRAPER_ID, {
            categoryIndex: currentCategoryIndex,
            pageNum: currentPageNum,
          });
          continue;
        }

        console.log(
          `🔗 Found ${cardElements.length} listings on page ${currentPageNum}.`,
        );
        let savedNewOnThisPage = 0;

        const detailLinks: { href: string; portalId: string }[] = [];
        const attemptedDetailUrls = new Set<string>();

        for (const element of cardElements) {
          const $card = $(element);
          const aTag = $card.find('a[href*="used-cars-detail"]').first();
          let href = aTag.attr("href") || "";
          if (!href) continue;

          if (!href.startsWith("http")) {
            href = href.startsWith("/")
              ? "https://www.theparking.eu" + href
              : "https://www.theparking.eu/" + href;
          }

          const idMatch =
            href.match(/\/([A-Z0-9]+)\.html/i) || href.match(/([0-9]{5,})/);
          const portalIdStr = idMatch ? idMatch[1] : Date.now().toString();
          const portalId = `tp-${portalIdStr}`;

          const existing = await prisma.carListing.findUnique({
            where: { portalId },
            select: { id: true },
          });
          if (existing) continue;

          detailLinks.push({ href, portalId });
        }

        console.log(
          `🔍 Found ${detailLinks.length} new listings out of ${cardElements.length} on this page.`,
        );

        if (detailLinks.length === 0) {
          console.log(
            `⏩ Page ${currentPageNum}: All listings already in the database. Skipping details to save resources.`,
          );
          noNewCarsCounter++;

          if (noNewCarsCounter >= 2) {
            console.log(
              `🛑 ${noNewCarsCounter} consecutive pages with no new listings. Moving to the next category...`,
            );
            currentCategoryIndex++;
            currentPageNum = 1;
            noNewCarsCounter = 0;
          } else {
            currentPageNum++;
          }
          await setState<TheParkingState>(SCRAPER_ID, {
            categoryIndex: currentCategoryIndex,
            pageNum: currentPageNum,
          });
          continue;
        }

        // Visit detail pages (capped) — biggest Bright Data cost after list navigations
        const CONCURRENCY = parseInt(
          process.env.TP_DETAIL_CONCURRENCY || "1",
          10,
        );
        const detailsToFetch = detailLinks.slice(0, MAX_DETAILS_PER_PAGE);
        if (detailLinks.length > detailsToFetch.length) {
          console.log(
            `💸 Cap: fetching ${detailsToFetch.length}/${detailLinks.length} new details this page (TP_MAX_DETAILS_PER_PAGE).`,
          );
        }

        async function runWithConcurrency<T, R>(
          items: T[],
          worker: (t: T) => Promise<R>,
          limit: number,
        ) {
          const results: R[] = [];
          let idx = 0;
          const runners = new Array(Math.min(limit, items.length))
            .fill(null)
            .map(async () => {
              while (true) {
                const i = idx++;
                if (i >= items.length) break;
                const cur = items[i] as T;
                try {
                  results.push(await worker(cur));
                } catch (e) {
                  /* ignore per-item errors */
                }
              }
            });
          await Promise.all(runners as any);
          return results;
        }

        await runWithConcurrency(
          detailsToFetch,
          async ({ href: detailUrl, portalId }) => {
            if (attemptedDetailUrls.has(detailUrl)) {
              return null;
            }
            attemptedDetailUrls.add(detailUrl);

            try {
              console.log(`🔎 Opening detail page: ${detailUrl}`);
              let detailHtml: string | null = null;
              try {
                detailHtml = await loadDetailPage(page, detailUrl);
              } catch (httpErr) {
                console.warn(
                  `⚠️ Could not open detail page after retries: ${detailUrl}`,
                );
                return null;
              }

              const $d = cheerio.load(detailHtml);

              // ── DATA EXTRACTION FROM DETAIL PAGE ──

              const titleText = $d("a.tag_f_titre span")
                .text()
                .trim()
                .replace(/\s+/g, " ");
              const titleParts = titleText
                .split(" ")
                .map((s) => s.trim())
                .filter(Boolean);

              const brand = titleParts[0]
                ? titleParts[0].charAt(0).toUpperCase() +
                  titleParts[0].slice(1).toLowerCase()
                : "";
              const model = titleParts[1]
                ? titleParts[1].charAt(0).toUpperCase() +
                  titleParts[1].slice(1).toLowerCase()
                : "";
              const version = titleParts.slice(2).join(" ") || "";

              const priceText = $d(".prix span")
                .first()
                .text()
                .replace(/[^\d]/g, "");
              const price = parseInt(priceText, 10) || 0;

              let year = 0;
              let mileageKm = 0;
              let fuelType = "Unknown";
              let transmission = "Unknown";
              let sellerType = "Private";
              let powerHp = 0;

              $d(".info-bloc-item").each((_i, el) => {
                const spans = $d(el).find("span");
                if (spans.length >= 2) {
                  const label = $d(spans[0]).text().trim().toLowerCase();
                  const value = $d(spans[1]).text().trim();

                  if (
                    label.includes("year") ||
                    label.includes("año") ||
                    label.includes("année")
                  ) {
                    year = parseInt(value.replace(/\D/g, ""), 10) || 0;
                  } else if (
                    label.includes("kilometer") ||
                    label.includes("kilómetro") ||
                    label.includes("km") ||
                    label.includes("mileage")
                  ) {
                    mileageKm = parseInt(value.replace(/[^\d]/g, ""), 10) || 0;
                  } else if (
                    label.includes("fuel") ||
                    label.includes("combustible") ||
                    label.includes("carburant")
                  ) {
                    fuelType = normalizeFuelType(value);
                  } else if (
                    label.includes("transmission") ||
                    label.includes("transmisión") ||
                    label.includes("boîte")
                  ) {
                    transmission = normalizeTransmission(value);
                  } else if (
                    label.includes("power") ||
                    label.includes("potencia") ||
                    label.includes("puissance")
                  ) {
                    powerHp = parsePowerCv(value, { allowBare: true }) || 0;
                  }
                }
              });

              // Seller type
              const sellerText = $d(".type-vendeur")
                .text()
                .trim()
                .toLowerCase();
              if (
                sellerText.includes("professional") ||
                sellerText.includes("profesional") ||
                sellerText.includes("professionnel")
              ) {
                sellerType = "Professional";
              } else {
                sellerType = "Private";
              }

              const locationText = $d(
                ".map-localisation .content-map, #map-annonce .content-map",
              )
                .text()
                .trim();
              const countryOfOrigin =
                detectCountryFromLocationText(locationText);

              // Title = outbound final link (a.tag_f_titre → /tools/…/L.html)
              const titleHref =
                $d("h1 a.tag_f_titre").attr("href") ||
                $d("a.tag_f_titre").first().attr("href") ||
                null;

              const { resolveTheParkingUrlForSave } = await import(
                "../services/urlVerify.service.js"
              );
              const live = await resolveTheParkingUrlForSave({
                previewUrl: detailUrl,
                titleHref,
              });
              if (!live) {
                console.warn(
                  `⏭️ Skip ${portalId}: title link + TheParking preview both dead/unreachable`,
                );
                await randomDelay(500, 1500);
                return null;
              }
              if (live.url.includes("theparking.eu/used-cars-detail")) {
                console.log(
                  `📎 ${portalId}: saved TheParking preview (title link missing or failed probe)`,
                );
              } else {
                console.log(
                  `🔗 ${portalId}: saved verified title/final link`,
                );
              }

              if (!EUROPEAN_COUNTRIES.has(countryOfOrigin)) {
                console.log(
                  `⏩ Skipping: ${brand} ${model} — Non-European country: ${countryOfOrigin}`,
                );
                await randomDelay(500, 1500);
                return null;
              }

              // ── QUALITY PIPELINE ──
              const rawData: RawVehicleData = {
                portalId,
                sourcePortal: "theparking",
                brand,
                model,
                version: version || null,
                year: year || new Date().getFullYear(),
                mileageKm,
                price,
                powerHp,
                fuelType,
                transmission,
                sellerType,
                countryOfOrigin,
                originalUrl: live.url,
              };

              const validated = await validateAndEnrich(rawData);

              if (!validated) {
                await randomDelay(500, 1500);
                return null;
              }

              const { saveListingIfNew } = await import(
                "../services/listingDedup.service.js"
              );
              const result = await saveListingIfNew({
                ...validated,
                urlVerifiedAt: live.verifiedAt,
              });
              if (result !== "created" && result !== "updated") {
                await randomDelay(400, 900);
                return null;
              }

              if (result === "created") {
                savedNewOnThisPage++;
                console.log(
                  `✨ NEW LISTING: ${validated.brand} ${validated.model} (${validated.year}) | ${validated.mileageKm} km | €${validated.price} | ${validated.transmission} | ${validated.fuelType} | URL: ${validated.originalUrl}`,
                );
              }
            } catch (detailError: any) {
              console.warn(
                `⚠️ Error processing detail for ${detailUrl}: ${detailError.message}`,
              );
            }

            await randomDelay(2000, 4000);
            return null;
          },
          CONCURRENCY,
        );

        console.log(
          `✅ Page ${currentPageNum} processed: ${savedNewOnThisPage} new listings saved.`,
        );
        totalSavedThisRun += savedNewOnThisPage;

        if (savedNewOnThisPage <= 10) {
          noNewCarsCounter++;
        } else {
          noNewCarsCounter = 0;
        }

        if (noNewCarsCounter >= 3) {
          console.log(
            `🛑 Listing limit reached for this category. Moving to the next...`,
          );
          currentCategoryIndex++;
          currentPageNum = 1;
          noNewCarsCounter = 0;
        } else {
          currentPageNum++;
        }
        await setState<TheParkingState>(SCRAPER_ID, {
          categoryIndex: currentCategoryIndex,
          pageNum: currentPageNum,
        });
      } catch (error: any) {
        console.error(
          `❌ Error in current category (Page ${currentPageNum}):`,
          error.message,
        );
        currentCategoryIndex++;
        currentPageNum = 1;
        noNewCarsCounter = 0;
        await setState<TheParkingState>(SCRAPER_ID, {
          categoryIndex: currentCategoryIndex,
          pageNum: currentPageNum,
        });
      }

      if (pagesScrapedThisRun < PAGES_PER_RUN) {
        await randomDelay(2000, 4000);
      }
    }
  } catch (globalError: any) {
    console.error(
      "❌ Critical error in scrapeTheParking:",
      globalError.message,
    );
  } finally {
    if (browserInstance) {
      await browserInstance.close();
    }
  }
}

/**
 * Detects the ISO code of the country from the location text of the detail card.
 * Example: "SERBIA" → "RS", "FRANCE| OCCITANIE (30000)" → "FR"
 */
async function loadDetailPage(page: any, detailUrl: string): Promise<string> {
  const attempts = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const html = await fetchWithFallback(detailUrl, { useProxy: false });
      if (html && /fiche-descri|detail-descri|bloc-prix/i.test(html)) {
        return html;
      }
    } catch (error) {
      lastError = error;
    }

    try {
      incr("playwrightNavigations", 1);
      await page.goto(detailUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForSelector(".fiche-descri, .detail-descri, .bloc-prix", {
        timeout: 20000,
      });
      const htmlFromBrowser = await page.content();
      if (
        htmlFromBrowser &&
        /fiche-descri|detail-descri|bloc-prix/i.test(htmlFromBrowser)
      ) {
        return htmlFromBrowser;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      await randomDelay(2500 + attempt * 1000, 4000 + attempt * 1000);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not load detail page: ${detailUrl}`);
}

function detectCountryFromLocationText(text: string): string {
  if (!text) return "EU";

  const normalized = text.toLowerCase().trim();

  for (const [keyword, code] of Object.entries(COUNTRY_TEXT_MAP)) {
    if (normalized.includes(keyword)) {
      return code;
    }
  }

  const altMatch = text.match(/alt="([^"]+)"/i);
  if (altMatch) {
    const altText = altMatch[1]!.toLowerCase();
    for (const [keyword, code] of Object.entries(COUNTRY_TEXT_MAP)) {
      if (altText.includes(keyword)) return code;
    }
  }

  return "EU";
}
