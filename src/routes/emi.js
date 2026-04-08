const express = require("express");
const dayjs = require("dayjs");

const { prisma } = require("../db");
const { requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async");
const { round2 } = require("../utils/money");

const router = express.Router();

const findOrCreateCustomer = async (name) => {
  if (!name) {
    return null;
  }
  const existing = await prisma.party.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (existing) {
    if (existing.type !== "CUSTOMER" && existing.type !== "BOTH") {
      return prisma.party.update({
        where: { id: existing.id },
        data: { type: "BOTH" },
      });
    }
    return existing;
  }
  return prisma.party.create({ data: { name, type: "CUSTOMER" } });
};

router.get(
  "/",
  requirePermission("emi.view"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.eMIAccount.findMany({
      include: { customer: true, schedules: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: rows });
  }),
);

router.post(
  "/",
  requirePermission("emi.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const totalAmount = round2(payload.totalAmount || 0);
    const installmentsCount = Number(payload.installmentsCount || 0);
    const startDate = payload.startDate ? dayjs(payload.startDate) : dayjs();
    const customer = payload.customerId
      ? await prisma.party.findUnique({ where: { id: Number(payload.customerId) } })
      : await findOrCreateCustomer(payload.customerName);

    if (!customer) {
      return res.status(400).json({ message: "Customer is required." });
    }
    if (!installmentsCount || installmentsCount <= 0) {
      return res.status(400).json({ message: "Installments count is required." });
    }

    const installmentAmount = round2(totalAmount / installmentsCount);
    const schedules = Array.from({ length: installmentsCount }).map((_, index) => ({
      dueDate: startDate.add(index, "month").toDate(),
      amount: installmentAmount,
    }));

    const record = await prisma.eMIAccount.create({
      data: {
        customerId: customer.id,
        totalAmount,
        installmentsCount,
        startDate: startDate.toDate(),
        status: "Active",
        penaltyPercent: round2(payload.penaltyPercent || 0),
        schedules: {
          create: schedules,
        },
      },
      include: { schedules: true, customer: true },
    });

    res.status(201).json({ data: record });
  }),
);

router.patch(
  "/:id/pay",
  requirePermission("emi.edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const payload = req.body || {};
    const amount = round2(payload.amount || 0);
    const now = new Date();

    const emi = await prisma.eMIAccount.findUnique({
      where: { id },
      include: { schedules: true },
    });
    if (!emi) {
      return res.status(404).json({ message: "EMI not found." });
    }

    const pending = emi.schedules.find((s) => s.status === "Pending");
    if (!pending) {
      return res.status(400).json({ message: "No pending installment found." });
    }

    if (amount !== Number(pending.amount)) {
      return res.status(400).json({ message: "Amount does not match installment." });
    }

    const updated = await prisma.eMISchedule.update({
      where: { id: pending.id },
      data: { status: "Paid", paidAt: now },
    });

    res.json({ data: updated });
  }),
);

router.patch(
  "/:id/penalty",
  requirePermission("emi.edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const penalty = round2(req.body.penaltyAmount || 0);
    const scheduleId = Number(req.body.scheduleId || 0);
    if (!scheduleId) {
      return res.status(400).json({ message: "scheduleId is required." });
    }
    const updated = await prisma.eMISchedule.update({
      where: { id: scheduleId },
      data: { penaltyAmount: penalty },
    });
    res.json({ data: updated });
  }),
);

module.exports = router;
