import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SaveInfo, WorldState } from "../shared/types";

export class ColonyStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS colonies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, population INTEGER NOT NULL, time REAL NOT NULL, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  save(world: WorldState, active = true): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO colonies VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at,
      population=excluded.population, time=excluded.time, state=excluded.state`,
      )
      .run(
        world.id,
        world.name,
        world.createdAt,
        now,
        world.creatures.filter((c) => c.alive).length,
        world.time,
        JSON.stringify(world),
      );
    if (active)
      this.db
        .prepare(
          "INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run("active", world.id);
  }
  active(): WorldState | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='active'").get() as
      { value: string } | undefined;
    return row ? this.load(row.value) : null;
  }
  load(id: string): WorldState | null {
    const row = this.db.prepare("SELECT state FROM colonies WHERE id=?").get(id) as
      { state: string } | undefined;
    if (!row) return null;
    const world = JSON.parse(row.state) as WorldState;
    if (
      world.version !== 1 ||
      typeof world.id !== "string" ||
      !Array.isArray(world.creatures) ||
      !Array.isArray(world.objects) ||
      !world.collective
    )
      throw new Error("Unsupported colony save.");
    for (const creature of world.creatures) creature.modelPending = false;
    return world;
  }
  list(activeId: string): SaveInfo[] {
    const rows = this.db
      .prepare(
        "SELECT id,name,created_at,updated_at,population,time FROM colonies ORDER BY updated_at DESC",
      )
      .all() as {
      id: string;
      name: string;
      created_at: string;
      updated_at: string;
      population: number;
      time: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      population: r.population,
      time: r.time,
      active: r.id === activeId,
    }));
  }
  close(): void {
    this.db.close();
  }
}
