import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { fitProjection, project } from "../client/game/geometry";
import { makeCreature } from "../server/simulation-core";
import type { Vec, WorldState } from "../shared/types";

async function clickCreature(page: Page, world: WorldState, point: Vec) {
  const canvas = page.getByTestId("world-canvas");
  const bounds = (await canvas.boundingBox())!;
  const view = fitProjection(bounds.width, bounds.height, world.width, world.height);
  const pixel = project(point, view);
  await canvas.click({ position: { x: pixel.x, y: pixel.y - 8 * view.scale } });
}
async function settings(page: Page) {
  await page.getByRole("button", { name: /^Claude status:/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("hatch, care, inspect memories, and control time in the new interface", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.url);
  await page.getByRole("button", { name: "Hatch the egg" }).click();
  const creature = app.state().creatures[0]!;
  await page.getByRole("button", { name: "Pause world", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume world", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apple tool", exact: true }).click();
  await clickCreature(page, app.state(), creature.position);
  await expect.poll(() => app.state().care.fed).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Wash tool", exact: true }).click();
  await clickCreature(page, app.state(), creature.position);
  await expect.poll(() => app.state().care.washed).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Toggle creature inspector" }).click();
  await expect(page.getByTestId("creature-thought")).toBeVisible();
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("washed");
  await page.getByRole("tab", { name: "Memory", exact: true }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Neighbors" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "4 times simulation speed" }).click();
  await expect.poll(() => app.state().speed).toBe(4);
  await page.getByRole("button", { name: "Resume world", exact: true }).click();
  await expect.poll(() => app.state().time).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test("saved worlds survive starting and loading a separate experiment", async ({ page, app }) => {
  await page.goto(app.url);
  await page.getByRole("button", { name: "Hatch the egg" }).click();
  const oldId = app.state().id;
  const creatureId = app.state().creatures[0]!.id;
  await page.getByRole("button", { name: "World files", exact: true }).click();
  await page.getByLabel("New world name").fill("Another experiment");
  await page.getByRole("button", { name: "New world", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hatch the egg" })).toBeVisible();
  await expect(page.locator(".window-document")).toHaveText("Another experiment");
  expect(app.state().id).not.toBe(oldId);
  await page.getByRole("button", { name: "World files", exact: true }).click();
  await page.locator(".file-list button").filter({ hasText: "Little beginning" }).click();
  await expect.poll(() => app.state().id).toBe(oldId);
  expect(app.state().creatures[0]!.id).toBe(creatureId);
});

test("colony terminal accepts messages without moving the page", async ({ page, app }) => {
  await page.goto(app.url);
  await page.getByRole("button", { name: "Hatch the egg" }).click();
  await page.getByRole("button", { name: "Toggle colony voice" }).click();
  await page.getByLabel("Speak to the Throng").fill("I will care for you.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("I will care for you.");
  await expect(page.getByLabel("Speak to the Throng")).toHaveValue("");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("squash requires a creature hit and leaves a witnessed loss", async ({ page, app }) => {
  await page.goto(app.url);
  await page.getByRole("button", { name: "Hatch the egg" }).click();
  await page.getByRole("button", { name: "Pause world", exact: true }).click();
  const victim = app.state().creatures[0]!;
  const witness = makeCreature(
    app.state(),
    { x: victim.position.x + 2, y: victim.position.y },
    victim,
  );
  await expect
    .poll(async () =>
      (await page.request.get(`${app.url}/api/state`))
        .json()
        .then((state) => state.creatures.length),
    )
    .toBe(2);
  await page.getByRole("button", { name: "Kill creature", exact: true }).click();
  await clickCreature(page, app.state(), { x: 2, y: 22 });
  expect(app.state().stats.deaths).toBe(0);
  await clickCreature(page, app.state(), victim.position);
  await expect.poll(() => victim.alive).toBe(false);
  expect(witness.alive).toBe(true);
  expect(app.state().stats.deaths).toBe(1);
  expect(
    witness.memories.some((memory) => memory.kind === "loss" && memory.actor === "player"),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Observe tool", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("Claude connection clears the key and an accepted AI plan moves a creature", async ({
  page,
  app,
}) => {
  await page.goto(app.url);
  await settings(page);
  await page.getByLabel("Anthropic API key").fill("FAKE_CLAUDE_BROWSER_TEST_KEY");
  await page.getByRole("button", { name: "Connect Claude", exact: true }).click();
  await expect(
    page.getByText("Access verified. Live status will update from the server."),
  ).toBeVisible();
  await expect(page.getByLabel("Anthropic API key")).toHaveValue("");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "FAKE_CLAUDE_BROWSER_TEST_KEY",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Hatch the egg" }).click();
  const startX = app.state().creatures[0]!.position.x;
  await expect.poll(() => app.scene().brain.accepted ?? 0).toBeGreaterThan(0);
  await expect.poll(() => app.state().creatures[0]!.position.x).toBeGreaterThan(startX + 0.2);
  expect(app.state().creatures[0]!.cognition?.goal).toBe("Find a useful place on the east side.");
  await page.getByRole("button", { name: "Toggle creature inspector" }).click();
  await expect(page.getByRole("complementary", { name: "Creature inspector" })).toContainText(
    "Find a useful place on the east side.",
  );
  await page.getByRole("button", { name: "Toggle colony voice" }).click();
  await page.getByLabel("Speak to the Throng").fill("Can you hear me?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() =>
      app
        .state()
        .collective.messages.some(
          (message) => message.source === "model" && message.text.includes("I hear you"),
        ),
    )
    .toBe(true);
});

test("mobile controls and connection dialogs fit the viewport", async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.url);
  await page.getByRole("button", { name: "Hatch the egg" }).click();
  await expect(page.getByTestId("world-canvas")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await settings(page);
  const box = await page.getByRole("dialog").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "How to play" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("game, inspector, and connection settings avoid serious accessibility violations", async ({
  page,
  app,
}) => {
  await page.goto(app.url);
  const egg = await new AxeBuilder({ page }).analyze();
  expect(egg.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual(
    [],
  );
  await page.getByRole("button", { name: "Hatch the egg" }).click();
  await page.getByRole("button", { name: "Toggle creature inspector" }).click();
  await expect(page.getByTestId("creature-thought")).toBeVisible();
  const colony = await new AxeBuilder({ page }).analyze();
  expect(colony.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual(
    [],
  );
  await settings(page);
  const connection = await new AxeBuilder({ page }).analyze();
  expect(
    connection.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")),
  ).toEqual([]);
});
