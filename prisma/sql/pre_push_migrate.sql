-- Preserve UserAlert.fuelType → fuelTypes before Prisma drops the old column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'UserAlert' AND column_name = 'fuelType'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'UserAlert' AND column_name = 'fuelTypes'
  ) THEN
    ALTER TABLE "UserAlert" ADD COLUMN "fuelTypes" TEXT[] NOT NULL DEFAULT '{}';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'UserAlert' AND column_name = 'fuelType'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'UserAlert' AND column_name = 'fuelTypes'
  ) THEN
    UPDATE "UserAlert"
    SET "fuelTypes" = ARRAY["fuelType"]
    WHERE "fuelType" IS NOT NULL
      AND "fuelType" <> ''
      AND (cardinality("fuelTypes") = 0 OR "fuelTypes" IS NULL);
  END IF;
END $$;

-- Preserve UserAlert.countryOfOrigin → countries[] before Prisma drops the old column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'UserAlert' AND column_name = 'countries'
  ) THEN
    ALTER TABLE "UserAlert" ADD COLUMN "countries" TEXT[] NOT NULL DEFAULT '{}';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'UserAlert' AND column_name = 'countryOfOrigin'
  ) THEN
    UPDATE "UserAlert"
    SET "countries" = ARRAY["countryOfOrigin"]
    WHERE "countryOfOrigin" IS NOT NULL
      AND "countryOfOrigin" <> ''
      AND (cardinality("countries") = 0 OR "countries" IS NULL);
  END IF;
END $$;

-- Data-minimization cleanup: remove legacy user-identifying columns that were
-- deleted from Prisma schema. Doing this here avoids prisma db push failing on
-- "destructive change" prompts during container boot.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'username'
  ) THEN
    ALTER TABLE "User" DROP COLUMN "username";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'firstName'
  ) THEN
    ALTER TABLE "User" DROP COLUMN "firstName";
  END IF;
END $$;

-- Deduplicate identical originalUrl before Prisma adds UNIQUE (keep newest updatedAt).
DELETE FROM "CarListing" a
USING "CarListing" b
WHERE a."originalUrl" = b."originalUrl"
  AND a.id <> b.id
  AND (
    a."updatedAt" < b."updatedAt"
    OR (a."updatedAt" = b."updatedAt" AND a.id < b.id)
  );

-- Drop legacy review columns (FullReview removed — fix quality at scrape time).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'CarListing' AND column_name = 'fullReview'
  ) THEN
    ALTER TABLE "CarListing" DROP COLUMN "fullReview";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'CarListing' AND column_name = 'verifiedAt'
  ) THEN
    ALTER TABLE "CarListing" DROP COLUMN "verifiedAt";
  END IF;
END $$;

-- VIP AI: daily inventory lookup counter (max 3/day by default)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'dailyAiDbLookups'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "dailyAiDbLookups" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- VIP AI: one broken-link grace DB pull per day (after normal lookups are spent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'dailyBrokenLinkGraceUsed'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "dailyBrokenLinkGraceUsed" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Ops key/value store (VIP counter message id, etc.). Created here so a fresh
-- restore + db push never races the first admin command.
CREATE TABLE IF NOT EXISTS "AppMeta" (
  "key"       TEXT PRIMARY KEY,
  "value"     TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Engine + power filters (CarListing + UserAlert + InventoryStats)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'CarListing' AND column_name = 'engine'
  ) THEN
    ALTER TABLE "CarListing" ADD COLUMN "engine" TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'CarListing' AND column_name = 'engineNorm'
  ) THEN
    ALTER TABLE "CarListing" ADD COLUMN "engineNorm" TEXT NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'UserAlert' AND column_name = 'engines'
  ) THEN
    ALTER TABLE "UserAlert" ADD COLUMN "engines" TEXT[] NOT NULL DEFAULT '{}';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'UserAlert' AND column_name = 'minPowerHp'
  ) THEN
    ALTER TABLE "UserAlert" ADD COLUMN "minPowerHp" INTEGER;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'InventoryStats' AND column_name = 'engines'
  ) THEN
    ALTER TABLE "InventoryStats" ADD COLUMN "engines" TEXT[] NOT NULL DEFAULT '{}';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'InventoryStats' AND column_name = 'minPower'
  ) THEN
    ALTER TABLE "InventoryStats" ADD COLUMN "minPower" INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'InventoryStats' AND column_name = 'maxPower'
  ) THEN
    ALTER TABLE "InventoryStats" ADD COLUMN "maxPower" INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'InventoryStats' AND column_name = 'avgPower'
  ) THEN
    ALTER TABLE "InventoryStats" ADD COLUMN "avgPower" DOUBLE PRECISION NOT NULL DEFAULT 0;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "CarListing_brandNorm_modelNorm_engineNorm_idx"
  ON "CarListing"("brandNorm", "modelNorm", "engineNorm");
CREATE INDEX IF NOT EXISTS "CarListing_brandNorm_modelNorm_powerHp_idx"
  ON "CarListing"("brandNorm", "modelNorm", "powerHp");
CREATE INDEX IF NOT EXISTS "CarListing_engineNorm_idx"
  ON "CarListing"("engineNorm");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'CarListing' AND column_name = 'urlVerifiedAt'
  ) THEN
    ALTER TABLE "CarListing" ADD COLUMN "urlVerifiedAt" TIMESTAMP(3);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "CarListing_urlVerifiedAt_idx"
  ON "CarListing"("urlVerifiedAt");

