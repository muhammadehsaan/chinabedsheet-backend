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

router.get(
  "/",
  requireAnyPermission(["sales.view", "purchases.view", "accounts.view", "emi.view"]),
  asyncHandler(async (req, res) => {
    const type = req.query.type;
    const rows = await prisma.party.findMany({
      where: type ? { type } : undefined,
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: await attachPartyNumbersToParties(prisma, rows) });
  }),
);

router.post(
  "/",
  requireAnyPermission(["sales.create", "purchases.create", "accounts.create", "emi.create"]),
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
  requireAnyPermission(["sales.view", "purchases.view", "accounts.view", "emi.view"]),
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
  requireAnyPermission(["sales.view", "purchases.view", "accounts.view", "emi.view"]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const purchases = await prisma.purchase.findMany({
      where: { supplierId: id },
      orderBy: { purchaseDate: "desc" },
    });
    const sales = await prisma.sale.findMany({
      where: { customerId: id },
      orderBy: { saleDate: "desc" },
    });
    res.json({ data: { purchases, sales } });
  }),
);

router.get(
  "/:id/ledger",
  requireAnyPermission(["sales.view", "purchases.view", "accounts.view", "emi.view"]),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const party = await prisma.party.findUnique({ where: { id } });
    if (!party) {
      return res.status(404).json({ message: "Party not found." });
    }
    const purchases = await prisma.purchase.findMany({ where: { supplierId: id } });
    const sales = await prisma.sale.findMany({
      where: { customerId: id },
      include: {
        payments: true,
      },
    });
    const opening = Number(party.openingBalance || 0);
    const purchaseEntries = [];
    let supplierRunningBalance = opening;
    [...purchases]
      .sort((a, b) => new Date(a.purchaseDate || 0).getTime() - new Date(b.purchaseDate || 0).getTime())
      .forEach((purchase) => {
        const credit = round2(Number(purchase.totalAmount || 0));
        const debit = round2(extractPaidAmountFromPaymentMethod(purchase.paymentMethod));
        supplierRunningBalance = round2(supplierRunningBalance + credit - debit);
        purchaseEntries.push({
          id: purchase.id,
          type: "purchase",
          date: purchase.purchaseDate ? String(purchase.purchaseDate).slice(0, 10) : "",
          invoiceNo: purchase.invoiceNo || purchase.billNo || `PU-${purchase.id}`,
          description: `Purchase Invoice #${purchase.invoiceNo || purchase.billNo || purchase.id}`,
          debit,
          credit,
          balance: supplierRunningBalance,
          paymentMethod: purchase.paymentMethod || "-",
        });
      });
    const purchaseTotal = purchases.reduce(
      (sum, row) => sum + Number(row.totalAmount) - extractPaidAmountFromPaymentMethod(row.paymentMethod),
      0,
    );
    const salesTotal = sales.reduce((sum, row) => sum + Number(row.totalAmount), 0);
    const salesPendingTotal = sales.reduce(
      (sum, row) => sum + Number(row.totalAmount || 0) - extractPaidAmountFromSale(row),
      0,
    );
    const balance = round2(opening + salesPendingTotal - purchaseTotal);
    res.json({
      data: {
        openingBalance: opening,
        totalSales: round2(salesTotal),
        totalSalesPending: round2(salesPendingTotal),
        totalPurchases: round2(purchaseTotal),
        balance,
        purchaseEntries,
      },
    });
  }),
);

module.exports = router;
