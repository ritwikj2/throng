import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.ts";
import { createWorld, applyCommand, stepWorld } from "../server/simulation.ts";

// A reproducible synthetic colony, never a user's database or AI account.
const world = createWorld(31415, "THRONG — Sample experiment");
applyCommand(world, { type: "hatch" });
for (let frame = 0; frame < 3200; frame++) {
  if (frame % 300 === 0) {
    for (const creature of world.creatures.filter((c) => c.alive)) {
      applyCommand(world, {
        type: "care",
        tool: "wash",
        position: creature.position,
        creatureId: creature.id,
      });
      if (creature.needs.food < 75)
        applyCommand(world, {
          type: "care",
          tool: "feed",
          position: creature.position,
          creatureId: creature.id,
        });
      if (creature.needs.joy < 70)
        applyCommand(world, {
          type: "care",
          tool: "pet",
          position: creature.position,
          creatureId: creature.id,
        });
    }
  }
  stepWorld(world, 0.1);
}
const directory = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
mkdirSync(directory, { recursive: true });
const app = await createApp({
  port: 0,
  databasePath: ":memory:",
  initialWorld: world,
  autoTick: false,
  brainEnvironmentPath: false,
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(app.url);
  await page.getByTestId("world-canvas").waitFor();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: directory + "colony.png", fullPage: true });
  await page.getByRole("button", { name: "Toggle creature inspector" }).click();
  await page
    .getByLabel("Inspect a creature")
    .selectOption(world.creatures.find((creature) => creature.alive).id);
  await page.getByTestId("creature-thought").waitFor();
  await page.screenshot({ path: directory + "individual.png", fullPage: true });
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  await page.locator(".memory-records article").first().waitFor();
  await page.screenshot({ path: directory + "memory.png", fullPage: true });
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "Kill creature", exact: true }).click();
  await page.screenshot({ path: directory + "squash.png", fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Claude status:/ }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: directory + "connect-claude.png", fullPage: true });
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: directory + "mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.request.post(app.url + "/api/colonies", {
    data: { name: "THRONG — First experiment", seed: 31415 },
  });
  await page.getByRole("button", { name: "Hatch the egg" }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: directory + "beginning.png", fullPage: true });
  if (errors.length) throw new Error("The browser reported an error while capturing screenshots.");
  const report = {
    population: world.creatures.filter((c) => c.alive).length,
    stage: world.stage,
    simulatedSeconds: world.time,
    buildings: world.stats.built,
    sharedKnowledge: world.collective.sharedKnowledge,
    screenshots: [
      "colony.png",
      "individual.png",
      "memory.png",
      "squash.png",
      "connect-claude.png",
      "mobile.png",
      "beginning.png",
    ],
    synthetic: true,
    provider: "local",
    paidModelCalls: 0,
    capturedAt: new Date().toISOString(),
  };
  writeFileSync(directory + "capture.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await app.stop();
}
