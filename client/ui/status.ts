import type { BrainStatus, Creature, SceneCreature } from "../../shared/types";

type ExtendedBrain = BrainStatus & {
  accepted?: number;
  rejected?: number;
  lastDecisionAt?: number | string | null;
  lastDecision?: string | null;
};
type StoredCognition = {
  goal?: unknown;
  lesson?: unknown;
  lastReasonedAt?: unknown;
  decisions?: unknown;
};

export function brainReadout(brain: BrainStatus) {
  const state = brain as ExtendedBrain;
  const model = brain.model || "Not configured";
  const isSonnet = model.toLowerCase().includes("claude-sonnet-5");
  const accepted =
    typeof state.accepted === "number" && Number.isFinite(state.accepted) ? state.accepted : null;
  const rejected =
    typeof state.rejected === "number" && Number.isFinite(state.rejected) ? state.rejected : null;
  let kind: "offline" | "error" | "waiting" | "pending" | "live" | "other" = "offline";
  let label = "Claude disconnected — body simulation only";
  if (brain.ready && brain.provider !== "local") {
    if (brain.lastError) {
      kind = "error";
      label = isSonnet
        ? "Claude error — body simulation only"
        : "Model request failed — body simulation only";
    } else if (!isSonnet) {
      kind = "other";
      label = `${model} configured — Sonnet 5 not selected`;
    } else if (brain.pending > 0) {
      kind = "pending";
      label = "Claude Sonnet 5 — request in progress";
    } else if (accepted !== null && accepted > 0) {
      kind = "live";
      label = `Claude Sonnet 5 — ${accepted} ${accepted === 1 ? "plan" : "plans"} applied`;
    } else {
      kind = "waiting";
      label = "Claude Sonnet 5 configured — awaiting a plan";
    }
  }
  return {
    kind,
    label,
    model,
    isSonnet,
    accepted,
    rejected,
    lastDecisionAt: state.lastDecisionAt ?? null,
    lastDecision: typeof state.lastDecision === "string" ? state.lastDecision : null,
  };
}

export function cognitionReadout(creature: Creature | SceneCreature) {
  const cognition = (creature as (Creature | SceneCreature) & { cognition?: StoredCognition })
    .cognition;
  return {
    goal: typeof cognition?.goal === "string" && cognition.goal.trim() ? cognition.goal : null,
    lesson:
      typeof cognition?.lesson === "string" && cognition.lesson.trim() ? cognition.lesson : null,
    at:
      typeof cognition?.lastReasonedAt === "number" && Number.isFinite(cognition.lastReasonedAt)
        ? cognition.lastReasonedAt
        : null,
    decisions:
      typeof cognition?.decisions === "number" && Number.isFinite(cognition.decisions)
        ? cognition.decisions
        : null,
  };
}

export function elapsed(seconds: number): string {
  const time = Math.max(0, Math.floor(seconds));
  return `${Math.floor(time / 60)
    .toString()
    .padStart(2, "0")}:${(time % 60).toString().padStart(2, "0")}`;
}
export function since(now: number, at: number): string {
  return now - at < 2 ? "just now" : `${elapsed(Math.max(0, now - at))} ago`;
}
