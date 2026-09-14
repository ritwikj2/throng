import type { Vec } from "../../shared/types";

export interface MotionSnapshot {
  id: string;
  time: number;
  paused: boolean;
  creatures: readonly { id: string; position: Vec }[];
}
interface Frame {
  at: number;
  time: number;
  positions: Map<string, Vec>;
}
export interface MotionSample {
  time: number;
  positions: ReadonlyMap<string, Vec>;
}

/** A one-snapshot presentation delay, with no extrapolation on a stalled connection. */
export class MotionBuffer {
  private frames: Frame[] = [];
  private worldId = "";
  private paused = false;
  constructor(private readonly delay = 100) {}

  push(world: MotionSnapshot, receivedAt: number): void {
    const last = this.frames[this.frames.length - 1];
    if (
      world.id !== this.worldId ||
      (last && (world.time < last.time || receivedAt - last.at > 800)) ||
      world.paused ||
      this.paused
    ) {
      this.frames = [];
    }
    this.worldId = world.id;
    this.paused = world.paused;
    this.frames.push({
      at: receivedAt,
      time: world.time,
      positions: new Map(
        world.creatures.map((creature) => [creature.id, { ...creature.position }]),
      ),
    });
    if (this.frames.length > 8) this.frames.shift();
  }

  sample(now: number): MotionSample {
    const first = this.frames[0];
    if (!first) return { time: 0, positions: new Map() };
    const last = this.frames[this.frames.length - 1]!;
    if (this.paused || this.frames.length === 1 || now - this.delay >= last.at) return last;
    const target = now - this.delay;
    if (target <= first.at) return first;
    let before = first;
    for (let i = 1; i < this.frames.length; i++) {
      const after = this.frames[i]!;
      if (after.at >= target) {
        const fraction = Math.max(
          0,
          Math.min(1, (target - before.at) / Math.max(1, after.at - before.at)),
        );
        const positions = new Map<string, Vec>();
        for (const [id, destination] of after.positions) {
          const start = before.positions.get(id) ?? destination;
          // Loading/teleporting should not send a creature flying across the entire habitat.
          if (Math.hypot(destination.x - start.x, destination.y - start.y) > 8)
            positions.set(id, destination);
          else
            positions.set(id, {
              x: start.x + (destination.x - start.x) * fraction,
              y: start.y + (destination.y - start.y) * fraction,
            });
        }
        return { time: before.time + (after.time - before.time) * fraction, positions };
      }
      before = after;
    }
    return last;
  }
}
