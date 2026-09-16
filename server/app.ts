import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { WebSocketServer, WebSocket } from "ws";
import { createWorld, stepWorld, applyCommand } from "./simulation";
import {
  createCognition,
  readBrainConfig,
  type BrainConfig,
  type CognitionOptions,
} from "./cognition";
import { ColonyStore } from "./store";
import {
  connectionSchema,
  persistBrainConnection,
  verifyBrainAccess,
  BrainConnectionError,
  type ConnectionInput,
} from "./brain-connection";
import { commandSchema, newColonySchema } from "./validation";
import type { SceneState, WorldState } from "../shared/types";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export interface AppOptions {
  host?: string;
  port?: number;
  databasePath?: string;
  dev?: boolean;
  brain?: BrainConfig;
  autoTick?: boolean;
  initialWorld?: WorldState;
  brainEnvironmentPath?: string | false;
  cognitionOptions?: CognitionOptions;
  verifyBrainConnection?: (input: ConnectionInput) => Promise<BrainConfig>;
}
export async function createApp(options: AppOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error("Use a loopback HOST for this local game.");
  const store = new ColonyStore(options.databasePath ?? resolve(PROJECT_ROOT, "data", "throng.db"));
  let world: WorldState = options.initialWorld ?? store.active() ?? createWorld();
  let brainConfig = options.brain ?? readBrainConfig({ THRONG_BRAIN: "local" });
  world.cognitionMode = brainConfig.provider === "local" ? "local" : "model";
  let cognition = createCognition(brainConfig, options.cognitionOptions);
  store.save(world);
  let closed = false;
  let lastTick = performance.now();
  let saveError = false;
  let connectingBrain = false;
  let connectionAbort: AbortController | null = null;
  let connectionFinished: Promise<void> | null = null;
  let lastPublishedAt = 0;
  const scene = (): SceneState => {
    // Order simultaneous HTTP acknowledgements and socket frames unambiguously.
    lastPublishedAt = Math.max(Date.now(), lastPublishedAt + 0.001);
    const { rng: _rng, serial: _serial, creatures, ...rest } = world;
    return {
      ...rest,
      creatures: creatures.map((c) => {
        const {
          memories,
          beliefs,
          relationships,
          rewards: _rewards,
          actionStartNeeds: _start,
          ...visible
        } = c;
        return {
          ...visible,
          memoryCount: memories.length,
          knownObjects: beliefs.length,
          friendCount: relationships.filter((r) => r.trust > 40).length,
        };
      }),
      brain: cognition.status(),
      serverTime: lastPublishedAt,
    };
  };
  const broadcast = () => {
    if (closed || sockets.clients.size === 0) return;
    const payload = JSON.stringify({ type: "state", state: scene() });
    for (const client of sockets.clients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 512_000)
        client.send(payload);
    }
  };
  const save = () => {
    store.save(world);
    saveError = false;
  };
  const json = (res: ServerResponse, code: number, data: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  let port = options.port ?? 8791;
  const trusted = (req: IncomingMessage): boolean => {
    const authority = req.headers.host;
    if (!authority) return false;
    const valid = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
    if (!valid.has(authority.toLowerCase())) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${authority}`) return false;
    return true;
  };
  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new Error("content-type");
    if (Number(req.headers["content-length"] ?? 0) > 16_384) {
      req.resume();
      throw new Error("body-limit");
    }
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += bytes.length;
      if (size > 16_384) throw new Error("body-limit");
      parts.push(bytes);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  };
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (!trusted(req))
      return json(res, 403, { error: "Open the game through its localhost address." });
    if (closed) return json(res, 503, { error: "The game is stopping." });
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", `http://${req.headers.host}`).pathname);
    } catch {
      return json(res, 400, { error: "Invalid path." });
    }
    try {
      if (pathname === "/api/health" && req.method === "GET")
        return json(res, 200, { ok: !saveError, version: "1.0.0" });
      if (pathname === "/api/state" && req.method === "GET") return json(res, 200, scene());
      if (pathname === "/api/brain/connect" && req.method === "POST") {
        const parsed = connectionSchema.safeParse(await readJson(req));
        if (!parsed.success)
          return json(res, 400, {
            error:
              "Check the provider, model, credentials, endpoint, and request limit (1–60 per minute).",
          });
        if (connectingBrain)
          return json(res, 409, { error: "A brain connection is already being checked." });
        connectingBrain = true;
        const controller = new AbortController();
        connectionAbort = controller;
        let finishConnection = () => {};
        const finished = new Promise<void>((resolve) => {
          finishConnection = resolve;
        });
        connectionFinished = finished;
        const cancelCheck = () => {
          if (!res.writableFinished) controller.abort();
        };
        res.once("close", cancelCheck);
        let cancelVerification = () => {};
        const canceled = new Promise<never>((_, reject) => {
          cancelVerification = () =>
            reject(new BrainConnectionError("The connection check was canceled."));
          controller.signal.addEventListener("abort", cancelVerification, { once: true });
        });
        let replacement: ReturnType<typeof createCognition> | undefined;
        try {
          const verification = options.verifyBrainConnection
            ? options.verifyBrainConnection(parsed.data)
            : verifyBrainAccess(parsed.data, { signal: controller.signal });
          const nextConfig = await Promise.race([verification, canceled]);
          if (closed || controller.signal.aborted)
            throw new BrainConnectionError("The connection check was canceled.");
          replacement = createCognition(nextConfig, options.cognitionOptions);
          // Flush the world before committing credentials. A failed save must not
          // leave a new provider enabled after the request reports failure.
          save();
          if (options.brainEnvironmentPath !== false)
            await persistBrainConnection(
              options.brainEnvironmentPath ?? resolve(PROJECT_ROOT, ".env"),
              parsed.data,
              controller.signal,
            );
          // Settings are committed. Complete the matching runtime change without
          // another fallible database write, even if the response was disconnected.
          cognition.stop();
          brainConfig = nextConfig;
          cognition = replacement;
          replacement = undefined;
          world.cognitionMode = brainConfig.provider === "local" ? "local" : "model";
          if (closed) cognition.stop();
          else {
            cognition.tick(world);
            broadcast();
          }
          return json(res, 200, {
            brain: cognition.status(),
            verification: brainConfig.provider === "local" ? "offline" : "decision-tested",
          });
        } catch (error) {
          replacement?.stop();
          return json(res, 400, {
            error:
              error instanceof BrainConnectionError
                ? error.message
                : "The brain could not connect or save its settings. Check the provider, model, credentials, and server connection.",
          });
        } finally {
          controller.signal.removeEventListener("abort", cancelVerification);
          res.removeListener("close", cancelCheck);
          if (connectionAbort === controller) connectionAbort = null;
          connectingBrain = false;
          if (connectionFinished === finished) connectionFinished = null;
          finishConnection();
        }
      }
      if (pathname.startsWith("/api/creatures/") && req.method === "GET") {
        const creature = world.creatures.find(
          (c) => c.id === pathname.slice("/api/creatures/".length),
        );
        return creature
          ? json(res, 200, creature)
          : json(res, 404, { error: "This creature is not in the current colony." });
      }
      if (pathname === "/api/command" && req.method === "POST") {
        const parsed = commandSchema.safeParse(await readJson(req));
        if (!parsed.success)
          return json(res, 400, { error: "That action could not be read. Please try again." });
        const result = applyCommand(world, parsed.data);
        if (result.ok) {
          save();
          if (parsed.data.type === "pause") cognition.tick(world);
        }
        broadcast();
        return json(res, 200, { result, state: scene() });
      }
      if (pathname === "/api/colonies" && req.method === "GET") {
        save();
        return json(res, 200, store.list(world.id));
      }
      if (pathname === "/api/colonies" && req.method === "POST") {
        const parsed = newColonySchema.safeParse(await readJson(req));
        if (!parsed.success)
          return json(res, 400, { error: "Choose a colony name of 1–40 characters." });
        save();
        cognition.stop();
        world = createWorld(parsed.data.seed, parsed.data.name);
        world.cognitionMode = brainConfig.provider === "local" ? "local" : "model";
        cognition = createCognition(brainConfig, options.cognitionOptions);
        lastTick = performance.now();
        save();
        broadcast();
        return json(res, 201, scene());
      }
      if (/^\/api\/colonies\/[^/]+\/load$/.test(pathname) && req.method === "POST") {
        await readJson(req);
        const id = pathname.split("/")[3]!;
        const loaded = store.load(id);
        if (!loaded) return json(res, 404, { error: "Colony not found." });
        save();
        cognition.stop();
        world = loaded;
        world.cognitionMode = brainConfig.provider === "local" ? "local" : "model";
        cognition = createCognition(brainConfig, options.cognitionOptions);
        lastTick = performance.now();
        save();
        broadcast();
        return json(res, 200, scene());
      }
      if (pathname.startsWith("/api/")) return json(res, 404, { error: "Not found." });
      if (req.method !== "GET" && req.method !== "HEAD")
        return json(res, 405, { error: "Method not allowed." });
      if (vite) {
        vite.middlewares(req, res, () => json(res, 404, { error: "Not found." }));
        return;
      }
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      const base = resolve(PROJECT_ROOT, "dist");
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const path = resolve(base, relative);
      if (!path.startsWith(base + sep) || relative.split("/").some((s) => s.startsWith(".")))
        return json(res, 404, { error: "Not found." });
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch {
        return json(res, 404, { error: "Build the game with npm run build before starting." });
      }
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      };
      res.writeHead(200, {
        "Content-Type": mime[extname(path)] ?? "application/octet-stream",
        "Cache-Control": relative.startsWith("assets/")
          ? "public,max-age=31536000,immutable"
          : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      const code = (error as Error).message;
      if (code === "body-limit") return json(res, 413, { error: "That message is too large." });
      if (code === "content-type" || error instanceof SyntaxError)
        return json(res, 400, { error: "Send a valid JSON request." });
      json(res, 500, {
        error: "The action could not be saved. Your last saved colony is still available.",
      });
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/live") {
      if (!options.dev) socket.destroy();
      return;
    }
    if (!trusted(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req));
  });
  sockets.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "state", state: scene() }));
    socket.on("error", () => {});
  });
  const vite = options.dev
    ? await (
        await import("vite")
      ).createServer({
        root: PROJECT_ROOT,
        configFile: resolve(PROJECT_ROOT, "vite.config.ts"),
        server: { middlewareMode: true, hmr: { server }, allowedHosts: ["localhost", "127.0.0.1"] },
        appType: "spa",
      })
    : null;
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      ok();
    });
  });
  port = (server.address() as { port: number }).port;
  const tick = () => {
    const now = performance.now();
    let remaining = Math.min(0.25, Math.max(0, (now - lastTick) / 1000)) * world.speed;
    lastTick = now;
    if (!world.paused) {
      while (remaining > 0.00001) {
        const dt = Math.min(0.1, remaining);
        stepWorld(world, dt);
        remaining -= dt;
      }
    }
    cognition.tick(world);
  };
  const timer = options.autoTick === false ? null : setInterval(tick, 50);
  const network = setInterval(broadcast, 100);
  const persist = setInterval(() => {
    try {
      save();
    } catch {
      saveError = true;
    }
  }, 5000);
  return {
    port,
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    state: () => world,
    scene,
    tick,
    stop: async () => {
      if (closed) return;
      closed = true;
      const finishing = connectionFinished;
      connectionAbort?.abort();
      if (timer) clearInterval(timer);
      clearInterval(network);
      clearInterval(persist);
      cognition.stop();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await vite?.close();
      await new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      });
      await finishing;
      try {
        save();
      } finally {
        store.close();
      }
    },
  };
}
