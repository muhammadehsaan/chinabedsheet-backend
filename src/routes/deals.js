const express = require("express");
const { prisma } = require("../db");
const { requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async");
const { round2, round3 } = require("../utils/money");

const router = express.Router();

/* ── LIST ALL DEALS ───────────────────────────────────────── */
router.get(
  "/",
  requirePermission("inventory.view"),
  asyncHandler(async (_req, res) => {
    const deals = await prisma.deal.findMany({
      include: {
        lines: {
          include: { item: { select: { id: true, name: true, currentStock: true, retailPrice: true, marketPrice: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: deals });
  }),
);

/* ── GET SINGLE DEAL ──────────────────────────────────────── */
router.get(
  "/:id",
  requirePermission("inventory.view"),
  asyncHandler(async (req, res) => {
    const deal = await prisma.deal.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        lines: {
          include: { item: { select: { id: true, name: true, currentStock: true, retailPrice: true, marketPrice: true } } },
        },
      },
    });
    if (!deal) return res.status(404).json({ message: "Deal not found." });
    res.json({ data: deal });
  }),
);

/* ── CREATE DEAL ──────────────────────────────────────────── */
router.post(
  "/",
  requirePermission("inventory.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const name = String(payload.name || "").trim();
    if (!name) return res.status(400).json({ message: "Deal name is required." });

    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    if (lines.length === 0) return res.status(400).json({ message: "At least one item is required in a deal." });

    // Auto-calculate dealPrice as sum of (qty * unitPrice) for all lines
    const autoPrice = lines.reduce(
      (sum, l) => sum + Number(l.quantity || 1) * Number(l.unitPrice || 0),
      0,
    );
    const dealPrice = payload.dealPrice !== undefined ? round2(payload.dealPrice) : round2(autoPrice);

    const deal = await prisma.deal.create({
      data: {
        name,
        description: String(payload.description || "").trim() || null,
        dealPrice,
        status: payload.status || "Active",
        lines: {
          create: lines.map((l) => ({
            itemId: l.itemId ? Number(l.itemId) : null,
            itemName: String(l.itemName || l.name || "").trim(),
            quantity: round3(l.quantity || 1),
            unitPrice: round2(l.unitPrice || 0),
          })),
        },
      },
      include: {
        lines: {
          include: { item: { select: { id: true, name: true, currentStock: true, retailPrice: true, marketPrice: true } } },
        },
      },
    });

    res.status(201).json({ data: deal });
  }),
);

/* ── UPDATE DEAL ──────────────────────────────────────────── */
router.patch(
  "/:id",
  requirePermission("inventory.edit"),
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    const existing = await prisma.deal.findUnique({ where: { id: dealId } });
    if (!existing) return res.status(404).json({ message: "Deal not found." });

    const payload = req.body || {};
    const lines = Array.isArray(payload.lines) ? payload.lines : null;

    const autoPrice = lines
      ? lines.reduce((sum, l) => sum + Number(l.quantity || 1) * Number(l.unitPrice || 0), 0)
      : null;
    const dealPrice =
      payload.dealPrice !== undefined
        ? round2(payload.dealPrice)
        : autoPrice !== null
        ? round2(autoPrice)
        : undefined;

    const deal = await prisma.$transaction(async (tx) => {
      if (lines) {
        await tx.dealLine.deleteMany({ where: { dealId } });
      }
      return tx.deal.update({
        where: { id: dealId },
        data: {
          ...(payload.name !== undefined && { name: String(payload.name).trim() }),
          ...(payload.description !== undefined && { description: String(payload.description || "").trim() || null }),
          ...(dealPrice !== undefined && { dealPrice }),
          ...(payload.status !== undefined && { status: payload.status }),
          ...(lines && {
            lines: {
              create: lines.map((l) => ({
                itemId: l.itemId ? Number(l.itemId) : null,
                itemName: String(l.itemName || l.name || "").trim(),
                quantity: round3(l.quantity || 1),
                unitPrice: round2(l.unitPrice || 0),
              })),
            },
          }),
        },
        include: {
          lines: {
            include: { item: { select: { id: true, name: true, currentStock: true, retailPrice: true, marketPrice: true } } },
          },
        },
      });
    });

    res.json({ data: deal });
  }),
);

/* ── DELETE DEAL ──────────────────────────────────────────── */
router.delete(
  "/:id",
  requirePermission("inventory.delete"),
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    const existing = await prisma.deal.findUnique({ where: { id: dealId } });
    if (!existing) return res.status(404).json({ message: "Deal not found." });
    await prisma.deal.delete({ where: { id: dealId } }); // lines cascade
    res.json({ data: { id: dealId } });
  }),
);

module.exports = router;
