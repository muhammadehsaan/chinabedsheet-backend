const express = require("express");

const { prisma } = require("../db");
const { requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async");
const { calcLineTotals, round2, round3 } = require("../utils/money");

const router = express.Router();
const COUNTER_SALE_LABEL = "Counter Sale";
const normalizePartyValue = (value) => String(value || "").trim().replace(/\s+/g, " ");
const isCancelledPaymentMethod = (value) => normalizePartyValue(value).toLowerCase().includes("cancel");

const normalizeBankAmount = (value) => round2(value || 0);
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
const normalizePaymentMethodKey = (value) => normalizePartyValue(value).toLowerCase();
const normalizeOptionalDate = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const sumSalePayments = (payments = []) =>
  round2(payments.reduce((sum, entry) => sum + Number(entry.amount || 0), 0));
const stripPromiseDateToken = (value) =>
  String(value || "")
    .replace(/\|\s*\[PROMISE_DATE:[^\]]+\]/gi, "")
    .replace(/\[PROMISE_DATE:[^\]]+\]\s*\|/gi, "")
    .replace(/\[PROMISE_DATE:[^\]]+\]/gi, "")
    .replace(/\|\s*\|/g, "|")
    .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
    .trim();
const buildPromiseDateToken = (value) => {
  const promiseDate = normalizeOptionalDate(value);
  return promiseDate ? `[PROMISE_DATE:${promiseDate.toISOString().slice(0, 10)}]` : "";
};
const extractPromiseDateTokenValue = (value) => {
  const match = String(value || "").match(/\[PROMISE_DATE:([^\]]+)\]/i);
  return match ? match[1] : "";
};
const normalizeSalePayments = (payload = {}) => {
  const rows = Array.isArray(payload.payments) ? payload.payments : [];
  if (rows.length > 0) {
    return rows
      .map((entry) => {
        const method = normalizePaymentMethodKey(entry.method || "cash") || "cash";
        const amount = normalizeBankAmount(entry.amount || 0);
        const bankAccountId = entry.bankAccountId ? Number(entry.bankAccountId) : null;
        return {
          method,
          amount,
          bankAccountId: method === "bank" ? bankAccountId : null,
        };
      })
      .filter((entry) => entry.amount > 0);
  }

  const bankAccountId = payload.bankAccountId ? Number(payload.bankAccountId) : null;
  const bankAmount = normalizeBankAmount(payload.bankAmount || 0);
  if (bankAccountId && bankAmount > 0) {
    return [{ method: "bank", amount: bankAmount, bankAccountId }];
  }
  return [];
};
const getPersistedSalePayments = (sale = {}) => {
  const rows = Array.isArray(sale.payments) ? sale.payments : [];
  if (rows.length > 0) {
    return rows
      .map((entry) => ({
        method: normalizePaymentMethodKey(entry.method || "cash") || "cash",
        amount: normalizeBankAmount(entry.amount || 0),
        bankAccountId: entry.bankAccountId ? Number(entry.bankAccountId) : null,
      }))
      .filter((entry) => entry.amount > 0);
  }
  if (sale.bankAccountId && normalizeBankAmount(sale.bankAmount || 0) > 0) {
    return [{
      method: "bank",
      amount: normalizeBankAmount(sale.bankAmount || 0),
      bankAccountId: Number(sale.bankAccountId),
    }];
  }
  return [];
};
const validateSalePayments = (payments = []) =>
  payments.every((entry) => entry.method !== "bank" || Number(entry.bankAccountId || 0) > 0);
