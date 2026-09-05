/**
 * Drain Redis digest queue → Telegram.
 *
 *   docker compose exec -T app npm run flush-queue
 *   docker compose exec -T app npm run flush-queue -- 1038094638
 *
 * Default telegramId = first TELEGRAM_ADMIN_USER_IDS entry.
 * If Redis queue is empty, refills one batch from inventory then sends.
 */
import 'dotenv/config';

process.env.SKIP_APP_BOOTSTRAP = 'true';

import { initRedis, disconnectRedis } from '../src/db/redis.js';
import { prisma } from '../src/db/prisma.js';
import { queueService } from '../src/services/queue.service.js';
import { getAdminUserIds } from '../src/utils/secrets.js';

async function main() {
  const argId = process.argv[2];
  const telegramId =
    argId && /^\d+$/.test(argId)
      ? parseInt(argId, 10)
      : getAdminUserIds()[0] || 0;

  if (!telegramId) {
    console.error(
      '❌ Pass a telegramId or set TELEGRAM_ADMIN_USER_IDS in .env\n' +
        '   npm run flush-queue -- 1038094638'
    );
    process.exit(1);
  }

  const redis = await initRedis();
  if (!redis) {
    console.error('❌ Redis not available — abort.');
    process.exit(1);
  }

  console.log(`📦 flush-queue → ${telegramId}`);
  const ok = await queueService.flushUserQueueNow(telegramId);
  if (!ok) process.exit(2);
  console.log('✅ Sent — check Telegram.');
}

main()
  .catch((err) => {
    console.error('❌ flush-queue failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectRedis();
    await prisma.$disconnect();
  });
