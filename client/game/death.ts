import type { Vec } from "../../shared/types";

export interface DeathMark {
  id: string;
  position: Vec;
  at: number;
}
export const DEATH_MARK_MS = 1800;

/** A visual transition observer, never a command or a simulation state mutation. */
export class DeathMarks {
  private worldId: string | null = null;
  private simulationTime = -Infinity;
  private known = new Map<string, boolean>();
  private marks = new Map<string, DeathMark>();

  update(
    world: {
      id: string;
      time: number;
      creatures: readonly { id: string; alive: boolean; position: Vec }[];
    },
    now: number,
  ): void {
    if (world.id !== this.worldId || world.time < this.simulationTime) this.clear();
    this.worldId = world.id;
    this.simulationTime = world.time;
    const current = new Map<string, boolean>();
    for (const creature of world.creatures) {
      if (!creature.alive && this.known.get(creature.id) === true) {
        this.marks.set(creature.id, {
          id: creature.id,
          position: { ...creature.position },
          at: now,
        });
      }
      if (creature.alive) this.marks.delete(creature.id);
      current.set(creature.id, creature.alive);
    }
    this.known = current;
    this.sample(now);
    while (this.marks.size > 64) this.marks.delete(this.marks.keys().next().value!);
  }

  sample(now: number): readonly DeathMark[] {
    for (const [id, mark] of this.marks) if (now - mark.at >= DEATH_MARK_MS) this.marks.delete(id);
    return [...this.marks.values()];
  }

  clear(): void {
    this.worldId = null;
    this.simulationTime = -Infinity;
    this.known.clear();
    this.marks.clear();
  }
}
