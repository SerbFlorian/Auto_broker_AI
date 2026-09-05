/**
 * Disaster recovery: download latest (or named) Cloudflare R2 dump and restore into Postgres.
 *
 * Safety: refuses to run unless CONFIRM_RESTORE=YES
 *
 * Usage:
 *   CONFIRM_RESTORE=YES npx tsx scripts/restore-from-r2.ts
 *   CONFIRM_RESTORE=YES BACKUP_KEY=pg-dumps/backup-....sql.gz npx tsx scripts/restore-from-r2.ts
 *
 * Docker:
 *   docker compose exec -e CONFIRM_RESTORE=YES app npx tsx scripts/restore-from-r2.ts
 */
import 'dotenv/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream';
import {
  assertR2Ready,
  downloadBackupObject,
  findLatestBackupKey
} from '../src/services/r2.service.js';

const execAsync = promisify(exec);
const pipelineAsync = promisify(pipeline);

async function main() {
  if (process.env.CONFIRM_RESTORE !== 'YES') {
    console.error(
      [
        'Refusing restore without CONFIRM_RESTORE=YES',
        '',
        'This OVERWRITES data in DATABASE_URL.',
        'Example:',
        '  CONFIRM_RESTORE=YES npx tsx scripts/restore-from-r2.ts'
      ].join('\n')
    );
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is not defined');

  const { client, bucket } = assertR2Ready();
  const key =
    process.env.BACKUP_KEY?.trim() ||
    (await findLatestBackupKey(client, bucket));

  if (!key) {
    throw new Error('No backups found in R2 under pg-dumps/');
  }

  console.log(`☁️ Downloading R2 object: ${key}`);
  const gzBuf = await downloadBackupObject(client, bucket, key);

  const stamp = Date.now();
  const gzPath = path.join(process.cwd(), `restore-${stamp}.sql.gz`);
  const sqlPath = path.join(process.cwd(), `restore-${stamp}.sql`);

  try {
    fs.writeFileSync(gzPath, gzBuf);
    console.log('🤐 Decompressing...');
    await pipelineAsync(
      fs.createReadStream(gzPath),
      zlib.createGunzip(),
      fs.createWriteStream(sqlPath)
    );

    console.log('🗄️ Wiping public schema, then applying dump...');
    // Plain pg_dump CREATE TABLE fails if objects already exist — wipe first (CONFIRM_RESTORE=YES).
    await execAsync(
      `psql "${dbUrl}" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO CURRENT_USER; GRANT ALL ON SCHEMA public TO public;"`,
      { maxBuffer: 16 * 1024 * 1024 }
    );

    console.log('🗄️ Restoring SQL dump via psql...');
    await execAsync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${sqlPath}"`, {
      maxBuffer: 64 * 1024 * 1024
    });

    console.log(`✅ Restore complete from ${key}`);
  } finally {
    if (fs.existsSync(gzPath)) fs.unlinkSync(gzPath);
    if (fs.existsSync(sqlPath)) fs.unlinkSync(sqlPath);
  }
}

main().catch(err => {
  console.error('❌ Restore failed:', err);
  process.exit(1);
});
