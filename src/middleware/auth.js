const jwt = require("jsonwebtoken");
const { prisma } = require("../db");
const { buildUserAccess, ensureRbacSetup, serializeUser } = require("../utils/rbac");

const authRequired = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
    await ensureRbacSetup(prisma);
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { roleConfig: true },
    });
    if (!user) {
      return res.status(401).json({ message: "User not found." });
    }
    if (user.status !== "Active") {
      return res.status(403).json({ message: "User is inactive." });
    }
    const access = buildUserAccess(user);
    req.authUser = user;
    req.user = {
      ...decoded,
      ...serializeUser(user),
      permissions: access.permissions,
    };
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

const requirePermission = (permissionKey) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (!permissionKey || req.user.permissions?.[permissionKey]) {
    return next();
  }
  return res.status(403).json({ message: "You do not have permission to access this action." });
};

const requireAnyPermission = (permissionKeys = []) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (!Array.isArray(permissionKeys) || permissionKeys.length === 0) {
    return next();
  }
  const allowed = permissionKeys.some((key) => req.user.permissions?.[key]);
  if (allowed) {
    return next();
  }
  return res.status(403).json({ message: "You do not have permission to access this action." });
};

module.exports = { authRequired, requirePermission, requireAnyPermission };
