-- Drop old simple Deal table and replace with proper Deal + DealLine

DROP TABLE IF EXISTS "Deal";

CREATE TABLE "Deal" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dealPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DealLine" (
    "id" SERIAL NOT NULL,
    "dealId" INTEGER NOT NULL,
    "itemId" INTEGER,
    "itemName" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DealLine" ADD CONSTRAINT "DealLine_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealLine" ADD CONSTRAINT "DealLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "DealLine_dealId_idx" ON "DealLine"("dealId");
CREATE INDEX "DealLine_itemId_idx" ON "DealLine"("itemId");
