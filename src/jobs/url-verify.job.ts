import cron from 'node-cron';
import { runUrlVerifyCycle } from '../services/urlVerify.service.js';

/**
 * Verify listings with urlVerifiedAt IS NULL (all portals).
 * Direct HTTP first; soft/blocked → Bright Data (urlverify pool); still failing → delete.
 */
export function startUrlVerifyCron() {
  const interval = process.env.URL_VERIFY_CRON || '10 */8 * * *';

  cron.schedule(interval, async () => {
    try {
      await runUrlVerifyCycle();
    } catch (err) {
      console.error('❌ Silent error in URL verify cycle:', err);
    }
  });

  console.log(
    `🔗 [UrlVerify] Cron "${interval}" (all portals, urlVerifiedAt IS NULL).`
  );

  setTimeout(() => {
    void runUrlVerifyCycle().catch((err) =>
      console.error('❌ [UrlVerify] Boot pass failed:', err)
    );
  }, 180_000);
}
