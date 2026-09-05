import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream';
import cron from 'node-cron';
import {
  BACKUP_PREFIX,
  createR2Client,
  getR2Bucket,
  pruneOldBackups,
  uploadBackupObject
} from '../services/r2.service.js';
import { notifyAdminCritical } from '../utils/adminNotify.js';

const execAsync = promisify(exec);
const pipelineAsync = promisify(pipeline);

function getRetentionDays(): number {
  const n = Number(process.env.BACKUP_RETENTION_DAYS ?? '7');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
}

export function startBackupCron() {
  // After nightly cleanups (02–04): dump at 06:00 → Cloudflare R2 only
  cron.schedule('0 6 * * *', async () => {
    try {
      await performBackup();
    } catch (err) {
      console.error('❌ Silent error in performBackup (6:00 AM):', err);
      await notifyAdminCritical(
        `⚠️ **Backup CRASH**\n\n${(err as Error).message || err}`
      );
    }
  });

  console.log(
    '🕒 [Backup Job] Daily 06:00 → Cloudflare R2 (no files to Telegram; alert only on failure).'
  );
}

export async function performBackup() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is not defined');

  const r2 = createR2Client();
  const bucket = getR2Bucket();
  if (!r2 || !bucket) {
    const msg =
      '⚠️ R2 backup skipped: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.';
    console.warn(msg);
    await notifyAdminCritical(msg);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sqlFileName = `backup-${timestamp}.sql`;
  const sqlFilePath = path.join(process.cwd(), sqlFileName);
  const gzFileName = `${sqlFileName}.gz`;
  const gzFilePath = path.join(process.cwd(), gzFileName);
  const objectKey = `${BACKUP_PREFIX}${gzFileName}`;

  try {
    console.log('📦 Starting PostgreSQL database backup...');
    // --clean --if-exists: dump includes DROP … IF EXISTS so restores onto a non-empty DB are safer
    await execAsync(
      `pg_dump --clean --if-exists --no-owner --no-acl "${dbUrl}" > "${sqlFilePath}"`
    );

    console.log('🤐 Compressing the backup file...');
    await pipelineAsync(
      fs.createReadStream(sqlFilePath),
      zlib.createGzip(),
      fs.createWriteStream(gzFilePath)
    );

    const sizeBytes = fs.statSync(gzFilePath).size;
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);

    console.log(`☁️ Uploading backup to Cloudflare R2 (${sizeMb} MB)...`);
    await uploadBackupObject(
      r2,
      bucket,
      objectKey,
      fs.createReadStream(gzFilePath),
      sizeBytes
    );

    const deleted = await pruneOldBackups(r2, bucket, getRetentionDays());
    console.log(
      `✅ Backup on R2: ${objectKey} (${sizeMb} MB). Pruned ${deleted} old object(s).`
    );
    // Success: logs only — never spam Telegram admin chat.
  } catch (error) {
    console.error('❌ Error during backup:', error);
    await notifyAdminCritical(
      `⚠️ **Backup FAILED** (Cloudflare R2)\n\n${(error as Error).message}`
    );
  } finally {
    if (fs.existsSync(sqlFilePath)) fs.unlinkSync(sqlFilePath);
    if (fs.existsSync(gzFilePath)) fs.unlinkSync(gzFilePath);
  }
}
