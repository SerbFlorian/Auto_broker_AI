import cron from 'node-cron';
import { runEngineEnrichmentCycle } from '../services/engineEnrichment.service.js';

/**
 * Every 2 hours: parse CarListing.version → engine / engineNorm / powerHp
 * using engine-catalog.json (+ heuristics). Does not re-scrape portals.
 */
export function startEngineEnrichmentCron() {
  cron.schedule('0 */2 * * *', async () => {
    try {
      await runEngineEnrichmentCycle();
    } catch (err) {
      console.error('❌ Silent error in engine enrichment:', err);
    }
  });

  console.log('🔧 [EngineEnrich] Cron every 2h (version → engine/CV).');

  // First pass shortly after boot so existing inventory fills without waiting 2h.
  setTimeout(() => {
    void runEngineEnrichmentCycle();
  }, 90_000);
}
