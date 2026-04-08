const path = require("path");
const dotenv = require("dotenv");

const envFile = process.env.POS_ENV_FILE
  ? path.resolve(process.env.POS_ENV_FILE)
  : path.join(__dirname, "..", ".env");

dotenv.config({ path: envFile });

require("./server");
