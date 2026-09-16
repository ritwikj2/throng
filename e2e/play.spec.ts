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
  await page.getByRole("button", { name: /^Brain status:/ }).click();
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

test("a chosen Anthropic model clears its key and an accepted plan moves a creature", async ({
  page,
  app,
}) => {
  await page.goto(app.url);
  await settings(page);
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  await page.getByLabel("API model ID").fill("claude-model-of-choice");
  await page.getByLabel("API key", { exact: true }).fill("FAKE_PROVIDER_BROWSER_TEST_KEY");
  await page.getByRole("button", { name: "Connect brain", exact: true }).click();
  await expect(page.locator("#brain-connect-feedback")).toContainText("test decision passed");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  expect(app.scene().brain.model).toBe("claude-model-of-choice");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "FAKE_PROVIDER_BROWSER_TEST_KEY",
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
  await page.getByLabel("Provider", { exact: true }).selectOption("compatible");
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
  await page.getByLabel("Provider", { exact: true }).selectOption("compatible");
  const connection = await new AxeBuilder({ page }).analyze();
  expect(
    connection.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")),
  ).toEqual([]);
});

test("OpenAI API model selection and offline switching preserve the existing creature", async ({
  page,
  app,
}) => {
  await page.goto(app.url);
  await page.getByRole("button", { name: "Hatch the egg" }).click();
  await page.getByRole("button", { name: "Pause world", exact: true }).click();
  const worldId = app.state().id;
  const creatureId = app.state().creatures[0]!.id;
  await settings(page);
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  await page.getByLabel("API model ID").fill("codex-model-from-my-api-account");
  await page.getByLabel("API key", { exact: true }).fill("FAKE_PROVIDER_BROWSER_TEST_KEY");
  await expect(page.getByLabel(/Calls per minute/)).toHaveValue("24");
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/brain/connect"));
  await page.getByRole("button", { name: "Connect brain", exact: true }).click();
  expect((await sent).postDataJSON()).toEqual({
    provider: "openai",
    model: "codex-model-from-my-api-account",
    apiKey: "FAKE_PROVIDER_BROWSER_TEST_KEY",
    callsPerMinute: 24,
  });
  await expect(page.locator("#brain-connect-feedback")).toContainText("test decision passed");
  await expect(page.getByTestId("brain-status")).toContainText("OpenAI API");
  expect(app.scene().brain.model).toBe("codex-model-from-my-api-account");
  expect(app.scene().brain.apiStyle).toBe("responses");
  await page.getByLabel("Provider", { exact: true }).selectOption("local");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Connect brain", exact: true }).click();
  await expect(page.locator("#brain-connect-feedback")).toContainText("No model request was made");
  expect(app.state().cognitionMode).toBe("local");
  expect(app.state().id).toBe(worldId);
  expect(app.state().creatures[0]!.id).toBe(creatureId);
});

test("compatible endpoints use explicit protocol and clear keys before switching destinations", async ({
  page,
  app,
}) => {
  await page.goto(app.url);
  await settings(page);
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  await page.getByLabel("API key", { exact: true }).fill("FAKE_PROVIDER_BROWSER_TEST_KEY");
  await page.getByLabel("Provider", { exact: true }).selectOption("compatible");
  await expect(page.locator("#brain-api-key")).toHaveValue("");
  await page.getByLabel("API model ID").fill("local-model:small");
  await page.getByLabel("API base URL").fill("http://127.0.0.1:11434/v1");
  await expect(page.getByLabel("API protocol")).toHaveValue("chat-completions");
  await page.locator("#brain-api-key").fill("FAKE_PROVIDER_BROWSER_TEST_KEY");
  await page.getByLabel("API base URL").fill("http://localhost:11434/v1");
  await expect(page.locator("#brain-api-key")).toHaveValue("");
  await page.locator("#brain-api-key").fill("FAKE_PROVIDER_BROWSER_TEST_KEY");
  await page.getByLabel("API protocol").selectOption("responses");
  await expect(page.locator("#brain-api-key")).toHaveValue("");
  await page.getByLabel("API protocol").selectOption("chat-completions");
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/brain/connect"));
  await page.getByRole("button", { name: "Connect brain", exact: true }).click();
  const payload = (await sent).postDataJSON();
  expect(payload).toEqual({
    provider: "compatible",
    model: "local-model:small",
    baseURL: "http://localhost:11434/v1",
    apiStyle: "chat-completions",
    callsPerMinute: 24,
  });
  await expect(page.locator("#brain-connect-feedback")).toContainText("test decision passed");
  expect(app.scene().brain).toMatchObject({
    provider: "compatible",
    baseURL: "http://localhost:11434/v1",
    apiStyle: "chat-completions",
    ready: true,
  });
  await page.locator("#brain-api-key").fill("FAKE_PROVIDER_BROWSER_TEST_KEY");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await settings(page);
  await expect(page.locator("#brain-api-key")).toHaveValue("");
  await expect(page.getByLabel("API base URL")).toHaveValue("http://localhost:11434/v1");
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    "FAKE_PROVIDER_BROWSER_TEST_KEY",
  );
});

test("Bedrock selection uses a model and region without browser AWS credentials", async ({
  page,
  app,
}) => {
  await page.goto(app.url);
  await settings(page);
  await page.getByLabel("Provider", { exact: true }).selectOption("bedrock");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByLabel("Model or inference-profile ID").fill("us.anthropic.example-model");
  await page.getByLabel("AWS region").fill("us-east-1");
  await page.getByRole("button", { name: "Connect brain", exact: true }).click();
  await expect(page.locator("#brain-connect-feedback")).toContainText("test decision passed");
  expect(app.scene().brain).toMatchObject({
    provider: "bedrock",
    model: "us.anthropic.example-model",
    awsRegion: "us-east-1",
    ready: true,
  });
});
