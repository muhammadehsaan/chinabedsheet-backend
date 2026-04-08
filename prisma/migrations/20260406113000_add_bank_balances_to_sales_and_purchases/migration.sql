ALTER TABLE "BankAccount"
ADD COLUMN "currentBalance" DECIMAL(12,2) NOT NULL DEFAULT 0;

UPDATE "BankAccount"
SET "currentBalance" = "openingBalance";

ALTER TABLE "Purchase"
ADD COLUMN "bankAccountId" INTEGER,
ADD COLUMN "bankAmount" DECIMAL(12,2);

ALTER TABLE "Sale"
ADD COLUMN "bankAccountId" INTEGER,
ADD COLUMN "bankAmount" DECIMAL(12,2);

ALTER TABLE "Purchase"
ADD CONSTRAINT "Purchase_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Sale"
ADD CONSTRAINT "Sale_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
