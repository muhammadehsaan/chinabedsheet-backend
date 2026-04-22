const express = require("express");
const { prisma } = require("../db");
const { requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async");
const { round2, round3 } = require("../utils/money");
const { uploadImageSet } = require("../utils/cloudinary");

const router = express.Router();

const normalizeCatalogName = (value) => String(value || "").trim().replace(/\s+/g, " ");
const normalizeItemName = (value) => normalizeCatalogName(value).toUpperCase();
const formatCatalogName = (value) =>
  normalizeCatalogName(value).replace(/\b([a-z])/g, (match) => match.toUpperCase());

const normalizeImageUrls = (imageUrls, singleImageUrl) => {
  const fromJson = Array.isArray(imageUrls)
    ? imageUrls.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  if (fromJson.length > 0) {
    return fromJson;
  }
  if (singleImageUrl) {
    return [String(singleImageUrl).trim()].filter(Boolean);
  }
  return [];
};

const normalizeIncomingImageValues = (input) => {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((entry) => String(entry || "").trim())
    .filter(
      (entry) =>
        entry.startsWith("http://") ||
        entry.startsWith("https://") ||
        entry.startsWith("data:image"),
    );
};

const fallbackUploadImageSet = (payload = {}) => {
  const direct = normalizeIncomingImageValues(payload.imageUrls);
  const data = normalizeIncomingImageValues(payload.imageDataUrls);
  return [...direct, ...data];
};

const resolveUploadedImageSet = async (payload = {}) => {
  try {
    return await uploadImageSet({
      imageUrls: payload.imageUrls,
      imageDataUrls: payload.imageDataUrls,
    });
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("cloudinary is not configured")) {
      return fallbackUploadImageSet(payload);
    }
    throw error;
  }
};

const findOrCreateUnit = async (name) => {
  const normalizedName = formatCatalogName(name);
  if (!normalizedName) {
    return null;
  }
  const existing = await prisma.unit.findFirst({
    where: { name: { equals: normalizedName, mode: "insensitive" } },
  });
  if (existing) {
    return existing;
  }
  return prisma.unit.create({ data: { name: normalizedName } });
};

const findOrCreateCategory = async (name) => {
  const normalizedName = formatCatalogName(name);
  if (!normalizedName) {
    return null;
  }
  const existing = await prisma.category.findFirst({
    where: { name: { equals: normalizedName, mode: "insensitive" } },
  });
  if (existing) {
    return existing;
  }
  return prisma.category.create({ data: { name: normalizedName } });
};

const AUTO_BARCODE_START = 1001;
const AUTO_BARCODE_END = 9999;
const isValidFourDigitBarcode = (value) => /^\d{4}$/.test(String(value || "").trim());
const isAutoBarcodeType = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .includes("auto");

const generateNextAutoBarcode = async () => {
  const rows = await prisma.item.findMany({
    where: { barcode: { not: null } },
    select: { barcode: true },
  });
  const usedBarcodes = new Set();
  rows.forEach((row) => {
    const value = String(row?.barcode || "").trim();
    if (!/^\d{4}$/.test(value)) {
      return;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    if (parsed < AUTO_BARCODE_START || parsed > AUTO_BARCODE_END) {
      return;
    }
    usedBarcodes.add(value);
  });

  for (let code = AUTO_BARCODE_START; code <= AUTO_BARCODE_END; code += 1) {
    const barcode = String(code);
    if (!usedBarcodes.has(barcode)) {
      return barcode;
    }
  }

  throw new Error("No 4-digit auto barcode available in range 1001-9999.");
};

router.get(
  "/categories",
  requirePermission("inventory.view"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.category.findMany({ orderBy: { name: "asc" } });
    res.json({ data: rows });
  }),
);

router.post(
  "/categories",
  requirePermission("inventory.create"),
  asyncHandler(async (req, res) => {
    const name = formatCatalogName(req.body.name);
    if (!name) {
      return res.status(400).json({ message: "Category name is required." });
    }
    const category = await findOrCreateCategory(name);
    res.status(201).json({ data: category });
  }),
);

router.get(
  "/units",
  requirePermission("inventory.view"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.unit.findMany({ orderBy: { name: "asc" } });
    const seen = new Set();
    const dedupedRows = [];
    rows.forEach((row) => {
      const key = normalizeCatalogName(row?.name).toLowerCase();
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      dedupedRows.push({
        ...row,
        name: formatCatalogName(row.name),
      });
    });
    res.json({ data: dedupedRows });
  }),
);

