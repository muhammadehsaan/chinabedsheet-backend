const express = require("express");
const { prisma } = require("../db");
const { requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async");
const { calcLineTotals, round2, round3 } = require("../utils/money");
const {
  attachPartyNumberToPurchase,
  attachPartyNumbersToParties,
  attachPartyNumbersToPurchases,
  findPartyIdByPartyNumber,
  getPartyNumberById,
  listPartyNumbers,
  setPartyNumberById,
} = require("../utils/partyNumbers");

const router = express.Router();

const normalizePartyValue = (value) => String(value || "").trim().replace(/\s+/g, " ");
const normalizePhone = (value) => String(value || "").replace(/\D+/g, "");
const parseTrailingNumber = (value) => {
  const match = String(value || "").match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
};
const formatPartyNumber = (number) => String(number).padStart(3, "0");
const normalizeBankAmount = (value) => round2(value || 0);
const PURCHASE_TX_OPTIONS = {
  maxWait: 15000,
  timeout: 120000,
};

const adjustBankBalance = async (tx, bankAccountId, deltaAmount) => {
  const resolvedBankId = Number(bankAccountId || 0);
  const delta = round2(deltaAmount || 0);
  if (!resolvedBankId || !delta) {
    return;
  }

  const bank = await tx.bankAccount.findUnique({ where: { id: resolvedBankId } });
  if (!bank) {
    return;
  }

  await tx.bankAccount.update({
    where: { id: resolvedBankId },
    data: {
      currentBalance: round2(Number(bank.currentBalance || 0) + delta),
    },
  });
};

const getNextSupplierPartyNumber = async (db) => {
  const rows = await listPartyNumbers(db);
  const maxNumber = rows.reduce((maxNo, partyNumber) => {
    const parsed = parseTrailingNumber(partyNumber);
    if (!Number.isFinite(parsed)) {
      return maxNo;
    }
    return Math.max(maxNo, parsed);
  }, 0);
  return formatPartyNumber(maxNumber + 1);
};

const findOrCreateSupplier = async (db, payload = {}) => {
  const requestedSupplierId = Number(payload.supplierId);
  const name = normalizePartyValue(payload.name || payload.supplierName);
  const requestedPartyNumber = normalizePartyValue(payload.partyNumber || payload.supplierPartyNumber);
  const phone = normalizePhone(payload.phone || payload.supplierPhone);
  const address = normalizePartyValue(payload.address || payload.city || payload.supplierCity);
  if (!name && !Number.isFinite(requestedSupplierId)) {
    return null;
  }

  const updateSupplierRecord = async (existingParty, existingPartyNumber = null) => {
    const persistedPartyNumber =
      existingPartyNumber !== null && existingPartyNumber !== undefined
        ? existingPartyNumber
        : await getPartyNumberById(db, existingParty.id);
    const nextType =
      existingParty.type !== "SUPPLIER" && existingParty.type !== "BOTH" ? "BOTH" : existingParty.type;
    const nextPartyNumber =
      requestedPartyNumber || persistedPartyNumber || (await getNextSupplierPartyNumber(db));
    const nextName = name || existingParty.name;
    const nextPhone = phone || existingParty.phone || null;
    const nextAddress = address || existingParty.address || null;
    const needsUpdate =
      nextType !== existingParty.type ||
      nextName !== existingParty.name ||
      nextPhone !== (existingParty.phone || null) ||
      nextAddress !== (existingParty.address || null);

    let party = existingParty;
    if (needsUpdate) {
      party = await db.party.update({
        where: { id: existingParty.id },
        data: {
          name: nextName,
          type: nextType,
          phone: nextPhone,
          address: nextAddress,
        },
      });
    }

    if (nextPartyNumber !== (persistedPartyNumber || null)) {
      await setPartyNumberById(db, party.id, nextPartyNumber);
    }

    return {
      ...party,
      partyNumber: nextPartyNumber || null,
    };
  };

  if (Number.isFinite(requestedSupplierId)) {
    const existingById = await db.party.findUnique({ where: { id: requestedSupplierId } });
    if (existingById) {
      const existingPartyNumber = await getPartyNumberById(db, existingById.id);
      return updateSupplierRecord(existingById, existingPartyNumber);
    }
  }

  const byPartyNumberId = requestedPartyNumber
    ? await findPartyIdByPartyNumber(db, requestedPartyNumber)
    : null;
  const byPartyNumber = byPartyNumberId
    ? await db.party.findUnique({ where: { id: byPartyNumberId } })
    : null;

  const supplierCandidates = name
    ? await db.party.findMany({
        where: { name: { equals: name, mode: "insensitive" } },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const hydratedCandidates = await attachPartyNumbersToParties(db, supplierCandidates);

  const byPhone =
    phone &&
    (await db.party.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    }));

  const exactMatch =
    byPartyNumber ||
    hydratedCandidates.find(
      (entry) =>
        phone &&
        normalizePhone(entry.phone) === phone &&
        (!address || normalizePartyValue(entry.address) === address),
    ) ||
    hydratedCandidates.find(
      (entry) => address && normalizePartyValue(entry.address) === address,
    ) ||
    (hydratedCandidates.length === 1 ? hydratedCandidates[0] : null) ||
    byPhone;

  if (exactMatch) {
    return updateSupplierRecord(exactMatch, exactMatch.partyNumber || null);
  }

  if (!name) {
    return null;
  }
  const nextPartyNumber = requestedPartyNumber || (await getNextSupplierPartyNumber(db));
  const created = await db.party.create({
    data: {
      name,
      type: "SUPPLIER",
      phone: phone || null,
      address: address || null,
    },
  });
  await setPartyNumberById(db, created.id, nextPartyNumber || null);
  return {
    ...created,
    partyNumber: nextPartyNumber || null,
  };
};

const findOrCreateItem = async (db, itemId, itemName, unitCost, itemCache = null) => {
  const numericItemId = Number(itemId);
  if (Number.isFinite(numericItemId) && numericItemId > 0) {
    const idKey = `id:${numericItemId}`;
    if (itemCache?.has(idKey)) {
      return itemCache.get(idKey);
    }
    const existingById = await db.item.findUnique({ where: { id: numericItemId } });
    if (existingById && itemCache) {
      itemCache.set(idKey, existingById);
      itemCache.set(`name:${String(existingById.name || "").trim().toLowerCase()}`, existingById);
    }
    return existingById;
  }
  const name = String(itemName || "").trim();
  if (!name) {
    return null;
  }
  const nameKey = `name:${name.toLowerCase()}`;
  if (itemCache?.has(nameKey)) {
    return itemCache.get(nameKey);
  }
  const existing = await db.item.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (existing) {
    if (itemCache) {
      itemCache.set(nameKey, existing);
      itemCache.set(`id:${existing.id}`, existing);
    }
    return existing;
  }
  const created = await db.item.create({
    data: {
      name,
      status: "Active",
      purchasePrice: round2(unitCost || 0),
    },
  });
  if (itemCache) {
    itemCache.set(nameKey, created);
    itemCache.set(`id:${created.id}`, created);
  }
  return created;
};

const preparePurchaseLines = async (db, lines) => {
  const preparedLines = [];
  const itemCache = new Map();
  let subtotal = 0;
  let taxAmount = 0;
  let totalAmount = 0;

  for (const line of lines) {
    const quantity = round3(line.quantity || 0);
    const unitCost = round2(line.unitCost || 0);
    const gstPercent = round2(line.gstPercent || 0);
    const totals = calcLineTotals(quantity, unitCost, gstPercent);
    subtotal += totals.base;
    taxAmount += totals.tax;
    totalAmount += totals.total;

    const item = await findOrCreateItem(db, line.itemId, line.itemName, unitCost, itemCache);
    preparedLines.push({
      itemId: item ? item.id : null,
      itemName: line.itemName || item?.name || "Product",
      quantity,
      unitCost,
      gstPercent,
      taxAmount: totals.tax,
      lineTotal: totals.total,
      lotNo: line.lotNo || null,
    });
  }

  return {
    preparedLines,
    subtotal: round2(subtotal),
    taxAmount: round2(taxAmount),
    totalAmount: round2(totalAmount),
  };
};

const applyPurchaseStock = async (tx, lines) => {
  for (const line of lines) {
    const itemId = Number(line.itemId);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      continue;
    }
    await tx.item.update({
      where: { id: itemId },
      data: {
        currentStock: {
          increment: round3(Number(line.quantity || 0)),
        },
        purchasePrice: round2(line.unitCost),
      },
    });
  }
};

