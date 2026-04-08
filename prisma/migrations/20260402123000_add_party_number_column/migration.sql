ALTER TABLE "Party"
ADD COLUMN IF NOT EXISTS "partyNumber" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Party_partyNumber_key"
ON "Party"("partyNumber");
