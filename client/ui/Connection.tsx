import { useEffect, useRef, useState } from "react";
import type { BrainStatus } from "../../shared/types";
import { request } from "../useColony";
import { brainReadout } from "./status";

export function ClaudeConnection({
  brain,
  onConnected,
}: {
  brain: BrainStatus;
  onConnected: () => void;
}) {
  const [key, setKey] = useState("");
  const [limit, setLimit] = useState("24");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const requestAbort = useRef<AbortController | null>(null);
  const active = useRef(true);
  const readout = brainReadout(brain);
  useEffect(() => {
    active.current = true;
    const element = input.current;
    return () => {
      active.current = false;
      requestAbort.current?.abort();
      if (element) element.value = "";
    };
  }, []);

  return (
    <div className="connection-settings">
      <div className={`connection-readout connection-${readout.kind}`}>
        <span className="status-led" />
        <strong>{readout.label}</strong>
      </div>
      {brain.lastError && (
        <p className="system-error" role="status">
          {brain.lastError}
        </p>
      )}
      <dl className="connection-counters">
        <div>
          <dt>Runtime model</dt>
          <dd>{readout.model}</dd>
        </div>
        <div>
          <dt>Requests</dt>
          <dd>{brain.calls}</dd>
        </div>
        <div>
          <dt>In flight</dt>
          <dd>{brain.pending}</dd>
        </div>
        <div>
          <dt>Failures</dt>
          <dd>{brain.failures}</dd>
        </div>
        <div>
          <dt>Accepted plans</dt>
          <dd>{readout.accepted ?? "Not reported"}</dd>
        </div>
        <div>
          <dt>Rejected plans</dt>
          <dd>{readout.rejected ?? "Not reported"}</dd>
        </div>
      </dl>
      <form
        className="connect-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending || !key.trim()) return;
          const calls = limit.trim() === "" ? undefined : Number(limit);
          if (calls !== undefined && (!Number.isInteger(calls) || calls < 1 || calls > 60)) {
            setError("Choose a request limit from 1 to 60 per minute.");
            return;
          }
          const apiKey = key.trim();
          setKey("");
          if (input.current) input.current.value = "";
          setPending(true);
          setVerified(false);
          setError(null);
          const controller = new AbortController();
          requestAbort.current = controller;
          try {
            const result = await request<{ brain: BrainStatus }>(
              "/api/brain/connect",
              { apiKey, ...(calls === undefined ? {} : { callsPerMinute: calls }) },
              controller.signal,
            );
            if (!active.current) return;
            if (!result.brain.ready || !brainReadout(result.brain).isSonnet) {
              setError(
                "Claude was not activated. Check the key and Sonnet 5 access, then try again.",
              );
            } else {
              setVerified(true);
              onConnected();
            }
          } catch (cause) {
            if (active.current && (cause as Error).name !== "AbortError")
              setError(
                "Claude could not be connected. Check the key and Sonnet 5 access, then try again.",
              );
          } finally {
            if (active.current) setPending(false);
            if (requestAbort.current === controller) requestAbort.current = null;
          }
        }}
      >
        <h3>Connect Claude</h3>
        <label htmlFor="claude-model">Model</label>
        <input id="claude-model" value="claude-sonnet-5" readOnly />
        <label htmlFor="claude-api-key">Anthropic API key</label>
        <input
          ref={input}
          id="claude-api-key"
          type="password"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            setError(null);
            setVerified(false);
          }}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Enter your API key"
          disabled={pending}
          aria-describedby="key-handling"
        />
        <label htmlFor="claude-request-limit">
          Requests per minute <span className="muted-text">(optional)</span>
        </label>
        <input
          id="claude-request-limit"
          type="number"
          inputMode="numeric"
          min={1}
          max={60}
          step={1}
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
          disabled={pending}
        />
        <p id="key-handling" className="small-print">
          The server verifies model access and stores the key privately. This field clears on submit
          or close; the browser does not save it.
        </p>
        <div className="connect-feedback" aria-live="polite">
          {pending ? (
            <p>Verifying Claude Sonnet 5 access…</p>
          ) : error ? (
            <p className="system-error" role="alert">
              {error}
            </p>
          ) : verified ? (
            <p>Access verified. Live status will update from the server.</p>
          ) : null}
        </div>
        <button type="submit" className="default-button" disabled={pending || !key.trim()}>
          {pending ? "Verifying…" : "Connect Claude"}
        </button>
      </form>
    </div>
  );
}
