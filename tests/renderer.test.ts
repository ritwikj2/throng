import { describe, expect, it } from "vitest";
import {
  clampToWorld,
  containsWorld,
  fitProjection,
  hash,
  keyboardStep,
  pointerPoint,
  pickCreature,
  project,
  spriteScale,
  unproject,
} from "../client/game/geometry";
import { MotionBuffer, type MotionSnapshot } from "../client/game/interpolation";
import { DeathMarks, DEATH_MARK_MS } from "../client/game/death";

describe("rectangular meadow input geometry", () => {
  it.each([
    [970, 550],
    [356, 400],
    [320, 320],
    [1440, 575],
    [240, 800],
    [1600, 320],
  ])("round-trips every region at a %i×%i viewport", (width, height) => {
    const projection = fitProjection(width, height, 32, 24);
    for (let x = 0; x <= 32; x += 1.25) {
      for (let y = 0; y <= 24; y += 1.75) {
        const screen = project({ x, y }, projection);
        const actual = unproject(screen, projection);
        expect(actual.x).toBeCloseTo(x, 9);
        expect(actual.y).toBeCloseTo(y, 9);
        expect(screen.x).toBeGreaterThanOrEqual(0);
        expect(screen.x).toBeLessThanOrEqual(width);
        expect(screen.y).toBeGreaterThanOrEqual(0);
        expect(screen.y).toBeLessThanOrEqual(height);
      }
    }
    const center = project({ x: 16, y: 12 }, projection);
    expect(center.x).toBeCloseTo(width / 2, 8);
    // Reserve actual sprite height, including the minimum readable scale on phones.
    const treeAtBack = project({ x: 1, y: 1 }, projection);
    expect(treeAtBack.y - 44 * spriteScale(projection)).toBeGreaterThanOrEqual(0);
    const front = project({ x: 31, y: 23 }, projection);
    expect(front.y + 4 * projection.scale).toBeLessThanOrEqual(height);
    const right = project({ x: 31, y: 1 }, projection);
    expect(right.x + 20 * projection.scale).toBeLessThanOrEqual(width);
  });

  it("maps screen directions directly and makes all meadow corners targetable", () => {
    const p = fitProjection(970, 550, 32, 24);
    const origin = project({ x: 5, y: 5 }, p);
    const right = project({ x: 6, y: 5 }, p);
    const down = project({ x: 5, y: 6 }, p);
    expect(right.x).toBeGreaterThan(origin.x);
    expect(right.y).toBe(origin.y);
    expect(down.x).toBe(origin.x);
    expect(down.y).toBeGreaterThan(origin.y);
    for (const point of [
      { x: 0, y: 0 },
      { x: 970, y: 0 },
      { x: 0, y: 550 },
      { x: 970, y: 550 },
    ]) {
      const target = clampToWorld(unproject(point, p), 32, 24);
      expect(containsWorld(target, 32, 24)).toBe(true);
      expect(target.x).toBeGreaterThanOrEqual(1);
      expect(target.y).toBeGreaterThanOrEqual(1);
      expect(target.x).toBeLessThanOrEqual(31);
      expect(target.y).toBeLessThanOrEqual(23);
    }
    expect(containsWorld({ x: NaN, y: 4 }, 32, 24)).toBe(false);
    expect(containsWorld({ x: 12, y: Infinity }, 32, 24)).toBe(false);
  });

  it("converts scaled pointer coordinates without applying the canvas pixel ratio twice", () => {
    const p = fitProjection(1000, 600, 32, 24);
    const body = project({ x: 16, y: 12 }, p);
    const box = { left: 30, top: 70, width: 500, height: 300 };
    const point = pointerPoint({ x: box.left + body.x / 2, y: box.top + body.y / 2 }, box, p);
    expect(point.x).toBeCloseTo(body.x);
    expect(point.y).toBeCloseTo(body.y);
    expect(unproject(point, p).x).toBeCloseTo(16);
    expect(unproject(point, p).y).toBeCloseTo(12);
  });

  it("keeps keyboard movement aligned with the rectangular screen axes", () => {
    expect(keyboardStep("ArrowRight", 0.5)).toEqual({ x: 0.5, y: 0 });
    expect(keyboardStep("ArrowLeft", 1.5)).toEqual({ x: -1.5, y: 0 });
    expect(keyboardStep("ArrowUp", 0.5)).toEqual({ x: 0, y: -0.5 });
    expect(keyboardStep("ArrowDown", 1.5)).toEqual({ x: 0, y: 1.5 });
    expect(keyboardStep("7", 0.5)).toBeNull();
  });

  it("keeps the one-unit command margin at every edge", () => {
    expect(clampToWorld({ x: -2, y: 26 }, 32, 24)).toEqual({ x: 1, y: 23 });
    expect(clampToWorld({ x: 40, y: -5 }, 32, 24)).toEqual({ x: 31, y: 1 });
    expect(clampToWorld({ x: 7.25, y: 12.125 }, 32, 24)).toEqual({ x: 7.25, y: 12.125 });
  });

  it.each([
    [970, 550],
    [356, 400],
  ])("picks the rendered body, not a newer server position, at %i×%i", (width, height) => {
    const p = fitProjection(width, height, 32, 24);
    const creatures = [
      { id: "moving", alive: true, position: { x: 23, y: 18 } },
      { id: "dead", alive: false, position: { x: 8, y: 8 } },
    ];
    const positions = new Map([["moving", { x: 8, y: 8 }]]);
    const foot = project({ x: 8, y: 8 }, p);
    const head = { x: foot.x, y: foot.y - 23 * spriteScale(p) };
    expect(pickCreature(head, creatures, p, positions)?.id).toBe("moving");
    expect(pickCreature(head, creatures, p, positions, true)?.id).toBe("moving");
    expect(pickCreature({ x: 2, y: 2 }, creatures, p, positions)).toBeNull();
  });

  it("keeps small sprites touchable and never targets a dead creature", () => {
    const p = fitProjection(320, 400, 32, 24);
    const creatures = [{ id: "a", alive: true, position: { x: 16, y: 12 } }];
    const foot = project(creatures[0]!.position, p);
    const edge = { x: foot.x + 21, y: foot.y - 15 * spriteScale(p) };
    expect(pickCreature(edge, creatures, p, undefined, true)?.id).toBe("a");
    expect(pickCreature(edge, creatures, p, undefined, false)).toBeNull();
    creatures[0]!.alive = false;
    expect(pickCreature(foot, creatures, p, undefined, true)).toBeNull();
  });

  it("produces the same static decoration noise after rendering a different seed", () => {
    const initial = Array.from({ length: 30 }, (_, i) => hash(42, i, 7));
    for (let i = 0; i < 30; i++) hash(99, i, 7);
    expect(Array.from({ length: 30 }, (_, i) => hash(42, i, 7))).toEqual(initial);
    expect(new Set(initial).size).toBe(30);
  });
});

