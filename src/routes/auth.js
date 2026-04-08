const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { prisma } = require("../db");
const { asyncHandler } = require("../utils/async");
const { authRequired } = require("../middleware/auth");
const { ensureRbacSetup, serializeUser } = require("../utils/rbac");

const router = express.Router();

const signToken = (user) => {
  const payload = { id: user.id, email: user.email, role: user.role };
  return jwt.sign(payload, process.env.JWT_SECRET || "secret", { expiresIn: "7d" });
};

const readAuthSetup = async () => {
  await ensureRbacSetup(prisma);
  const usersCount = await prisma.user.count();
  return {
    usersCount,
    allowPublicSignup: usersCount === 0,
  };
};

router.get(
  "/setup",
  asyncHandler(async (_req, res) => {
    res.json({ data: await readAuthSetup() });
  }),
);

router.post(
  "/signup",
  asyncHandler(async (req, res) => {
    const setup = await readAuthSetup();
    const payload = req.body || {};
    const name = String(payload.name || "").trim();
    const email = String(payload.email || "").trim().toLowerCase();
    const password = String(payload.password || "");

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email, and password are required." });
    }

    if (!setup.allowPublicSignup) {
      return res.status(403).json({ message: "Public signup is disabled. Ask admin to create a user." });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ message: "Email already exists." });
    }

    const adminRole = await prisma.role.findFirst({ where: { key: "admin" } });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        name,
        username: String(payload.username || "").trim() || null,
        email,
        phone: String(payload.phone || "").trim() || null,
        notes: String(payload.notes || "").trim() || null,
        passwordHash,
        role: adminRole?.name || "Admin",
        roleId: adminRole?.id || null,
        status: "Active",
      },
      include: { roleConfig: true },
    });

    const token = signToken(user);
    res.status(201).json({
      data: {
        token,
        user: serializeUser(user),
      },
    });
  }),
);

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    await ensureRbacSetup(prisma);
    const payload = req.body || {};
    const identifier = String(payload.email || payload.username || "").trim();
    const normalizedIdentifier = identifier.toLowerCase();
    const password = String(payload.password || "");

    if (!identifier || !password) {
      return res.status(400).json({ message: "Email or username and password are required." });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: normalizedIdentifier },
          { username: { equals: identifier, mode: "insensitive" } },
        ],
      },
      include: { roleConfig: true },
    });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials." });
    }
    if (user.status !== "Active") {
      return res.status(403).json({ message: "User is inactive." });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ message: "Invalid credentials." });
    }

    const token = signToken(user);
    res.json({
      data: {
        token,
        user: serializeUser(user),
      },
    });
  }),
);

router.get(
  "/me",
  authRequired,
  asyncHandler(async (req, res) => {
    await ensureRbacSetup(prisma);
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { roleConfig: true },
    });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    res.json({ data: serializeUser(user) });
  }),
);

module.exports = router;
