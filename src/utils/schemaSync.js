const { spawnSync } = require("child_process");
const path = require("path");

const resolvePrismaCliPath = () => {
  try {
    return require.resolve("prisma/build/index.js");
  } catch (error) {
    return null;
  }
};

const shouldSkipSchemaSync = () =>
  String(process.env.AUTO_PRISMA_DB_PUSH || "true").trim().toLowerCase() === "false";

const ensureDatabaseSchema = async () => {
  if (shouldSkipSchemaSync()) {
    return;
  }

  const prismaCliPath = resolvePrismaCliPath();
  if (!prismaCliPath) {
    // eslint-disable-next-line no-console
    console.warn("Prisma CLI is not installed; skipping database schema sync.");
    return;
  }

  const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
  const result = spawnSync(
    process.execPath,
    [prismaCliPath, "db", "push", "--skip-generate", "--schema", schemaPath],
    {
      env: {
        ...process.env,
        PRISMA_HIDE_UPDATE_MESSAGE: "1",
      },
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error(`Prisma db push failed with exit code ${result.status || 1}.`);
  }
};

module.exports = { ensureDatabaseSchema };
