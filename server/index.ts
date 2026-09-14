import { resolve } from "node:path";
import { createApp, PROJECT_ROOT } from "./app";
import { readBrainConfig } from "./cognition";
try {
  try {
    process.loadEnvFile(resolve(PROJECT_ROOT, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const port = Number(process.env.PORT ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  const app = await createApp({
    host: process.env.HOST ?? "127.0.0.1",
    port,
    databasePath: resolve(
      process.env.THRONG_DATA_DIR ?? resolve(PROJECT_ROOT, "data"),
      "throng.db",
    ),
    dev: process.env.NODE_ENV !== "production",
    brain: readBrainConfig(process.env),
  });
  console.log(`Throng is ready at ${app.url}`);
  console.log(
    "Your colony is saved locally. Pause the world or stop this server to stop its clock.",
  );
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void app.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  console.error(
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? "That port is in use. Stop the other game or set PORT in .env."
      : "Throng could not start. Check .env, the data directory, and your provider settings.",
  );
  process.exitCode = 1;
}