const summarizeLegacyBankFields = (payments = []) => {
  const bankRows = payments.filter((entry) => Number(entry.bankAccountId || 0) > 0 && Number(entry.amount || 0) > 0);
  const totalBankAmount = normalizeBankAmount(
    bankRows.reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
  );
  if (bankRows.length === 1) {
    return {
      bankAccountId: bankRows[0].bankAccountId,
      bankAmount: totalBankAmount,
    };
  }
  return {
    bankAccountId: null,
    bankAmount: totalBankAmount > 0 ? totalBankAmount : null,
  };
};
const adjustSalePaymentsBalance = async (tx, payments = [], direction = 1) => {
  for (const entry of payments) {
    if (!entry.bankAccountId || Number(entry.amount || 0) <= 0) {
      continue;
    }
    await adjustBankBalance(tx, entry.bankAccountId, Number(entry.amount || 0) * direction);
  }
};
const areSameSalePayments = (left = [], right = []) => {
  if (left.length !== right.length) {
    return false;
  }
  const serialize = (entry) =>
    `${normalizePaymentMethodKey(entry.method)}|${Number(entry.bankAccountId || 0)}|${normalizeBankAmount(entry.amount || 0)}`;
  const leftRows = [...left].map(serialize).sort();
  const rightRows = [...right].map(serialize).sort();
  return leftRows.every((entry, index) => entry === rightRows[index]);
};
const reduceBankPaymentsForReturn = (payments = [], returnAmount = 0) => {
  let remaining = normalizeBankAmount(returnAmount || 0);
  const nextPayments = payments.map((entry) => ({
    ...entry,
    amount: normalizeBankAmount(entry.amount || 0),
  }));
  for (let index = nextPayments.length - 1; index >= 0 && remaining > 0; index -= 1) {
    if (!nextPayments[index].bankAccountId || nextPayments[index].amount <= 0) {
      continue;
    }
    const deduction = Math.min(nextPayments[index].amount, remaining);
    nextPayments[index].amount = normalizeBankAmount(nextPayments[index].amount - deduction);
    remaining = normalizeBankAmount(remaining - deduction);
  }
  return nextPayments.filter((entry) => entry.amount > 0);
};

const findOrCreatePartyByType = async (db, name, preferredType) => {
  if (!name) {
    return null;
  }
  const existing = await db.party.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (existing) {
    if (existing.type !== preferredType && existing.type !== "BOTH") {
      return db.party.update({
        where: { id: existing.id },
        data: { type: "BOTH" },
      });
    }
    return existing;
  }
  return db.party.create({ data: { name, type: preferredType } });
};

const findOrCreateCustomer = async (db, payload = {}) => {
  const requestedCustomerId = Number(payload.customerId || 0);
  const customerName = normalizePartyValue(payload.customerName || payload.name);
  const customerPhone = normalizePartyValue(payload.customerPhone || payload.phone);
  const customerAddress = normalizePartyValue(payload.customerCity || payload.city || payload.address);

  if (!customerName && !requestedCustomerId) {
    return null;
  }

  let existingCustomer = null;
  if (requestedCustomerId) {
    existingCustomer = await db.party.findUnique({ where: { id: requestedCustomerId } });
  }

  if (!existingCustomer && customerName) {
    existingCustomer = await db.party.findFirst({
      where: { name: { equals: customerName, mode: "insensitive" } },
    });
  }

  if (!existingCustomer) {
    if (!customerName) {
      return null;
    }
    return db.party.create({
      data: {
        name: customerName,
        type: "CUSTOMER",
        phone: customerPhone || null,
        address: customerAddress || null,
      },
    });
  }

  const nextType =
    existingCustomer.type !== "CUSTOMER" && existingCustomer.type !== "BOTH"
      ? "BOTH"
      : existingCustomer.type;
  const nextName = customerName || existingCustomer.name;
  const nextPhone = customerPhone || existingCustomer.phone || null;
  const nextAddress = customerAddress || existingCustomer.address || null;
  const needsUpdate =
    nextType !== existingCustomer.type ||
    nextName !== existingCustomer.name ||
    nextPhone !== (existingCustomer.phone || null) ||
    nextAddress !== (existingCustomer.address || null);

  if (!needsUpdate) {
    return existingCustomer;
  }

  return db.party.update({
    where: { id: existingCustomer.id },
    data: {
      name: nextName,
      type: nextType,
      phone: nextPhone,
      address: nextAddress,
    },
  });
};

const resolveUnitPrice = (item, pricingMode, provided) => {
  if (provided !== undefined && provided !== null && provided !== "") {
    return round2(provided);
  }
  if (!item) {
    return 0;
  }
  if (pricingMode === "wholesale") {
    return round2(item.wholesalePrice);
  }
  if (pricingMode === "retail") {
    return round2(item.retailPrice);
  }
  if (pricingMode === "market") {
    return round2(item.marketPrice);
  }
  return round2(item.retailPrice || item.marketPrice || item.wholesalePrice || 0);
};

