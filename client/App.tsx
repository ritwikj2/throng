import { useCallback, useEffect, useRef, useState } from "react";
import { WorldCanvas } from "./game/WorldCanvas";
import { useColony } from "./useColony";
import {
  STRUCTURES,
  type Command,
  type Needs,
  type StructureKind,
  type Tool,
  type Vec,
} from "../shared/types";
import { PixelIcon, type PixelIconName } from "./ui/icons";
import { DesktopMenu, NeedMeters, RetroDialog } from "./ui/Retro";
import { Inspector } from "./ui/Inspector";
import { ColonyTerminal } from "./ui/Terminal";
import { ClaudeConnection } from "./ui/Connection";
import { WorldFiles, Construction, ActivityLog, HelpManual } from "./ui/GameDialogs";
import { brainReadout, elapsed } from "./ui/status";

type DialogName = "files" | "settings" | "build" | "help" | "history" | null;
export const TOOLS: { id: Tool; label: string; icon: PixelIconName; hint: string }[] = [
  {
    id: "inspect",
    label: "Observe",
    icon: "inspect",
    hint: "Click an individual to open its record.",
  },
  { id: "feed", label: "Apple", icon: "feed", hint: "Click the field to place an apple." },
  { id: "wash", label: "Wash", icon: "wash", hint: "Click an individual to wash it." },
  { id: "play", label: "Ball", icon: "play", hint: "Click the field to place a ball." },
  { id: "pet", label: "Pet", icon: "pet", hint: "Click an individual to pet it." },
  { id: "tree", label: "Tree", icon: "tree", hint: "Click the field to plant a tree." },
  {
    id: "kill",
    label: "Squash",
    icon: "kill",
    hint: "SQUASH ARMED — click a living creature to kill it. Esc cancels.",
  },
];
const isStructure = (tool: Tool | StructureKind): tool is StructureKind =>
  Object.hasOwn(STRUCTURES, tool);

