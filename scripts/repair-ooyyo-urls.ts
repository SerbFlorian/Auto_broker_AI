/**
 * Manual / one-shot URL verify (same logic as the 2h cron).
 *
 * Probes ALL portals with urlVerifiedAt IS NULL:
 *   direct HTTP → Bright Data on soft → delete if still dead; mark verified if OK.
 * OOYYO: also tries Contact seller repair when the stored URL is an aggregator page.
 *
 *   docker compose exec -T scraper npx tsx scripts/repair-ooyyo-urls.ts --dry-run --limit=30
 *   docker compose exec -T scraper npx tsx scripts/repair-ooyyo-urls.ts --limit=500
 *
 * Re-queue already-"verified" non-OOYYO rows (stamped without HTTP in older builds):
 *   docker compose exec -T scraper npx tsx scripts/repair-ooyyo-urls.ts --invalidate-others --limit=500
 */
import 'dotenv/config';
import { runUrlVerifyCycle } from '../src/services/urlVerify.service.js';
import { prisma } from '../src/db/prisma.js';

const dryRun = process.argv.includes('--dry-run');
const invalidateOthers = process.argv.includes('--invalidate-others');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg
  ? Math.max(1, parseInt(limitArg.split('=')[1] || '2000', 10) || 2000)
  : 2000;

console.log(
  `🔗 URL verify / repair` +
    (dryRun ? ' [dry-run]' : '') +
    (invalidateOthers ? ' [invalidate-others]' : '') +
    ` limit=${limit} (all portals, urlVerifiedAt IS NULL)`
);

try {
  if (invalidateOthers && !dryRun) {
    const queued = await prisma.carListing.updateMany({
      where: {
        urlVerifiedAt: { not: null },
        NOT: { sourcePortal: 'ooyyo' }
      },
      data: { urlVerifiedAt: null }
    });
    console.log(
      `📎 Queued ${queued.count} non-OOYYO listing(s) for real HTTP verify (cleared urlVerifiedAt)`
    );
  }

  const pending = await prisma.carListing.count({
    where: { urlVerifiedAt: null }
  });
  console.log(`📋 Pending verify (all portals): ${pending}`);

  const stats = await runUrlVerifyCycle({ dryRun, limit });
  console.log(JSON.stringify(stats, null, 2));

  if (!dryRun && stats.scanned >= limit) {
    console.log(
      `ℹ️ Hit limit=${limit}. Re-run until pending verify reaches 0.`
    );
  }
} finally {
  await prisma.$disconnect();
}
