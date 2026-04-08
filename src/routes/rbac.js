const express = require("express");
const bcrypt = require("bcryptjs");

const { prisma } = require("../db");
const { requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async");
const {
  createPermissionState,
  ensureRbacSetup,
  normalizePermissions,
  resolveRolePayload,
  serializeUser,
} = require("../utils/rbac");

const router = express.Router();

const slugifyRoleKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const normalizeRoleName = (value) => String(value || "").trim().replace(/\s+/g, " ");

const loadSnapshot = async () => {
  await ensureRbacSetup(prisma);
  const [roles, users] = await Promise.all([
    prisma.role.findMany({
      orderBy: [{ isLocked: "desc" }, { name: "asc" }],
    }),
    prisma.user.findMany({
      include: { roleConfig: true },
      orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    }),
  ]);

  return {
    roles: roles.map(resolveRolePayload),
    users: users.map(serializeUser),
  };
};

router.get(
  "/snapshot",
  requirePermission("settings.view"),
  asyncHandler(async (req, res) => {
    res.json({ data: await loadSnapshot() });
  }),
);

router.post(
  "/roles",
  requirePermission("settings.roles"),
  requirePermission("settings.permissions"),
  asyncHandler(async (req, res) => {
    await ensureRbacSetup(prisma);
    const payload = req.body || {};
    const name = normalizeRoleName(payload.name);
    const key = slugifyRoleKey(payload.key || payload.name);

    if (!name || !key) {
      return res.status(400).json({ message: "Role name is required." });
    }

    const duplicate = await prisma.role.findFirst({
      where: {
        OR: [{ key }, { name: { equals: name, mode: "insensitive" } }],
      },
    });
    if (duplicate) {
      return res.status(409).json({ message: "A role with this name already exists." });
    }

    const role = await prisma.role.create({
      data: {
        key,
        name,
        description: String(payload.description || "").trim() || null,
        status: payload.status === "Inactive" ? "Inactive" : "Active",
        isLocked: false,
        permissions: normalizePermissions(payload.permissions || createPermissionState(false)),
      },
    });

    res.status(201).json({ data: resolveRolePayload(role) });
  }),
);

router.patch(
  "/roles/:id",
  requirePermission("settings.roles"),
  requirePermission("settings.permissions"),
  asyncHandler(async (req, res) => {
    await ensureRbacSetup(prisma);
    const roleId = Number(req.params.id);
    if (!Number.isFinite(roleId)) {
      return res.status(400).json({ message: "Invalid role id." });
    }

    const existing = await prisma.role.findUnique({ where: { id: roleId } });
    if (!existing) {
      return res.status(404).json({ message: "Role not found." });
    }
    if (existing.isLocked) {
      return res.status(403).json({ message: "Admin role is locked and cannot be modified." });
    }

    const payload = req.body || {};
    const name = normalizeRoleName(payload.name || existing.name);
    const key = slugifyRoleKey(payload.key || payload.name || existing.key);

    const duplicate = await prisma.role.findFirst({
      where: {
        id: { not: roleId },
        OR: [{ key }, { name: { equals: name, mode: "insensitive" } }],
      },
    });
    if (duplicate) {
      return res.status(409).json({ message: "A role with this name already exists." });
    }

    const role = await prisma.role.update({
      where: { id: roleId },
      data: {
        key,
        name,
        description:
          payload.description !== undefined ? String(payload.description || "").trim() || null : existing.description,
        status: payload.status === "Inactive" ? "Inactive" : "Active",
        permissions:
          payload.permissions !== undefined
            ? normalizePermissions(payload.permissions || {})
            : existing.permissions,
      },
    });

    await prisma.user.updateMany({
      where: { roleId: role.id },
      data: { role: role.name },
    });

    res.json({ data: resolveRolePayload(role) });
  }),
);

router.delete(
  "/roles/:id",
  requirePermission("settings.roles"),
  asyncHandler(async (req, res) => {
    await ensureRbacSetup(prisma);
    const roleId = Number(req.params.id);
    if (!Number.isFinite(roleId)) {
      return res.status(400).json({ message: "Invalid role id." });
    }

    const existing = await prisma.role.findUnique({ where: { id: roleId } });
    if (!existing) {
      return res.status(404).json({ message: "Role not found." });
    }
    if (existing.isLocked) {
      return res.status(403).json({ message: "Admin role cannot be deleted." });
    }

    const assignedUsers = await prisma.user.count({ where: { roleId } });
    if (assignedUsers > 0) {
      return res.status(409).json({ message: "Move assigned users before deleting this role." });
    }

    await prisma.role.delete({ where: { id: roleId } });
    res.json({ data: { id: roleId } });
  }),
);

router.post(
  "/users",
  requirePermission("settings.users"),
  asyncHandler(async (req, res) => {
    await ensureRbacSetup(prisma);
    const payload = req.body || {};
    const name = normalizeRoleName(payload.name);
    const email = String(payload.email || "").trim().toLowerCase();
    const password = String(payload.password || "");
    const roleId = Number(payload.roleId || 0);

    if (!name || !email || !password || !roleId) {
      return res.status(400).json({ message: "Name, email, password and role are required." });
    }

    const [existingUser, role] = await Promise.all([
      prisma.user.findUnique({ where: { email } }),
      prisma.role.findUnique({ where: { id: roleId } }),
    ]);
    if (existingUser) {
      return res.status(409).json({ message: "Email already exists." });
    }
    if (!role) {
      return res.status(404).json({ message: "Selected role was not found." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        name,
        username: String(payload.username || "").trim() || null,
        email,
        phone: String(payload.phone || "").trim() || null,
        notes: String(payload.notes || "").trim() || null,
        passwordHash,
        role: role.name,
        roleId: role.id,
        status: payload.status === "Inactive" ? "Inactive" : "Active",
      },
      include: { roleConfig: true },
    });

    res.status(201).json({ data: serializeUser(user) });
  }),
);

router.patch(
  "/users/:id",
  requirePermission("settings.users"),
  asyncHandler(async (req, res) => {
    await ensureRbacSetup(prisma);
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      include: { roleConfig: true },
    });
    if (!existing) {
      return res.status(404).json({ message: "User not found." });
    }
    if (existing.roleConfig?.isLocked) {
      return res.status(403).json({ message: "Admin user is protected." });
    }

    const payload = req.body || {};
    const nextEmail =
      payload.email !== undefined ? String(payload.email || "").trim().toLowerCase() : existing.email;
    if (!nextEmail) {
      return res.status(400).json({ message: "Email is required." });
    }

    const emailOwner = await prisma.user.findFirst({
      where: {
        email: nextEmail,
        id: { not: userId },
      },
    });
    if (emailOwner) {
      return res.status(409).json({ message: "Email already exists." });
    }

    let role = existing.roleConfig;
    if (payload.roleId !== undefined) {
      const nextRoleId = Number(payload.roleId || 0);
      role = nextRoleId ? await prisma.role.findUnique({ where: { id: nextRoleId } }) : null;
      if (!role) {
        return res.status(404).json({ message: "Selected role was not found." });
      }
    }

    const data = {
      name:
        payload.name !== undefined ? normalizeRoleName(payload.name) || existing.name : existing.name,
      username:
        payload.username !== undefined ? String(payload.username || "").trim() || null : existing.username,
      email: nextEmail,
      phone: payload.phone !== undefined ? String(payload.phone || "").trim() || null : existing.phone,
      notes: payload.notes !== undefined ? String(payload.notes || "").trim() || null : existing.notes,
      status: payload.status === "Inactive" ? "Inactive" : "Active",
      role: role?.name || existing.role,
      roleId: role?.id || existing.roleId,
    };

    const nextPassword = String(payload.password || "");
    if (nextPassword) {
      data.passwordHash = await bcrypt.hash(nextPassword, 10);
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      include: { roleConfig: true },
    });

    res.json({ data: serializeUser(user) });
  }),
);

router.delete(
  "/users/:id",
  requirePermission("settings.users"),
  asyncHandler(async (req, res) => {
    await ensureRbacSetup(prisma);
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      include: { roleConfig: true },
    });
    if (!existing) {
      return res.status(404).json({ message: "User not found." });
    }
    if (existing.roleConfig?.isLocked) {
      return res.status(403).json({ message: "Admin user cannot be deleted." });
    }

    await prisma.user.delete({ where: { id: userId } });
    res.json({ data: { id: userId } });
  }),
);

module.exports = router;
