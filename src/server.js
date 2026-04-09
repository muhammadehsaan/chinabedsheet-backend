require("dotenv").config();

const { normalizeDatabaseEnv } = require("./utils/env");
const { ensureDatabaseSchema } = require("./utils/schemaSync");

normalizeDatabaseEnv(process.env);

const PORT = Number(process.env.PORT || 5000);

const start = async () => {
  await ensureDatabaseSchema();

  const { app } = require("./app");

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend running on http://localhost:${PORT}`);
  });
};

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start backend:", error);
  process.exit(1);
});