const reversePurchaseStock = async (tx, lines) => {
  for (const line of lines) {
    const itemId = Number(line.itemId);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      continue;
    }
    await tx.item.update({
      where: { id: itemId },
      data: {
        currentStock: {
          decrement: round3(Number(line.quantity || 0)),
        },
      },
    });
  }
};

router.get(
  "/",
  requirePermission("purchases.view"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.purchase.findMany({
      include: { supplier: true, lines: true, bankAccount: true },
      orderBy: { purchaseDate: "desc" },
    });
    res.json({ data: await attachPartyNumbersToPurchases(prisma, rows) });
  }),
);

router.post(
  "/",
  requirePermission("purchases.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const purchaseDate = payload.purchaseDate ? new Date(payload.purchaseDate) : new Date();
    const supplierName = String(payload.supplierName || "").trim();
    const lines = Array.isArray(payload.items) ? payload.items : [];

    if (!supplierName) {
      return res.status(400).json({ message: "Supplier name is required." });
    }
    if (lines.length === 0) {
      return res.status(400).json({ message: "At least one line item is required." });
    }

    const purchase = await prisma.$transaction(async (tx) => {
      const supplier = await findOrCreateSupplier(tx, {
        supplierId: payload.supplierId,
        name: supplierName,
        partyNumber: payload.supplierPartyNumber,
        phone: payload.supplierPhone,
        city: payload.supplierCity,
      });
      const { preparedLines, subtotal, taxAmount, totalAmount } = await preparePurchaseLines(tx, lines);
      const bankAccountId = payload.bankAccountId ? Number(payload.bankAccountId) : null;
      const bankAmount = normalizeBankAmount(payload.bankAmount || 0);

      const record = await tx.purchase.create({
        data: {
          invoiceNo: payload.invoiceNo || null,
          billNo: payload.billNo || null,
          purchaseDate,
          paymentMethod: payload.paymentMethod || "Cash",
          notes: payload.notes || null,
          supplierId: supplier ? supplier.id : null,
          bankAccountId,
          bankAmount: bankAccountId && bankAmount > 0 ? bankAmount : null,
          subtotal: round2(subtotal),
          taxAmount: round2(taxAmount),
          totalAmount: round2(totalAmount),
          lines: {
            create: preparedLines,
          },
        },
        include: { lines: true, supplier: true, bankAccount: true },
      });

      await applyPurchaseStock(tx, record.lines);
      if (bankAccountId && bankAmount > 0) {
        await adjustBankBalance(tx, bankAccountId, -bankAmount);
      }

      return attachPartyNumberToPurchase(tx, record);
    }, PURCHASE_TX_OPTIONS);

    res.status(201).json({ data: purchase });
  }),
);