router.post(
  "/units",
  requirePermission("inventory.create"),
  asyncHandler(async (req, res) => {
    const name = formatCatalogName(req.body.name);
    if (!name) {
      return res.status(400).json({ message: "Unit name is required." });
    }
    const unit = await findOrCreateUnit(name);
    res.status(201).json({ data: unit });
  }),
);

router.get(
  "/items",
  requirePermission("inventory.view"),
  asyncHandler(async (req, res) => {
    const items = await prisma.item.findMany({
      include: { category: true, unit: true, variations: true },
      orderBy: { createdAt: "desc" },
    });
    const data = items.map((item) => ({
      ...item,
      salePrice: item.retailPrice,
      imageUrls: normalizeImageUrls(item.imageUrls),
    }));
    res.json({ data });
  }),
);

router.post(
  "/items",
  requirePermission("inventory.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const name = normalizeItemName(payload.name);
    if (!name) {
      return res.status(400).json({ message: "Product name is required." });
    }

    const category = payload.categoryId
      ? await prisma.category.findUnique({ where: { id: Number(payload.categoryId) } })
      : await findOrCreateCategory(payload.categoryName);

    const unit = payload.unitId
      ? await prisma.unit.findUnique({ where: { id: Number(payload.unitId) } })
      : await findOrCreateUnit(payload.unit);

    const barcodeType = payload.barcodeType || null;
    let barcode = payload.barcode || null;
    if (isAutoBarcodeType(barcodeType) && !isValidFourDigitBarcode(barcode)) {
      barcode = await generateNextAutoBarcode();
    }
    const uploadedImageUrls = await resolveUploadedImageSet(payload);

    const item = await prisma.item.create({
      data: {
        name,
        sku: payload.sku || null,
        status: payload.status || "Active",
        lowStockThreshold: Number(payload.lowStockThreshold || 5),
        barcodeType,
        barcode,
        purchasePrice: round2(payload.purchasePrice || 0),
        wholesalePrice: round2(payload.wholesalePrice || 0),
        retailPrice: round2(payload.retailPrice || 0),
        marketPrice: round2(payload.marketPrice || 0),
        commissionPercent: round2(payload.commissionPercent ?? payload.commission ?? 0),
        commissionAmount: round2(payload.commissionAmount ?? 0),
        currentStock: round3(payload.openingStock || 0),
        imageUrls: uploadedImageUrls.length > 0 ? uploadedImageUrls : null,
        categoryId: category ? category.id : null,
        unitId: unit ? unit.id : null,
      },
    });

    res.status(201).json({
      data: {
        ...item,
        salePrice: item.retailPrice,
        imageUrls: normalizeImageUrls(item.imageUrls),
      },
    });
  }),
);

