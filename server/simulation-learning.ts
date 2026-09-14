import type {
  ActionKind,
  Belief,
  Creature,
  Lexeme,
  Memory,
  ObjectKind,
  WorldState,
} from "../shared/types.js";
import {
  append,
  clamp,
  distance,
  event,
  externalRelief,
  isDurableLoss,
  observation,
  LIMITS,
  living,
  NEEDS,
  needFor,
  random,
  readable,
  remember,
  say,
  text,
  VISION,
} from "./simulation-core.js";

export function perceive(world: WorldState, creature: Creature): void {
  if (world.time - creature.lastPerceivedAt < 0.7) return;
  creature.lastPerceivedAt = world.time;
  const visible = world.objects
    .filter((o) => distance(o.position, creature.position) <= VISION)
    .sort(
      (a, b) => distance(a.position, creature.position) - distance(b.position, creature.position),
    )
    .slice(0, 24);
  const visibleIds = new Set(visible.map((o) => o.id));
  creature.beliefs = creature.beliefs.filter(
    (belief) =>
      !(distance(belief.position, creature.position) <= VISION && !visibleIds.has(belief.objectId)),
  );
  for (const seen of visible) {
    const known = creature.beliefs.find((b) => b.objectId === seen.id);
    if (known) {
      known.position = { ...seen.position };
      known.observed = observation(world, seen);
      known.confidence = 1;
      if (known.source === "shared") known.source = "seen";
      continue;
    }
    const belief: Belief = {
      objectId: seen.id,
      kind: seen.kind,
      position: { ...seen.position },
      confidence: 1,
      learnedAt: world.time,
      source: "seen",
      observed: observation(world, seen),
    };
    append(creature.beliefs, belief, LIMITS.beliefs);
    remember(
      world,
      creature,
      "discovery",
      `I saw a ${readable(seen.kind)} near ${seen.position.x.toFixed(1)}, ${seen.position.y.toFixed(1)}.`,
      { subjectId: seen.id, position: seen.position, importance: 35 },
    );
    world.stats.discoveries++;
  }
}
export function learnWord(
  world: WorldState,
  creature: Creature,
  meaning: string,
): Lexeme | undefined {
  let word = world.collective.lexicon.find(
    (entry) => entry.meaning === meaning && entry.knownBy.includes(creature.id),
  );
  if (word) {
    word.uses = Math.min(100000, word.uses + 1);
    return word;
  }
  // Independent discoveries may have different sounds; a meeting spreads a specific sound.
  if (world.collective.lexicon.length >= LIMITS.lexicon) return undefined;
  const first = ["lu", "vi", "na", "ke", "so", "ri", "mu", "ta"];
  const second = ["m", "li", "va", "ni", "ru", "ka", "o", "si"];
  let sound = `${first[Math.floor(random(world) * first.length)] ?? "lu"}${second[Math.floor(random(world) * second.length)] ?? "mi"}`;
  if (world.collective.lexicon.some((entry) => entry.sound === sound))
    sound += world.collective.lexicon.length.toString(36);
  word = { sound, meaning, discoveredAt: world.time, uses: 1, knownBy: [creature.id] };
  world.collective.lexicon.push(word);
  return word;
}
export function utter(world: WorldState, creature: Creature, meaning: string): void {
  const word = learnWord(world, creature, meaning);
  if (!word) return;
  const shared = word.knownBy.length > 1;
  creature.utterance = {
    text: shared ? `${word.sound} · ${meaning}` : word.sound,
    at: world.time,
    until: world.time + 4,
    translated: shared,
  };
}
export function experience(
  world: WorldState,
  creature: Creature,
  action: ActionKind,
  kind?: ObjectKind,
  subjectId?: string,
  bonus = 0,
  failure?: string,
): void {
  const start = creature.actionStartNeeds ?? creature.needs;
  const delta = NEEDS.reduce((sum, need) => sum + creature.needs[need] - start[need], 0);
  const reward = clamp(failure ? -0.3 : delta / 80 + bonus, -1, 1);
  const previous = creature.rewards[action] ?? { count: 0, mean: 0 };
  const count = Math.min(10000, previous.count + 1);
  creature.rewards[action] = {
    count,
    mean: previous.mean + (reward - previous.mean) / Math.min(count, 12),
  };
  if (kind)
    creature.preferences[kind] = clamp(
      (creature.preferences[kind] ?? 0) * 0.65 + reward * 35,
      -100,
      100,
    );
  const need = needFor(action);
  const change = need ? creature.needs[need] - start[need] : 0;
  const content =
    failure ??
    (need
      ? `${action} ${kind ? `at the ${readable(kind)} ` : ""}changed my ${need} by ${change.toFixed(1)}; it is now ${creature.needs[need].toFixed(0)}.`
      : `${action} ${kind ? `with the ${readable(kind)} ` : ""}finished; the colony gained useful work.`);
  remember(world, creature, "experience", content, {
    importance: 60,
    actor: "creature",
    sourceId: creature.id,
    valence: reward,
    ...(subjectId ? { subjectId } : {}),
    ...(need ? { need, delta: change } : {}),
    position: creature.position,
  });
  creature.learningCount++;
  const belief = creature.beliefs.find((b) => b.objectId === subjectId);
  if (belief && !failure) {
    belief.source = "experienced";
    belief.confidence = 1;
    const visible = world.objects.find(
      (target) => target.id === subjectId && distance(target.position, creature.position) <= VISION,
    );
    if (visible) {
      belief.position = { ...visible.position };
      belief.observed = observation(world, visible);
    }
  }
  if (creature.learningCount === 1 || creature.learningCount % 6 === 0)
    event(
      world,
      "learning",
      `${creature.name} learned from ${action}: reward ${reward.toFixed(2)}${kind ? `, ${readable(kind)} preference ${(creature.preferences[kind] ?? 0).toFixed(0)}` : ""}.`,
      creature.id,
    );
  if (!failure && need && change > 0) utter(world, creature, need);
}
function relate(world: WorldState, a: Creature, b: Creature): void {
  let relationship = a.relationships.find((entry) => entry.id === b.id);
  if (!relationship) {
    relationship = { id: b.id, familiarity: 0, trust: 45, lastMet: world.time, shared: 0 };
    append(a.relationships, relationship, LIMITS.relationships);
  }
  relationship.familiarity = clamp(relationship.familiarity + 9);
  relationship.trust = clamp(relationship.trust + 2);
  relationship.lastMet = world.time;
}
export function shareMemory(
  world: WorldState,
  from: Creature,
  to: Creature,
  memory: Memory,
): boolean {
  if (
    !from.alive ||
    !to.alive ||
    from.id === to.id ||
    distance(from.position, to.position) > VISION ||
    !from.memories.some((owned) => owned.id === memory.id)
  )
    return false;
  const marker = `[${memory.id}]`;
  if (to.memories.some((entry) => entry.sourceId === from.id && entry.text.includes(marker)))
    return false;
  const alreadyKnowsLoss =
    isDurableLoss(memory) &&
    to.memories.some(
      (entry) =>
        isDurableLoss(entry) &&
        entry.subjectId === memory.subjectId &&
        entry.actor === memory.actor,
    );
  remember(world, to, "social", `${from.name} shared ${marker}: ${memory.text}`, {
    sourceId: from.id,
    ...(memory.actor ? { actor: memory.actor } : {}),
    ...(memory.subjectId ? { subjectId: memory.subjectId } : {}),
    ...(memory.position ? { position: memory.position } : {}),
    ...(memory.need ? { need: memory.need } : {}),
    importance: Math.min(90, Math.max(45, memory.importance - 8)),
    valence: clamp(memory.valence, -1, 1),
  });
  relate(world, from, to);
  relate(world, to, from);
  const relation = to.relationships.find((entry) => entry.id === from.id);
  if (relation) relation.shared = Math.min(100000, relation.shared + 1);
  to.learningCount++;
  world.collective.sharedKnowledge = Math.min(1000000, world.collective.sharedKnowledge + 1);
  if (isDurableLoss(memory) && !alreadyKnowsLoss) {
    externalRelief(to, "joy", -6);
    externalRelief(to, "social", -4);
    world.collective.grief = clamp((world.collective.grief ?? 0) + 2);
    if (memory.actor === "player") {
      world.collective.fear = clamp((world.collective.fear ?? 0) + 2);
      world.collective.trust = clamp(world.collective.trust - 2);
    }
  }
  event(
    world,
    "speech",
    `${from.name} shared a remembered ${memory.kind} with ${to.name}.`,
    from.id,
  );
  return true;
}
function share(world: WorldState, from: Creature, to: Creature): number {
  let learned = 0;
  const candidate = [...from.beliefs]
    .filter(
      (belief) =>
        belief.confidence >= 0.35 && !to.beliefs.some((own) => own.objectId === belief.objectId),
    )
    .sort((a, b) => b.confidence - a.confidence || b.learnedAt - a.learnedAt)[0];
  if (candidate) {
    append(
      to.beliefs,
      {
        ...candidate,
        position: { ...candidate.position },
        observed: candidate.observed ? { ...candidate.observed } : undefined,
        source: "shared",
        sourceId: from.id,
        learnedAt: world.time,
        confidence: candidate.confidence * 0.82,
      },
      LIMITS.beliefs,
    );
    remember(
      world,
      to,
      "social",
      `${from.name} told me about a ${readable(candidate.kind)} at ${candidate.position.x.toFixed(1)}, ${candidate.position.y.toFixed(1)}${candidate.source === "shared" && candidate.sourceId ? `, heard from ${candidate.sourceId}` : ""}. I have not checked it.`,
      {
        sourceId: from.id,
        subjectId: candidate.objectId,
        position: candidate.position,
        importance: 65,
        valence: 0.2,
      },
    );
    to.learningCount++;
    learned++;
  }
  const word = world.collective.lexicon.find(
    (entry) => entry.knownBy.includes(from.id) && !entry.knownBy.includes(to.id),
  );
  if (word) {
    if (word.knownBy.length < 64) word.knownBy.push(to.id);
    word.uses = Math.min(100000, word.uses + 1);
    remember(
      world,
      to,
      "social",
      `${from.name} uses ${word.sound} for ${word.meaning}; now that sound means something to me.`,
      { sourceId: from.id, importance: 60, valence: 0.3 },
    );
    learned++;
  }
  const relation = to.relationships.find((entry) => entry.id === from.id);
  if (relation) relation.shared = Math.min(100000, relation.shared + learned);
  world.collective.sharedKnowledge = Math.min(1000000, world.collective.sharedKnowledge + learned);
  return learned;
}
export function socialize(world: WorldState, a: Creature, b: Creature): void {
  if (!a.alive || !b.alive || distance(a.position, b.position) > REACH_FOR_SOCIAL) return;
  relate(world, a, b);
  relate(world, b, a);
  const learned = share(world, a, b) + share(world, b, a);
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const loss = [...from.memories]
      .reverse()
      .find(
        (memory) =>
          isDurableLoss(memory) &&
          !to.memories.some(
            (entry) =>
              isDurableLoss(entry) &&
              entry.subjectId === memory.subjectId &&
              entry.actor === memory.actor,
          ),
      );
    if (loss) shareMemory(world, from, to, loss);
  }
  for (const creature of [a, b]) {
    if (creature.id === a.id) {
      creature.needs.social = clamp(creature.needs.social + 24);
      creature.needs.joy = clamp(creature.needs.joy + 4);
    } else {
      externalRelief(creature, "social", 24);
      externalRelief(creature, "joy", 4);
    }
    creature.lastSocialAt = world.time;
    utter(world, creature, "together");
  }
  remember(
    world,
    b,
    "social",
    `${a.name} spent time beside me; my social need is now ${b.needs.social.toFixed(0)}.`,
    { sourceId: a.id, subjectId: a.id, need: "social", importance: 40, valence: 0.4 },
  );
  world.stats.conversations++;
  event(
    world,
    "speech",
    `${a.name} and ${b.name} met${learned ? ` and exchanged ${learned} pieces of knowledge` : " again"}.`,
    a.id,
  );
  if (learned && world.collective.sharedKnowledge <= 4)
    say(
      world,
      `${a.name} and ${b.name} now share ${learned} new ${learned === 1 ? "reference" : "references"}. Our knowledge travels with us when we meet.`,
    );
}
const REACH_FOR_SOCIAL = 1.7;
export function reflect(world: WorldState, creature: Creature): void {
  if (world.cognitionMode === "model") return;
  if (world.time - creature.lastReflectionAt < 32) return;
  creature.lastReflectionAt = world.time;
  const evidence = [...creature.memories]
    .reverse()
    .find((entry) => entry.kind === "experience" && entry.at > world.time - 50);
  if (!evidence) return;
  remember(
    world,
    creature,
    "reflection",
    `My recent experience (${evidence.id}): ${text(evidence.text, 135)} I will use that result when choosing again.`,
    {
      importance: 70,
      valence: evidence.valence,
      sourceId: creature.id,
      ...(evidence.subjectId ? { subjectId: evidence.subjectId } : {}),
      ...(evidence.need ? { need: evidence.need, delta: evidence.delta } : {}),
    },
  );
}
export function updateCollective(world: WorldState): void {
  const population = living(world).length;
  const shared = world.collective.lexicon.filter(
    (word) =>
      word.knownBy.filter((known) => world.creatures.some((c) => c.id === known && c.alive))
        .length > 1,
  ).length;
  world.collective.coherence = clamp(
    shared * 9 +
      Math.min(35, world.collective.sharedKnowledge * 2) +
      Math.min(20, world.stats.built * 5) -
      (world.collective.fear ?? 0) * 0.25 -
      (world.collective.grief ?? 0) * 0.15,
  );
  const stages = ["egg", "care", "company", "language", "cooperation", "chorus"] as const;
  const wanted =
    world.objects.some((o) => o.kind === "beacon" && o.built) &&
    population >= 6 &&
    world.collective.coherence >= 45
      ? "chorus"
      : world.stats.built >= 1 && world.collective.sharedKnowledge >= 2
        ? "cooperation"
        : shared >= 2
          ? "language"
          : population >= 2
            ? "company"
            : "care";
  if (stages.indexOf(wanted) <= stages.indexOf(world.stage)) return;
  world.stage = wanted;
  const detail = `${population} living creatures, ${shared} shared words, ${world.stats.built} completed places.`;
  append(
    world.collective.milestones,
    { id: `stage-${wanted}`, label: wanted, detail, at: world.time },
    LIMITS.milestones,
  );
  event(world, "milestone", `${wanted}: ${detail}`);
  say(world, `Our colony has reached ${wanted}: ${detail}`);
}
