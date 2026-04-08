const express = require("express");

const { prisma } = require("../db");
const { asyncHandler } = require("../utils/async");
const { round3 } = require("../utils/money");

const router = express.Router();

router.get(
  "/claims",
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    const rows = await prisma.claim.findMany({
      where: status ? { status } : undefined,
      include: { customer: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: rows });
  }),
);

router.post(
  "/claims",
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const record = await prisma.claim.create({
      data: {
        customerId: payload.customerId ? Number(payload.customerId) : null,
        description: payload.description || "Claim",
        status: payload.status || "Pending",
      },
    });
    res.status(201).json({ data: record });
  }),
);

router.get(
  "/deliveries",
  asyncHandler(async (req, res) => {
    const rows = await prisma.delivery.findMany({
      include: { rider: true, sale: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: rows });
  }),
);

router.post(
  "/deliveries",
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const record = await prisma.delivery.create({
      data: {
        saleId: payload.saleId ? Number(payload.saleId) : null,
        riderId: payload.riderId ? Number(payload.riderId) : null,
        status: payload.status || "Hold",
        notes: payload.notes || null,
      },
    });
    res.status(201).json({ data: record });
  }),
);

router.patch(
  "/deliveries/:id/status",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body.status || "Hold";
    const record = await prisma.$transaction(async (tx) => {
      const existing = await tx.delivery.findUnique({
        where: { id },
        include: {
          sale: {
            include: {
              lines: true,
            },
          },
        },
      });
      if (!existing) {
        return null;
      }

      let nextNotes = existing.notes || null;
      const hasPendingStockDeduction = String(existing.notes || "").includes("[PENDING_STOCK_DEDUCTION]");
      if (status === "Delivered" && hasPendingStockDeduction && existing.sale?.lines?.length) {
        for (const line of existing.sale.lines) {
          if (!line.itemId) {
            continue;
          }
          const stockItem = await tx.item.findUnique({ where: { id: line.itemId } });
          if (!stockItem) {
            continue;
          }
          await tx.item.update({
            where: { id: line.itemId },
            data: {
              currentStock: round3(Number(stockItem.currentStock) - Number(line.quantity)),
            },
          });
        }
        nextNotes = String(existing.notes || "")
          .replace("[PENDING_STOCK_DEDUCTION]", "")
          .replace(/\s+/g, " ")
          .trim();
        nextNotes = nextNotes || null;
      }

      return tx.delivery.update({ where: { id }, data: { status, notes: nextNotes } });
    });
    if (!record) {
      return res.status(404).json({ message: "Delivery not found." });
    }
    res.json({ data: record });
  }),
);

router.get(
  "/riders",
  asyncHandler(async (req, res) => {
    const rows = await prisma.rider.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ data: rows });
  }),
);

router.post(
  "/riders",
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const record = await prisma.rider.create({
      data: {
        name: payload.name || "Rider",
        phone: payload.phone || null,
        lastLat: payload.lastLat || null,
        lastLng: payload.lastLng || null,
        status: payload.status || "Active",
      },
    });
    res.status(201).json({ data: record });
  }),
);

router.patch(
  "/riders/:id/location",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const record = await prisma.rider.update({
      where: { id },
      data: {
        lastLat: req.body.lastLat || null,
        lastLng: req.body.lastLng || null,
        status: req.body.status || undefined,
      },
    });
    res.json({ data: record });
  }),
);

module.exports = router;