router.get(
  "/",
  requirePermission("sales.view"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.sale.findMany({
      include: {
        customer: true,
        bankAccount: true,
        payments: {
          include: {
            bankAccount: true,
          },
          orderBy: { id: "asc" },
        },
        lines: {
          include: {
            item: {
              select: {
                id: true,
                purchasePrice: true,
              },
            },
          },
        },
      },
      orderBy: { saleDate: "desc" },
    });
    res.json({ data: rows });
  }),
);

router.get(
  "/deals",
  requirePermission("sales.view"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.deal.findMany({ orderBy: { updatedAt: "desc" } });
    res.json({ data: rows });
  }),
);

router.post(
  "/deals",
  requirePermission("sales.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const name = String(payload.name || "").trim();
    if (!name) {
      return res.status(400).json({ message: "Deal name is required." });
    }
    const deal = await prisma.deal.create({
      data: {
        name,
        productsIncluded: payload.productsIncluded || null,
        price: round2(payload.price || 0),
        status: payload.status || "Active",
      },
    });
    res.status(201).json({ data: deal });
  }),
);

router.get(
  "/audit",
  requirePermission("sales.view"),
  asyncHandler(async (req, res) => {
    const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ data: logs });
  }),
);

router.post(
  "/",
  requirePermission("sales.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const saleDate = payload.saleDate ? new Date(payload.saleDate) : new Date();
    const customerName = String(payload.customerName || "").trim();
    const lines = Array.isArray(payload.items) ? payload.items : [];
    const pricingMode = payload.pricingMode || "market";
    const paymentMethod = payload.paymentMethod || "Cash";
    const salesmanName = String(payload.userName || "").trim();
    const salePayments = normalizeSalePayments(payload);
    if (!validateSalePayments(salePayments)) {
      return res.status(400).json({ message: "Each bank payment row needs a valid registered bank." });
    }
    const { bankAccountId, bankAmount } = summarizeLegacyBankFields(salePayments);
    const isHoldSale = String(paymentMethod).toLowerCase().includes("hold");
    const isEmiSale = String(paymentMethod).toLowerCase().includes("emi");
    const deliveryPolicy = String(payload.deliveryPolicy || "BEFORE_PAYMENT").toUpperCase();
    const isDeliverAfterPayment = isEmiSale && deliveryPolicy === "AFTER_PAYMENT";
    const deliveryNote = isEmiSale
      ? isDeliverAfterPayment
        ? "Delivery pending until payment completion."
        : "Delivered before payment completion."
      : "";
    const counterSaleNote = !customerName ? "Counter sale invoice." : "";
    const baseNotes = stripPromiseDateToken(String(payload.notes || "").trim());

    if (lines.length === 0) {
      return res.status(400).json({ message: "At least one line item is required." });
    }

    const customer = customerName
      ? await findOrCreateCustomer(prisma, payload)
      : null;

    let subtotal = 0;
    let taxAmount = 0;
    let totalAmount = 0;
    let totalCommission = 0;
    const preparedLines = [];

    for (const line of lines) {
      const itemId = line.itemId ? Number(line.itemId) : null;
      const item =
        itemId !== null
          ? await prisma.item.findUnique({ where: { id: itemId } })
          : line.itemName
            ? await prisma.item.findFirst({
                where: { name: { equals: line.itemName, mode: "insensitive" } },
              })
            : null;

      const quantity = round3(line.quantity || 0);
      const unitPrice = resolveUnitPrice(item, pricingMode, line.unitPrice);
      const taxPercent = round2(line.taxPercent || line.gstPercent || 0);
      const totals = calcLineTotals(quantity, unitPrice, taxPercent);
      const commissionPercent = Number(line.commissionPercent ?? item?.commissionPercent ?? 0);
      const commissionAmount = Number(line.commissionAmount ?? item?.commissionAmount ?? 0);
      const lineCommission = round2(
        totals.total * (commissionPercent / 100) + quantity * commissionAmount,
      );

      subtotal += totals.base;
      taxAmount += totals.tax;
      totalAmount += totals.total;
      totalCommission += lineCommission;

      preparedLines.push({
        itemId: item ? item.id : null,
        itemName: line.itemName || item?.name || "Product",
        quantity,
        unitPrice,
        taxPercent,
        taxAmount: totals.tax,
        lineTotal: totals.total,
      });
    }
    const totalPaidAmount = sumSalePayments(salePayments);
    const remainingAmount = Math.max(0, round2(totalAmount - totalPaidAmount));
    const promiseDate = normalizeOptionalDate(payload.promiseDate);
    const isCreditSale = !isHoldSale && !isEmiSale && Boolean(customer?.id) && remainingAmount > 0;
    if (isCreditSale && !promiseDate) {
      return res.status(400).json({ message: "Please enter promise date." });
    }
    if (payload.promiseDate && !promiseDate) {
      return res.status(400).json({ message: "Invalid promise date." });
    }
    const promiseDateToken = isCreditSale ? buildPromiseDateToken(promiseDate) : "";
    const mergedNotes = [baseNotes, counterSaleNote, deliveryNote, promiseDateToken].filter(Boolean).join(" | ") || null;

    const sale = await prisma.$transaction(async (tx) => {
      const record = await tx.sale.create({
        data: {
          invoiceNo: payload.invoiceNo || null,
          saleDate,
          paymentMethod,
          notes: mergedNotes,
          customerId: customer ? customer.id : null,
          bankAccountId,
          bankAmount: bankAmount > 0 ? bankAmount : null,
          pricingMode,
          language: payload.language || "EN",
          subtotal: round2(subtotal),
          taxAmount: round2(taxAmount),
          totalAmount: round2(totalAmount),
          promiseDate: isCreditSale ? promiseDate : null,
          loyaltyPoints: Math.floor(totalAmount / 1000),
          lines: {
            create: preparedLines,
          },
          payments: salePayments.length > 0
            ? {
                create: salePayments.map((entry) => ({
                  method: entry.method,
                  amount: round2(entry.amount),
                  bankAccountId: entry.bankAccountId || null,
                })),
              }
            : undefined,
        },
        include: { lines: true, customer: true, bankAccount: true, payments: true },
      });

      if (isEmiSale) {
        await tx.delivery.create({
          data: {
            saleId: record.id,
            status: isDeliverAfterPayment ? "Pending Payment" : "Delivered",
            notes: isDeliverAfterPayment
              ? "Deliver after payment. [PENDING_STOCK_DEDUCTION]"
              : "Delivered before payment.",
          },
        });
      }

      await tx.auditLog.create({
        data: {
          entity: "sale",
          action: "CREATE",
          refNo: record.invoiceNo || String(record.id),
          userName: payload.userName || "System",
        },
      });

      if (salesmanName && !isHoldSale && round2(totalCommission) > 0) {
        const salesmanParty = await findOrCreatePartyByType(tx, salesmanName, "SALESMAN");
        await tx.accountsEntry.create({
          data: {
            entryDate: saleDate,
            type: "payment",
            amount: round2(totalCommission),
            mode: "Commission",
            description: `Sales commission - Invoice ${record.invoiceNo || `SA-${record.id}`}`,
            partyId: salesmanParty.id,
          },
        });
      }

      if (isDeliverAfterPayment) {
        await adjustSalePaymentsBalance(tx, salePayments, 1);
        return record;
      }

      for (const line of record.lines) {
        if (!line.itemId) {
          continue;
        }
        const item = await tx.item.findUnique({ where: { id: line.itemId } });
        if (!item) {
          continue;
        }
        await tx.item.update({
          where: { id: line.itemId },
          data: {
            currentStock: round3(Number(item.currentStock) - Number(line.quantity)),
          },
        });
      }

      await adjustSalePaymentsBalance(tx, salePayments, 1);

      return record;
    });

    res.status(201).json({ data: sale });
  }),
);

