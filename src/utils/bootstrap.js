const { spawn } = require("child_process");
const path = require("path");

const runCommand = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });

const shouldAutoMigrate = () => {
  const raw = String(process.env.AUTO_MIGRATE || "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
};

const ensureDatabaseReady = async () => {
  if (!shouldAutoMigrate()) {
    return;
  }

  const projectRoot = path.resolve(__dirname, "..", "..");
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

  await runCommand(npxCmd, ["prisma", "generate"], projectRoot);
  await runCommand(npxCmd, ["prisma", "migrate", "deploy"], projectRoot);
};

module.exports = {
  ensureDatabaseReady,
};

