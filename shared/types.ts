export type Vec = { x: number; y: number };
export type Need = "food" | "clean" | "joy" | "rest" | "social";
export type Needs = Record<Need, number>;
export type ActionKind =
  "idle" | "walk" | "eat" | "wash" | "play" | "rest" | "socialize" | "gather" | "build" | "sing";
export type ObjectKind =
  "apple" | "ball" | "tree" | "rock" | "feeder" | "bath" | "carousel" | "beacon";
export type Tool = "inspect" | "feed" | "wash" | "play" | "pet" | "tree" | "kill";
export type StructureKind = "feeder" | "bath" | "carousel" | "beacon";
export type BrainProvider = "local" | "openai" | "anthropic" | "bedrock";
export type Stage = "egg" | "care" | "company" | "language" | "cooperation" | "chorus";
export type MemoryKind =
  "discovery" | "experience" | "social" | "player" | "birth" | "loss" | "reflection";
export interface Memory {
  id: string;
  at: number;
  kind: MemoryKind;
  text: string;
  importance: number;
  valence: number;
  subjectId?: string;
  position?: Vec;
  need?: Need;
  delta?: number;
  sourceId?: string;
  actor?: "player" | "creature" | "environment";
}
export interface Belief {
  objectId: string;
  kind: ObjectKind;
  position: Vec;
  confidence: number;
  learnedAt: number;
  source: "seen" | "experienced" | "shared";
  sourceId?: string;
  observed?: { amount: number; capacity: number; built: boolean; progress: number; at: number };
}
export interface Relationship {
  id: string;
  familiarity: number;
  trust: number;
  lastMet: number;
  shared: number;
}
export interface Traits {
  curiosity: number;
  sociability: number;
  diligence: number;
  sensitivity: number;
  pitch: number;
}
export interface Intention {
  action: ActionKind;
  text: string;
  reason: string;
  source: "local" | "model";
  since: number;
  until: number;
  targetId?: string;
  destination?: Vec;
  memoryIds: string[];
}
export interface Creature {
  id: string;
  name: string;
  position: Vec;
  previousPosition: Vec;
  facing: -1 | 1;
  bornAt: number;
  generation: number;
  parentId?: string;
  alive: boolean;
  needs: Needs;
  health: number;
  traits: Traits;
  action: ActionKind;
  intention: Intention;
  actionProgress: number;
  memories: Memory[];
  beliefs: Belief[];
  relationships: Relationship[];
  preferences: Partial<Record<ObjectKind, number>>;
  rewards: Partial<Record<ActionKind, { count: number; mean: number }>>;
  utterance?: { text: string; at: number; until: number; translated: boolean };
  contentmentTime: number;
  lastReplicatedAt: number;
  lastDecisionAt: number;
  lastPerceivedAt: number;
  lastSocialAt: number;
  lastReflectionAt: number;
  lastModelAt: number;
  modelPending: boolean;
  carried?: { kind: "wood" | "stone"; amount: number };
  actionStartNeeds?: Needs;
  learningCount: number;
  cognition?: { goal: string; lesson: string; lastReasonedAt: number; decisions: number };
}
export interface WorldObject {
  id: string;
  kind: ObjectKind;
  position: Vec;
  amount: number;
  capacity: number;
  built: boolean;
  progress: number;
  createdAt: number;
  lastUsedAt: number;
}
export interface ColonyEvent {
  id: string;
  at: number;
  kind: "birth" | "care" | "learning" | "speech" | "building" | "loss" | "milestone";
  text: string;
  creatureId?: string;
}
export interface Message {
  id: string;
  at: number;
  speaker: "player" | "throng";
  text: string;
  source: "local" | "model" | "player";
}
export interface Lexeme {
  sound: string;
  meaning: string;
  discoveredAt: number;
  uses: number;
  knownBy: string[];
}
export interface Milestone {
  id: string;
  label: string;
  detail: string;
  at: number;
}
export interface Collective {
  coherence: number;
  trust: number;
  fear?: number;
  grief?: number;
  lexicon: Lexeme[];
  messages: Message[];
  milestones: Milestone[];
  sharedKnowledge: number;
  choirUntil: number;
}
export interface WorldState {
  version: 1;
  cognitionMode?: "local" | "model";
  id: string;
  name: string;
  seed: number;
  rng: number;
  serial: number;
  width: number;
  height: number;
  time: number;
  createdAt: string;
  speed: 1 | 4 | 12;
  paused: boolean;
  hatched: boolean;
  stage: Stage;
  capacity: number;
  creatures: Creature[];
  objects: WorldObject[];
  resources: { wood: number; stone: number };
  collective: Collective;
  events: ColonyEvent[];
  care: { fed: number; washed: number; played: number; petted: number };
  stats: {
    births: number;
    deaths: number;
    playerKills?: number;
    discoveries: number;
    conversations: number;
    built: number;
  };
}
export type SceneCreature = Omit<
  Creature,
  "memories" | "beliefs" | "relationships" | "rewards" | "actionStartNeeds"
