const path = require("path");
const dotenv = require("dotenv");
const { normalizeDatabaseEnv } = require("./utils/env");

const envFile = process.env.POS_ENV_FILE
  ? path.resolve(process.env.POS_ENV_FILE)
  : path.join(__dirname, "..", ".env");

dotenv.config({ path: envFile });
normalizeDatabaseEnv(process.env);

require("./server");
