import { prisma } from '../db/prisma.js';
import { cacheDelByPrefix } from './cache.service.js';

/**
 * Purge personal/VIP data for a user while keeping telegramId + free trial counters (anti-abuse).
 */
export async function purgeUserPersonalData(
  userId: string,
  telegramId: number | bigint
): Promise<void> {
  await prisma.userAlert.deleteMany({ where: { userId } });
  await prisma.sentListing.deleteMany({ where: { userId } });
  await prisma.user.update({
    where: { id: userId },
    data: {
      becameFreeAt: null
    }
  });

  try {
    const { queueService } = await import('./queue.service.js');
    await queueService.clearUserQueue(Number(telegramId));
  } catch {
    /* queue may be unavailable during early boot */
  }

  await cacheDelByPrefix('alerts:idx:');
}

/**
 * Auto-purge users who left VIP after DATA_PURGE_HOURS (default 48).
 */
export async function performScheduledDataPurge(): Promise<number> {
  const hours = Math.max(1, parseInt(process.env.DATA_PURGE_HOURS || '48', 10) || 48);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    where: {
      subscriptionStatus: 'free',
      becameFreeAt: { not: null, lte: cutoff },
      OR: [
        { alerts: { some: {} } },
        { sentListings: { some: {} } }
      ]
    },
    select: { id: true, telegramId: true }
  });

  for (const u of users) {
    await purgeUserPersonalData(u.id, u.telegramId);
  }

  return users.length;
}
