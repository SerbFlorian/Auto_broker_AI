/**
 * Clear SentListing history for one Telegram user (fresh digests).
 *
 *   docker compose exec -T app npx tsx scripts/clear-sent.ts 1038094638
 */
import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';

const tg = BigInt(process.argv[2] || '1038094638');

async function main() {
  const user = await prisma.user.findUnique({
    where: { telegramId: tg },
    select: { id: true }
  });
  if (!user) {
    console.error('user not found:', tg.toString());
    process.exit(1);
  }
  const r = await prisma.sentListing.deleteMany({ where: { userId: user.id } });
  console.log('Deleted sent rows:', r.count);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
