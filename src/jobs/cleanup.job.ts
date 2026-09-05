import cron from 'node-cron';
import { prisma } from '../db/prisma.js';

/**
 * DB maintenance only — NO re-fetch of listing URLs.
 * (HTTP availability checks removed: portals like Ooyyo often return 410 to the VPS
 * and that wiped valid inventory.)
 */
export function startCleanupCron() {
  // 🕒 3:00 AM — zero KM
  cron.schedule('0 3 * * *', async () => {
    try {
      await performZeroKmCleanup();
    } catch (err) {
      console.error('❌ Silent error in performZeroKmCleanup (3:00 AM):', err);
    }
  });

  // 🕒 4:00 AM — stale by age
  cron.schedule('0 4 * * *', async () => {
    try {
      await performAgeCleanup();
    } catch (err) {
      console.error('❌ Silent error in performAgeCleanup (4:00 AM):', err);
    }
  });

  // 🕒 5:00 AM — privacy purge for ex-VIP after DATA_PURGE_HOURS
  cron.schedule('0 5 * * *', async () => {
    try {
      const { performScheduledDataPurge } = await import(
        '../services/privacy.service.js'
      );
      const n = await performScheduledDataPurge();
      if (n > 0) {
        console.log(`🧹 Privacy purge: cleaned ${n} ex-VIP user(s).`);
      }
    } catch (err) {
      console.error('❌ Silent error in privacy purge (5:00 AM):', err);
    }
  });

  console.log(
    '🧹 [Cleanup Job] Scheduled: 03:00 (0 km) | 04:00 (age 14d) | 05:00 (privacy purge). No HTTP URL re-check.'
  );
}

export async function performAgeCleanup() {
  console.log('🧹 Starting purge of stale ads (updatedAt > 14 days ago)...');
  try {
    const cutoffDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const result = await prisma.carListing.deleteMany({
      where: { updatedAt: { lt: cutoffDate } }
    });

    console.log(
      `✅ Purge completed. ${result.count} stale ads (not seen in 14 days) were removed from the DB.`
    );
  } catch (error) {
    console.error('❌ Error in Age Cleanup Job:', error);
    const { notifyAdminCritical } = await import('../utils/adminNotify.js');
    await notifyAdminCritical(
      `⚠️ **DB cleanup crash** (age >14d)\n\n${(error as Error).message || error}`
    );
  }
}

export async function performZeroKmCleanup() {
  console.log('🧹 Starting cleanup of ads with zero kilometers (mileageKm = 0)...');
  try {
    const result = await prisma.carListing.deleteMany({
      where: {
        mileageKm: 0
      }
    });

    console.log(
      `✅ 0km cleanup completed. ${result.count} ads without mileage data were deleted.`
    );
  } catch (error) {
    console.error('❌ Error in Zero KM Cleanup Job:', error);
  }
}

export async function performDataAnomalyCleanup() {
  console.log('🧹 Starting data anomaly cleanup...');
  try {
    const result = await prisma.carListing.deleteMany({
      where: {
        OR: [
          { price: { gt: 1000000000 } },
          { mileageKm: { gt: 2000000 } },
          { price: { lte: 0 } }
        ]
      }
    });

    if (result.count > 0) {
      console.log(
        `🧹 Anomaly cleanup: deleted ${result.count} ads with corrupt data.`
      );
    } else {
      console.log('✅ No data anomalies found.');
    }
  } catch (error) {
    console.error('❌ Error in Data Anomaly Cleanup Job:', error);
  }
}