> & {
  memoryCount: number;
  knownObjects: number;
  friendCount: number;
};
export interface BrainStatus {
  provider: BrainProvider;
  model: string | null;
  ready: boolean;
  label: string;
  calls: number;
  failures: number;
  pending: number;
  budgetPerMinute: number;
  lastError: string | null;
  accepted?: number;
  rejected?: number;
  lastDecisionAt?: number | null;
}
export interface SceneState extends Omit<WorldState, "creatures" | "rng" | "serial"> {
  creatures: SceneCreature[];
  brain: BrainStatus;
  serverTime: number;
}
export type Command =
  | { type: "hatch" }
  | { type: "care"; tool: Exclude<Tool, "inspect">; position: Vec; creatureId?: string }
  | { type: "speed"; speed: 1 | 4 | 12 }
  | { type: "pause"; paused: boolean }
  | { type: "build"; kind: StructureKind; position: Vec }
  | { type: "capacity" }
  | { type: "message"; text: string };
export interface CommandResult {
  ok: boolean;
  message: string;
  creatureId?: string;
}
export interface SaveInfo {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  population: number;
  time: number;
  active: boolean;
}
export interface MindContext {
  worldId: string;
  creatureId: string;
  at: number;
  name: string;
  needs: Needs;
  traits: Traits;
  intention: Intention;
  memories: Memory[];
  beliefs: Belief[];
  neighbors: { id: string; name: string; action: ActionKind; familiarity: number }[];
  availableActions: ActionKind[];
  playerMessages: string[];
  bounds?: { width: number; height: number };
  body?: {
    position: Vec;
    health: number;
    age: number;
    generation: number;
    carried?: Creature["carried"];
  };
  cognition?: Creature["cognition"];
  preferences?: Creature["preferences"];
  rewards?: Creature["rewards"];
  relationships?: Relationship[];
}
export interface MindDecision {
  action: ActionKind;
  targetId?: string;
  destination?: Vec;
  thought: string;
  reason: string;
  speech?: string;
  memoryIds: string[];
  goal?: string;
  lesson?: string;
  share?: { memoryId: string; recipientId: string };
}
export const STRUCTURES: Record<
  StructureKind,
  { name: string; wood: number; stone: number; description: string; population: number }
> = {
  feeder: {
    name: "Apple grove",
    wood: 8,
    stone: 2,
    description: "Grows food the colony can find and eat.",
    population: 3,
  },
  bath: {
    name: "Bathing pool",
    wood: 4,
    stone: 8,
    description: "A place to wash without your help.",
    population: 3,
  },
  carousel: {
    name: "Roundabout",
    wood: 12,
    stone: 4,
    description: "Shared play brings neighbors together.",
    population: 4,
  },
  beacon: {
    name: "Resonator",
    wood: 14,
    stone: 12,
    description: "A place for the colony to sing together.",
    population: 6,
  },
};
export const STAGE_LABELS: Record<Stage, string> = {
  egg: "A small beginning",
  care: "Learning to live",
  company: "We are more",
  language: "Finding a voice",
  cooperation: "Learning together",
  chorus: "Many, together",
};
