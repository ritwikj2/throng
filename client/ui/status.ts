import type { BrainProvider, BrainStatus, Creature, SceneCreature } from "../../shared/types";

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

export const BRAIN_PROVIDER_LABELS: Record<BrainProvider, string> = {
  local: "Offline (body simulation)",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  compatible: "Compatible API",
  bedrock: "Claude on Amazon Bedrock",
};

export function brainReadout(brain: BrainStatus) {
  const state = brain as ExtendedBrain;
  const provider = BRAIN_PROVIDER_LABELS[brain.provider] ?? "Unknown provider";
  const model =
    brain.provider === "local" ? "None (body simulation)" : brain.model || "Not configured";
  const identity = brain.model ? `${provider} · ${brain.model}` : provider;
  const accepted =
    typeof state.accepted === "number" && Number.isFinite(state.accepted) ? state.accepted : null;
  const rejected =
    typeof state.rejected === "number" && Number.isFinite(state.rejected) ? state.rejected : null;
  let kind: "offline" | "error" | "waiting" | "pending" | "live" = "offline";
  let label = "Brain offline — body simulation only";
  if (brain.provider !== "local") {
    if (!brain.ready) {
      label = `${identity} disconnected — body simulation only`;
    } else if (brain.lastError) {
      kind = "error";
      label = `${identity} — last request failed`;
    } else if (brain.pending > 0) {
      kind = "pending";
      label = `${identity} — ${brain.pending} pending`;
    } else if (accepted !== null && accepted > 0) {
      kind = "live";
      label = `${identity} — ${accepted} ${accepted === 1 ? "plan" : "plans"} applied`;
    } else {
      kind = "waiting";
      label = `${identity} configured — waiting for a plan`;
    }
  }
  return {
    kind,
    label,
    provider,
    model,
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
