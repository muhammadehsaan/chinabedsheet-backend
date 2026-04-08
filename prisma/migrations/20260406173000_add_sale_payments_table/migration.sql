CREATE TABLE "SalePayment" (
  "id" SERIAL NOT NULL,
  "saleId" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "bankAccountId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SalePayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalePayment_saleId_idx" ON "SalePayment"("saleId");
CREATE INDEX "SalePayment_bankAccountId_idx" ON "SalePayment"("bankAccountId");

ALTER TABLE "SalePayment"
  ADD CONSTRAINT "SalePayment_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "Sale"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SalePayment"
  ADD CONSTRAINT "SalePayment_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