router.patch(
  "/:id/clear-hold",
  requirePermission("sales.edit"),
  asyncHandler(async (req, res) => {
    const rawRef = String(req.params.id || "").trim();
    const payload = req.body || {};
    const numericId = Number(rawRef);

    let sale =
      Number.isFinite(numericId) && numericId > 0
        ? await prisma.sale.findUnique({ where: { id: numericId } })
        : null;

    if (!sale && rawRef) {
      sale = await prisma.sale.findFirst({
        where: { invoiceNo: { equals: rawRef, mode: "insensitive" } },
      });
    }

    const invoiceRef = String(payload.invoiceNo || "").trim();
    if (!sale && invoiceRef) {
      sale = await prisma.sale.findFirst({
        where: { invoiceNo: { equals: invoiceRef, mode: "insensitive" } },
      });
    }

    if (!sale) {
      return res.status(404).json({ message: "Hold invoice not found." });
    }

    const paymentMethod = String(payload.paymentMethod || "Cash").trim() || "Cash";
    const clearNote = String(payload.notes || "").trim();
    const nextNotes = [String(sale.notes || "").trim(), clearNote].filter(Boolean).join(" | ") || null;

    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.sale.update({
        where: { id: sale.id },
        data: {
          paymentMethod,
          notes: nextNotes,
        },
        include: {
          customer: true,
          lines: {
            include: {
              item: {
                select: {
                  id: true,
                  purchasePrice: true,
                },
              },
            },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          entity: "sale",
          action: "CLEAR_HOLD",
          refNo: record.invoiceNo || String(record.id),
          userName: payload.userName || "System",
        },
      });

      return record;
    });

    res.json({ data: updated });
  }),
);

