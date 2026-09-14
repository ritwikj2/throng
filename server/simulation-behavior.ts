import { STRUCTURES } from "../shared/types.js";
import type {
  ActionKind,
  Creature,
  Intention,
  Need,
  ObjectKind,
  StructureKind,
  Vec,
  WorldObject,
  WorldState,
} from "../shared/types.js";
import {
  clamp,
  distance,
  event,
  home,
  idle,
  intention,
  living,
  needFor,
  object,
  observation,
  point,
  random,
  readable,
  REACH,
  remember,
  say,
  setIntention,
  urgent,
  VISION,
} from "./simulation-core.js";
import { experience, socialize, utter } from "./simulation-learning.js";

export const structureKind = (kind: string): kind is StructureKind =>
  Object.hasOwn(STRUCTURES, kind);
export function projectReady(site: WorldObject): boolean {
  if (site.built || !structureKind(site.kind)) return false;
  const cost = STRUCTURES[site.kind];
  return site.amount >= cost.wood && site.capacity >= cost.stone;
}
export function createSite(
  world: WorldState,
  kind: StructureKind,
  position: Vec,
): WorldObject | undefined {
  if (world.objects.some((item) => item.kind === kind)) return undefined;
  // While unbuilt, amount/capacity hold delivered wood/stone. On completion,
  // they become the facility's stock/service capacity. This ledger is saved.
  const site = object(world, kind, position, 0, 0, false);
  if (site)
    event(
      world,
      "building",
      `${STRUCTURES[kind].name} planned; materials must reach the colony before construction.`,
    );
  return site;
}
export function fundProjects(world: WorldState): void {
  for (const site of world.objects) {
    if (site.built || !structureKind(site.kind)) continue;
    const cost = STRUCTURES[site.kind];
    const wood = Math.max(0, Math.min(cost.wood - site.amount, world.resources.wood));
    const stone = Math.max(0, Math.min(cost.stone - site.capacity, world.resources.stone));
    site.amount += wood;
    site.capacity += stone;
    world.resources.wood -= wood;
    world.resources.stone -= stone;
  }
}
function proposeProject(world: WorldState): void {
  if (world.objects.some((o) => !o.built)) return;
  const population = living(world).length;
  const kind = (["feeder", "bath", "carousel", "beacon"] as const).find(
    (value) =>
      population >= STRUCTURES[value].population && !world.objects.some((o) => o.kind === value),
  );
  if (!kind) return;
  const center = home(world);
  for (let index = 0; index < 16; index++) {
    const angle = (index * Math.PI) / 4;
    const radius = index < 8 ? 3.2 : 5;
    const position = point(world, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
    if (
      !world.objects.some(
        (o) => distance(o.position, position) < 1.4 && o.kind !== "apple" && o.kind !== "ball",
      )
    ) {
      createSite(world, kind, position);
      return;
    }
  }
}
export function knownObjects(world: WorldState, creature: Creature): WorldObject[] {
  const visible = world.objects.filter(
    (item) => distance(item.position, creature.position) <= VISION,
  );
  const visibleIds = new Set(visible.map((item) => item.id));
  const remembered = creature.beliefs
    .filter(
      (belief) =>
        !visibleIds.has(belief.objectId) && distance(belief.position, creature.position) > VISION,
    )
    .map((belief): WorldObject => ({
      id: belief.objectId,
      kind: belief.kind,
      position: { ...belief.position },
      // Old saves without a snapshot know the place, not its availability.
      amount: belief.observed?.amount ?? 0,
      capacity: belief.observed?.capacity ?? 0,
      built: belief.observed?.built ?? false,
      progress: belief.observed?.progress ?? 0,
      createdAt: belief.learnedAt,
      lastUsedAt: belief.observed?.at ?? belief.learnedAt,
    }));
  return [...visible, ...remembered];
}
function shortage(world: WorldState, material: "wood" | "stone"): number {
  return world.objects.reduce((total, site) => {
    if (site.built || !structureKind(site.kind)) return total;
    return (
      total +
      Math.max(
        0,
        STRUCTURES[site.kind][material] - (material === "wood" ? site.amount : site.capacity),
      )
    );
  }, 0);
}
export const actionForNeed = (need: Need): ActionKind =>
  ({ food: "eat", clean: "wash", joy: "play", rest: "rest", social: "socialize" })[
    need
  ] as ActionKind;
interface Candidate {
  action: ActionKind;
  score: number;
  target?: WorldObject;
  neighbor?: Creature;
  destination?: Vec;
}
export function choosePlan(world: WorldState, creature: Creature): void {
  proposeProject(world);
  const bodyUrgency = urgent(creature);
  const danger = [...creature.memories]
    .reverse()
    .find(
      (memory) =>
        memory.kind === "loss" &&
        memory.actor === "player" &&
        memory.sourceId === "player" &&
        world.time - memory.at < 25 &&
        memory.position &&
        distance(creature.position, memory.position) < 3.5,
    );
  if (!bodyUrgency && danger?.position) {
    let dx = creature.position.x - danger.position.x;
    let dy = creature.position.y - danger.position.y;
    if (Math.hypot(dx, dy) < 0.1) {
      const angle = random(world) * Math.PI * 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    }
    const length = Math.hypot(dx, dy);
    let destination = point(world, {
      x: creature.position.x + (dx / length) * 3,
      y: creature.position.y + (dy / length) * 3,
    });
    if (distance(destination, creature.position) < 0.5) {
      // At a corner, move along the boundary instead of repeatedly completing
      // an immobile retreat that points outside the field.
      destination =
        [
          { x: creature.position.x + 3, y: creature.position.y },
          { x: creature.position.x - 3, y: creature.position.y },
          { x: creature.position.x, y: creature.position.y + 3 },
          { x: creature.position.x, y: creature.position.y - 3 },
        ]
          .map((candidate) => point(world, candidate))
          .filter((candidate) => distance(candidate, creature.position) >= 0.5)
          .sort((a, b) => distance(b, danger.position!) - distance(a, danger.position!))[0] ??
        destination;
    }
    const retreat = intention(
      world,
      "walk",
      "Move away from where I saw the player kill.",
      `I witnessed this loss (${danger.id}); I need some distance.`,
      destination,
      undefined,
      [danger.id],
    );
    setIntention(creature, retreat, world);
    return;
  }
  if (creature.carried && !bodyUrgency) {
    const plan = intention(
      world,
      "gather",
      `Bring ${creature.carried.amount} ${creature.carried.kind} home.`,
      "Materials become usable only when I deliver them.",
      home(world),
    );
    plan.until = world.time + 70;
    setIntention(creature, plan, world);
    return;
  }
  const candidates: Candidate[] = [];
  for (const target of knownObjects(world, creature)) {
    const separation = distance(creature.position, target.position);
    const preference = (creature.preferences[target.kind] ?? 0) * 0.18;
    let action: ActionKind | undefined;
    let score = 0;
    if (!target.built) {
      if (projectReady(target)) {
        action = "build";
        score = 62;
      }
    } else if (
      (target.kind === "apple" || target.kind === "feeder") &&
      target.amount >= 1 &&
      creature.needs.food < 92
    ) {
      action = "eat";
      score = (100 - creature.needs.food) * 0.9;
    } else if (target.kind === "bath" && creature.needs.clean < 92) {
      action = "wash";
      score = (100 - creature.needs.clean) * 0.8 + 2;
    } else if ((target.kind === "ball" || target.kind === "carousel") && creature.needs.joy < 92) {
      action = "play";
      score = (100 - creature.needs.joy) * 0.75 + (target.kind === "carousel" ? 2 : 0);
    } else if (
      (target.kind === "tree" || target.kind === "rock") &&
      target.amount >= 1 &&
      !creature.carried
    ) {
      const material = target.kind === "tree" ? "wood" : "stone";
      const needed = shortage(world, material);
      if (needed > 0 || world.resources[material] < (material === "wood" ? 20 : 14)) {
        action = "gather";
        score = needed > 0 ? 42 + Math.min(needed, 8) : 9 + creature.traits.diligence * 0.08;
      }
    } else if (target.kind === "beacon") {
      action = "sing";
      score = (100 - creature.needs.joy) * 0.4 + (100 - creature.needs.social) * 0.4 + 4;
    }
    if (action)
      candidates.push({
        action,
        target,
        score: score + preference + (creature.rewards[action]?.mean ?? 0) * 4 - separation * 0.7,
      });
  }
  candidates.push({ action: "rest", score: (100 - creature.needs.rest) * 0.75 - 2 });
  candidates.push({ action: "wash", score: (100 - creature.needs.clean) * 0.45 - 6 });
  candidates.push({
    action: "sing",
    score: (100 - creature.needs.joy) * 0.32 + (100 - creature.needs.social) * 0.2 - 2,
  });
  if (world.time - creature.lastSocialAt >= 10) {
    for (const neighbor of living(world).filter(
      (other) => other.id !== creature.id && distance(other.position, creature.position) <= VISION,
    )) {
      const familiar = creature.relationships.find(
        (relationship) => relationship.id === neighbor.id,
      );
      candidates.push({
        action: "socialize",
        neighbor,
        score:
          (100 - creature.needs.social) * 0.7 +
          creature.traits.sociability * 0.06 +
          (familiar ? 1 : 13) -
          distance(neighbor.position, creature.position) * 0.8,
      });
    }
  }
  let candidate: Candidate | undefined;
  if (bodyUrgency) {
    const expected = actionForNeed(bodyUrgency);
    candidate = candidates
      .filter(
        (choice) =>
          choice.action === expected ||
          ((bodyUrgency === "social" || bodyUrgency === "joy") && choice.action === "sing"),
      )
      .sort((a, b) => b.score - a.score)[0];
  } else {
    candidates.push({ action: "walk", score: 6 + creature.traits.curiosity * 0.08 });
    candidate = candidates.sort((a, b) => b.score - a.score)[0];
  }
  if (!candidate) candidate = { action: "walk", score: 0 };
  const target = candidate.target;
  let destination = target?.position ?? candidate.neighbor?.position;
  if (candidate.action === "walk") {
    const angle = random(world) * Math.PI * 2;
    destination = point(world, {
      x: creature.position.x + Math.cos(angle) * 5.5,
      y: creature.position.y + Math.sin(angle) * 5.5,
    });
  }
  const need = needFor(candidate.action);
  const relevant = creature.memories
    .filter((memory) =>
      target
        ? memory.subjectId === target.id
        : need
          ? memory.need === need
          : memory.kind === "experience",
    )
    .slice(-3)
    .map((memory) => memory.id);
  const belief = creature.beliefs.find((entry) => entry.objectId === target?.id);
  const reason = `${need ? `${need} is ${creature.needs[need].toFixed(0)}/100. ` : "Local work and exploration policy. "}${target ? `${readable(target.kind)}: ${belief?.source ?? "visible"}; learned preference ${(creature.preferences[target.kind] ?? 0).toFixed(1)}.` : bodyUrgency === "food" ? "I need to look for food I have not found yet." : `Based on ${creature.learningCount} completed experiences.`}`;
  const content =
    candidate.action === "socialize"
      ? `Meet ${candidate.neighbor?.name ?? "a neighbor"}.`
      : candidate.action === "walk"
        ? `Look near ${destination?.x.toFixed(1)}, ${destination?.y.toFixed(1)}.`
        : `${candidate.action[0]?.toUpperCase()}${candidate.action.slice(1)}${target ? ` at the ${readable(target.kind)}` : " here"}.`;
  const plan = intention(
    world,
    candidate.action,
    content,
    reason,
    destination,
    target?.id ?? candidate.neighbor?.id,
    relevant,
  );
  if (candidate.action === "gather") plan.until = world.time + 70;
  setIntention(creature, plan, world);
}
function move(
  world: WorldState,
  creature: Creature,
  destination: Vec,
  dt: number,
  reach = REACH,
): boolean {
  const goal = point(world, destination);
  const separation = distance(creature.position, goal);
  if (separation <= reach) return true;
  const travel = Math.min(separation - reach, dt * (1.55 + creature.traits.diligence * 0.006));
  const dx = ((goal.x - creature.position.x) / separation) * travel;
  const dy = ((goal.y - creature.position.y) / separation) * travel;
  creature.position = point(world, { x: creature.position.x + dx, y: creature.position.y + dy });
  if (Math.abs(dx) > 0.00001) creature.facing = dx > 0 ? 1 : -1;
  creature.action = "walk";
  return distance(creature.position, goal) <= reach + 0.000001;
}
function hasSlot(world: WorldState, creature: Creature, target: WorldObject): boolean {
  const slots = target.kind === "carousel" || target.kind === "beacon" ? target.capacity : 1;
  const waiting = living(world)
    .filter(
      (other) =>
        other.intention.targetId === target.id &&
        distance(other.position, target.position) <= REACH + 0.01,
    )
    .sort((a, b) => a.intention.since - b.intention.since || a.id.localeCompare(b.id));
  return waiting.slice(0, Math.max(1, slots)).some((other) => other.id === creature.id);
}
function complete(
  world: WorldState,
  creature: Creature,
  action: ActionKind,
  target?: WorldObject,
  bonus = 0,
): void {
  if (target) target.lastUsedAt = world.time;
  experience(world, creature, action, target?.kind, target?.id, bonus);
  idle(world, creature);
}
function abandon(world: WorldState, creature: Creature, message: string): void {
  const target = creature.beliefs.find((belief) => belief.objectId === creature.intention.targetId);
  experience(
    world,
    creature,
    creature.intention.action,
    target?.kind,
    target?.objectId,
    0,
    message,
  );
  if (target && distance(target.position, creature.position) <= VISION)
    creature.beliefs = creature.beliefs.filter((belief) => belief !== target);
  idle(world, creature);
}
export function execute(world: WorldState, creature: Creature, dt: number): void {
  const plan: Intention = creature.intention;
  const action = plan.action;
  if (action === "idle") {
    idle(world, creature);
    return;
  }
  if (world.time > plan.until) {
    abandon(world, creature, `${action} took too long; I should choose a reachable opportunity.`);
    return;
  }
  if (action === "gather" && creature.carried) {
    if (!move(world, creature, home(world), dt)) return;
    creature.action = "gather";
    creature.actionProgress += dt / 0.8;
    if (creature.actionProgress >= 1) {
      const cargo = creature.carried;
      world.resources[cargo.kind] = Math.min(10000, world.resources[cargo.kind] + cargo.amount);
      remember(
        world,
        creature,
        "experience",
        `I delivered ${cargo.amount} ${cargo.kind}; the common store now holds ${world.resources[cargo.kind]}.`,
        { importance: 50, valence: 0.3 },
      );
      creature.carried = undefined;
      const remembered = creature.beliefs.find((belief) => belief.objectId === plan.targetId);
      experience(
        world,
        creature,
        "gather",
        remembered?.kind ?? (cargo.kind === "wood" ? "tree" : "rock"),
        plan.targetId,
        0.25,
      );
      idle(world, creature);
    }
    return;
  }
  const neighbor =
    action === "socialize"
      ? world.creatures.find(
          (other) =>
            other.id === plan.targetId &&
            other.alive &&
            distance(other.position, creature.position) <= VISION,
        )
      : undefined;
  const perceivedTarget =
    action !== "socialize"
      ? knownObjects(world, creature).find((target) => target.id === plan.targetId)
      : undefined;
  if (plan.targetId && !perceivedTarget && !neighbor) {
    abandon(
      world,
      creature,
      "I can no longer find the expected place or neighbor where I can see.",
    );
    return;
  }
  const target =
    action !== "socialize"
      ? world.objects.find(
          (item) =>
            item.id === plan.targetId && distance(item.position, creature.position) <= VISION,
        )
      : undefined;
  const expectedKinds = (
    {
      eat: ["apple", "feeder"],
      wash: ["bath"],
      play: ["ball", "carousel"],
      sing: ["beacon"],
      gather: ["tree", "rock"],
    } as Partial<Record<ActionKind, ObjectKind[]>>
  )[action];
  if (
    target &&
    expectedKinds &&
    (!target.built ||
      !expectedKinds.includes(target.kind) ||
      ((action === "eat" || action === "gather") && target.amount < 1))
  ) {
    abandon(
      world,
      creature,
      "Now that I can see the place, it is not ready for the action I planned.",
    );
    return;
  }
  // Far targets are remembered snapshots, including ones moved or removed out
  // of sight. Approach that remembered place; only act on a visible real object.
  const destination = perceivedTarget?.position ?? neighbor?.position ?? plan.destination;
  if (destination && !move(world, creature, destination, dt, action === "walk" ? 0.15 : REACH))
    return;
  if (action === "walk") {
    complete(world, creature, action, undefined, 0.025);
    return;
  }
  if (plan.targetId && !target && !neighbor) {
    abandon(world, creature, "I reached the remembered place, but could not verify the object.");
    return;
  }
  creature.action = action;
  if (
    target &&
    target.built &&
    ["eat", "wash", "play", "sing"].includes(action) &&
    !hasSlot(world, creature, target)
  ) {
    creature.action = "idle";
    return;
  }
  if (action === "build") {
    if (!target || !structureKind(target.kind)) {
      abandon(world, creature, "There is no valid construction plan here.");
      return;
    }
    if (target.built) {
      if (creature.actionProgress > 0) complete(world, creature, action, target, 0.2);
      else idle(world, creature);
      return;
    }
    if (!projectReady(target)) {
      idle(world, creature);
      return;
    }
    target.progress = clamp(target.progress + dt / 8, 0, 1);
    creature.actionProgress = target.progress;
    if (target.progress >= 1) {
      target.built = true;
      target.capacity =
        target.kind === "feeder"
          ? 10
          : target.kind === "bath"
            ? 1
            : target.kind === "carousel"
              ? 4
              : 8;
      target.amount = target.kind === "feeder" ? 5 : target.capacity;
      world.stats.built++;
      event(
        world,
        "building",
        `${creature.name} completed the ${STRUCTURES[target.kind].name}.`,
        creature.id,
      );
      say(
        world,
        `${STRUCTURES[target.kind].name} is ready. ${creature.name} finished work at ${target.position.x.toFixed(1)}, ${target.position.y.toFixed(1)}.`,
      );
      complete(world, creature, action, target, 0.4);
    }
    return;
  }
  const duration =
    (
      {
        eat: 1.5,
        wash: target ? 3 : 4.5,
        play: 3,
        rest: 5,
        socialize: 2.2,
        gather: 2.4,
        sing: 3,
      } as Partial<Record<ActionKind, number>>
    )[action] ?? 1;
  creature.actionProgress = clamp(creature.actionProgress + dt / duration, 0, 1);
  if (creature.actionProgress < 1 - 0.000001) return;
  if (action === "eat") {
    if (
      !target ||
      !target.built ||
      !["apple", "feeder"].includes(target.kind) ||
      target.amount < 1
    ) {
      abandon(world, creature, "I reached this food source, but no portion remained.");
      return;
    }
    target.amount = Math.max(0, target.amount - 1);
    creature.needs.food = clamp(creature.needs.food + (target.kind === "apple" ? 34 : 31));
  } else if (action === "wash") {
    creature.needs.clean = clamp(creature.needs.clean + (target ? 40 : 18));
  } else if (action === "play") {
    if (!target || !["ball", "carousel"].includes(target.kind)) {
      abandon(world, creature, "I cannot play with the target I chose.");
      return;
    }
    creature.needs.joy = clamp(creature.needs.joy + (target.kind === "carousel" ? 40 : 28));
    if (target.kind === "ball")
      target.position = point(world, {
        x: target.position.x + (random(world) - 0.5) * 1.1,
        y: target.position.y + (random(world) - 0.5) * 1.1,
      });
  } else if (action === "rest") {
    creature.needs.rest = clamp(creature.needs.rest + 34);
  } else if (action === "sing") {
    creature.needs.joy = clamp(creature.needs.joy + 11);
    creature.needs.social = clamp(creature.needs.social + (target ? 12 : 5));
    utter(world, creature, target ? "together" : "joy");
    if (target?.kind === "beacon") world.collective.choirUntil = world.time + 5;
  } else if (action === "socialize") {
    if (!neighbor) {
      abandon(world, creature, "My neighbor is no longer here.");
      return;
    }
    socialize(world, creature, neighbor);
  } else if (action === "gather") {
    if (!target || !["tree", "rock"].includes(target.kind) || target.amount < 1) {
      abandon(world, creature, "I found no harvestable material remaining here.");
      return;
    }
    const amount = Math.min(Math.floor(target.amount), target.kind === "tree" ? 3 : 2);
    target.amount -= amount;
    target.lastUsedAt = world.time;
    const learned = creature.beliefs.find((belief) => belief.objectId === target.id);
    if (learned) {
      learned.source = "experienced";
      learned.observed = observation(world, target);
    }
    creature.carried = { kind: target.kind === "tree" ? "wood" : "stone", amount };
    creature.actionProgress = 0;
    plan.until = world.time + 45;
    return;
  }
  complete(world, creature, action, target, action === "socialize" ? 0.04 : 0);
}
