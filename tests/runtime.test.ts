import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { request as httpRequest } from "node:http";
import { createApp } from "../server/app";
import type { SceneState, Creature, Command } from "../shared/types";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function start(extra: Parameters<typeof createApp>[0] = {}) {
  const app = await createApp({ port: 0, databasePath: ":memory:", autoTick: false, ...extra });
  apps.push(app);
  return app;
}
async function command(app: Awaited<ReturnType<typeof start>>, body: Command) {
  const response = await fetch(`${app.url}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    result: { ok: boolean; creatureId?: string };
    state: SceneState;
  }>;
}
describe("local game runtime", () => {
  it("hatches a real creature and exposes its private history only in the focused inspector", async () => {
    const app = await start();
    expect((await (await fetch(`${app.url}/api/state`)).json()).hatched).toBe(false);
    const response = await command(app, { type: "hatch" });
    expect(response.result.ok).toBe(true);
    expect(response.state.creatures).toHaveLength(1);
    expect(response.state.creatures[0]).not.toHaveProperty("memories");
    expect(response.state.creatures[0]).not.toHaveProperty("beliefs");
    expect(response.state.creatures[0]).not.toHaveProperty("relationships");
    const creature = (await (
      await fetch(`${app.url}/api/creatures/${response.state.creatures[0]!.id}`)
    ).json()) as Creature;
    expect(Array.isArray(creature.memories)).toBe(true);
    expect(creature.intention.text.length).toBeGreaterThan(0);
    expect((await fetch(`${app.url}/api/creatures/absent`)).status).toBe(404);
  });
  it("rejects invalid actions without changing the world", async () => {
    const app = await start();
    const before = JSON.stringify(app.state());
    for (const body of [
      { type: "care", tool: "feed", position: { x: -3, y: 2 } },
      { type: "speed", speed: 900 },
      { type: "message", text: "x".repeat(281) },
      { type: "hatch", secret: "unexpected" },
    ]) {
      const response = await fetch(`${app.url}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(JSON.stringify(app.state())).toBe(before);
  });
  it("rejects cross-site commands and rebinding hosts", async () => {
    const app = await start();
    const badHeaders: Record<string, string>[] = [
      { Origin: "https://outside.example" },
      { Host: `outside.example:${app.port}` },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const extra of badHeaders) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          `${app.url}/api/command`,
          { method: "POST", headers: { "Content-Type": "application/json", ...extra } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.once("error", reject);
        req.end('{"type":"hatch"}');
      });
      expect(status, JSON.stringify(extra)).toBe(403);
    }
    expect(app.state().hatched).toBe(false);
    const allowed = await fetch(`${app.url}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: app.url },
      body: '{"type":"hatch"}',
    });
    expect(allowed.status).toBe(200);
  });
  it("validates JSON content and enforces request size", async () => {
    const app = await start();
    const malformed = await fetch(`${app.url}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const text = await fetch(`${app.url}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: '{"type":"hatch"}',
    });
    expect(text.status).toBe(400);
    const large = await fetch(`${app.url}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "message", text: "a".repeat(20_000) }),
    });
    expect(large.status).toBe(413);
  });
  it("keeps old colonies when starting another, then restores identities and memories", async () => {
    const app = await start();
    await command(app, { type: "hatch" });
    const original = structuredClone(app.state());
    const created = await fetch(`${app.url}/api/colonies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second beginning", seed: 123 }),
    });
    expect(created.status).toBe(201);
    const second = (await created.json()) as SceneState;
    expect(second.id).not.toBe(original.id);
    expect(second.name).toBe("Second beginning");
    expect(second.hatched).toBe(false);
    const saved = await (await fetch(`${app.url}/api/colonies`)).json();
    expect(saved).toHaveLength(2);
    const loaded = await fetch(`${app.url}/api/colonies/${original.id}/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(loaded.status).toBe(200);
    expect(app.state()).toEqual(original);
  });
  it("survives a process restart without advancing offline simulation time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "throng-save-"));
    dirs.push(dir);
    const databasePath = join(dir, "world.db");
    const first = await start({ databasePath });
    await command(first, { type: "hatch" });
    await command(first, { type: "pause", paused: true });
    const snapshot = structuredClone(first.state());
    await first.stop();
    const second = await start({ databasePath });
    expect(second.state()).toEqual(snapshot);
  });
  it("streams state and rejects cross-origin websocket connections", async () => {
    const app = await start();
    const socket = new WebSocket(`${app.url.replace("http", "ws")}/live`, { origin: app.url });
    const first = await new Promise<{ type: string; state: SceneState }>((resolve, reject) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      socket.once("error", reject);
    });
    expect(first.type).toBe("state");
    expect(first.state.id).toBe(app.state().id);
    socket.close();
    const bad = new WebSocket(`${app.url.replace("http", "ws")}/live`, {
      origin: "https://outside.example",
    });
    await expect(
      new Promise((resolve, reject) => {
        bad.once("open", resolve);
        bad.once("error", reject);
      }),
    ).rejects.toThrow("403");
  });
  it("does not expose local configuration or unknown files", async () => {
    const app = await start();
    for (const path of ["/api/missing", "/.env", "/server/index.ts", "/data/throng.db"])
      expect((await fetch(app.url + path)).status).toBe(404);
    const health = await (await fetch(`${app.url}/api/health`)).json();
    expect(health).toEqual({ ok: true, version: "1.0.0" });
  });
});