router.patch(
  "/:id",
  requirePermission("purchases.edit"),
  asyncHandler(async (req, res) => {
    const purchaseId = Number(req.params.id);
    if (!Number.isFinite(purchaseId)) {
      return res.status(400).json({ message: "Invalid purchase id." });
    }

    const existing = await prisma.purchase.findUnique({
      where: { id: purchaseId },
      include: { lines: true, supplier: true },
    });
    if (!existing) {
      return res.status(404).json({ message: "Purchase not found." });
    }

    const payload = req.body || {};
    const data = {};

    if (payload.invoiceNo !== undefined) {
      const nextInvoiceNo = String(payload.invoiceNo || "").trim();
      data.invoiceNo = nextInvoiceNo || null;
    }
    if (payload.billNo !== undefined) {
      const nextBillNo = String(payload.billNo || "").trim();
      data.billNo = nextBillNo || null;
    }
    if (payload.purchaseDate !== undefined) {
      const nextDate = new Date(payload.purchaseDate);
      if (Number.isNaN(nextDate.getTime())) {
        return res.status(400).json({ message: "Invalid purchase date." });
      }
      data.purchaseDate = nextDate;
    }
    if (payload.paymentMethod !== undefined) {
      const method = String(payload.paymentMethod || "").trim();
      data.paymentMethod = method || existing.paymentMethod || "Cash";
    }
    if (payload.bankAccountId !== undefined) {
      data.bankAccountId = payload.bankAccountId ? Number(payload.bankAccountId) : null;
    }
    if (payload.bankAmount !== undefined) {
      const nextBankAmount = normalizeBankAmount(payload.bankAmount || 0);
      data.bankAmount = nextBankAmount > 0 ? nextBankAmount : null;
    }
    if (payload.notes !== undefined) {
      const nextNotes = String(payload.notes || "").trim();
      data.notes = nextNotes || null;
    }

    if (payload.supplierName !== undefined) {
      const supplierName = String(payload.supplierName || "").trim();
      if (!supplierName) {
        return res.status(400).json({ message: "Supplier name is required." });
      }
      if (payload.items === undefined) {
        const supplier = await findOrCreateSupplier(prisma, {
          supplierId: payload.supplierId,
          name: supplierName,
          partyNumber: payload.supplierPartyNumber,
          phone: payload.supplierPhone,
          city: payload.supplierCity,
        });
        data.supplierId = supplier ? supplier.id : null;
      }
    }

    let updated;
    if (payload.items !== undefined) {
      const lines = Array.isArray(payload.items) ? payload.items : [];
      if (lines.length === 0) {
        return res.status(400).json({ message: "At least one line item is required." });
      }

      updated = await prisma.$transaction(async (tx) => {
        const nextData = { ...data };
        if (payload.supplierName !== undefined) {
          const supplier = await findOrCreateSupplier(tx, {
            supplierId: payload.supplierId,
            name: String(payload.supplierName || "").trim(),
            partyNumber: payload.supplierPartyNumber,
            phone: payload.supplierPhone,
            city: payload.supplierCity,
          });
          nextData.supplierId = supplier ? supplier.id : null;
        }

        const totals = await preparePurchaseLines(tx, lines);
        await adjustBankBalance(tx, existing.bankAccountId, Number(existing.bankAmount || 0));

        await reversePurchaseStock(tx, existing.lines);
        await tx.purchaseLine.deleteMany({ where: { purchaseId } });

        const record = await tx.purchase.update({
          where: { id: purchaseId },
          data: {
            ...nextData,
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
            lines: {
              create: totals.preparedLines,
            },
          },
          include: { supplier: true, lines: true, bankAccount: true },
        });

        await applyPurchaseStock(tx, record.lines);
        await adjustBankBalance(tx, record.bankAccountId, -Number(record.bankAmount || 0));

        return attachPartyNumberToPurchase(tx, record);
      }, PURCHASE_TX_OPTIONS);
    } else {
      updated = await prisma.$transaction(async (tx) => {
        await adjustBankBalance(tx, existing.bankAccountId, Number(existing.bankAmount || 0));
        const record = await tx.purchase.update({
          where: { id: purchaseId },
          data,
          include: { supplier: true, lines: true, bankAccount: true },
        });
        await adjustBankBalance(tx, record.bankAccountId, -Number(record.bankAmount || 0));
        return record;
      }, PURCHASE_TX_OPTIONS);
      updated = await attachPartyNumberToPurchase(prisma, updated);
    }

    res.json({ data: updated });
  }),
);

module.exports = router;
