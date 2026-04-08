const express = require("express");

const { prisma } = require("../db");
const { requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async");
const { round2 } = require("../utils/money");

const router = express.Router();

const normalizeAccountNumber = (value) => String(value || "").replace(/\s+/g, "").trim();
const buildBankEntryRef = (bankId) => `BANK:${Number(bankId || 0)}`;
const buildStatementRefNo = (entry) => String(entry.mode || "BANK").toUpperCase().replace(/\s+/g, "-") + `-${entry.id}`;
const normalizeOptionalDate = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

router.get(
  "/banks",
  requirePermission("accounts.view"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.bankAccount.findMany({
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });
    res.json({ data: rows });
  }),
);

router.get(
  "/banks/:id/history",
  requirePermission("accounts.view"),
  asyncHandler(async (req, res) => {
    const bankId = Number(req.params.id);
    if (!bankId) {
      return res.status(400).json({ message: "Valid bank id is required." });
    }

    const bank = await prisma.bankAccount.findUnique({
      where: { id: bankId },
      include: {
        salePayments: {
          include: {
            sale: {
              include: {
                customer: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        sales: {
          include: {
            customer: {
              select: {
                name: true,
              },
            },
            payments: {
              select: {
                id: true,
              },
            },
          },
          orderBy: { saleDate: "asc" },
        },
        purchases: {
          include: {
            supplier: {
              select: {
                name: true,
              },
            },
          },
          orderBy: { purchaseDate: "asc" },
        },
      },
    });
    const manualEntries = await prisma.accountsEntry.findMany({
      where: {
        bankName: buildBankEntryRef(bankId),
      },
      orderBy: { entryDate: "asc" },
    });

    if (!bank) {
      return res.status(404).json({ message: "Bank account not found." });
    }

    const timeline = [
      ...(bank.salePayments || []).map((entry) => ({
        id: `sale-payment-${entry.id}`,
        date: entry.sale?.saleDate || entry.createdAt,
        refNo: entry.sale?.invoiceNo || `SA-${entry.saleId}`,
        module: "Sale",
        description: entry.sale?.customer?.name
          ? `Sale received from ${entry.sale.customer.name}`
          : "Counter sale received",
        inAmount: round2(entry.amount || 0),
        outAmount: 0,
      })),
      ...(bank.sales || [])
        .filter((sale) => !(sale.payments || []).length && Number(sale.bankAmount || 0) > 0)
        .map((sale) => ({
        id: `sale-${sale.id}`,
        date: sale.saleDate,
        refNo: sale.invoiceNo || `SA-${sale.id}`,
        module: "Sale",
        description: sale.customer?.name
          ? `Sale received from ${sale.customer.name}`
          : "Counter sale received",
        inAmount: round2(sale.bankAmount || 0),
        outAmount: 0,
      })),
      ...(bank.purchases || []).map((purchase) => ({
        id: `purchase-${purchase.id}`,
        date: purchase.purchaseDate,
        refNo: purchase.invoiceNo || purchase.billNo || `PU-${purchase.id}`,
        module: "Purchase",
        description: purchase.supplier?.name
          ? `Purchase payment to ${purchase.supplier.name}`
          : "Purchase payment",
        inAmount: 0,
        outAmount: round2(purchase.bankAmount || 0),
      })),
      ...manualEntries.map((entry) => ({
        id: `manual-${entry.id}`,
        date: entry.entryDate || entry.createdAt,
        refNo: buildStatementRefNo(entry),
        module: "Bank",
        description: entry.description || entry.mode || "Bank transaction",
        inAmount:
          String(entry.type || "").toLowerCase() === "payment"
            ? 0
            : round2(entry.amount || 0),
        outAmount:
          String(entry.type || "").toLowerCase() === "payment"
            ? round2(entry.amount || 0)
            : 0,
      })),
    ].sort((left, right) => {
      const leftTime = new Date(left.date || 0).getTime();
      const rightTime = new Date(right.date || 0).getTime();
      return leftTime - rightTime;
    });

    let runningBalance = round2(bank.openingBalance || 0);
    const entries = [
      {
        id: "opening-balance",
        date: bank.openingDate || bank.createdAt,
        refNo: "Opening",
        module: "Opening",
        description: "Opening balance",
        inAmount: round2(bank.openingBalance || 0),
        outAmount: 0,
        balance: runningBalance,
      },
      ...timeline.map((entry) => {
        runningBalance = round2(runningBalance + Number(entry.inAmount || 0) - Number(entry.outAmount || 0));
        return {
          ...entry,
          balance: runningBalance,
        };
      }),
    ];

    const totalIn = round2(
      timeline.reduce((sum, entry) => sum + Number(entry.inAmount || 0), 0),
    );
    const totalOut = round2(
      timeline.reduce((sum, entry) => sum + Number(entry.outAmount || 0), 0),
    );

    res.json({
      data: {
        bank: {
          id: bank.id,
          bankName: bank.bankName,
          accountTitle: bank.accountTitle,
          accountNumber: bank.accountNumber,
          openingBalance: bank.openingBalance,
          currentBalance: bank.currentBalance,
          openingDate: bank.openingDate,
          status: bank.status,
        },
        summary: {
          openingBalance: round2(bank.openingBalance || 0),
          totalIn,
          totalOut,
          currentBalance: round2(bank.currentBalance || 0),
        },
        entries,
      },
    });
  }),
);

router.post(
  "/banks/transactions",
  requirePermission("accounts.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const transactionType = String(payload.type || "").trim().toUpperCase();
    const amount = round2(payload.amount || 0);
    const sourceBankId = Number(payload.bankAccountId || 0);
    const targetBankId = Number(payload.targetBankAccountId || 0);
    const entryDate = normalizeOptionalDate(payload.entryDate) || new Date();
    const reference = String(payload.reference || "").trim();
    const note = String(payload.notes || "").trim();

    if (!["DEPOSIT", "WITHDRAW", "TRANSFER"].includes(transactionType)) {
      return res.status(400).json({ message: "Valid transaction type is required." });
    }
    if (!sourceBankId) {
      return res.status(400).json({ message: "Please select a bank account." });
    }
    if (amount <= 0) {
      return res.status(400).json({ message: "Amount must be greater than zero." });
    }
    if (transactionType === "TRANSFER" && !targetBankId) {
      return res.status(400).json({ message: "Please select destination bank." });
    }
    if (transactionType === "TRANSFER" && sourceBankId === targetBankId) {
      return res.status(400).json({ message: "Source and destination bank must be different." });
    }
    if (payload.entryDate && !normalizeOptionalDate(payload.entryDate)) {
      return res.status(400).json({ message: "Invalid transaction date." });
    }

    const [sourceBank, targetBank] = await Promise.all([
      prisma.bankAccount.findUnique({ where: { id: sourceBankId } }),
      targetBankId ? prisma.bankAccount.findUnique({ where: { id: targetBankId } }) : Promise.resolve(null),
    ]);

    if (!sourceBank) {
      return res.status(404).json({ message: "Selected bank account not found." });
    }
    if (transactionType === "TRANSFER" && !targetBank) {
      return res.status(404).json({ message: "Destination bank account not found." });
    }
    if (["WITHDRAW", "TRANSFER"].includes(transactionType) && Number(sourceBank.currentBalance || 0) < amount) {
      return res.status(400).json({ message: "Insufficient balance in selected bank." });
    }

    const defaultReference = `${transactionType}-${Date.now()}`;
    const resolvedReference = reference || defaultReference;

    const result = await prisma.$transaction(async (tx) => {
      const updateBankBalance = async (bankId, deltaAmount) => {
        const bank = await tx.bankAccount.findUnique({ where: { id: bankId } });
        if (!bank) {
          throw new Error("BANK_NOT_FOUND");
        }
        return tx.bankAccount.update({
          where: { id: bankId },
          data: {
            currentBalance: round2(Number(bank.currentBalance || 0) + Number(deltaAmount || 0)),
          },
        });
      };

      if (transactionType === "DEPOSIT") {
        const updatedBank = await updateBankBalance(sourceBankId, amount);
        const entry = await tx.accountsEntry.create({
          data: {
            entryDate,
            type: "receipt",
            amount,
            mode: "Deposit",
            bankName: buildBankEntryRef(sourceBankId),
            description: `${resolvedReference}${note ? ` | ${note}` : ""}`,
          },
        });
        return { type: transactionType, sourceBank: updatedBank, targetBank: null, entries: [entry] };
      }

      if (transactionType === "WITHDRAW") {
        const updatedBank = await updateBankBalance(sourceBankId, -amount);
        const entry = await tx.accountsEntry.create({
          data: {
            entryDate,
            type: "payment",
            amount,
            mode: "Withdraw",
            bankName: buildBankEntryRef(sourceBankId),
            description: `${resolvedReference}${note ? ` | ${note}` : ""}`,
          },
        });
        return { type: transactionType, sourceBank: updatedBank, targetBank: null, entries: [entry] };
      }

      const updatedSourceBank = await updateBankBalance(sourceBankId, -amount);
      const updatedTargetBank = await updateBankBalance(targetBankId, amount);
      const transferOutEntry = await tx.accountsEntry.create({
        data: {
          entryDate,
          type: "payment",
          amount,
          mode: "Transfer Out",
          bankName: buildBankEntryRef(sourceBankId),
          description: `${resolvedReference} | Transfer to ${targetBank.bankName}${note ? ` | ${note}` : ""}`,
        },
      });
      const transferInEntry = await tx.accountsEntry.create({
        data: {
          entryDate,
          type: "receipt",
          amount,
          mode: "Transfer In",
          bankName: buildBankEntryRef(targetBankId),
          description: `${resolvedReference} | Transfer from ${sourceBank.bankName}${note ? ` | ${note}` : ""}`,
        },
      });
      return {
        type: transactionType,
        sourceBank: updatedSourceBank,
        targetBank: updatedTargetBank,
        entries: [transferOutEntry, transferInEntry],
      };
    });

    res.status(201).json({ data: result });
  }),
);

router.post(
  "/banks",
  requirePermission("accounts.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const bankName = String(payload.bankName || "").trim();
    const accountTitle = String(payload.accountTitle || "").trim();
    const accountNumber = normalizeAccountNumber(payload.accountNumber);

    if (!bankName) {
      return res.status(400).json({ message: "Bank name is required." });
    }
    if (!accountTitle) {
      return res.status(400).json({ message: "Account title is required." });
    }
    if (!accountNumber) {
      return res.status(400).json({ message: "Account number is required." });
    }

    const existing = await prisma.bankAccount.findUnique({
      where: { accountNumber },
    });
    if (existing) {
      return res.status(400).json({ message: "This account number is already registered." });
    }

    const openingDate = payload.openingDate ? new Date(payload.openingDate) : null;
    if (payload.openingDate && Number.isNaN(openingDate.getTime())) {
      return res.status(400).json({ message: "Invalid opening date." });
    }

    const record = await prisma.bankAccount.create({
      data: {
        bankName,
        accountTitle,
        accountNumber,
        openingBalance: round2(payload.openingBalance || 0),
        currentBalance: round2(payload.openingBalance || 0),
        openingDate,
        branchName: String(payload.branchName || "").trim() || null,
        accountType: String(payload.accountType || "CURRENT").trim().toUpperCase(),
        iban: String(payload.iban || "").trim() || null,
        notes: String(payload.notes || "").trim() || null,
        status: String(payload.status || "Active").trim() || "Active",
      },
    });

    res.status(201).json({ data: record });
  }),
);

router.patch(
  "/banks/:id",
  requirePermission("accounts.edit"),
  asyncHandler(async (req, res) => {
    const bankId = Number(req.params.id);
    if (!bankId) {
      return res.status(400).json({ message: "Valid bank id is required." });
    }

    const existing = await prisma.bankAccount.findUnique({ where: { id: bankId } });
    if (!existing) {
      return res.status(404).json({ message: "Bank account not found." });
    }

    const payload = req.body || {};
    const bankName = String(payload.bankName ?? existing.bankName).trim();
    const accountTitle = String(payload.accountTitle ?? existing.accountTitle).trim();
    const accountNumber = normalizeAccountNumber(payload.accountNumber ?? existing.accountNumber);

    if (!bankName) {
      return res.status(400).json({ message: "Bank name is required." });
    }
    if (!accountTitle) {
      return res.status(400).json({ message: "Account title is required." });
    }
    if (!accountNumber) {
      return res.status(400).json({ message: "Account number is required." });
    }

    const duplicate = await prisma.bankAccount.findFirst({
      where: {
        accountNumber,
        NOT: { id: bankId },
      },
    });
    if (duplicate) {
      return res.status(400).json({ message: "This account number is already registered." });
    }

    const openingDate = payload.openingDate
      ? new Date(payload.openingDate)
      : payload.openingDate === null
        ? null
        : existing.openingDate;
    if (payload.openingDate && Number.isNaN(openingDate.getTime())) {
      return res.status(400).json({ message: "Invalid opening date." });
    }

    const record = await prisma.bankAccount.update({
      where: { id: bankId },
      data: {
        bankName,
        accountTitle,
        accountNumber,
        openingBalance:
          payload.openingBalance !== undefined
            ? round2(payload.openingBalance || 0)
            : existing.openingBalance,
        currentBalance:
          payload.openingBalance !== undefined
            ? round2(Number(existing.currentBalance || 0) - Number(existing.openingBalance || 0) + Number(payload.openingBalance || 0))
            : existing.currentBalance,
        openingDate,
        branchName:
          payload.branchName !== undefined
            ? String(payload.branchName || "").trim() || null
            : existing.branchName,
        accountType:
          payload.accountType !== undefined
            ? String(payload.accountType || "CURRENT").trim().toUpperCase()
            : existing.accountType,
        iban:
          payload.iban !== undefined
            ? String(payload.iban || "").trim() || null
            : existing.iban,
        notes:
          payload.notes !== undefined
            ? String(payload.notes || "").trim() || null
            : existing.notes,
        status:
          payload.status !== undefined
            ? String(payload.status || "Active").trim() || "Active"
            : existing.status,
      },
    });

    res.json({ data: record });
  }),
);

module.exports = router;