router.patch(
  "/items/:id",
  requirePermission("inventory.edit"),
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.id);
    if (!itemId || Number.isNaN(itemId)) {
      return res.status(400).json({ message: "Invalid item id." });
    }

    const existing = await prisma.item.findUnique({ where: { id: itemId } });
    if (!existing) {
      return res.status(404).json({ message: "Product not found." });
    }

    const payload = req.body || {};
    const name = payload.name !== undefined ? normalizeItemName(payload.name) : undefined;
    if (payload.name !== undefined && !name) {
      return res.status(400).json({ message: "Product name is required." });
    }

    let category = undefined;
    if ("categoryId" in payload || "categoryName" in payload) {
      if (payload.categoryId) {
        category = await prisma.category.findUnique({ where: { id: Number(payload.categoryId) } });
      } else if (payload.categoryName) {
        category = await findOrCreateCategory(payload.categoryName);
      } else {
        category = null;
      }
    }

    let unit = undefined;
    if ("unitId" in payload || "unit" in payload) {
      if (payload.unitId) {
        unit = await prisma.unit.findUnique({ where: { id: Number(payload.unitId) } });
      } else if (payload.unit) {
        unit = await findOrCreateUnit(payload.unit);
      } else {
        unit = null;
      }
    }

    const barcodeType =
      payload.barcodeType !== undefined ? payload.barcodeType || null : undefined;
    const resolvedBarcodeType = barcodeType !== undefined ? barcodeType : existing.barcodeType || null;
    let barcode = payload.barcode !== undefined ? payload.barcode || null : undefined;
    if (isAutoBarcodeType(resolvedBarcodeType)) {
      if (barcode === undefined) {
        if (!isValidFourDigitBarcode(existing.barcode)) {
          barcode = await generateNextAutoBarcode();
        }
      } else if (!isValidFourDigitBarcode(barcode)) {
        barcode = await generateNextAutoBarcode();
      }
    }
    let uploadedImageUrls = undefined;
    if ("imageUrls" in payload || "imageDataUrls" in payload) {
      uploadedImageUrls = await resolveUploadedImageSet(payload);
    }

    const data = {};
    if (name !== undefined) data.name = name;
    if ("sku" in payload) data.sku = payload.sku || null;
    if ("status" in payload) data.status = payload.status || "Active";
    if ("lowStockThreshold" in payload) {
      data.lowStockThreshold = Number(payload.lowStockThreshold || 5);
    }
    if (payload.barcodeType !== undefined) data.barcodeType = barcodeType;
    if (payload.barcode !== undefined || barcode !== undefined) data.barcode = barcode;
    if ("purchasePrice" in payload || "purchase" in payload) {
      data.purchasePrice = round2(payload.purchasePrice ?? payload.purchase ?? 0);
    }
    if ("wholesalePrice" in payload || "wholesale" in payload) {
      data.wholesalePrice = round2(payload.wholesalePrice ?? payload.wholesale ?? 0);
    }
    if ("retailPrice" in payload || "retail" in payload) {
      data.retailPrice = round2(payload.retailPrice ?? payload.retail ?? 0);
    }
    if ("marketPrice" in payload || "market" in payload) {
      data.marketPrice = round2(payload.marketPrice ?? payload.market ?? 0);
    }
    if ("commissionPercent" in payload || "commission" in payload) {
      data.commissionPercent = round2(payload.commissionPercent ?? payload.commission ?? 0);
    }
    if ("commissionAmount" in payload) {
      data.commissionAmount = round2(payload.commissionAmount ?? 0);
    }
    if ("openingStock" in payload || "currentStock" in payload) {
      data.currentStock = round3(payload.openingStock ?? payload.currentStock ?? 0);
    }
    if (uploadedImageUrls !== undefined) {
      data.imageUrls = uploadedImageUrls.length > 0 ? uploadedImageUrls : null;
    }
    if (category !== undefined) data.categoryId = category ? category.id : null;
    if (unit !== undefined) data.unitId = unit ? unit.id : null;

    const item = await prisma.item.update({
      where: { id: itemId },
      data,
    });

    res.json({
      data: {
        ...item,
        salePrice: item.retailPrice,
        imageUrls: normalizeImageUrls(item.imageUrls),
      },
    });
  }),
);

router.patch(
  "/items/:id/pricing",
  requirePermission("inventory.edit"),
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.id);
    const payload = req.body || {};
    const item = await prisma.item.update({
      where: { id: itemId },
      data: {
        purchasePrice: round2(payload.purchase || payload.purchasePrice || 0),
        wholesalePrice: round2(payload.wholesale || payload.wholesalePrice || 0),
        retailPrice: round2(payload.retail || payload.retailPrice || 0),
        marketPrice: round2(payload.market || payload.marketPrice || 0),
      },
    });
    res.json({ data: item });
  }),
);

router.delete(
  "/items/:id",
  requirePermission("inventory.delete"),
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.id);
    if (!itemId || Number.isNaN(itemId)) {
      return res.status(400).json({ message: "Invalid item id." });
    }

    const existing = await prisma.item.findUnique({ where: { id: itemId } });
    if (!existing) {
      return res.status(404).json({ message: "Product not found." });
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.purchaseLine.updateMany({
          where: { itemId },
          data: { itemId: null },
        });
        await tx.saleLine.updateMany({
          where: { itemId },
          data: { itemId: null },
        });
        await tx.stockAdjustment.deleteMany({ where: { itemId } });
        await tx.variation.deleteMany({ where: { itemId } });
        await tx.item.delete({ where: { id: itemId } });
      });
    } catch (error) {
      if (error?.code === "P2003") {
        return res.status(409).json({
          message: "This product has linked records and cannot be deleted right now.",
        });
      }
      throw error;
    }

    res.json({ data: { id: itemId } });
  }),
);

router.get(
  "/alerts/low-stock",
  requirePermission("inventory.view"),
  asyncHandler(async (req, res) => {
    const items = await prisma.item.findMany();
    const rows = items.filter(
      (item) => Number(item.currentStock) <= Number(item.lowStockThreshold || 0),
    );
    res.json({ data: rows });
  }),
);

router.get(
  "/alerts/expiry",
  requirePermission("inventory.view"),
  asyncHandler(async (req, res) => {
    res.json({ data: [] });
  }),
);

router.get(
  "/stock-adjustments",
  requirePermission("inventory.view"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.stockAdjustment.findMany({
      include: { item: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: rows });
  }),
);

