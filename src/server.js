require("dotenv").config();

const { normalizeDatabaseEnv } = require("./utils/env");
const { ensureDatabaseReady } = require("./utils/bootstrap");

normalizeDatabaseEnv(process.env);

const { app } = require("./app");

const PORT = Number(process.env.PORT || 5000);

const startServer = async () => {
  try {
    await ensureDatabaseReady();
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Backend running on http://localhost:${PORT}`);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Startup failed while preparing database schema.");
    // eslint-disable-next-line no-console
    console.error(error?.message || error);
    process.exit(1);
  }
};

startServer();
