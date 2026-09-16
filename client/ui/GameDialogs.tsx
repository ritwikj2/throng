import { useEffect, useState } from "react";
import {
  STRUCTURES,
  type Command,
  type SaveInfo,
  type SceneState,
  type StructureKind,
} from "../../shared/types";
import { request } from "../useColony";
import { PixelIcon } from "./icons";
import { elapsed } from "./status";

export function WorldFiles({
  changeColony,
  createFirst,
  setChanging,
  onDone,
}: {
  changeColony: (path: string, body: unknown) => Promise<SceneState>;
  createFirst: boolean;
  setChanging: (value: boolean) => void;
  onDone: (message: string) => void;
}) {
  const [saves, setSaves] = useState<SaveInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void request<SaveInfo[]>("/api/colonies", undefined, controller.signal)
      .then(setSaves)
      .catch((cause) => {
        if ((cause as Error).name !== "AbortError")
          setError("World files could not be listed. Your saves have not been changed.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  const open = async (path: string, body: unknown, message: string) => {
    if (busy) return;
    setBusy(true);
    setChanging(true);
    setError(null);
    try {
      await changeColony(path, body);
      onDone(message);
    } catch {
      setError("The world could not be opened. Existing saves have not been removed.");
    } finally {
      setBusy(false);
      setChanging(false);
    }
  };
  return (
    <>
      {error && (
        <p className="system-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="new-world-form"
        onSubmit={(event) => {
          event.preventDefault();
          void open(
            "/api/colonies",
            { name: name.trim() || "Untitled world" },
            "New world opened. Previous worlds remain saved.",
          );
        }}
      >
        <label htmlFor="new-world-name">New world name</label>
        <div>
          <input
            id="new-world-name"
            value={name}
            autoFocus={createFirst}
            maxLength={40}
            placeholder="Untitled world"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <button className="default-button" type="submit" disabled={busy}>
            {busy ? "Opening…" : "New world"}
          </button>
        </div>
      </form>
      <div className="file-list" aria-label="Saved worlds">
        <div className="file-list-heading">
          <span>WORLD</span>
          <span>POPULATION / TIME</span>
        </div>
        {loading ? (
          <p className="file-list-empty" role="status">
            Reading world directory…
          </p>
        ) : saves.length ? (
          saves.map((save) => (
            <button
              key={save.id}
              disabled={save.active || busy}
              className={save.active ? "current-file" : ""}
              onClick={() =>
                void open(
                  `/api/colonies/${encodeURIComponent(save.id)}/load`,
                  {},
                  `${save.name} opened.`,
                )
              }
            >
              <PixelIcon name="files" size={20} />
              <span>
                <strong>{save.name}</strong>
                <small>{save.active ? "OPEN" : "Saved world"}</small>
              </span>
              <span>
                {save.population} / {elapsed(save.time)}
              </span>
            </button>
          ))
        ) : (
          <p className="file-list-empty">No saved worlds listed.</p>
        )}
      </div>
    </>
  );
}

export function Construction({
  world,
  canPlay,
  act,
  onPlan,
}: {
  world: SceneState;
  canPlay: boolean;
  act: (command: Command) => Promise<boolean>;
  onPlan: (kind: StructureKind) => void;
}) {
  const count = world.creatures.filter((creature) => creature.alive).length;
  return (
    <>
      <div className="build-resources">
        WOOD {world.resources.wood} · STONE {world.resources.stone} · POPULATION {count}
      </div>
      <div className="structure-list">
        {(Object.entries(STRUCTURES) as [StructureKind, (typeof STRUCTURES)[StructureKind]][]).map(
          ([kind, item]) => {
            const exists = world.objects.some((object) => object.kind === kind);
            const unlocked = count >= item.population;
            return (
              <button
                key={kind}
                disabled={!canPlay || exists || !unlocked}
                onClick={() => onPlan(kind)}
              >
                <PixelIcon name="build" size={24} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description}</small>
                  <em>
                    {exists
                      ? "Already planned"
                      : !unlocked
                        ? `Requires ${item.population} creatures`
                        : `${item.wood} wood / ${item.stone} stone`}
                  </em>
                </span>
                <span>→</span>
              </button>
            );
          },
        )}
      </div>
      <div className="capacity-controls">
        <span>CAPACITY {world.capacity} / 64</span>
        <button
          disabled={!canPlay || world.capacity >= 64 || count < Math.max(2, world.capacity - 2)}
          onClick={() => void act({ type: "capacity" })}
        >
          {world.capacity >= 64 ? "Maximum capacity" : "Expand capacity"}
        </button>
      </div>
    </>
  );
}

export function ActivityLog({
  world,
  onSelect,
}: {
  world: SceneState;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="activity-log">
      {world.events.length ? (
        world.events
          .slice()
          .reverse()
          .map((event) => (
            <div key={event.id}>
              <time>{elapsed(event.at)}</time>
              <span>{event.kind.toUpperCase()}</span>
              {event.creatureId ? (
                <button className="inline-link" onClick={() => onSelect(event.creatureId!)}>
                  {event.text}
                </button>
              ) : (
                <p>{event.text}</p>
              )}
            </div>
          ))
      ) : (
        <p>No events recorded.</p>
      )}
    </div>
  );
}

export function HelpManual({ tools }: { tools: readonly { label: string; hint: string }[] }) {
  return (
    <div className="help-manual">
      <h3>CARE FOR THE HABITAT</h3>
      <p>
        Hatch the egg. Place apples and balls; wash and pet individuals. Watch the Fed, Amused, and
        Clean meters. Well-cared-for creatures can replicate.
      </p>
      <h3>TOOLS</h3>
      <table>
        <tbody>
          {tools.map((item, index) => (
            <tr key={item.label}>
              <th>
                <kbd>{index + 1}</kbd> {item.label}
              </th>
              <td>{item.hint}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <kbd>Space</kbd> pauses when the field is not focused. On the canvas, arrow keys move the
        target and <kbd>Enter</kbd> or <kbd>Space</kbd> uses the selected tool. <kbd>Esc</kbd>{" "}
        returns to Observe.
      </p>
      <h3>INDIVIDUALS &amp; THE COLLECTIVE</h3>
      <p>
        Observe opens an individual record. Model goals and lessons appear only when recorded.
        Body-policy actions are labeled separately. The colony voice drawer identifies model and
        body messages.
      </p>
      <h3>BRAIN CONNECTION</h3>
      <p>
        Open Simulation → Connect brain. Choose offline body simulation, Anthropic, OpenAI, a
        compatible service, or Claude on Amazon Bedrock. Model IDs are editable. OpenAI uses your
        API account’s model access; it does not sign into the Codex CLI or ChatGPT app.
      </p>
      <p>
        An external connection sends one small, potentially paid test decision for an isolated
        creature before replacing the current brain. Configured access is not an applied colony
        plan: live pending, failure, applied, and rejected counts show what has actually happened.
        Offline mode runs body simulation without model decisions.
      </p>
      <h3>WORLD FILES</h3>
      <p>
        File → New world creates a separate save. File → Open world restores an existing one. No
        world is deleted when you switch. World time does not advance while the server is stopped.
      </p>
      <p className="about-note">
        The gray desktop, tools, and artwork are original interpretations. The episode establishes
        nurture, replication, a collective intelligence, and creature deaths; its exact interface is
        not fully documented. This is not an exact replica or a claim of sentience.
      </p>
    </div>
  );
}
