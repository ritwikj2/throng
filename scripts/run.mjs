import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const command = process.argv[2];
const commands = {
  dev: () => [
    require.resolve("tsx/cli"),
    "watch",
    "--clear-screen=false",
    "--ignore",
    "./data/**",
    "server/index.ts",
  ],
  start: () => ["--import", "tsx", "server/index.ts"],
  e2e: () => [require.resolve("@playwright/test/cli"), "test"],
};
if (!Object.hasOwn(commands, command)) {
  console.error("Choose dev, start, or e2e.");
  process.exit(1);
}
const child = spawn(process.execPath, [...commands[command](), ...process.argv.slice(3)], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"]
      .filter(Boolean)
      .join(" "),
    ...(command === "start" ? { NODE_ENV: "production" } : {}),
    ...(command === "dev" ? { CHOKIDAR_USEPOLLING: "true", CHOKIDAR_INTERVAL: "400" } : {}),
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", () => {
  console.error("Could not start. Run npm ci and try again.");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
