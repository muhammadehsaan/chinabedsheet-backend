const express = require("express");

const { prisma } = require("../db");
const { requireAnyPermission } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async");
const { round2 } = require("../utils/money");
const {
  attachPartyNumbersToParties,
  ensurePartyNumberColumn,
  findPartyIdByPartyNumber,
  setPartyNumberById,
} = require("../utils/partyNumbers");

const router = express.Router();
const normalizeText = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
const normalizeCompactText = (value) => String(value || "").trim().replace(/\s+/g, " ");
const extractPaidAmountFromPaymentMethod = (value) => {
  const text = String(value || "").trim();
  if (!text || normalizeText(text) === "credit") {
    return 0;
  }
  const matches = text.match(/\d[\d,]*\.?\d*/g) || [];
  return matches.reduce((sum, part) => sum + (Number(part.replace(/,/g, "")) || 0), 0);
};
const extractPaidAmountFromSale = (sale = {}) => {
  if (Array.isArray(sale.payments) && sale.payments.length > 0) {
    return round2(
      sale.payments.reduce((sum, row) => sum + (Number(row.amount) || 0), 0),
    );
  }
  return round2(extractPaidAmountFromPaymentMethod(sale.paymentMethod));
};
const toDateOnly = (value) => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
};

router.get(
  "/",
  requireAnyPermission(["parties.view", "sales.view", "purchases.view", "accounts.view", "emi.view"]),
  asyncHandler(async (req, res) => {
    const type = normalizeCompactText(req.query.type);
    const search = normalizeCompactText(req.query.search);
    const date = normalizeCompactText(req.query.date);
    const rows = await prisma.party.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(date
          ? {
              createdAt: {
                gte: new Date(`${date}T00:00:00.000Z`),
                lt: new Date(`${date}T23:59:59.999Z`),
              },
            }
          : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { phone: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
                { address: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    const hydratedRows = await attachPartyNumbersToParties(prisma, rows);
    const partyIds = hydratedRows.map((party) => party.id);
    const [purchases, sales] = await Promise.all([
      prisma.purchase.findMany({
        where: { supplierId: { in: partyIds } },
        select: { supplierId: true, totalAmount: true, paymentMethod: true },
      }),
      prisma.sale.findMany({
        where: { customerId: { in: partyIds } },
        include: {
          payments: { select: { amount: true } },
        },
      }),
    ]);

    const purchaseByParty = new Map();
    purchases.forEach((row) => {
      const key = Number(row.supplierId || 0);
      if (!key) return;
      const total = Number(row.totalAmount || 0);
      const paid = extractPaidAmountFromPaymentMethod(row.paymentMethod);
      const entry = purchaseByParty.get(key) || { total: 0, paid: 0, count: 0 };
      entry.total += total;
      entry.paid += paid;
      entry.count += 1;
      purchaseByParty.set(key, entry);
    });

    const saleByParty = new Map();
    sales.forEach((row) => {
      const key = Number(row.customerId || 0);
      if (!key) return;
      const total = Number(row.totalAmount || 0);
      const paid = extractPaidAmountFromSale(row);
      const entry = saleByParty.get(key) || { total: 0, paid: 0, count: 0 };
      entry.total += total;
      entry.paid += paid;
      entry.count += 1;
      saleByParty.set(key, entry);
    });

    const data = hydratedRows.map((party) => {
      const partyId = Number(party.id || 0);
      const purchaseStats = purchaseByParty.get(partyId) || { total: 0, paid: 0, count: 0 };
      const saleStats = saleByParty.get(partyId) || { total: 0, paid: 0, count: 0 };
      const openingBalance = Number(party.openingBalance || 0);
      const ledgerBalance = round2(
        openingBalance +
          (purchaseStats.total - purchaseStats.paid) +
          (saleStats.total - saleStats.paid),
      );
      return {
        ...party,
        totalPurchases: purchaseStats.count,
        totalSales: saleStats.count,
        totalPurchaseAmount: round2(purchaseStats.total),
        totalSaleAmount: round2(saleStats.total),
        totalPurchasePaid: round2(purchaseStats.paid),
        totalSalePaid: round2(saleStats.paid),
        ledgerBalance,
        balance: ledgerBalance,
      };
    });

    res.json({ data });
  }),
);

router.post(
  "/",
  requireAnyPermission(["parties.create", "sales.create", "purchases.create", "accounts.create", "emi.create"]),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const name = String(payload.name || "").trim();
    const partyNumber = String(payload.partyNumber || "").trim() || null;
    if (!name) {
      return res.status(400).json({ message: "Party name is required." });
    }
    if (partyNumber) {
      await ensurePartyNumberColumn(prisma);
      const existingId = await findPartyIdByPartyNumber(prisma, partyNumber);
      if (existingId) {
        return res.status(400).json({ message: "Party number already exists." });
      }
    }
    const party = await prisma.party.create({
      data: {
        name,
        type: payload.type || "CUSTOMER",
        phone: payload.phone || null,
        email: payload.email || null,
        address: payload.address || null,
        openingBalance: round2(payload.openingBalance || 0),
      },
    });
    if (partyNumber) {
      await setPartyNumberById(prisma, party.id, partyNumber);
    }
    const [hydratedParty] = await attachPartyNumbersToParties(prisma, [party]);
    res.status(201).json({ data: hydratedParty });
  }),
);

router.get(
  "/:id",
  requireAnyPermission(["parties.view", "sales.view", "purchases.view", "accounts.view", "emi.view"]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const party = await prisma.party.findUnique({ where: { id } });
    if (!party) {
      return res.status(404).json({ message: "Party not found." });
    }
    const [hydratedParty] = await attachPartyNumbersToParties(prisma, [party]);
    res.json({ data: hydratedParty });
  }),
);

