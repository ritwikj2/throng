# How Throng works

The Node.js server owns the simulation and SQLite saves. The React browser interface draws the world and sends player commands. The selected model provider supplies individual decisions when connected; the body simulation continues between requests.

## World and display

`server/simulation.ts` creates worlds, accepts validated commands, advances life, and admits model plans. Its helpers implement physical actions, perception, personal memory, reward updates, reproduction, and social transfer. Steps are no larger than 0.1 simulated seconds. Acceleration changes simulated time, not animation frequency.

`client/game/` draws a rectangular pixel meadow with original sprites. X points right and Y points down. Static terrain and sprite images are cached. A single `requestAnimationFrame` loop draws each display frame, interpolating position between server snapshots. Pointer and keyboard targeting use the same projection. A Squash click must hit a living creature; a brief flattened marker follows the authoritative death state.

The runtime broadcasts scene snapshots ten times per second. Memory bodies, beliefs, rewards, and relationship records are omitted from those snapshots. The inspector requests one creature’s detailed record separately. The player may inspect any creature; an individual’s model context remains limited to its own knowledge.

## Individual cognition

1. The creature perceives nearby objects and records its observations.
2. Real interactions update needs, preferences, action outcomes, and memory.
3. The model receives a bounded selection of that creature’s experiences, known objects, visible neighbors, needs, body position, relationships, continuing goal, and lesson.
4. It proposes an available action, optional target or walking destination, short public intention/reason, optional speech, and supporting memory IDs. It may preserve or change its goal, record an evidence-backed lesson, or share an offered memory with a visible neighbor.
5. The engine rechecks the proposal against the current state before mutation. Accepted actions drive movement and physical work. Speech enters the collective channel with model provenance.
6. Subsequent decisions receive the retained goal, lesson, and new outcomes. Shared knowledge reaches a recipient through explicit communication, not a global private-memory pool.

There are ten action kinds: idle, walk, eat, wash, play, rest, socialize, gather, build, and sing. A model cannot create resources, teleport, alter needs directly, execute code, or make a tool call outside this action interface. Goal and lesson prose can still be mistaken: valid evidence IDs do not prove the prose is semantically faithful.

This uses a pretrained model with persistent state. It does not train model weights. Local preferences and mean action rewards also adapt through simple game heuristics; they are not a learned neural policy. The inspector distinguishes model plans from body-policy actions. In model mode, fixed local reflection and scripted direct player replies are suppressed.

## Model connection and scheduling

A fresh setup uses `local`, with no model calls. The connection dialog supports Anthropic Messages, OpenAI Responses, a compatible Chat completions or Responses server, Claude on Amazon Bedrock, or offline play. Each external provider accepts a model ID. Unknown protocols require an adapter; a CLI login alone is not a model endpoint. See [provider setup](BRAINS.md).

`POST /api/brain/connect` validates the selected provider, model, credentials, endpoint, region, and call budget. It requests one decision for an isolated synthetic creature through the actual provider adapter, validates the response, and checks that the simulation can apply it. It does not send the saved world during this check. Successful checks atomically save the selected settings to the server's `.env` and replace the scheduler without replacing the world. The file is created with owner-only permissions on POSIX systems. Failed checks keep the prior connection. Closing the dialog or stopping the server cancels verification and settings preparation before the atomic commit. Once settings are committed, activation completes even if the browser disconnects; the next status read reports the saved provider. The world is flushed before the settings commit, and shutdown waits for connection finalization before closing the save store. Offline selection makes no model request.

The dialog clears passwords on submission, closing, or provider/endpoint/protocol changes. Passwords are never prefilled from the server or stored in browser storage. Custom endpoints use a separate `COMPATIBLE_API_KEY`; an empty key omits authentication and clears the previously saved compatible key. The official OpenAI dialog always selects the official endpoint. Custom URLs require HTTPS or loopback HTTP, have no URL credentials/query/fragment, and cannot redirect the request to another origin. Only safe settings and categorized errors appear in status.

The connection check is one separate request outside the colony quota. A passed test establishes one usable decision, not future availability or the quality of every plan. Live counters track applied plans in the actual colony. Manual `.env` configuration is validated at startup but does not send a connection test; `npm run check:brain` provides the opt-in check.

`server/cognition.ts` limits calls by wall-clock time and allows at most two in flight. The dialog and example configuration budget is 24 requests per minute for the entire colony, with an eight-simulation-second minimum between routine attempts per creature. New losses, messages, and shared knowledge can prompt an earlier attempt within the same global budget. The scheduler rotates among individuals. At larger populations, each individual necessarily receives fewer calls.

All adapters have a 1,600-token output ceiling. Sonnet 5 requests use adaptive thinking with low effort; the verified `gpt-5.2-codex` and `gpt-5.3-codex` API IDs request low reasoning effort. OpenAI uses a strict JSON schema, Anthropic/Bedrock use a decision tool, and compatible servers receive a JSON-only instruction with server-side validation. Reasoning can consume part of the output ceiling. The public readout is a short intention and reason, not raw model reasoning. The dialog configures a 25-second timeout. Failures back off; SDK retries and redirects are disabled so scheduled attempts stay bounded.

Pause, world replacement, shutdown, removed or dead creatures, and contexts older than 360 simulated seconds invalidate pending responses. Admission also checks current urgency, known targets, memory ownership, visible recipients, and bounded destinations. Invalid responses, engine refusals, accepted plans, in-flight requests, and failures have distinct status counters.

## Loss and social memory

Squash kills one selected creature without graphic effects. It increments death and player-kill counts, clears carried material, and records a player-caused loss. Nearby witnesses receive their own loss memory. Fear and grief rise, trust falls, and later contexts can include the event. Important losses are retained preferentially when bounded memory fills; ordinary care does not immediately erase the history.

Children begin with separate histories. Shared discoveries retain the source individual and remembered location. The sound vocabulary uses bounded experience categories and synthesized tones; it is a designed social signal system, not a newly trained language.

## Persistence and boundaries

`server/store.ts` saves full serializable world state to SQLite. Goals, lessons, memories, relationships, death counts, and the active colony survive restart. Network requests are not saved; stale pending flags are cleared. Creating or switching colonies keeps earlier saves. No offline catch-up runs, although time continues while the server itself is running and the world is unpaused.

The local server validates loopback Host and Origin headers, content type, command shapes, and request size. Credentials are absent from snapshots and databases. Provider errors use safe categories instead of raw response bodies. A source-export allowlist excludes runtime data, credentials, dependencies, and Git history.

## Verification

`npm run verify` checks TypeScript, formatting, unit/integration tests, and the production build. `npm run test:e2e` exercises the UI, saved worlds, care, loss, mocked provider connections and switching, credential clearing, model-driven movement and speech, mobile layout, accessibility, and display-rate drawing.

`npm run check:brain` is a separate opt-in, one-request live-provider check against an isolated creature. `npm run screenshots` captures a deterministic local-only colony. Neither automated fixtures nor screenshots establish that a real account is currently connected.
