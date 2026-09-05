-- Run after `npx prisma db push` (Prisma cannot declare GIN indexes in schema).
CREATE INDEX IF NOT EXISTS "CarListing_versionTokens_gin_idx"
  ON "CarListing" USING GIN ("versionTokens");