export function App() {
  const { world, connected, error, send, changeColony } = useColony();
  const [tool, setTool] = useState<Tool | StructureKind>("inspect");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sound, setSound] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [newFile, setNewFile] = useState(false);
  const desktop = useRef<HTMLElement>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  const announce = useCallback((message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6500);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    const full = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", full);
    return () => {
      media.removeEventListener("change", update);
      document.removeEventListener("fullscreenchange", full);
    };
  }, []);
  useEffect(() => {
    setSelectedId(null);
    setInspectorOpen(false);
    setTool("inspect");
    setNotice(null);
  }, [world?.id]);
  const act = useCallback(
    async (command: Command) => {
      try {
        const result = await send(command);
        if (result.message) announce(result.message);
        if (result.ok && result.creatureId) setSelectedId(result.creatureId);
        return result.ok;
      } catch (cause) {
        announce((cause as Error).message || "The world could not complete that action.");
        return false;
      }
    },
    [send, announce],
  );
  useEffect(() => {
    const cancelTool = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        dialog ||
        document.querySelector(".desktop-menu[open]")
      )
        return;
      setTool("inspect");
      setInspectorOpen(false);
    };
    const shortcut = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (
        event.defaultPrevented ||
        dialog ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.repeat ||
        element.closest(
          "input,textarea,select,summary,[contenteditable=true],[role=dialog],.desktop-menu[open]",
        )
      )
        return;
      if (!world || !connected || changing) return;
      if (event.code === "Space") {
        if (element.closest("button")) return;
        event.preventDefault();
        void act({ type: "pause", paused: !world.paused });
        return;
      }
      const index = Number(event.key) - 1;
      if (world.hatched && Number.isInteger(index) && index >= 0 && index < TOOLS.length) {
        event.preventDefault();
        setTool(TOOLS[index]!.id);
      }
    };
    // Escape must also disarm a tool when the canvas handles and stops the key itself.
    window.addEventListener("keydown", cancelTool, true);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("keydown", cancelTool, true);
      window.removeEventListener("keydown", shortcut);
    };
  }, [act, dialog, world?.hatched, world?.paused, connected, changing]);

  if (!world)
    return (
      <main className="desktop boot-desktop">
        <section className="boot-window">
          <div className="window-title">
            <PixelIcon name="app" size={18} />
            <h1>THRONG</h1>
          </div>
          <div className="boot-content">
            <p className="boot-label">ARTIFICIAL LIFE ENVIRONMENT</p>
            <p role="status">
              {error ? "World connection unavailable." : "Connecting to the local world…"}
            </p>
            {error && (
              <>
                <p className="small-print">The display could not load the saved world.</p>
                <button className="default-button" onClick={() => location.reload()}>
                  Retry connection
                </button>
              </>
            )}
          </div>
        </section>
      </main>
    );

  const living = world.creatures.filter((creature) => creature.alive);
  const selected = world.creatures.find((creature) => creature.id === selectedId);
  const brain = brainReadout(world.brain);
  const running = !connected
    ? "OFFLINE"
    : !world.hatched
      ? "EGG"
      : world.paused
        ? "PAUSED"
        : "RUNNING";
  const canPlay = connected && !changing && world.hatched;
  const hint = isStructure(tool)
    ? `Place ${STRUCTURES[tool].name.toLowerCase()} on the ground. Esc cancels.`
    : (TOOLS.find((item) => item.id === tool)?.hint ?? "Choose a tool.");
  const averaged: Needs | null = living.length
    ? {
        food: living.reduce((sum, c) => sum + c.needs.food, 0) / living.length,
        joy: living.reduce((sum, c) => sum + c.needs.joy, 0) / living.length,
        clean: living.reduce((sum, c) => sum + c.needs.clean, 0) / living.length,
        rest: living.reduce((sum, c) => sum + c.needs.rest, 0) / living.length,
        social: living.reduce((sum, c) => sum + c.needs.social, 0) / living.length,
      }
    : null;
  const focus = (id: string | null) => {
    setSelectedId(id);
    if (id) {
      setTool("inspect");
      setInspectorOpen(true);
    }
  };
  const onWorldSelect = (id: string | null) => {
    setSelectedId(id);
    if (id && tool === "inspect") setInspectorOpen(true);
  };
  const interact = (position: Vec, creatureId?: string) => {
    if (!connected || changing) return;
    if (!world.hatched) {
      void act({ type: "hatch" });
      return;
    }
    if (isStructure(tool)) {
      const chosen = tool;
      void act({ type: "build", kind: chosen, position }).then((ok) => {
        if (ok) setTool((current) => (current === chosen ? "inspect" : current));
      });
      return;
    }
    if (tool === "inspect") {
      focus(creatureId ?? null);
      return;
    }
    if (
      tool === "kill" &&
      (!creatureId ||
        !world.creatures.some((creature) => creature.id === creatureId && creature.alive))
    ) {
      announce("Squash is selected. Click a living creature; empty ground does nothing.");
      return;
    }
    void act({ type: "care", tool, position, ...(creatureId ? { creatureId } : {}) });
  };
  const files = (create: boolean) => {
    setNewFile(create);
    setDialog("files");
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await desktop.current?.requestFullscreen();
    } catch {
      announce("Full screen is not available in this browser.");
    }
  };

  return (
    <main ref={desktop} className="desktop" aria-label="THRONG game">
      <a className="skip-link" href="#playfield">
        Skip to playfield
      </a>
      <section className="app-window">
        <header className="window-title main-title">
          <PixelIcon name="app" size={19} />
          <h1>THRONG</h1>
          <span className="window-document">{world.name}</span>
          <button
            className="window-button"
            aria-label="How to play"
            onClick={() => setDialog("help")}
          >
            ?
          </button>
          <button
            className="window-button"
            aria-label={fullscreen ? "Exit full screen" : "Enter full screen"}
            aria-pressed={fullscreen}
            disabled={!document.fullscreenEnabled}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? "▣" : "□"}
          </button>
        </header>
        <nav className="menubar" aria-label="Application menu">
          <DesktopMenu label="File">
            <button onClick={() => files(true)}>New world…</button>
            <button onClick={() => files(false)}>Open world…</button>
            <hr />
            <span className="menu-note">Worlds save automatically.</span>
          </DesktopMenu>
          <DesktopMenu label="View">
            <button onClick={() => setInspectorOpen((value) => !value)}>
              {inspectorOpen ? "Hide" : "Show"} inspector
            </button>
            <button onClick={() => setTerminalOpen((value) => !value)}>
              {terminalOpen ? "Hide" : "Show"} colony voice
            </button>
            <button onClick={() => setDialog("history")}>Activity log…</button>
            <hr />
            <button onClick={() => setSound((value) => !value)}>
              {sound ? "Mute" : "Enable"} sound
            </button>
          </DesktopMenu>
          <DesktopMenu label="Simulation">
            <button
              disabled={!canPlay}
              onClick={() => void act({ type: "pause", paused: !world.paused })}
            >
              {world.paused ? "Resume" : "Pause"} <kbd>Space</kbd>
            </button>
            <hr />
            {([1, 4, 12] as const).map((speed) => (
              <button
                key={speed}
                disabled={!canPlay}
                onClick={() => void act({ type: "speed", speed })}
              >
                {world.speed === speed ? "✓ " : ""}
                {speed}× speed
              </button>
            ))}
            <hr />
            <button disabled={!canPlay} onClick={() => setDialog("build")}>
              Structures &amp; capacity…
            </button>
            <button onClick={() => setDialog("settings")}>Connect Claude…</button>
          </DesktopMenu>
          <DesktopMenu label="Help">
            <button onClick={() => setDialog("help")}>Controls &amp; about THRONG…</button>
            <button onClick={() => setDialog("settings")}>Claude connection…</button>
          </DesktopMenu>
          <span className="menu-era">ARTIFICIAL LIFE / 1994</span>
        </nav>
        <div className="command-bar">
          <span className={`run-indicator run-${running.toLowerCase()}`}>
            <i />
            {running}
          </span>
          <div className="population-counter">
            <span>ALIVE</span>
            <strong>{String(living.length).padStart(3, "0")}</strong>
            <span>/ {world.capacity}</span>
          </div>
          <span className="simulation-clock">{elapsed(world.time)}</span>
          <div className="playback-controls" aria-label="Simulation controls">
            <button
              className="square-button"
              disabled={!canPlay}
              onClick={() => void act({ type: "pause", paused: !world.paused })}
              aria-label={world.paused ? "Resume world" : "Pause world"}
            >
              <PixelIcon name={world.paused ? "run" : "pause"} size={14} />
            </button>
            {([1, 4, 12] as const).map((speed) => (
              <button
                key={speed}
                className={world.speed === speed ? "button-pressed" : ""}
                disabled={!canPlay}
                aria-pressed={world.speed === speed}
                aria-label={`${speed} times simulation speed`}
                onClick={() => void act({ type: "speed", speed })}
              >
                {speed}×
              </button>
            ))}
          </div>
          <span className="command-spacer" />
          <button
            className="square-button"
            aria-label="Toggle creature inspector"
            aria-expanded={inspectorOpen}
            onClick={() => setInspectorOpen((value) => !value)}
            title="Individual inspector"
          >
            <PixelIcon name="inspect" size={17} />
          </button>
          <button
            className={`square-button ${terminalOpen ? "button-pressed" : ""}`}
            aria-label="Toggle colony voice"
            aria-expanded={terminalOpen}
            aria-controls={terminalOpen ? "colony-terminal" : undefined}
            onClick={() => setTerminalOpen((value) => !value)}
            title="Colony voice"
          >
            <PixelIcon name="terminal" size={19} />
          </button>
          <button
            className="square-button"
            aria-label={sound ? "Mute creature sounds" : "Enable creature sounds"}
            aria-pressed={sound}
            onClick={() => setSound((value) => !value)}
          >
            <PixelIcon name={sound ? "sound" : "mute"} size={18} />
          </button>
          <button
            className="square-button"
            aria-label="World files"
            onClick={() => files(false)}
            title="Open or create a world"
          >
            <PixelIcon name="files" size={19} />
          </button>
        </div>
        <div className="workspace">
          <aside className="toolwell" aria-label="Tool palette">
            <div className="palette-caption" aria-hidden="true">
              TOOLS
            </div>
            <div className="care-tools" role="toolbar" aria-label="Care tools">
              {TOOLS.map((item, index) => (
                <button
                  key={item.id}
                  className={`tool-button ${tool === item.id ? "tool-selected" : ""} ${item.id === "kill" ? "squash-tool" : ""}`}
                  disabled={!canPlay}
                  aria-label={item.id === "kill" ? "Kill creature" : `${item.label} tool`}
                  aria-pressed={tool === item.id}
                  aria-keyshortcuts={String(index + 1)}
                  title={`${item.label} [${index + 1}] — ${item.hint}`}
                  onClick={() => setTool(item.id)}
                >
                  <PixelIcon name={item.icon} size={22} />
                  <span>{item.label}</span>
                  <kbd>{index + 1}</kbd>
                </button>
              ))}
            </div>
            <button
              className={`build-tool ${isStructure(tool) ? "button-pressed" : ""}`}
              disabled={!canPlay}
              aria-label="Build for the colony"
              onClick={() => setDialog("build")}
            >
              <PixelIcon name="build" size={21} />
              <span>Build</span>
            </button>
          </aside>
          <section
            id="playfield"
            className={`field-frame ${tool === "kill" ? "field-kill-armed" : ""}`}
            aria-label="Living world"
            tabIndex={-1}
          >
            <div className="canvas-wrap">
              <WorldCanvas
                world={world}
                selectedId={selectedId}
                tool={tool}
                onSelect={onWorldSelect}
                onInteract={interact}
                sound={sound}
                reducedMotion={reducedMotion}
              />
              {!world.hatched && (
                <div className="initialize-prompt">
                  <span>ONE EGG. NO INSTRUCTIONS.</span>
                  <button
                    className="default-button"
                    disabled={!connected || changing}
                    onClick={() => void act({ type: "hatch" })}
                  >
                    Hatch the egg
                  </button>
                </div>
              )}
              {world.paused && world.hatched && (
                <div className="paused-overlay" aria-hidden="true">
                  PAUSED
                </div>
              )}
            </div>
          </section>
          {inspectorOpen && (
            <Inspector
              world={world}
              selectedId={selectedId}
              onSelect={focus}
              onClose={() => setInspectorOpen(false)}
            />
          )}
        </div>
        <div className="vitals-strip">
          <button
            className="vitals-subject"
            onClick={() => setInspectorOpen((value) => !value)}
            title="Open individual inspector"
          >
            {selected ? `${selected.name}${selected.alive ? "" : " [ARCHIVE]"}` : "COLONY MEAN"}
            <span>▾</span>
          </button>
          <NeedMeters
            name={selected?.name ?? "Colony average"}
            needs={selected?.needs ?? averaged}
          />
          <span className="resource-counter">
            WOOD {Math.floor(world.resources.wood)} · STONE {Math.floor(world.resources.stone)}
          </span>
        </div>
        <div className={`tool-status ${tool === "kill" ? "kill-armed" : ""}`}>
          <span>
            {!connected
              ? "World connection lost. Retrying…"
              : changing
                ? "Opening world…"
                : !world.hatched
                  ? "Hatch the egg to initialize the habitat."
                  : hint}
          </span>
          {tool !== "inspect" && (
            <button onClick={() => setTool("inspect")} aria-label="Cancel selected tool">
              Cancel <kbd>Esc</kbd>
            </button>
          )}
        </div>
        {terminalOpen && (
          <ColonyTerminal
            world={world}
            connected={connected && !changing}
            onClose={() => setTerminalOpen(false)}
            onMessage={(text) => act({ type: "message", text })}
          />
        )}
        <footer className="statusbar">
          <button
            className={`brain-indicator brain-${brain.kind}`}
            aria-label={`Claude status: ${brain.label}. Open connection settings`}
            onClick={() => setDialog("settings")}
          >
            <i />
            {brain.label}
          </button>
          <span className="status-notice" role="status" aria-live="polite">
            {notice ??
              (error ? "World connection interrupted." : `PHASE: ${world.stage.toUpperCase()}`)}
          </span>
          <span className="save-indicator">LOCAL SAVE</span>
        </footer>
      </section>
      {dialog === "settings" && (
        <RetroDialog
          open
          onClose={() => setDialog(null)}
          title="THRONG — Claude connection"
          description="Real model access, request state, and display preferences."
        >
          <ClaudeConnection
            brain={world.brain}
            onConnected={() => announce("Claude access verified. Waiting for live model status.")}
          />
          <fieldset className="display-settings">
            <legend>Display &amp; sound</legend>
            <label>
              <input
                type="checkbox"
                checked={sound}
                onChange={(event) => setSound(event.target.checked)}
              />{" "}
              Creature sound
            </label>
            <label>
              <input
                type="checkbox"
                checked={reducedMotion}
                onChange={(event) => setReducedMotion(event.target.checked)}
              />{" "}
              Reduce decorative motion
            </label>
            <p className="small-print">
              Sound starts after a field interaction. Body movement remains visible with reduced
              motion.
            </p>
          </fieldset>
        </RetroDialog>
      )}
      {dialog === "files" && (
        <RetroDialog
          open
          onClose={() => setDialog(null)}
          title="THRONG — World files"
          description="Open a saved world or create a separate one. Existing worlds and their histories are preserved."
        >
          <WorldFiles
            changeColony={changeColony}
            createFirst={newFile}
            setChanging={setChanging}
            onDone={(message) => {
              setDialog(null);
              announce(message);
            }}
          />
        </RetroDialog>
      )}
      {dialog === "build" && (
        <RetroDialog
          open
          onClose={() => setDialog(null)}
          title="THRONG — Structures & capacity"
          description="Place a construction plan in the field. The colony gathers materials and builds it."
        >
          <Construction
            world={world}
            canPlay={canPlay}
            act={act}
            onPlan={(kind) => {
              setTool(kind);
              setDialog(null);
            }}
          />
        </RetroDialog>
      )}
      {dialog === "history" && (
        <RetroDialog
          open
          onClose={() => setDialog(null)}
          title="THRONG — Activity log"
          description="Recorded events from this world."
        >
          <ActivityLog
            world={world}
            onSelect={(id) => {
              focus(id);
              setDialog(null);
            }}
          />
        </RetroDialog>
      )}
      {dialog === "help" && (
        <RetroDialog
          open
          onClose={() => setDialog(null)}
          title="About THRONG"
          description="An original artificial-life game interface inspired by the 1994 setting of Black Mirror’s Plaything."
          wide
        >
          <HelpManual tools={TOOLS} />
        </RetroDialog>
      )}
    </main>
  );
}
