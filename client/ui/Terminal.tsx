import { useEffect, useRef, useState } from "react";
import type { SceneState } from "../../shared/types";
import { elapsed } from "./status";

export function ColonyTerminal({
  world,
  connected,
  onClose,
  onMessage,
}: {
  world: SceneState;
  connected: boolean;
  onClose: () => void;
  onMessage: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [world.id, world.collective.messages.length]);
  return (
    <section className="terminal-drawer" id="colony-terminal" aria-label="Colony voice terminal">
      <div className="terminal-title">
        <h2>COLONY VOICE</h2>
        <span>
          {world.collective.lexicon.length} shared words · {world.collective.sharedKnowledge} shared
          discoveries
        </span>
        <button className="window-button" aria-label="Close colony terminal" onClick={onClose}>
          ×
        </button>
      </div>
      <div
        ref={log}
        className="terminal-log"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
        }}
      >
        {world.collective.messages.length ? (
          world.collective.messages.slice(-30).map((message) => (
            <div className="terminal-line" key={message.id}>
              <time>{elapsed(message.at)}</time>
              <span className="terminal-speaker">
                {message.speaker === "player"
                  ? "YOU"
                  : message.source === "model"
                    ? "THRONG / MODEL"
                    : "THRONG / BODY"}
              </span>
              <p>{message.text}</p>
            </div>
          ))
        ) : (
          <p className="terminal-empty">
            {world.hatched
              ? "No transmissions recorded."
              : "Habitat uninitialized. Hatch the egg to begin."}
          </p>
        )}
      </div>
      <form
        className="terminal-input"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!text.trim() || busy || !connected || !world.hatched) return;
          setBusy(true);
          try {
            if (await onMessage(text.trim())) setText("");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="colony-message">&gt;</label>
        <input
          id="colony-message"
          aria-label="Speak to the Throng"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Broadcast to the colony…"
          maxLength={280}
          disabled={!world.hatched || !connected || busy}
        />
        <button type="submit" disabled={!world.hatched || !connected || busy || !text.trim()}>
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
