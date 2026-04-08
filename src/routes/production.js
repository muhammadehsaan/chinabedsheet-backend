const express = require("express");

const { prisma } = require("../db");
const { requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async");
const { round2, round3 } = require("../utils/money");

const router = express.Router();

router.get(
  "/recipes",
  requirePermission("production.view"),
  asyncHandler(async (req, res) => {
    const recipes = await prisma.productionRecipe.findMany({
      include: { bomLines: true },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ data: recipes });
  }),
);

router.post(
  "/recipes",
  requirePermission("production.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const name = String(payload.name || "").trim();
    const productName = String(payload.productName || "").trim();
    if (!name || !productName) {
      return res.status(400).json({ message: "Recipe name and product name are required." });
    }
    const recipe = await prisma.productionRecipe.create({
      data: {
        name,
        productName,
        notes: payload.notes || null,
        bomLines: payload.bomLines
          ? {
              create: payload.bomLines.map((line) => ({
                materialName: line.materialName,
                quantityPerUnit: round3(line.quantityPerUnit || 0),
                unit: line.unit || "Unit",
                costPerUnit: round2(line.costPerUnit || 0),
              })),
            }
          : undefined,
      },
      include: { bomLines: true },
    });
    res.status(201).json({ data: recipe });
  }),
);

router.patch(
  "/recipes/:id",
  requirePermission("production.edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const payload = req.body || {};
    const recipe = await prisma.productionRecipe.update({
      where: { id },
      data: {
        name: payload.name || undefined,
        productName: payload.productName || undefined,
        notes: payload.notes || undefined,
        isActive: payload.isActive ?? undefined,
      },
    });
    res.json({ data: recipe });
  }),
);

router.get(
  "/recipes/:id/bom",
  requirePermission("production.view"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const lines = await prisma.bomLine.findMany({ where: { recipeId: id } });
    res.json({ data: lines });
  }),
);

router.post(
  "/recipes/:id/bom",
  requirePermission("production.edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];

    const updated = await prisma.$transaction(async (tx) => {
      await tx.bomLine.deleteMany({ where: { recipeId: id } });
      if (lines.length > 0) {
        await tx.bomLine.createMany({
          data: lines.map((line) => ({
            recipeId: id,
            materialName: line.materialName,
            quantityPerUnit: round3(line.quantityPerUnit || 0),
            unit: line.unit || "Unit",
            costPerUnit: round2(line.costPerUnit || 0),
          })),
        });
      }
      return tx.productionRecipe.findUnique({ where: { id }, include: { bomLines: true } });
    });

    res.json({ data: updated });
  }),
);

router.get(
  "/runs",
  requirePermission("production.view"),
  asyncHandler(async (req, res) => {
    const runs = await prisma.productionRun.findMany({
      include: { recipe: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: runs });
  }),
);

router.post(
  "/runs",
  requirePermission("production.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const recipeId = payload.recipeId ? Number(payload.recipeId) : null;
    const units = round3(payload.units || 0);
    if (!recipeId && !payload.productName) {
      return res.status(400).json({ message: "recipeId or productName is required." });
    }

    const recipe = recipeId
      ? await prisma.productionRecipe.findUnique({ where: { id: recipeId }, include: { bomLines: true } })
      : null;
    const productName = recipe?.productName || payload.productName || "Production";

    const bomLines = recipe?.bomLines || [];
    let materialCost = 0;
    for (const line of bomLines) {
      materialCost += Number(line.costPerUnit) * Number(line.quantityPerUnit) * units;
    }

    const laborCost = round2(payload.laborCost || 0);
    const overheadCost = round2(payload.overheadCost || 0);
    const totalCostPerUnit =
      units > 0 ? round2((materialCost + laborCost + overheadCost) / units) : 0;

    const run = await prisma.$transaction(async (tx) => {
      const record = await tx.productionRun.create({
        data: {
          recipeId: recipe ? recipe.id : null,
          productName,
          units,
          status: payload.status || "Processing",
          materialCost: round2(materialCost),
          laborCost,
          overheadCost,
          totalCostPerUnit,
        },
      });

      // Auto inventory deduction for raw materials
      for (const line of bomLines) {
        const item = await tx.item.findFirst({
          where: { name: { equals: line.materialName, mode: "insensitive" } },
        });
        if (!item) {
          continue;
        }
        const deductQty = round3(Number(line.quantityPerUnit) * units);
        await tx.item.update({
          where: { id: item.id },
          data: { currentStock: round3(Number(item.currentStock) - deductQty) },
        });
      }

      return record;
    });

    res.status(201).json({ data: run });
  }),
);

module.exports = router;
