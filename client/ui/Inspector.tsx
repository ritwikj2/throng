import { useEffect, useRef, useState } from "react";
import type { Creature, SceneState } from "../../shared/types";
import { request } from "../useColony";
import { NeedMeters } from "./Retro";
import { cognitionReadout, elapsed, since } from "./status";

type Tab = "now" | "memory" | "neighbors";
const TABS: Tab[] = ["now", "memory", "neighbors"];

export function Inspector({
  world,
  selectedId,
  onSelect,
  onClose,
}: {
  world: SceneState;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Creature | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>("now");
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    setDetail(null);
    setError(false);
    setTab("now");
    setMinimized(false);
    if (!selectedId) return;
    let disposed = false;
    let controller: AbortController | undefined;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const creature = await request<Creature>(
          `/api/creatures/${encodeURIComponent(selectedId)}`,
          undefined,
          controller.signal,
        );
        if (!disposed) {
          setDetail(creature);
          setError(false);
        }
      } catch (cause) {
        if (!disposed && (cause as Error).name !== "AbortError") setError(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
    };
  }, [selectedId, world.id]);
  useEffect(() => {
    const reset = () => setPosition(null);
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, []);
  const snapshot = world.creatures.find((creature) => creature.id === selectedId);
  const record = detail?.id === selectedId ? detail : null;
  const creature = snapshot ?? record;
  const latestCognition = creature ? cognitionReadout(creature) : null;
  const storedCognition = record ? cognitionReadout(record) : null;
  const cognition = creature
    ? {
        goal: latestCognition?.goal ?? storedCognition?.goal ?? null,
        lesson: latestCognition?.lesson ?? storedCognition?.lesson ?? null,
        at: latestCognition?.at ?? storedCognition?.at ?? null,
        decisions: latestCognition?.decisions ?? storedCognition?.decisions ?? null,
      }
    : null;
  const living = world.creatures.filter((item) => item.alive);
  const inFlight =
    !!creature?.modelPending &&
    world.brain.ready &&
    world.brain.pending > 0 &&
    !world.brain.lastError;
  const source = creature?.intention.source === "model" ? "MODEL PLAN" : "BODY POLICY";
  return (
    <aside
      ref={panel}
      className={`inspector-window ${minimized ? "inspector-minimized" : ""}`}
      aria-label="Creature inspector"
      style={
        position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined
      }
    >
      <div
        className="window-title inspector-drag"
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target as HTMLElement).closest("button") ||
            window.innerWidth < 640 ||
            !panel.current
          )
            return;
          const box = panel.current.getBoundingClientRect();
          const host = panel.current.parentElement!.getBoundingClientRect();
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: box.left - host.left,
            top: box.top - host.top,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          const element = panel.current;
          const parent = element?.parentElement;
          if (!start || start.id !== event.pointerId || !element || !parent) return;
          setPosition({
            x: Math.max(
              0,
              Math.min(
                parent.clientWidth - element.offsetWidth,
                start.left + event.clientX - start.x,
              ),
            ),
            y: Math.max(0, Math.min(parent.clientHeight - 28, start.top + event.clientY - start.y)),
          });
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <h2>{creature ? `INDIVIDUAL: ${creature.name}` : "INDIVIDUAL INSPECTOR"}</h2>
        <button
          className="window-button"
          aria-label={minimized ? "Expand inspector" : "Minimize inspector"}
          onClick={() => setMinimized((value) => !value)}
        >
          {minimized ? "□" : "_"}
        </button>
        <button className="window-button" aria-label="Close inspector" onClick={onClose}>
          ×
        </button>
      </div>
      {!minimized && (
        <div className="inspector-body">
          <label className="sr-only" htmlFor="individual-picker">
            Inspect a creature
          </label>
          <select
            id="individual-picker"
            value={selectedId ?? ""}
            onChange={(event) => onSelect(event.target.value || null)}
          >
            <option value="">Select an individual…</option>
            {creature && !creature.alive && (
              <option value={creature.id}>{creature.name} — deceased</option>
            )}
            {living.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.action}
              </option>
            ))}
          </select>
          {!creature ? (
            <p className="inspector-empty">
              {world.hatched
                ? "Choose Observe, then click a creature in the field."
                : "Hatch the egg to initialize the first life."}
            </p>
          ) : (
            <>
              <div className="individual-meta">
                <span className={creature.alive ? "" : "deceased"}>
                  {creature.alive ? creature.action.toUpperCase() : "DECEASED"}
                </span>
                <span>
                  GEN {creature.generation} · AGE {elapsed(world.time - creature.bornAt)}
                </span>
              </div>
              <div
                className="inspector-tabs"
                role="tablist"
                aria-label="Creature details"
                onKeyDown={(event) => {
                  let index = TABS.indexOf(tab);
                  if (event.key === "ArrowRight") index = (index + 1) % TABS.length;
                  else if (event.key === "ArrowLeft")
                    index = (index + TABS.length - 1) % TABS.length;
                  else if (event.key === "Home") index = 0;
                  else if (event.key === "End") index = TABS.length - 1;
                  else return;
                  event.preventDefault();
                  event.stopPropagation();
                  const next = TABS[index]!;
                  setTab(next);
                  document.getElementById(`inspect-tab-${next}`)?.focus();
                }}
              >
                {TABS.map((item) => (
                  <button
                    key={item}
                    role="tab"
                    id={`inspect-tab-${item}`}
                    aria-controls={`inspect-panel-${item}`}
                    aria-selected={tab === item}
                    tabIndex={tab === item ? 0 : -1}
                    onClick={() => setTab(item)}
                  >
                    {item === "now" ? "Now" : item === "memory" ? "Memory" : "Neighbors"}
                  </button>
                ))}
              </div>
              <div
                className="inspector-page"
                role="tabpanel"
                id={`inspect-panel-${tab}`}
                aria-labelledby={`inspect-tab-${tab}`}
              >
                {error && (
                  <p className="record-warning" role="status">
                    Memory record unavailable. Showing the latest world snapshot.
                  </p>
                )}
                {tab === "now" && (
                  <>
                    <div className="source-row">
                      <strong
                        className={creature.intention.source === "model" ? "model-source" : ""}
                      >
                        {source}
                      </strong>
                      {inFlight && <span>REQUEST IN FLIGHT</span>}
                    </div>
                    <p className="intention-text" data-testid="creature-thought">
                      {creature.intention.text}
                    </p>
                    <dl className="mind-record">
                      <dt>Goal</dt>
                      <dd>{cognition?.goal ?? "No model goal recorded."}</dd>
                      <dt>Lesson</dt>
                      <dd>{cognition?.lesson ?? "No model lesson recorded."}</dd>
                      <dt>Action reason</dt>
                      <dd>{creature.intention.reason}</dd>
                    </dl>
                    {cognition?.decisions !== null && cognition?.decisions !== undefined && (
                      <p className="record-footnote">
                        {cognition.decisions} model decisions
                        {cognition.at !== null ? ` · last ${since(world.time, cognition.at)}` : ""}
                      </p>
                    )}
                    <details className="advanced-record">
                      <summary>Body state &amp; learned preferences</summary>
                      <NeedMeters name={creature.name} needs={creature.needs} advanced />
                      <p>
                        Health {Math.round(creature.health)} / 100 · {creature.learningCount}{" "}
                        learned experiences
                      </p>
                      {Object.entries(creature.preferences).length > 0 && (
                        <dl className="preference-record">
                          {Object.entries(creature.preferences).map(([kind, value]) => (
                            <div key={kind}>
                              <dt>{kind}</dt>
                              <dd>
                                {Number(value) > 0 ? "+" : ""}
                                {Number(value).toFixed(1)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </details>
                  </>
                )}
                {tab === "memory" && (
                  <div className="memory-records">
                    {!record ? (
                      <p>{error ? "Memory request failed." : "Loading memory record…"}</p>
                    ) : record.memories.length ? (
                      record.memories
                        .slice()
                        .reverse()
                        .map((memory) => (
                          <article key={memory.id}>
                            <header>
                              <span>{memory.kind.toUpperCase()}</span>
                              <time>{since(world.time, memory.at)}</time>
                            </header>
                            <p>{memory.text}</p>
                            {memory.delta !== undefined && (
                              <small>
                                {memory.need ?? "reward"} {memory.delta > 0 ? "+" : ""}
                                {memory.delta.toFixed(1)}
                                {memory.sourceId ? " · shared experience" : ""}
                              </small>
                            )}
                          </article>
                        ))
                    ) : (
                      <p>No experiences recorded.</p>
                    )}
                  </div>
                )}
                {tab === "neighbors" && (
                  <div className="neighbor-records">
                    {creature.parentId && (
                      <p>
                        Parent:{" "}
                        <button
                          className="inline-link"
                          onClick={() => onSelect(creature.parentId!)}
                        >
                          {world.creatures.find((item) => item.id === creature.parentId)?.name ??
                            creature.parentId}
                        </button>
                      </p>
                    )}
                    {!record ? (
                      <p>{error ? "Neighbor record unavailable." : "Loading neighbor record…"}</p>
                    ) : record.relationships.length ? (
                      record.relationships
                        .slice()
                        .sort((a, b) => b.familiarity - a.familiarity)
                        .map((relation) => (
                          <button
                            className="neighbor-row"
                            key={relation.id}
                            onClick={() => onSelect(relation.id)}
                          >
                            <span>
                              {world.creatures.find((item) => item.id === relation.id)?.name ??
                                "Remembered neighbor"}
                            </span>
                            <small>
                              {Math.round(relation.familiarity)} familiar · {relation.shared} shared
                            </small>
                          </button>
                        ))
                    ) : (
                      <p>No known neighbors.</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
