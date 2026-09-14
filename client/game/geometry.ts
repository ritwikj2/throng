import type { Vec } from "../../shared/types";

export interface Projection {
  width: number;
  height: number;
  mapWidth: number;
  mapHeight: number;
  origin: Vec;
  cellWidth: number;
  cellHeight: number;
  scale: number;
}

const positive = (value: number): number => (Number.isFinite(value) ? Math.max(1, value) : 1);
export const spriteScale = (projection: Projection): number => projection.scale;

/** Rectangular meadow: X points right, Y points down. All screen values are CSS pixels. */
export function fitProjection(
  width: number,
  height: number,
  mapWidth: number,
  mapHeight: number,
): Projection {
  width = positive(width);
  height = positive(height);
  mapWidth = positive(mapWidth);
  mapHeight = positive(mapHeight);
  const scale =
    Math.round(Math.max(1, Math.min(2, width / (mapWidth * 16), height / (mapHeight * 11))) * 4) /
    4;
  // Continuous grass also fills these edges. Reserve only enough room to keep
  // legal one-unit-margin objects, including a tree's crown, inside the viewport.
  const bottom = Math.min(height * 0.08, 5 * scale);
  const side = Math.min(
    width * 0.18,
    Math.max(3, (23 * scale - width / mapWidth) / Math.max(0.25, 1 - 2 / mapWidth)),
  );
  const top = Math.min(
    height * 0.3,
    Math.max(3, (44 * scale - (height - bottom) / mapHeight) / Math.max(0.25, 1 - 1 / mapHeight)),
  );
  return {
    width,
    height,
    mapWidth,
    mapHeight,
    scale,
    origin: { x: side, y: top },
    cellWidth: Math.max(0.001, (width - 2 * side) / mapWidth),
    cellHeight: Math.max(0.001, (height - top - bottom) / mapHeight),
  };
}

export function project(position: Vec, projection: Projection): Vec {
  return {
    x: projection.origin.x + position.x * projection.cellWidth,
    y: projection.origin.y + position.y * projection.cellHeight,
  };
}
export function unproject(position: Vec, projection: Projection): Vec {
  return {
    x: (position.x - projection.origin.x) / projection.cellWidth,
    y: (position.y - projection.origin.y) / projection.cellHeight,
  };
}

export function containsWorld(position: Vec, width: number, height: number): boolean {
  const epsilon = 1e-8;
  return (
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    position.x >= -epsilon &&
    position.y >= -epsilon &&
    position.x <= width + epsilon &&
    position.y <= height + epsilon
  );
}

export function clampToWorld(position: Vec, width: number, height: number, margin = 1): Vec {
  const mx = Math.min(margin, width / 2),
    my = Math.min(margin, height / 2);
  return {
    x: Math.max(mx, Math.min(width - mx, position.x)),
    y: Math.max(my, Math.min(height - my, position.y)),
  };
}

/** Pointer events and painting share CSS pixels even when the backing canvas uses DPR. */
export function pointerPoint(
  client: Vec,
  box: { left: number; top: number; width: number; height: number },
  projection: Projection,
): Vec {
  return {
    x: ((client.x - box.left) * projection.width) / Math.max(1, box.width),
    y: ((client.y - box.top) * projection.height) / Math.max(1, box.height),
  };
}

export function keyboardStep(key: string, step: number): Vec | null {
  switch (key) {
    case "ArrowUp":
      return { x: 0, y: -step };
    case "ArrowDown":
      return { x: 0, y: step };
    case "ArrowLeft":
      return { x: -step, y: 0 };
    case "ArrowRight":
      return { x: step, y: 0 };
    default:
      return null;
  }
}

export interface Pickable {
  id: string;
  position: Vec;
  alive: boolean;
}

/** Use the displayed body, with at least a 44px-wide touch target, rather than a future snapshot. */
export function pickCreature<T extends Pickable>(
  point: Vec,
  creatures: readonly T[],
  projection: Projection,
  positions?: ReadonlyMap<string, Vec>,
  touch = false,
): T | null {
  const unit = spriteScale(projection);
  const rx = Math.max(touch ? 22 : 14, 15 * unit);
  const ry = Math.max(touch ? 25 : 19, 19 * unit);
  let found: T | null = null,
    best = Infinity,
    depth = -Infinity;
  for (const creature of creatures) {
    if (!creature.alive) continue;
    const ground = project(positions?.get(creature.id) ?? creature.position, projection);
    const distance =
      ((point.x - ground.x) / rx) ** 2 + ((point.y - (ground.y - 15 * unit)) / ry) ** 2;
    if (
      distance <= 1 &&
      (distance < best - 1e-8 || (Math.abs(distance - best) < 1e-8 && ground.y > depth))
    ) {
      found = creature;
      best = distance;
      depth = ground.y;
    }
  }
  return found;
}

/** Decoration never consumes the simulation's random stream. */
export function hash(seed: number, x: number, y = 0): number {
  let value = (seed ^ Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 1, 0x119de1f3)) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}
export function hashId(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}