router.get(
  "/:id/history",
  requireAnyPermission(["parties.view", "sales.view", "purchases.view", "accounts.view", "emi.view"]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const purchases = await prisma.purchase.findMany({
      where: { supplierId: id },
      include: {
        lines: true,
      },
      orderBy: { purchaseDate: "desc" },
    });
    const sales = await prisma.sale.findMany({
      where: { customerId: id },
      include: {
        lines: true,
        payments: true,
      },
      orderBy: { saleDate: "desc" },
    });
    res.json({ data: { purchases, sales } });
  }),
);

router.get(
  "/:id/ledger",
  requireAnyPermission(["parties.view", "sales.view", "purchases.view", "accounts.view", "emi.view"]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const party = await prisma.party.findUnique({ where: { id } });
    if (!party) {
      return res.status(404).json({ message: "Party not found." });
    }
    const [purchases, sales, adjustments] = await Promise.all([
      prisma.purchase.findMany({ where: { supplierId: id }, orderBy: { purchaseDate: "asc" } }),
      prisma.sale.findMany({
        where: { customerId: id },
        include: {
          payments: true,
        },
        orderBy: { saleDate: "asc" },
      }),
      prisma.accountsEntry.findMany({
        where: { partyId: id },
        orderBy: { entryDate: "asc" },
      }),
    ]);

    const opening = round2(Number(party.openingBalance || 0));
    const timeline = [];
    purchases.forEach((purchase) => {
      const credit = round2(Number(purchase.totalAmount || 0));
      const debit = round2(extractPaidAmountFromPaymentMethod(purchase.paymentMethod));
      timeline.push({
        id: `purchase-${purchase.id}`,
        date: purchase.purchaseDate,
        entryDate: toDateOnly(purchase.purchaseDate),
        sourceType: "Purchase",
        sourceId: purchase.id,
        invoiceNo: purchase.invoiceNo || purchase.billNo || `PU-${purchase.id}`,
        description: `Purchase Invoice #${purchase.invoiceNo || purchase.billNo || purchase.id}`,
        debit,
        credit,
        notes: purchase.paymentMethod || "-",
      });
    });
    sales.forEach((sale) => {
      const credit = round2(Number(sale.totalAmount || 0));
      const debit = round2(extractPaidAmountFromSale(sale));
      timeline.push({
        id: `sale-${sale.id}`,
        date: sale.saleDate,
        entryDate: toDateOnly(sale.saleDate),
        sourceType: "Sale",
        sourceId: sale.id,
        invoiceNo: sale.invoiceNo || `SA-${sale.id}`,
        description: `Sale Invoice #${sale.invoiceNo || sale.id}`,
        debit,
        credit,
        notes: sale.paymentMethod || "-",
      });
    });
    adjustments.forEach((entry) => {
      const type = normalizeText(entry.type);
      const mode = normalizeCompactText(entry.mode);
      const amount = round2(Number(entry.amount || 0));
      const isPaymentLike = type === "payment" || type === "receipt";
      timeline.push({
        id: `adjustment-${entry.id}`,
        date: entry.entryDate,
        entryDate: toDateOnly(entry.entryDate),
        sourceType: "Payment",
        sourceId: entry.id,
        invoiceNo: `PM-${entry.id}`,
        description: entry.description || `Manual ${mode || "entry"}`,
        debit: isPaymentLike ? amount : 0,
        credit: isPaymentLike ? 0 : amount,
        notes: mode || "-",
      });
    });

    timeline.sort((a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime());

    let runningBalance = opening;
    const entries = timeline.map((entry) => {
      runningBalance = round2(runningBalance + Number(entry.credit || 0) - Number(entry.debit || 0));
      return {
        ...entry,
        balance: runningBalance,
      };
    });

    const purchaseEntries = entries.filter((entry) => entry.sourceType === "Purchase");
    const totalSales = round2(sales.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0));
    const totalSalesPending = round2(
      sales.reduce(
        (sum, row) => sum + Number(row.totalAmount || 0) - extractPaidAmountFromSale(row),
        0,
      ),
    );
    const totalPurchases = round2(
      purchases.reduce(
        (sum, row) => sum + Number(row.totalAmount || 0) - extractPaidAmountFromPaymentMethod(row.paymentMethod),
        0,
      ),
    );

    res.json({
      data: {
        openingBalance: opening,
        totalSales,
        totalSalesPending,
        totalPurchases,
        balance: round2(runningBalance),
        entries,
        purchaseEntries,
      },
    });
  }),
);

