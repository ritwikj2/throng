import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  BrainApiStyle,
  BrainConnectionInput,
  BrainProvider,
  BrainStatus,
} from "../../shared/types";
import { request } from "../useColony";
import { BRAIN_PROVIDER_LABELS, brainReadout } from "./status";

type ConnectionResult = {
  brain: BrainStatus;
  verification: "decision-tested" | "offline";
};

function defaultApiStyle(provider: BrainProvider): BrainApiStyle {
  return provider === "openai" ? "responses" : "chat-completions";
}

export function BrainConnection({
  brain,
  onConnected,
}: {
  brain: BrainStatus;
  onConnected: (message: string) => void;
}) {
  // Draft settings are initialized once per dialog, independently of live snapshots.
  const [provider, setProvider] = useState<BrainProvider>(brain.provider);
  const [model, setModel] = useState(brain.provider === "local" ? "" : (brain.model ?? ""));
  const [baseURL, setBaseURL] = useState(brain.baseURL ?? "");
  const [apiStyle, setApiStyle] = useState<BrainApiStyle>(
    brain.apiStyle ?? defaultApiStyle(brain.provider),
  );
  const [awsRegion, setAwsRegion] = useState(brain.awsRegion ?? "");
  const [key, setKey] = useState("");
  const [limit, setLimit] = useState(
    brain.provider !== "local" &&
      Number.isInteger(brain.budgetPerMinute) &&
      brain.budgetPerMinute >= 1 &&
      brain.budgetPerMinute <= 60
      ? String(brain.budgetPerMinute)
      : "24",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const requestAbort = useRef<AbortController | null>(null);
  const active = useRef(true);
  const readout = brainReadout(brain);
  const external = provider !== "local";
  const requiresKey = provider === "anthropic" || provider === "openai";
  const showsKey = requiresKey || provider === "compatible";
  const showsProtocol = provider === "compatible";
  const complete =
    !external ||
    (!!model.trim() &&
      (!requiresKey || !!key.trim()) &&
      (provider !== "compatible" || !!baseURL.trim()) &&
      (provider !== "bedrock" || !!awsRegion.trim()));

  // Clear detached password elements as well as state when a field or dialog closes.
  const passwordRef = useCallback((element: HTMLInputElement | null) => {
    if (input.current && input.current !== element) input.current.value = "";
    input.current = element;
  }, []);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      requestAbort.current?.abort();
      if (input.current) input.current.value = "";
    };
  }, []);

  const clearKey = () => {
    setKey("");
    if (input.current) input.current.value = "";
  };
  const clearFeedback = () => {
    setError(null);
    setConfirmation(null);
  };
  const changeProvider = (next: BrainProvider) => {
    clearKey();
    clearFeedback();
    setProvider(next);
    const current = brain.provider === next;
    setModel(current && next !== "local" ? (brain.model ?? "") : "");
    setBaseURL(current ? (brain.baseURL ?? "") : "");
    setAwsRegion(current ? (brain.awsRegion ?? "") : "");
    setApiStyle(current ? (brain.apiStyle ?? defaultApiStyle(next)) : defaultApiStyle(next));
  };

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || requestAbort.current) return;
    const apiKey = key.trim();
    clearKey();
    clearFeedback();
    if (!complete) {
      setError("Complete the required connection fields, then submit again.");
      return;
    }
    const calls = limit.trim() === "" ? undefined : Number(limit);
    if (external && calls !== undefined && (!Number.isInteger(calls) || calls < 1 || calls > 60)) {
      setError("Choose a request limit from 1 to 60 per minute, or leave it empty.");
      return;
    }
    if (provider === "compatible") {
      try {
        const endpoint = new URL(baseURL.trim());
        if (
          !["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password
        )
          throw new Error("Invalid endpoint");
      } catch {
        setError("Enter a full http:// or https:// base URL without a username or password.");
        return;
      }
    }
    const body: BrainConnectionInput = external
      ? {
          provider,
          model: model.trim(),
          ...(showsKey && apiKey ? { apiKey } : {}),
          ...(provider === "compatible" ? { baseURL: baseURL.trim() } : {}),
          ...(showsProtocol ? { apiStyle } : {}),
          ...(provider === "bedrock" ? { awsRegion: awsRegion.trim() } : {}),
          ...(calls === undefined ? {} : { callsPerMinute: calls }),
        }
      : { provider };
    setPending(true);
    const controller = new AbortController();
    requestAbort.current = controller;
    try {
      const result = await request<ConnectionResult>("/api/brain/connect", body, controller.signal);
      if (!active.current) return;
      const verified =
        result.brain.provider === provider &&
        (external
          ? result.verification === "decision-tested" && result.brain.ready
          : result.verification === "offline");
      if (!verified) {
        setError(
          "The server did not confirm this connection. Check live brain status before retrying.",
        );
        return;
      }
      const connected = brainReadout(result.brain);
      const message = external
        ? `${connected.provider} · ${connected.model}: test decision passed. Colony plans will appear in live status.`
        : "Brain offline — body simulation only. No model request was made.";
      setConfirmation(message);
      onConnected(message);
    } catch (cause) {
      if (!active.current || (cause instanceof Error && cause.name === "AbortError")) return;
      // The connection endpoint returns sanitized, categorized error messages.
      setError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : external
            ? "Brain connection failed. Check the model, connection settings, credentials, and access. Live brain status is shown above."
            : "Offline mode was not confirmed. Check live brain status and try again.",
      );
    } finally {
      if (active.current) setPending(false);
      if (requestAbort.current === controller) requestAbort.current = null;
    }
  };

  return (
    <div className="connection-settings">
      <div className={`connection-readout connection-${readout.kind}`} data-testid="brain-status">
        <span className="status-led" aria-hidden="true" />
        <strong>{readout.label}</strong>
      </div>
      {brain.lastError && (
        <p className="system-error" role="status">
          {brain.lastError}
        </p>
      )}
      <dl className="connection-counters" aria-label="Live brain counters">
        <div className="connection-detail">
          <dt>Provider</dt>
          <dd>{readout.provider}</dd>
        </div>
        <div className="connection-detail">
          <dt>Runtime model</dt>
          <dd>{readout.model}</dd>
        </div>
        {brain.provider === "compatible" && brain.baseURL && (
          <div className="connection-detail">
            <dt>Endpoint</dt>
            <dd>{brain.baseURL}</dd>
          </div>
        )}
        {brain.provider === "bedrock" && brain.awsRegion && (
          <div className="connection-detail">
            <dt>AWS region</dt>
            <dd>{brain.awsRegion}</dd>
          </div>
        )}
        {brain.provider !== "local" && brain.apiStyle && (
          <div className="connection-detail">
            <dt>Protocol</dt>
            <dd>{brain.apiStyle}</dd>
          </div>
        )}
        <div>
          <dt>Requests</dt>
          <dd data-testid="brain-calls">{brain.calls}</dd>
        </div>
        <div>
          <dt>In flight</dt>
          <dd data-testid="brain-pending">{brain.pending}</dd>
        </div>
        <div>
          <dt>Failures</dt>
          <dd data-testid="brain-failures">{brain.failures}</dd>
        </div>
        <div>
          <dt>Applied plans</dt>
          <dd data-testid="brain-accepted">{readout.accepted ?? "Not reported"}</dd>
        </div>
        <div>
          <dt>Rejected plans</dt>
          <dd data-testid="brain-rejected">{readout.rejected ?? "Not reported"}</dd>
        </div>
      </dl>
      <form
        className="connect-form"
        id="brain-connect-form"
        noValidate
        onSubmit={connect}
        aria-busy={pending}
      >
        <h3>Connect brain</h3>
        <label htmlFor="brain-provider">Provider</label>
        <select
          id="brain-provider"
          value={provider}
          onChange={(event) => changeProvider(event.target.value as BrainProvider)}
          disabled={pending}
          aria-describedby="brain-provider-help"
        >
          {Object.entries(BRAIN_PROVIDER_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <p id="brain-provider-help" className="small-print">
          {provider === "local"
            ? "Offline body simulation. Creatures keep their physical needs and body behavior; no model decisions are requested."
            : provider === "anthropic"
              ? "Use an Anthropic API model ID and a key with access to that model."
              : provider === "openai"
                ? "Official OpenAI connections use the Responses API. Use a model ID available to your OpenAI API account, including Codex models if your account has access. This does not sign into the Codex CLI or ChatGPT app."
                : provider === "bedrock"
                  ? "Claude on Amazon Bedrock uses the game server’s AWS credentials. Enter a Claude model or inference-profile ID and its AWS region. No AWS keys are entered here."
                  : "Connect a service that supports the selected OpenAI-compatible protocol. Its URL is required; keys from other providers are never reused."}
        </p>
        {external && (
          <>
            <label htmlFor="brain-model">
              {provider === "bedrock" ? "Model or inference-profile ID" : "API model ID"}
            </label>
            <input
              id="brain-model"
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                clearFeedback();
              }}
              placeholder={
                provider === "bedrock"
                  ? "Claude model or inference-profile ID"
                  : "Enter the provider’s exact model ID"
              }
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              disabled={pending}
            />
            {provider === "compatible" && (
              <>
                <label htmlFor="brain-base-url">API base URL</label>
                <input
                  id="brain-base-url"
                  type="url"
                  value={baseURL}
                  onChange={(event) => {
                    clearKey();
                    setBaseURL(event.target.value);
                    clearFeedback();
                  }}
                  placeholder="http://localhost:8000/v1"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  disabled={pending}
                  aria-describedby="brain-endpoint-help"
                />
                <p id="brain-endpoint-help" className="small-print">
                  The game server calls this endpoint. localhost means the server’s machine, not the
                  browser’s.
                </p>
              </>
            )}
            {showsProtocol && (
              <>
                <label htmlFor="brain-api-style">API protocol</label>
                <select
                  id="brain-api-style"
                  value={apiStyle}
                  onChange={(event) => {
                    clearKey();
                    setApiStyle(event.target.value as BrainApiStyle);
                    clearFeedback();
                  }}
                  disabled={pending}
                >
                  <option value="responses">Responses API</option>
                  <option value="chat-completions">Chat completions API</option>
                </select>
              </>
            )}
            {provider === "bedrock" && (
              <>
                <label htmlFor="brain-aws-region">AWS region</label>
                <input
                  id="brain-aws-region"
                  value={awsRegion}
                  onChange={(event) => {
                    setAwsRegion(event.target.value);
                    clearFeedback();
                  }}
                  placeholder="Region hosting the model"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  disabled={pending}
                />
              </>
            )}
            {showsKey && (
              <>
                <label htmlFor="brain-api-key">
                  API key{" "}
                  {provider === "compatible" && <span className="muted-text">(optional)</span>}
                </label>
                <input
                  ref={passwordRef}
                  id="brain-api-key"
                  type="password"
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value);
                    clearFeedback();
                  }}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={
                    requiresKey ? "Enter your API key" : "Leave empty if the endpoint needs no key"
                  }
                  required={requiresKey}
                  disabled={pending}
                  aria-describedby="brain-key-handling"
                />
                <p id="brain-key-handling" className="small-print">
                  Keys are stored only by the game server. Existing keys are never returned or
                  prefilled. The password clears on provider, endpoint, or protocol changes, submit,
                  and close; the app does not store it in the browser.
                </p>
              </>
            )}
            <label htmlFor="brain-request-limit">
              Calls per minute <span className="muted-text">(optional)</span>
            </label>
            <input
              id="brain-request-limit"
              type="number"
              inputMode="numeric"
              min={1}
              max={60}
              step={1}
              value={limit}
              onChange={(event) => {
                setLimit(event.target.value);
                clearFeedback();
              }}
              disabled={pending}
            />
          </>
        )}
        <p id="brain-verification-notice" className="connection-verification">
          {external
            ? "Connecting sends one small test decision for an isolated creature. Your provider may charge for it. The new settings are saved and the current brain is replaced only after the test passes."
            : "Selecting offline mode stops model planning. Body simulation continues. No model call is made."}
        </p>
        <div className="connect-feedback" id="brain-connect-feedback" aria-live="polite">
          {pending ? (
            <p>
              {external
                ? "Testing one isolated decision…"
                : "Switching to offline body simulation…"}
            </p>
          ) : error ? (
            <p className="system-error" role="alert">
              {error}
            </p>
          ) : confirmation ? (
            <p>{confirmation}</p>
          ) : null}
        </div>
        <button
          id="brain-connect-submit"
          type="submit"
          className="default-button"
          disabled={pending || !complete}
          aria-describedby="brain-verification-notice"
        >
          {pending ? (external ? "Testing…" : "Switching…") : "Connect brain"}
        </button>
      </form>
    </div>
  );
}
