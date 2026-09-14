import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, CommandResult, SceneState } from "../shared/types";

export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    signal,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(typeof data.error === "string" ? data.error : "The game could not respond.");
  return data as T;
}
export function useColony() {
  const [world, setWorld] = useState<SceneState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const accept = useCallback((state: SceneState) => {
    if (state.serverTime < latest.current) return;
    latest.current = state.serverTime;
    setWorld(state);
    setError(null);
  }, []);
  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 500;
    const abort = new AbortController();
    void request<SceneState>("/api/state", undefined, abort.signal)
      .then(accept)
      .catch((e) => {
        if (!stopped) setError((e as Error).message);
      });
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/live`,
      );
      socket.onopen = () => {
        if (!stopped) {
          setConnected(true);
          delay = 500;
        }
      };
      socket.onmessage = (event) => {
        if (stopped) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === "state") accept(data.state);
        } catch {
          /* Ignore incomplete frames. */
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stopped) return;
        setConnected(false);
        timer = setTimeout(connect, delay);
        delay = Math.min(8000, delay * 2);
      };
    };
    connect();
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
      socket?.close();
    };
  }, [accept]);
  const send = useCallback(
    async (command: Command): Promise<CommandResult> => {
      const response = await request<{ result: CommandResult; state: SceneState }>(
        "/api/command",
        command,
      );
      accept(response.state);
      return response.result;
    },
    [accept],
  );
  const changeColony = useCallback(
    async (path: string, body: unknown) => {
      const next = await request<SceneState>(path, body);
      accept(next);
      return next;
    },
    [accept],
  );
  return { world, connected, error, send, changeColony };
}
