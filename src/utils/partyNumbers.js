const { Prisma } = require("@prisma/client");

let ensurePartyNumberColumnPromise = null;

const normalizePartyNumber = (value) => {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text || null;
};

const ensurePartyNumberColumn = async (db) => {
  if (!ensurePartyNumberColumnPromise) {
    ensurePartyNumberColumnPromise = (async () => {
      await db.$executeRawUnsafe('ALTER TABLE "Party" ADD COLUMN IF NOT EXISTS "partyNumber" TEXT');
      await db.$executeRawUnsafe(
        'CREATE UNIQUE INDEX IF NOT EXISTS "Party_partyNumber_key" ON "Party"("partyNumber")',
      );
    })().catch((error) => {
      ensurePartyNumberColumnPromise = null;
      throw error;
    });
  }
  return ensurePartyNumberColumnPromise;
};

const getPartyNumberMap = async (db, partyIds = []) => {
  const normalizedIds = Array.from(
    new Set(
      (partyIds || [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value)),
    ),
  );
  if (normalizedIds.length === 0) {
    return new Map();
  }
  await ensurePartyNumberColumn(db);
  const rows = await db.$queryRaw(
    Prisma.sql`SELECT "id", "partyNumber" FROM "Party" WHERE "id" IN (${Prisma.join(normalizedIds)})`,
  );
  return new Map(
    rows.map((row) => [Number(row.id), normalizePartyNumber(row.partyNumber)]),
  );
};

const getPartyNumberById = async (db, partyId) => {
  const map = await getPartyNumberMap(db, [partyId]);
  return map.get(Number(partyId)) || null;
};

const listPartyNumbers = async (db) => {
  await ensurePartyNumberColumn(db);
  const rows = await db.$queryRaw(
    Prisma.sql`SELECT "partyNumber" FROM "Party" WHERE "partyNumber" IS NOT NULL`,
  );
  return rows
    .map((row) => normalizePartyNumber(row.partyNumber))
    .filter(Boolean);
};

const findPartyIdByPartyNumber = async (db, partyNumber) => {
  const normalized = normalizePartyNumber(partyNumber);
  if (!normalized) {
    return null;
  }
  await ensurePartyNumberColumn(db);
  const rows = await db.$queryRaw(
    Prisma.sql`
      SELECT "id"
      FROM "Party"
      WHERE LOWER(COALESCE("partyNumber", '')) = LOWER(${normalized})
      ORDER BY "createdAt" DESC
      LIMIT 1
    `,
  );
  return rows[0] ? Number(rows[0].id) : null;
};

const setPartyNumberById = async (db, partyId, partyNumber) => {
  const normalizedId = Number(partyId);
  if (!Number.isFinite(normalizedId)) {
    return null;
  }
  await ensurePartyNumberColumn(db);
  const normalized = normalizePartyNumber(partyNumber);
  await db.$executeRaw(
    Prisma.sql`UPDATE "Party" SET "partyNumber" = ${normalized} WHERE "id" = ${normalizedId}`,
  );
  return normalized;
};

const attachPartyNumbersToParties = async (db, parties = []) => {
  if (!Array.isArray(parties) || parties.length === 0) {
    return [];
  }
  const map = await getPartyNumberMap(
    db,
    parties.map((party) => party?.id),
  );
  return parties.map((party) => ({
    ...party,
    partyNumber: map.get(Number(party.id)) || null,
  }));
};

const attachPartyNumbersToPurchases = async (db, purchases = []) => {
  if (!Array.isArray(purchases) || purchases.length === 0) {
    return [];
  }
  const map = await getPartyNumberMap(
    db,
    purchases.map((purchase) => purchase?.supplier?.id || purchase?.supplierId),
  );
  return purchases.map((purchase) => {
    const supplierId = Number(purchase?.supplier?.id || purchase?.supplierId);
    const partyNumber = map.get(supplierId) || null;
    return {
      ...purchase,
      supplierPartyNumber: purchase?.supplierPartyNumber || partyNumber,
      supplier: purchase.supplier
        ? {
            ...purchase.supplier,
            partyNumber: purchase.supplier.partyNumber || partyNumber,
          }
        : purchase.supplier,
    };
  });
};

const attachPartyNumberToPurchase = async (db, purchase) => {
  if (!purchase) {
    return purchase;
  }
  const [row] = await attachPartyNumbersToPurchases(db, [purchase]);
  return row || purchase;
};

module.exports = {
  attachPartyNumberToPurchase,
  attachPartyNumbersToParties,
  attachPartyNumbersToPurchases,
  ensurePartyNumberColumn,
  findPartyIdByPartyNumber,
  getPartyNumberById,
  listPartyNumbers,
  normalizePartyNumber,
  setPartyNumberById,
};