router.post(
  "/stock-adjustments",
  requirePermission("inventory.adjust"),
  asyncHandler(async (req, res) => {
    const itemId = Number(req.body.itemId);
    const quantity = round3(req.body.quantity || 0);
    if (!itemId || Number.isNaN(itemId)) {
      return res.status(400).json({ message: "itemId is required." });
    }
    const item = await prisma.item.findUnique({ where: { id: itemId } });
    if (!item) {
      return res.status(404).json({ message: "Product not found." });
    }

    const adjustment = await prisma.$transaction(async (tx) => {
      const updated = await tx.item.update({
        where: { id: itemId },
        data: { currentStock: round3(Number(item.currentStock) + quantity) },
      });
      const entry = await tx.stockAdjustment.create({
        data: {
          itemId,
          quantity,
          reason: req.body.reason || null,
        },
      });
      return { entry, updated };
    });

    res.status(201).json({ data: adjustment.entry });
  }),
);

router.get(
  "/variations",
  requirePermission("inventory.view"),
  asyncHandler(async (req, res) => {
    const itemId = req.query.itemId ? Number(req.query.itemId) : undefined;
    const rows = await prisma.variation.findMany({
      where: itemId ? { itemId } : undefined,
      include: { item: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      data: rows.map((row) => ({
        ...row,
        imageUrls: normalizeImageUrls(row.imageUrls, row.imageUrl),
      })),
    });
  }),
);

router.post(
  "/variations",
  requirePermission("inventory.create"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const itemId = Number(payload.itemId);
    if (!itemId || Number.isNaN(itemId)) {
      return res.status(400).json({ message: "itemId is required." });
    }
    const uploadedImageUrls = await resolveUploadedImageSet(payload);
    const variation = await prisma.variation.create({
      data: {
        itemId,
        size: payload.size || null,
        color: payload.color || null,
        clothType: payload.clothType || null,
        barcodeType: payload.barcodeType || null,
        barcode: payload.barcode || null,
        purchasePrice: payload.purchasePrice ? round2(payload.purchasePrice) : null,
        wholesalePrice: payload.wholesalePrice ? round2(payload.wholesalePrice) : null,
        retailPrice: payload.retailPrice ? round2(payload.retailPrice) : null,
        marketPrice: payload.marketPrice ? round2(payload.marketPrice) : null,
        openingStock: payload.openingStock ? round3(payload.openingStock) : null,
        imageUrl: uploadedImageUrls[0] || payload.imageUrl || null,
        imageUrls: uploadedImageUrls.length > 0 ? uploadedImageUrls : null,
      },
    });
    res.status(201).json({
      data: {
        ...variation,
        imageUrls: normalizeImageUrls(variation.imageUrls, variation.imageUrl),
      },
    });
  }),
);

router.patch(
  "/variations/:id",
  requirePermission("inventory.edit"),
  asyncHandler(async (req, res) => {
    const variationId = Number(req.params.id);
    const payload = req.body || {};
    let uploadedImageUrls = undefined;
    if ("imageUrls" in payload || "imageDataUrls" in payload || "imageUrl" in payload) {
      uploadedImageUrls = await resolveUploadedImageSet({
        imageUrls: payload.imageUrls || (payload.imageUrl ? [payload.imageUrl] : []),
        imageDataUrls: payload.imageDataUrls,
      });
    }
    const variation = await prisma.variation.update({
      where: { id: variationId },
      data: {
        size: payload.size || undefined,
        color: payload.color || undefined,
        clothType: payload.clothType || undefined,
        barcodeType: payload.barcodeType || undefined,
        barcode: payload.barcode || undefined,
        purchasePrice: payload.purchasePrice ? round2(payload.purchasePrice) : undefined,
        wholesalePrice: payload.wholesalePrice ? round2(payload.wholesalePrice) : undefined,
        retailPrice: payload.retailPrice ? round2(payload.retailPrice) : undefined,
        marketPrice: payload.marketPrice ? round2(payload.marketPrice) : undefined,
        openingStock: payload.openingStock ? round3(payload.openingStock) : undefined,
        imageUrl:
          uploadedImageUrls !== undefined
            ? uploadedImageUrls[0] || null
            : payload.imageUrl || undefined,
        imageUrls:
          uploadedImageUrls !== undefined
            ? uploadedImageUrls.length > 0
              ? uploadedImageUrls
              : null
            : undefined,
      },
    });
    res.json({
      data: {
        ...variation,
        imageUrls: normalizeImageUrls(variation.imageUrls, variation.imageUrl),
      },
    });
  }),
);

module.exports = router;
