const permissionGroups = [
  {
    key: "dashboard",
    label: "Dashboard",
    permissions: [
      { key: "dashboard.view", label: "View dashboard" },
      { key: "dashboard.notifications", label: "Open notifications" },
    ],
  },
  {
    key: "sales",
    label: "Sales & POS",
    permissions: [
      { key: "sales.view", label: "View sales" },
      { key: "sales.create", label: "Create sales" },
      { key: "sales.edit", label: "Edit sales" },
      { key: "sales.delete", label: "Delete / cancel sales" },
      { key: "sales.print", label: "Print invoices" },
    ],
  },
  {
    key: "inventory",
    label: "Inventory",
    permissions: [
      { key: "inventory.view", label: "View inventory" },
      { key: "inventory.create", label: "Create items" },
      { key: "inventory.edit", label: "Edit items" },
      { key: "inventory.delete", label: "Delete items" },
      { key: "inventory.adjust", label: "Adjust stock" },
    ],
  },
  {
    key: "production",
    label: "Production",
    permissions: [
      { key: "production.view", label: "View production" },
      { key: "production.create", label: "Create production entries" },
      { key: "production.edit", label: "Edit production entries" },
      { key: "production.delete", label: "Delete production entries" },
    ],
  },
  {
    key: "purchases",
    label: "Purchases",
    permissions: [
      { key: "purchases.view", label: "View purchases" },
      { key: "purchases.create", label: "Create purchases" },
      { key: "purchases.edit", label: "Edit purchases" },
      { key: "purchases.delete", label: "Delete purchases" },
    ],
  },
  {
    key: "accounts",
    label: "Accounts & Finance",
    permissions: [
      { key: "accounts.view", label: "View accounts" },
      { key: "accounts.create", label: "Create bank / ledger" },
      { key: "accounts.edit", label: "Edit bank / ledger" },
      { key: "accounts.delete", label: "Delete bank / ledger" },
    ],
  },
  {
    key: "emi",
    label: "EMI & Installments",
    permissions: [
      { key: "emi.view", label: "View EMI" },
      { key: "emi.create", label: "Create EMI" },
      { key: "emi.edit", label: "Edit EMI" },
      { key: "emi.delete", label: "Delete EMI" },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    permissions: [
      { key: "reports.view", label: "View reports" },
      { key: "reports.export", label: "Export reports" },
      { key: "reports.print", label: "Print reports" },
    ],
  },
  {
    key: "settings",
    label: "Settings & Security",
    permissions: [
      { key: "settings.view", label: "View settings" },
      { key: "settings.roles", label: "Manage roles" },
      { key: "settings.users", label: "Manage users" },
      { key: "settings.permissions", label: "Change permissions" },
    ],
  },
];

const allPermissionKeys = permissionGroups.flatMap((group) =>
  group.permissions.map((permission) => permission.key),
);

const createPermissionState = (fill = false, overrides = {}) =>
  allPermissionKeys.reduce(
    (acc, key) => ({
      ...acc,
      [key]: key in overrides ? Boolean(overrides[key]) : fill,
    }),
    {},
  );

const defaultRoles = [
  {
    key: "admin",
    name: "Admin",
    description: "System owner with complete access to every area.",
    status: "Active",
    isLocked: true,
    permissions: createPermissionState(true),
  },
  {
    key: "manager",
    name: "Manager",
    description: "Can manage sales, inventory, purchases and reports.",
    status: "Active",
    isLocked: false,
    permissions: createPermissionState(false, {
      "dashboard.view": true,
      "dashboard.notifications": true,
      "sales.view": true,
      "sales.create": true,
      "sales.edit": true,
      "sales.print": true,
      "inventory.view": true,
      "inventory.create": true,
      "inventory.edit": true,
      "inventory.adjust": true,
      "production.view": true,
      "production.create": true,
      "production.edit": true,
      "purchases.view": true,
      "purchases.create": true,
      "purchases.edit": true,
      "accounts.view": true,
      "accounts.create": true,
      "accounts.edit": true,
      "emi.view": true,
      "emi.create": true,
      "emi.edit": true,
      "reports.view": true,
      "reports.export": true,
      "settings.view": true,
      "settings.users": true,
    }),
  },
  {
    key: "sales-executive",
    name: "Sales Executive",
    description: "Handles counter sales, printing and customer dealing.",
    status: "Active",
    isLocked: false,
    permissions: createPermissionState(false, {
      "dashboard.view": true,
      "sales.view": true,
      "sales.create": true,
      "sales.print": true,
      "inventory.view": true,
      "emi.view": true,
      "emi.create": true,
      "reports.view": true,
    }),
  },
];

const normalizePermissions = (permissions = {}, fill = false) =>
  allPermissionKeys.reduce(
    (acc, key) => ({
      ...acc,
      [key]: key in permissions ? Boolean(permissions[key]) : fill,
    }),
    {},
  );

const resolveRolePayload = (role) => {
  if (!role) {
    return null;
  }
  return {
    ...role,
    permissions: normalizePermissions(role.permissions || {}, Boolean(role.isLocked)),
  };
};

const buildUserAccess = (user) => {
  const roleConfig = resolveRolePayload(user?.roleConfig || null);
  const isAdminRole =
    Boolean(roleConfig?.isLocked) ||
    String(roleConfig?.key || "").toLowerCase() === "admin" ||
    String(user?.role || "").toLowerCase() === "admin";
  const permissions = isAdminRole
    ? createPermissionState(true)
    : normalizePermissions(roleConfig?.permissions || {});
  return {
    roleConfig,
    permissions,
    isAdminRole,
  };
};

const serializeUser = (user) => {
  const access = buildUserAccess(user);
  return {
    id: user.id,
    name: user.name,
    username: user.username || "",
    email: user.email,
    phone: user.phone || "",
    notes: user.notes || "",
    status: user.status,
    role: access.roleConfig?.name || user.role || "Admin",
    roleId: access.roleConfig?.id || user.roleId || null,
    roleKey: access.roleConfig?.key || null,
    permissions: access.permissions,
    isLocked: access.isAdminRole,
  };
};

const attachUserRole = async (db, user) => {
  const legacyRole = String(user?.role || "").trim().toLowerCase();
  const targetRole =
    (user?.roleId ? await db.role.findUnique({ where: { id: user.roleId } }) : null) ||
    (legacyRole
      ? await db.role.findFirst({
          where: {
            OR: [
              { key: legacyRole.replace(/\s+/g, "-") },
              { name: { equals: user.role, mode: "insensitive" } },
            ],
          },
        })
      : null) ||
    (await db.role.findFirst({ where: { key: "admin" } }));

  if (!targetRole) {
    return null;
  }

  if (Number(user.roleId || 0) !== Number(targetRole.id) || user.role !== targetRole.name) {
    await db.user.update({
      where: { id: user.id },
      data: {
        roleId: targetRole.id,
        role: targetRole.name,
      },
    });
  }

  return targetRole;
};

let bootstrapPromise = null;

const ensureRbacSchema = async (db) => {
  const statements = [
    `
      CREATE TABLE IF NOT EXISTS "Role" (
        "id" SERIAL NOT NULL,
        "key" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "status" TEXT NOT NULL DEFAULT 'Active',
        "isLocked" BOOLEAN NOT NULL DEFAULT false,
        "permissions" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
      );
    `,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Role_key_key" ON "Role"("key");`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Role_name_key" ON "Role"("name");`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT;`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notes" TEXT;`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "roleId" INTEGER;`,
    `CREATE INDEX IF NOT EXISTS "User_roleId_idx" ON "User"("roleId");`,
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'User_roleId_fkey'
        ) THEN
          ALTER TABLE "User"
          ADD CONSTRAINT "User_roleId_fkey"
          FOREIGN KEY ("roleId") REFERENCES "Role"("id")
          ON DELETE SET NULL
          ON UPDATE CASCADE;
        END IF;
      END $$;
    `,
    `
      UPDATE "User"
      SET "username" = COALESCE(NULLIF(split_part("email", '@', 1), ''), 'user-' || "id")
      WHERE "username" IS NULL;
    `,
  ];

  for (const statement of statements) {
    await db.$executeRawUnsafe(statement);
  }
};

const ensureRbacSetup = async (db) => {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    await ensureRbacSchema(db);

    for (const role of defaultRoles) {
      await db.role.upsert({
        where: { key: role.key },
        update: {
          name: role.name,
          description: role.description,
          status: role.status,
          isLocked: role.isLocked,
          permissions: role.permissions,
        },
        create: {
          key: role.key,
          name: role.name,
          description: role.description,
          status: role.status,
          isLocked: role.isLocked,
          permissions: role.permissions,
        },
      });
    }

    const users = await db.user.findMany({
      select: { id: true, role: true, roleId: true },
    });

    for (const user of users) {
      await attachUserRole(db, user);
    }
  })().finally(() => {
    bootstrapPromise = null;
  });

  return bootstrapPromise;
};

const canAccessPermission = (userLike, permissionKey) => {
  if (!permissionKey) {
    return true;
  }
  const permissions =
    userLike?.permissions ||
    buildUserAccess({
      ...userLike,
      roleConfig: userLike?.roleConfig || null,
    }).permissions;
  return Boolean(permissions?.[permissionKey]);
};

module.exports = {
  permissionGroups,
  allPermissionKeys,
  createPermissionState,
  defaultRoles,
  normalizePermissions,
  resolveRolePayload,
  buildUserAccess,
  serializeUser,
  ensureRbacSetup,
  canAccessPermission,
};
