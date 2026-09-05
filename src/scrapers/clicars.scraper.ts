import * as cheerio from "cheerio";
import { fetchWithFallback } from "../utils/httpClient.js";
import { randomDelay } from "../utils/delay.js";
import { prisma } from "../db/prisma.js";
import {
  validateAndEnrich,
  type RawVehicleData,
} from "../services/dataQualityPipeline.js";
import { getState, setState } from "../utils/state.manager.js";
import { parsePowerCv } from "../utils/power.js";

const SCRAPER_ID = "clicars";
const BASE_LIST_URL =
  "https://www.clicars.com/coches-segunda-mano-ocasion";

/**
 * Clicars UI looks like infinite scroll, but the server uses `?page=N`
 * (same data the browser scroll loads). Catalog is ~1.5k cars and once
 * fully ingested we only watch the first pages — new stock lands at the top.
 */
const PAGES_PER_RUN = Math.max(
  1,
  parseInt(process.env.CLICARS_PAGES_PER_RUN || process.env.SCRAPER_PAGES || '10', 10) || 10,
);
/** Steady-state window: only pages 1…MAX_PAGE (no deep crawl). */
const MAX_PAGE = Math.max(
  1,
  parseInt(process.env.CLICARS_MAX_PAGE || process.env.SCRAPER_STEADY_PAGES || '10', 10) || 10,
);
/** Consecutive pages with 0 new → wrap to page 1 early. */
const EMPTY_PAGES_BEFORE_WRAP = 2;

interface ClicarsState {
  page: number;
}

