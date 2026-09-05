/**
 * One-shot / manual FX conversion for non-euro countries.
 *
 *   npm run convert:prices
 *   docker compose exec -T scraper npx tsx scripts/convert-prices-fx.ts
 *   docker compose exec -T scraper npx tsx scripts/convert-prices-fx.ts --dry-run
 */
import 'dotenv/config';
import { runPriceFxCycle } from '../src/services/priceFx.service.js';
import { prisma } from '../src/db/prisma.js';

const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg
  ? Math.max(1, parseInt(limitArg.split('=')[1] || '5000', 10) || 5000)
  : undefined;

console.log(
  `💱 Converting non-EUR listing prices → EUR` +
    (dryRun ? ' (dry-run)' : '') +
    (limit ? ` limit=${limit}` : '') +
    '...'
);

try {
  const stats = await runPriceFxCycle({ dryRun, limit });
  console.log(JSON.stringify(stats, null, 2));
} finally {
  await prisma.$disconnect();
}
