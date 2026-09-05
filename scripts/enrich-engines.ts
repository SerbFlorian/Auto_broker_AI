/**
 * Manual / one-shot engine + CV enrichment from version text.
 *   docker compose exec -T scraper npx tsx scripts/enrich-engines.ts
 *   npm run enrich:engines
 */
import 'dotenv/config';
import { enrichListingsFromVersion } from '../src/services/engineEnrichment.service.js';
import { prisma } from '../src/db/prisma.js';

const limit = Math.max(1, parseInt(process.env.ENRICH_LIMIT || '20000', 10) || 20_000);

console.log(`🔧 Enriching up to ${limit} listings from version → engine/CV...`);
const stats = await enrichListingsFromVersion({
  onlyMissingEngine: true,
  fillPower: true,
  limit
});
console.log(
  `✅ Done — scanned ${stats.scanned}, engine set ${stats.engineSet}, power set ${stats.powerSet}.`
);
await prisma.$disconnect();