export async function scrapeClicars(searchUrl?: string) {
  console.log(
    `⚡ Starting Clicars scraper (watch pages 1–${MAX_PAGE}, ${PAGES_PER_RUN}/run)...`,
  );

  try {
    let page = await loadPageState(searchUrl);
    if (page > MAX_PAGE) {
      console.log(
        `🔁 Saved page ${page} is past watch window → reset to page 1.`,
      );
      page = 1;
      await persistPage(page);
    }
    let pagesScrapedThisRun = 0;
    let totalSaved = 0;
    let totalSkipped = 0;
    let emptyStreak = 0;
    let prevPageIds: string[] = [];

    console.log(`🧠 Resuming Clicars at page ${page}`);

    while (pagesScrapedThisRun < PAGES_PER_RUN) {
      pagesScrapedThisRun++;
      const currentUrl = buildPageUrl(searchUrl || BASE_LIST_URL, page);
      console.log(
        `📄 Clicars [Batch ${pagesScrapedThisRun}/${PAGES_PER_RUN}] page=${page}: ${currentUrl}`,
      );

      const htmlResponse = await fetchWithFallback(currentUrl, {
        useProxy: false,
      });
      if (!htmlResponse) {
        console.warn(
          "⚠️ Could not get HTML from the listing. Aborting current batch.",
        );
        break;
      }

      const $ = cheerio.load(htmlResponse);
      const items = $("article.sale-list__item").toArray();
      const pageIds = items
        .map((el) => $(el).attr("data-vehicle-web-id") || "")
        .filter(Boolean);

      if (items.length === 0) {
        console.log(
          "🏁 No cards on this page. End of catalog → wrap to page 1.",
        );
        page = 1;
        await persistPage(page);
        emptyStreak = 0;
        prevPageIds = [];
        break;
      }

      // Past last page Clicars re-serves the same cars (page 120 === page 200)
      if (
        prevPageIds.length > 0 &&
        pageIds.length === prevPageIds.length &&
        pageIds.every((id, i) => id === prevPageIds[i])
      ) {
        console.log(
          `🏁 Duplicate page content at page=${page} (scroll end) → wrap to page 1.`,
        );
        page = 1;
        await persistPage(page);
        emptyStreak = 0;
        prevPageIds = [];
        break;
      }

      console.log(`🔎 Detected ${items.length} vehicle cards on this page.`);

      let newOnThisPage = 0;

      for (const element of items) {
        const aTag = $(element).find("a.analytics-list-click-car");
        if (!aTag.length) continue;

        const rawId = $(element).attr("data-vehicle-web-id");
        if (!rawId) continue;

        const portalId = `clicars-${rawId}`;

        const existingCar = await prisma.carListing.findUnique({
          where: { portalId },
          select: { id: true },
        });

        if (existingCar) {
          totalSkipped++;
          continue;
        }

        let originalUrl = aTag.attr("href") || "";
        if (originalUrl && !originalUrl.startsWith("http")) {
          originalUrl = `https://www.clicars.com${originalUrl}`;
        }

        const makeStr = aTag.attr("data-analytics-vehicle-maker") || "Unknown";
        const modelStr = aTag.attr("data-analytics-vehicle-model") || "Unknown";
        const version = $(element).find(".version").text().trim();
        const infoText = $(element).find(".info").text().trim();

        const parts = infoText.split("|").map((s) => s.trim());
        const year = parseInt(parts[0] || "0", 10) || 0;
        const mileageKm =
          parseInt(parts[1]?.replace(/\D/g, "") || "0", 10) || 0;
        const powerHp = parsePowerCv(parts[2] || "", { allowBare: true }) || 0;

        let transmission = "Unknown";
        if (parts[3]) {
          const transStr = parts[3].toLowerCase();
          if (transStr.includes("manual")) transmission = "Manual";
          else if (
            transStr.includes("automát") ||
            transStr.includes("autonomía") ||
            transStr.includes("automatic")
          )
            transmission = "Automatic";
        }

        const priceStr = $(element).find(".price").text().replace(/\D/g, "");
        const price = parseFloat(priceStr) || 0;
        const fuelType =
          $(element).find(".fuelName").text().trim() || "Unknown";

        if (price <= 0) continue;

        const rawData: RawVehicleData = {
          portalId,
          sourcePortal: "clicars",
          brand: makeStr.charAt(0).toUpperCase() + makeStr.slice(1),
          model: modelStr.charAt(0).toUpperCase() + modelStr.slice(1),
          version: version || null,
          year,
          mileageKm,
          price,
          powerHp: powerHp > 0 ? powerHp : 0,
          fuelType,
          transmission,
          sellerType: "Professional",
          countryOfOrigin: "ES",
          originalUrl,
        };

        const validated = await validateAndEnrich(rawData);
        if (!validated) {
          await randomDelay(800, 1500);
          continue;
        }

        try {
          const { saveListingIfNew } = await import(
            "../services/listingDedup.service.js"
          );
          const result = await saveListingIfNew(validated);
          if (result === "created") {
            totalSaved++;
            newOnThisPage++;
            console.log(
              `✨ NEW: ${validated.brand} ${validated.model} | ${validated.price}€`,
            );
          } else {
            totalSkipped++;
          }
        } catch (err: any) {
          console.error(`❌ Error saving car ${portalId}:`, err.message);
        }

        await randomDelay(1000, 1800);
      }

      console.log(`✅ Page processed: ${newOnThisPage} new cars saved.`);

      prevPageIds = pageIds;

      if (newOnThisPage === 0) emptyStreak++;
      else emptyStreak = 0;

      const nextPage = page + 1;
      const shouldWrap =
        nextPage > MAX_PAGE || emptyStreak >= EMPTY_PAGES_BEFORE_WRAP;

      if (shouldWrap) {
        console.log(
          nextPage > MAX_PAGE
            ? `🔁 Reached watch window page ${MAX_PAGE} → wrap to page 1 (new stock is at the top).`
            : `🔁 ${emptyStreak} empty pages → wrap to page 1.`,
        );
        page = 1;
        await persistPage(page);
        emptyStreak = 0;
        prevPageIds = [];
        break;
      }

      page = nextPage;
      await persistPage(page);

      if (pagesScrapedThisRun < PAGES_PER_RUN) {
        await randomDelay(2500, 4500);
      }
    }

    console.log(
      `✅ Clicars batch completed: ${totalSaved} new | ${totalSkipped} skipped. Next page=${page}.`,
    );
  } catch (error: any) {
    console.error("❌ Error in scrapeClicars:", error.message);
  }
}

async function loadPageState(searchUrl?: string): Promise<number> {
  const raw = await getState<ClicarsState | string>(SCRAPER_ID);

  if (typeof raw === "string" && raw.length > 0) {
    try {
      const p = parseInt(new URL(raw).searchParams.get("page") || "1", 10);
      return Number.isFinite(p) && p >= 1 ? p : 1;
    } catch {
      return 1;
    }
  }

  if (raw && typeof raw === "object" && typeof raw.page === "number") {
    return raw.page >= 1 ? raw.page : 1;
  }

  if (searchUrl) {
    try {
      const p = parseInt(
        new URL(searchUrl).searchParams.get("page") || "1",
        10,
      );
      return Number.isFinite(p) && p >= 1 ? p : 1;
    } catch {
      /* fall through */
    }
  }

  return 1;
}

async function persistPage(page: number) {
  await setState<ClicarsState>(SCRAPER_ID, { page });
}

function buildPageUrl(base: string, page: number): string {
  try {
    const url = new URL(base.includes("?") || base.includes("/coches") ? base : BASE_LIST_URL);
    // Prefer clean list path if caller passed a weird URL
    if (!url.pathname.includes("coches-segunda-mano")) {
      return `${BASE_LIST_URL}?page=${page}`;
    }
    url.searchParams.set("page", String(page));
    return url.toString();
  } catch {
    return `${BASE_LIST_URL}?page=${page}`;
  }
}
