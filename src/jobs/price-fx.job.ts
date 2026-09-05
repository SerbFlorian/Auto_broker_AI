import cron from 'node-cron';
import { runPriceFxCycle } from '../services/priceFx.service.js';

/**
 * Every hour: convert non-euro portal prices (SEK/PLN/CHF/…) stored as fake € into real EUR.
 * Marks rows via priceNative so they are never double-converted.
 */
export function startPriceFxCron() {
  cron.schedule('15 * * * *', async () => {
    try {
      await runPriceFxCycle();
    } catch (err) {
      console.error('❌ Silent error in price FX conversion:', err);
    }
  });

  console.log('💱 [PriceFX] Cron every hour at :15 (local TZ).');

  // First pass soon after scraper boot so SE/PL/… digests stop showing krona-as-euro.
  setTimeout(() => {
    void runPriceFxCycle().catch((err) =>
      console.error('❌ [PriceFX] Boot pass failed:', err)
    );
  }, 120_000);
}