function snapshot(time: number, x: number, extra: Partial<MotionSnapshot> = {}): MotionSnapshot {
  return {
    id: "one",
    time,
    paused: false,
    creatures: [{ id: "a", position: { x, y: 12 } }],
    ...extra,
  };
}

describe("snapshot presentation", () => {
  it("moves continuously between network updates and stops at the latest known position", () => {
    const buffer = new MotionBuffer(100);
    buffer.push(snapshot(0, 10), 0);
    buffer.push(snapshot(0.1, 12), 100);
    expect(buffer.sample(125).positions.get("a")?.x).toBeCloseTo(10.5);
    expect(buffer.sample(150).positions.get("a")?.x).toBeCloseTo(11);
    expect(buffer.sample(175).positions.get("a")?.x).toBeCloseTo(11.5);
    expect(buffer.sample(150).time).toBeCloseTo(0.05);
    expect(buffer.sample(10000).positions.get("a")?.x).toBe(12);
  });

  it("freezes at the authoritative paused position", () => {
    const buffer = new MotionBuffer();
    buffer.push(snapshot(0, 10), 0);
    buffer.push(snapshot(0.1, 12, { paused: true }), 100);
    expect(buffer.sample(100).positions.get("a")?.x).toBe(12);
    expect(buffer.sample(10000).positions.get("a")?.x).toBe(12);
  });

  it("does not interpolate across a colony load, time rollback, or long connection gap", () => {
    const buffer = new MotionBuffer();
    buffer.push(snapshot(4, 8), 0);
    buffer.push(snapshot(1, 20, { id: "two" }), 100);
    expect(buffer.sample(100).positions.get("a")?.x).toBe(20);
    buffer.push(snapshot(0.5, 16, { id: "two" }), 200);
    expect(buffer.sample(200).positions.get("a")?.x).toBe(16);
    buffer.push(snapshot(2, 18, { id: "two" }), 1500);
    expect(buffer.sample(1500).positions.get("a")?.x).toBe(18);
  });

  it("places new creatures at their birth position without flying in from the origin", () => {
    const buffer = new MotionBuffer();
    buffer.push(snapshot(0, 10), 0);
    buffer.push(
      snapshot(0.1, 11, {
        creatures: [
          { id: "a", position: { x: 11, y: 12 } },
          { id: "baby", position: { x: 11.5, y: 12.5 } },
        ],
      }),
      100,
    );
    expect(buffer.sample(150).positions.get("baby")).toEqual({ x: 11.5, y: 12.5 });
  });
});

describe("authoritative non-graphic death feedback", () => {
  function world(alive: boolean, id = "world", time = 1) {
    return { id, time, creatures: [{ id: "a", alive, position: { x: 16, y: 12 } }] };
  }

  it("creates one marker only after a seen live creature becomes dead", () => {
    const marks = new DeathMarks();
    const living = world(true);
    marks.update(living, 0);
    expect(marks.sample(20)).toEqual([]);
    marks.update(world(false, "world", 1.1), 100);
    expect(marks.sample(100)).toEqual([{ id: "a", at: 100, position: { x: 16, y: 12 } }]);
    marks.update(world(false, "world", 1.2), 200);
    expect(marks.sample(200)[0]?.at).toBe(100);
    expect(living.creatures[0]!.alive).toBe(true);
  });

  it("expires briefly on presentation time even while simulation time is paused", () => {
    const marks = new DeathMarks();
    marks.update(world(true), 0);
    marks.update(world(false), 100);
    marks.update(world(false), 1000);
    expect(marks.sample(100 + DEATH_MARK_MS - 1)).toHaveLength(1);
    expect(marks.sample(100 + DEATH_MARK_MS)).toEqual([]);
    marks.update(world(false), 5000);
    expect(marks.sample(5000)).toEqual([]);
  });

  it("does not replay old deaths on first load, colony changes, or time rollback", () => {
    const marks = new DeathMarks();
    marks.update(world(false), 0);
    expect(marks.sample(0)).toEqual([]);
    marks.update(world(true, "world", 2), 100);
    marks.update(world(false, "world", 3), 200);
    expect(marks.sample(200)).toHaveLength(1);
    marks.update(world(false, "new-world", 3), 300);
    expect(marks.sample(300)).toEqual([]);
    marks.update(world(true, "new-world", 4), 400);
    marks.update(world(false, "new-world", 2), 500);
    expect(marks.sample(500)).toEqual([]);
  });
});