router.post(
  "/:id/payments",
  requireAnyPermission(["parties.create", "accounts.create", "purchases.create", "sales.create"]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ message: "Invalid party id." });
    }
    const party = await prisma.party.findUnique({ where: { id } });
    if (!party) {
      return res.status(404).json({ message: "Party not found." });
    }

    const payload = req.body || {};
    const amount = round2(Number(payload.amount || 0));
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Payment amount must be greater than zero." });
    }
    const direction = normalizeText(payload.direction || payload.type || "payment");
    const type = direction === "received" ? "RECEIPT" : "PAYMENT";
    const mode = normalizeCompactText(payload.mode || "Cash") || "Cash";
    const description =
      normalizeCompactText(payload.description) ||
      (type === "RECEIPT"
        ? `Payment received from ${party.name}`
        : `Payment paid to ${party.name}`);
    const date = payload.entryDate ? new Date(payload.entryDate) : new Date();
    if (Number.isNaN(date.getTime())) {
      return res.status(400).json({ message: "Invalid entry date." });
    }
    const bankAccountId = Number(payload.bankAccountId || 0);
    const useBank = normalizeText(mode) === "bank";
    if (useBank && (!Number.isFinite(bankAccountId) || bankAccountId <= 0)) {
      return res.status(400).json({ message: "Please select a registered bank account." });
    }
    const bankRecord = useBank
      ? await prisma.bankAccount.findUnique({ where: { id: bankAccountId } })
      : null;
    if (useBank && !bankRecord) {
      return res.status(404).json({ message: "Selected bank account not found." });
    }

    const created = await prisma.$transaction(async (tx) => {
      if (useBank) {
        const delta = type === "PAYMENT" ? -amount : amount;
        await tx.bankAccount.update({
          where: { id: bankAccountId },
          data: {
            currentBalance: round2(Number(bankRecord.currentBalance || 0) + delta),
          },
        });
      }
      const entry = await tx.accountsEntry.create({
        data: {
          entryDate: date,
          type,
          amount,
          mode,
          description,
          partyId: id,
          bankName: useBank ? `BANK:${bankAccountId}` : null,
        },
      });
      return { entry };
    });

    res.status(201).json({
      data: {
        id: created.entry.id,
        partyId: id,
        type,
        amount,
        mode,
        description,
        entryDate: created.entry.entryDate,
        bankAccountId: useBank ? bankAccountId : null,
        bankName: bankRecord?.bankName || null,
      },
    });
  }),
);

module.exports = router;
