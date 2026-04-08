const express = require("express");
const dayjs = require("dayjs");

const { prisma } = require("../db");
const { requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async");
const { round2, round3 } = require("../utils/money");

const router = express.Router();

const parseRange = (query) => {
  const startDate = query.startDate ? dayjs(query.startDate) : dayjs().subtract(30, "day");
  const endDate = query.endDate ? dayjs(query.endDate) : dayjs();
  return {
    start: startDate.startOf("day").toDate(),
    end: endDate.endOf("day").toDate(),
  };
};

router.get(
  "/sales",
  requirePermission("reports.view"),
  asyncHandler(async (req, res) => {
    const { start, end } = parseRange(req.query);
    const sales = await prisma.sale.findMany({
      where: { saleDate: { gte: start, lte: end } },
      include: { lines: true, customer: true },
    });

    const summary = sales.reduce(
      (acc, sale) => {
        acc.invoices += 1;
        acc.subtotal += Number(sale.subtotal);
        acc.taxAmount += Number(sale.taxAmount);
        acc.totalAmount += Number(sale.totalAmount);
        return acc;
      },
      { invoices: 0, subtotal: 0, taxAmount: 0, totalAmount: 0 },
    );

    const itemMap = new Map();
    sales.forEach((sale) => {
      (sale.lines || []).forEach((line) => {
        const key = line.itemId || line.itemName;
        const existing = itemMap.get(key) || { itemId: line.itemId, itemName: line.itemName, quantity: 0, amount: 0 };
        existing.quantity += Number(line.quantity);
        existing.amount += Number(line.lineTotal);
        itemMap.set(key, existing);
      });
    });

    const topItems = Array.from(itemMap.values()).sort((a, b) => b.amount - a.amount).slice(0, 10);

    res.json({
      data: {
        summary: {
          invoices: summary.invoices,
          subtotal: round2(summary.subtotal),
          taxAmount: round2(summary.taxAmount),
          totalAmount: round2(summary.totalAmount),
        },
        topItems,
        records: sales.map((sale) => ({
          id: sale.id,
          invoiceNo: sale.invoiceNo || "",
          saleDate: sale.saleDate,
          customerName: sale.customer?.name || "-",
          paymentMethod: sale.paymentMethod || "-",
          subtotal: round2(sale.subtotal),
          taxAmount: round2(sale.taxAmount),
          totalAmount: round2(sale.totalAmount),
        })),
      },
    });
  }),
);

router.get(
  "/purchases",
  requirePermission("reports.view"),
  asyncHandler(async (req, res) => {
    const { start, end } = parseRange(req.query);
    const purchases = await prisma.purchase.findMany({
      where: { purchaseDate: { gte: start, lte: end } },
      include: { supplier: true },
    });

    const summary = purchases.reduce(
      (acc, row) => {
        acc.invoices += 1;
        acc.subtotal += Number(row.subtotal);
        acc.taxAmount += Number(row.taxAmount);
        acc.totalAmount += Number(row.totalAmount);
        return acc;
      },
      { invoices: 0, subtotal: 0, taxAmount: 0, totalAmount: 0 },
    );

    res.json({
      data: {
        summary: {
          invoices: summary.invoices,
          subtotal: round2(summary.subtotal),
          taxAmount: round2(summary.taxAmount),
          totalAmount: round2(summary.totalAmount),
        },
        records: purchases.map((row) => ({
          id: row.id,
          invoiceNo: row.invoiceNo || row.billNo || "",
          purchaseDate: row.purchaseDate,
          supplierName: row.supplier?.name || "-",
          paymentMethod: row.paymentMethod || "-",
          subtotal: round2(row.subtotal),
          taxAmount: round2(row.taxAmount),
          totalAmount: round2(row.totalAmount),
        })),
      },
    });
  }),
);

router.get(
  "/profit",
  requirePermission("reports.view"),
  asyncHandler(async (req, res) => {
    const { start, end } = parseRange(req.query);
    const sales = await prisma.sale.findMany({
      where: { saleDate: { gte: start, lte: end } },
      include: { lines: true },
    });

    const itemCostMap = new Map();
    const items = await prisma.item.findMany();
    items.forEach((item) => {
      itemCostMap.set(item.id, Number(item.purchasePrice));
    });

    const summary = { revenue: 0, cost: 0, grossProfit: 0, grossMarginPercent: 0 };
    const profitByItem = new Map();

    sales.forEach((sale) => {
      summary.revenue += Number(sale.subtotal);
      (sale.lines || []).forEach((line) => {
        const cost = itemCostMap.get(line.itemId) || 0;
        const lineCost = cost * Number(line.quantity);
        const lineProfit = Number(line.lineTotal) - lineCost;
        summary.cost += lineCost;
        summary.grossProfit += lineProfit;

        const key = line.itemId || line.itemName;
        const entry =
          profitByItem.get(key) || { itemId: line.itemId, itemName: line.itemName, quantity: 0, profit: 0 };
        entry.quantity += Number(line.quantity);
        entry.profit += lineProfit;
        profitByItem.set(key, entry);
      });
    });

    summary.grossMarginPercent =
      summary.revenue > 0 ? round2((summary.grossProfit / summary.revenue) * 100) : 0;

    res.json({
      data: {
        summary: {
          revenue: round2(summary.revenue),
          cost: round2(summary.cost),
          grossProfit: round2(summary.grossProfit),
          grossMarginPercent: summary.grossMarginPercent,
        },
        byItem: Array.from(profitByItem.values()).sort((a, b) => b.profit - a.profit),
      },
    });
  }),
);

router.get(
  "/stock",
  requirePermission("reports.view"),
  asyncHandler(async (req, res) => {
    const items = await prisma.item.findMany({ include: { category: true } });
    const lowStockItems = items.filter((item) => Number(item.currentStock) <= item.lowStockThreshold);
    const totalStockValue = items.reduce(
      (sum, item) => sum + Number(item.currentStock) * Number(item.purchasePrice),
      0,
    );
    res.json({
      data: {
        summary: {
          items: items.length,
          lowStockItems: lowStockItems.length,
          totalStockValue: round2(totalStockValue),
        },
        records: items.map((item) => ({
          itemId: item.id,
          itemName: item.name,
          category: item.category?.name || "-",
          currentStock: round3(item.currentStock),
          lowStockThreshold: item.lowStockThreshold,
          stockValue: round2(Number(item.currentStock) * Number(item.purchasePrice)),
        })),
      },
    });
  }),
);

router.get(
  "/gst",
  requirePermission("reports.view"),
  asyncHandler(async (req, res) => {
    const { start, end } = parseRange(req.query);
    const sales = await prisma.sale.findMany({ where: { saleDate: { gte: start, lte: end } } });
    const purchases = await prisma.purchase.findMany({ where: { purchaseDate: { gte: start, lte: end } } });
    const gstCollectedOnSales = sales.reduce((sum, row) => sum + Number(row.taxAmount), 0);
    const gstPaidOnPurchases = purchases.reduce((sum, row) => sum + Number(row.taxAmount), 0);
    const salesTaxableValue = sales.reduce((sum, row) => sum + Number(row.subtotal), 0);
    res.json({
      data: {
        gstCollectedOnSales: round2(gstCollectedOnSales),
        gstPaidOnPurchases: round2(gstPaidOnPurchases),
        netGstPayable: round2(gstCollectedOnSales - gstPaidOnPurchases),
        salesTaxableValue: round2(salesTaxableValue),
      },
    });
  }),
);

router.get(
  "/daybook",
  requirePermission("reports.view"),
  asyncHandler(async (req, res) => {
    const { start, end } = parseRange(req.query);
    const sales = await prisma.sale.findMany({ where: { saleDate: { gte: start, lte: end } } });
    const purchases = await prisma.purchase.findMany({ where: { purchaseDate: { gte: start, lte: end } } });
    const entries = await prisma.accountsEntry.findMany({ where: { entryDate: { gte: start, lte: end } } });

    const dayMap = new Map();
    const ensure = (date) => {
      if (!dayMap.has(date)) {
        dayMap.set(date, {
          date,
          sales: 0,
          purchases: 0,
          cashIn: 0,
          cashOut: 0,
          expenses: 0,
          bankDeposit: 0,
          cheque: 0,
          netCashMovement: 0,
        });
      }
      return dayMap.get(date);
    };

    sales.forEach((row) => {
      const date = dayjs(row.saleDate).format("YYYY-MM-DD");
      const bucket = ensure(date);
      bucket.sales += Number(row.totalAmount);
    });

    purchases.forEach((row) => {
      const date = dayjs(row.purchaseDate).format("YYYY-MM-DD");
      const bucket = ensure(date);
      bucket.purchases += Number(row.totalAmount);
    });

    entries.forEach((row) => {
      const date = dayjs(row.entryDate).format("YYYY-MM-DD");
      const bucket = ensure(date);
      if (row.type === "receipt") {
        bucket.cashIn += Number(row.amount);
        if (row.mode && row.mode !== "Cash") {
          if (String(row.mode).toLowerCase().includes("cheque")) {
            bucket.cheque += Number(row.amount);
          } else {
            bucket.bankDeposit += Number(row.amount);
          }
        }
      } else if (row.type === "payment") {
        bucket.cashOut += Number(row.amount);
        if (row.mode && row.mode !== "Cash") {
          if (String(row.mode).toLowerCase().includes("cheque")) {
            bucket.cheque += Number(row.amount);
          } else {
            bucket.bankDeposit += Number(row.amount);
          }
        }
      } else if (row.type === "expense") {
        bucket.expenses += Number(row.amount);
      }
    });

    const records = Array.from(dayMap.values()).map((row) => {
      const net = row.cashIn - row.cashOut - row.expenses;
      return {
        ...row,
        sales: round2(row.sales),
        purchases: round2(row.purchases),
        cashIn: round2(row.cashIn),
        cashOut: round2(row.cashOut),
        expenses: round2(row.expenses),
        bankDeposit: round2(row.bankDeposit),
        cheque: round2(row.cheque),
        netCashMovement: round2(net),
      };
    }).sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf());

    res.json({ data: { from: dayjs(start).format("YYYY-MM-DD"), to: dayjs(end).format("YYYY-MM-DD"), records } });
  }),
);

router.get(
  "/expiry",
  requirePermission("reports.view"),
  asyncHandler(async (req, res) => {
    res.json({ data: { summary: { totalLots: 0, expiredLots: 0 }, records: [] } });
  }),
);

module.exports = router;
