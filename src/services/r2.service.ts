import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

export const BACKUP_PREFIX = 'pg-dumps/';

export function getR2Bucket(): string | undefined {
  return process.env.R2_BUCKET?.trim() || undefined;
}

export function createR2Client(): S3Client | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = getR2Bucket();

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }

  const endpoint =
    process.env.R2_ENDPOINT?.trim() ||
    `https://${accountId}.r2.cloudflarestorage.com`;

  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey }
  });
}

export function assertR2Ready(): { client: S3Client; bucket: string } {
  const client = createR2Client();
  const bucket = getR2Bucket();
  if (!client || !bucket) {
    throw new Error(
      'R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.'
    );
  }
  return { client, bucket };
}

export async function uploadBackupObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Readable | Buffer,
  contentLength?: number
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/gzip',
      ...(contentLength != null ? { ContentLength: contentLength } : {})
    })
  );
}

export async function listBackupObjects(
  client: S3Client,
  bucket: string
): Promise<{ Key: string; LastModified?: Date; Size?: number }[]> {
  const objects: { Key: string; LastModified?: Date; Size?: number }[] = [];
  let continuationToken: string | undefined;

  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: BACKUP_PREFIX,
        ContinuationToken: continuationToken
      })
    );

    for (const obj of listed.Contents ?? []) {
      if (!obj.Key) continue;
      objects.push({
        Key: obj.Key,
        LastModified: obj.LastModified,
        Size: obj.Size
      });
    }

    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return objects;
}

/** Newest dump by LastModified (fallback: key sort). */
export async function findLatestBackupKey(
  client: S3Client,
  bucket: string
): Promise<string | null> {
  const objects = await listBackupObjects(client, bucket);
  if (objects.length === 0) return null;

  objects.sort((a, b) => {
    const ta = a.LastModified?.getTime() ?? 0;
    const tb = b.LastModified?.getTime() ?? 0;
    if (tb !== ta) return tb - ta;
    return b.Key.localeCompare(a.Key);
  });

  return objects[0]?.Key ?? null;
}

export async function downloadBackupObject(
  client: S3Client,
  bucket: string,
  key: string
): Promise<Buffer> {
  const res = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  if (!res.Body) throw new Error(`Empty body for R2 object: ${key}`);

  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function pruneOldBackups(
  client: S3Client,
  bucket: string,
  retentionDays: number
): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const objects = await listBackupObjects(client, bucket);
  const toDelete = objects
    .filter(o => (o.LastModified?.getTime() ?? 0) < cutoff)
    .map(o => ({ Key: o.Key }));

  if (toDelete.length === 0) return 0;

  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 1000) {
    const chunk = toDelete.slice(i, i + 1000);
    const res = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk, Quiet: true }
      })
    );
    deleted += res.Deleted?.length ?? chunk.length;
  }

  return deleted;
}
