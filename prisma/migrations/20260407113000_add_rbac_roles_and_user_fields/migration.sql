CREATE TABLE "Role" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

ALTER TABLE "User"
ADD COLUMN "username" TEXT,
ADD COLUMN "phone" TEXT,
ADD COLUMN "notes" TEXT,
ADD COLUMN "roleId" INTEGER;

UPDATE "User"
SET "username" = COALESCE(NULLIF(split_part("email", '@', 1), ''), 'user-' || "id")
WHERE "username" IS NULL;

ALTER TABLE "User"
ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "User_roleId_idx" ON "User"("roleId");
