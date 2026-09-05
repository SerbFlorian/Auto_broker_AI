import cron from "node-cron";
//import { scrapeWallapop } from '../scrapers/wallapop.scraper.js';
import { scrapeClicars } from "../scrapers/clicars.scraper.js";
import { scrapeTheParking } from "../scrapers/theparking.scraper.js";
import { scrapeOoyyo } from "../scrapers/ooyyo.scraper.js";
import { prisma } from "../db/prisma.js";
import { startCleanupCron } from "./cleanup.job.js";
import { startEngineEnrichmentCron } from "./engine-enrichment.job.js";
import { startPriceFxCron } from "./price-fx.job.js";
import { notifyAdminCritical } from "../utils/adminNotify.js";

let isFastRunning = false;
let isSlowRunning = false;

/** Inclusive window for scrapers (container local time — set TZ=Europe/Madrid in compose). */
const HOUR_START = 8;
const HOUR_END = 20;

export function startScraperCron() {
  console.log("⏱️ Configuring Smart Dual-Speed Cron Jobs...");

  startCleanupCron();
  startEngineEnrichmentCron();
  startPriceFxCron();

  const fastCron = process.env.SCRAPER_FAST_CRON || "0 8,12,16,20 * * 1-5";
  cron.schedule(fastCron, async () => {
    console.log(
      "⚡ [FAST CRON 2h] Running low-protection scrapers (Clicars, Ooyyo)...",
    );
    await runFastHttpCycle();
  });

  const slowCron = process.env.SCRAPER_SLOW_CRON || "0 10,16 * * 1-5";
  cron.schedule(slowCron, async () => {
    console.log(
      "🐢 [SLOW CRON 4h] TheParking (low page budget, state resumes)...",
    );
    await runSlowProxyCycle();
  });

  console.log(
    `✅ Cron: Fast [${fastCron}] | Slow [${slowCron}] | Engine enrich 2h | Cleanup 03/04/05 | Backup 06:00 R2`,
  );

  if (process.env.SCRAPER_ENABLE_MANUAL_TEST === "true") {
    (async () => {
      if (!shouldRunScrapers()) {
        console.log(
          "🧪 [TEST] Outside business hours, skipping manual test run.",
        );
        return;
      }

      console.log("🧪 [TEST] Starting manual sequential execution...");
      console.log("▶️ 1/2: Running FAST scrapers...");
      await runFastHttpCycle();
      console.log("✅ 1/2: Fast scrapers completed.");

      console.log("▶️ 2/2: Running SLOW scrapers...");
      await runSlowProxyCycle();
      console.log("✅ 2/2: Slow scrapers completed. Test finished.");
    })();
  }
}

async function runFastHttpCycle() {
  if (isFastRunning) return;
  if (!shouldRunScrapers()) {
    console.log(
      "⏰ [FAST CRON] Outside business hours, skipping scraper cycle.",
    );
    return;
  }

  isFastRunning = true;

  try {
    await scrapeClicars();
    // Rotates EU markets (AT…CH); state advances country when exhausted / empty
    await scrapeOoyyo();

    const { refreshInventoryStats } = await import("./inventory-stats.job.js");
    await refreshInventoryStats();
    await triggerMatchingService(40);
  } catch (error) {
    console.error("❌ [FAST CRON] Error:", error);
    await notifyAdminCritical(
      `⚠️ **FAST scraper crash**\n\n${(error as Error).message || error}`,
    );
  } finally {
    isFastRunning = false;
  }
}

async function runSlowProxyCycle() {
  if (isSlowRunning) return;
  if (!shouldRunScrapers()) {
    console.log(
      "⏰ [SLOW CRON] Outside business hours, skipping scraper cycle.",
    );
    return;
  }

  isSlowRunning = true;

  try {
    //await scrapeWallapop();
    await scrapeTheParking();

    const { refreshInventoryStats } = await import("./inventory-stats.job.js");
    await refreshInventoryStats();
    await triggerMatchingService(240);
  } catch (error) {
    console.error("❌ [SLOW CRON] Error:", error);
    await notifyAdminCritical(
      `⚠️ **SLOW scraper (TheParking) crash**\n\n${(error as Error).message || error}`,
    );
  } finally {
    isSlowRunning = false;
  }
}

/** Safety guard matching cron: Mon–Fri (1–5), hours 08–20 inclusive. */
function shouldRunScrapers(): boolean {
  const now = new Date();
  const day = now.getDay(); // 0=Sun … 6=Sat
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= HOUR_START && hour <= HOUR_END;
}

async function triggerMatchingService(minutesLookback: number) {
  const { MatchingService } = await import("../services/matching.service.js");

  const sinceDate = new Date(Date.now() - minutesLookback * 60 * 1000);
  const newCars = await prisma.carListing.findMany({
    where: { updatedAt: { gte: sinceDate } },
  });

  if (newCars.length > 0) {
    console.log(`🎯 Processing ${newCars.length} cars for VIP alerts...`);
    await MatchingService.processNewListings(newCars);
  }
}
