import { readFileSync, writeFileSync } from "node:fs";
try {
  writeFileSync(
    new URL("../.env", import.meta.url),
    readFileSync(new URL("../.env.example", import.meta.url)),
    { flag: "wx", mode: 0o600 },
  );
  console.log("Created .env. Start the game, then use Simulation → Connect brain to add your key.");
} catch (error) {
  if (error.code === "EEXIST") console.log("Your existing .env was kept.");
  else {
    console.error("Could not create .env. Check the folder permissions.");
    process.exitCode = 1;
  }
}
