require("dotenv").config();

const { normalizeDatabaseEnv } = require("./utils/env");
const { ensureDatabaseReady } = require("./utils/bootstrap");

normalizeDatabaseEnv(process.env);

const { app } = require("./app");

const PORT = Number(process.env.PORT || 5000);

const startServer = async () => {
  const startHttpServer = () => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Backend running on http://localhost:${PORT}`);
    });
  };

  try {
    await ensureDatabaseReady();
    startHttpServer();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Database bootstrap failed. Continuing with existing schema.");
    // eslint-disable-next-line no-console
    console.error(error?.message || error);
    startHttpServer();
  }
};

startServer();