router.patch(
  "/:id",
  requirePermission("sales.edit"),
  asyncHandler(async (req, res) => {
    const saleId = Number(req.params.id);
    if (!saleId || Number.isNaN(saleId)) {
      return res.status(400).json({ message: "Invalid sale id." });
    }

    const existingSale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: { customer: true, lines: true, deliveries: true, payments: true },
    });
    if (!existingSale) {
      return res.status(404).json({ message: "Sale not found." });
    }
    if (isCancelledPaymentMethod(existingSale.paymentMethod)) {
      return res.status(400).json({ message: "Cancelled invoice cannot be edited." });
    }

    const payload = req.body || {};
    const lines = Array.isArray(payload.items) ? payload.items : [];
    if (lines.length === 0) {
      return res.status(400).json({ message: "At least one line item is required." });
    }

    const saleDate = payload.saleDate ? new Date(payload.saleDate) : existingSale.saleDate;
    if (Number.isNaN(saleDate.getTime())) {
      return res.status(400).json({ message: "Invalid sale date." });
    }

    const resolvedCustomerName =
      payload.customerName !== undefined
        ? String(payload.customerName || "").trim()
        : String(existingSale.customer?.name || "").trim();

    const pricingMode = payload.pricingMode || existingSale.pricingMode || "market";
    const customer = resolvedCustomerName
      ? await findOrCreateCustomer(prisma, {
          customerId:
            payload.customerId !== undefined ? payload.customerId : existingSale.customerId,
          customerName: resolvedCustomerName,
          customerPhone:
            payload.customerPhone !== undefined
              ? payload.customerPhone
              : existingSale.customer?.phone,
          customerCity:
            payload.customerCity !== undefined
              ? payload.customerCity
              : existingSale.customer?.address,
        })
      : null;
    const existingPayments = getPersistedSalePayments(existingSale);
    const requestedPayments =
      Array.isArray(payload.payments) || payload.bankAccountId !== undefined || payload.bankAmount !== undefined
        ? normalizeSalePayments(payload)
        : existingPayments;
    if (!validateSalePayments(requestedPayments)) {
      return res.status(400).json({ message: "Each bank payment row needs a valid registered bank." });
    }
    const counterSaleNote = !resolvedCustomerName ? "Counter sale invoice." : "";

    let subtotal = 0;
    let taxAmount = 0;
    let totalAmount = 0;
    const preparedLines = [];

    for (const line of lines) {
      const itemId = line.itemId ? Number(line.itemId) : null;
      const item =
        itemId !== null
          ? await prisma.item.findUnique({ where: { id: itemId } })
          : line.itemName
            ? await prisma.item.findFirst({
                where: { name: { equals: line.itemName, mode: "insensitive" } },
              })
            : null;

      const quantity = round3(line.quantity || 0);
      const unitPrice = resolveUnitPrice(item, pricingMode, line.unitPrice);
      const taxPercent = round2(line.taxPercent || line.gstPercent || 0);
      const totals = calcLineTotals(quantity, unitPrice, taxPercent);

      subtotal += totals.base;
      taxAmount += totals.tax;
      totalAmount += totals.total;

      preparedLines.push({
        itemId: item ? item.id : null,
        itemName: line.itemName || item?.name || "Product",
        quantity,
        unitPrice,
        taxPercent,
        taxAmount: totals.tax,
        lineTotal: totals.total,
      });
    }
    const totalPaidAmount = sumSalePayments(requestedPayments);
    const remainingAmount = Math.max(0, round2(totalAmount - totalPaidAmount));
    const paymentMethod =
      payload.paymentMethod !== undefined
        ? payload.paymentMethod || "Cash"
        : existingSale.paymentMethod || "Cash";
    const isHoldSale = String(paymentMethod).toLowerCase().includes("hold");
    const isEmiSale = String(paymentMethod).toLowerCase().includes("emi");
    const promiseDate = normalizeOptionalDate(
      payload.promiseDate !== undefined
        ? payload.promiseDate
        : existingSale.promiseDate || extractPromiseDateTokenValue(existingSale.notes),
    );
    const isCreditSale = !isHoldSale && !isEmiSale && Boolean(customer?.id) && remainingAmount > 0;
    if (isCreditSale && !promiseDate) {
      return res.status(400).json({ message: "Please enter promise date." });
    }
    if (payload.promiseDate !== undefined && payload.promiseDate && !promiseDate) {
      return res.status(400).json({ message: "Invalid promise date." });
    }
    const promiseDateToken = isCreditSale ? buildPromiseDateToken(promiseDate) : "";
    const existingNotesWithoutPromise = stripPromiseDateToken(existingSale.notes || "");
    const nextNotesWithoutPromise = stripPromiseDateToken(
      String(payload.notes !== undefined ? payload.notes : existingNotesWithoutPromise).trim(),
    );
    const returnAmount = Math.max(0, round2(Number(existingSale.totalAmount || 0) - Number(totalAmount || 0)));
    const shouldAutoRefundReturnFromBank =
      existingPayments.some((entry) => Number(entry.bankAccountId || 0) > 0) &&
      returnAmount > 0 &&
      areSameSalePayments(requestedPayments, existingPayments);
    const effectivePayments = shouldAutoRefundReturnFromBank
      ? reduceBankPaymentsForReturn(requestedPayments, returnAmount)
      : requestedPayments;
    const { bankAccountId, bankAmount: effectiveBankAmount } = summarizeLegacyBankFields(effectivePayments);

    const updatedSale = await prisma.$transaction(async (tx) => {
      const hasPendingStockDeduction = (existingSale.deliveries || []).some((delivery) =>
        String(delivery.notes || "").includes("[PENDING_STOCK_DEDUCTION]"),
      );
      await adjustSalePaymentsBalance(tx, existingPayments, -1);

      if (!hasPendingStockDeduction) {
        for (const oldLine of existingSale.lines) {
          if (!oldLine.itemId) {
            continue;
          }
          const stockItem = await tx.item.findUnique({ where: { id: oldLine.itemId } });
          if (!stockItem) {
            continue;
          }
          await tx.item.update({
            where: { id: oldLine.itemId },
            data: {
              currentStock: round3(Number(stockItem.currentStock) + Number(oldLine.quantity)),
            },
          });
        }
      }

      await tx.saleLine.deleteMany({ where: { saleId } });
      await tx.salePayment.deleteMany({ where: { saleId } });

      const record = await tx.sale.update({
        where: { id: saleId },
        data: {
          invoiceNo: payload.invoiceNo !== undefined ? payload.invoiceNo || null : existingSale.invoiceNo,
          saleDate,
          paymentMethod,
          notes:
            [nextNotesWithoutPromise, counterSaleNote, promiseDateToken]
              .filter(Boolean)
              .join(" | ") || null,
          customerId: customer ? customer.id : null,
          bankAccountId,
          bankAmount: effectiveBankAmount > 0 ? effectiveBankAmount : null,
          pricingMode,
          language: payload.language || existingSale.language || "EN",
          subtotal: round2(subtotal),
          taxAmount: round2(taxAmount),
          totalAmount: round2(totalAmount),
          promiseDate: isCreditSale ? promiseDate : null,
          loyaltyPoints: Math.floor(totalAmount / 1000),
          lines: {
            create: preparedLines,
          },
          payments: effectivePayments.length > 0
            ? {
                create: effectivePayments.map((entry) => ({
                  method: entry.method,
                  amount: round2(entry.amount),
                  bankAccountId: entry.bankAccountId || null,
                })),
              }
            : undefined,
        },
        include: { lines: true, customer: true, bankAccount: true, payments: true },
      });

      if (!hasPendingStockDeduction) {
        for (const newLine of record.lines) {
          if (!newLine.itemId) {
            continue;
          }
          const stockItem = await tx.item.findUnique({ where: { id: newLine.itemId } });
          if (!stockItem) {
            continue;
          }
          await tx.item.update({
            where: { id: newLine.itemId },
            data: {
              currentStock: round3(Number(stockItem.currentStock) - Number(newLine.quantity)),
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          entity: "sale",
          action: "UPDATE",
          refNo: record.invoiceNo || String(record.id),
          userName: payload.userName || "System",
        },
      });

      await adjustSalePaymentsBalance(tx, effectivePayments, 1);

      return record;
    });

    res.json({ data: updatedSale });
  }),
);

router.post(
  "/:id/cancel",
  requirePermission("sales.delete"),
  asyncHandler(async (req, res) => {
    const saleId = Number(req.params.id);
    if (!saleId || Number.isNaN(saleId)) {
      return res.status(400).json({ message: "Invalid sale id." });
    }

    const existingSale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: { customer: true, lines: true, deliveries: true, bankAccount: true, payments: true },
    });
    if (!existingSale) {
      return res.status(404).json({ message: "Sale not found." });
    }
    if (isCancelledPaymentMethod(existingSale.paymentMethod)) {
      return res.status(400).json({ message: "Invoice is already cancelled." });
    }

    const payload = req.body || {};
    const cancelReason = String(payload.reason || "Invoice cancelled.").trim();
    const existingPayments = getPersistedSalePayments(existingSale);

    const cancelledSale = await prisma.$transaction(async (tx) => {
      const hasPendingStockDeduction = (existingSale.deliveries || []).some((delivery) =>
        String(delivery.notes || "").includes("[PENDING_STOCK_DEDUCTION]"),
      );

      if (!hasPendingStockDeduction) {
        for (const oldLine of existingSale.lines) {
          if (!oldLine.itemId) {
            continue;
          }
          const stockItem = await tx.item.findUnique({ where: { id: oldLine.itemId } });
          if (!stockItem) {
            continue;
          }
          await tx.item.update({
            where: { id: oldLine.itemId },
            data: {
              currentStock: round3(Number(stockItem.currentStock) + Number(oldLine.quantity)),
            },
          });
        }
      }

      await adjustSalePaymentsBalance(tx, existingPayments, -1);

      if ((existingSale.deliveries || []).length > 0) {
        await tx.delivery.updateMany({
          where: { saleId },
          data: {
            status: "Cancelled",
            notes: [cancelReason, "Invoice cancelled."].filter(Boolean).join(" | "),
          },
        });
      }

      const record = await tx.sale.update({
        where: { id: saleId },
        data: {
          paymentMethod: "Cancelled",
          notes: [String(existingSale.notes || "").trim(), cancelReason, "[CANCELLED]"]
            .filter(Boolean)
            .join(" | "),
          bankAccountId: null,
          bankAmount: null,
          subtotal: 0,
          taxAmount: 0,
          totalAmount: 0,
          promiseDate: null,
          loyaltyPoints: 0,
        },
        include: { customer: true, lines: true, bankAccount: true, payments: true },
      });

      await tx.auditLog.create({
        data: {
          entity: "sale",
          action: "CANCEL",
          refNo: record.invoiceNo || String(record.id),
          userName: payload.userName || "System",
        },
      });

      return record;
    });

    res.json({ data: cancelledSale });
  }),
);

module.exports = router;
