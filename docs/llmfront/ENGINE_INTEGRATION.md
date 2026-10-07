# Engine integration: Brain Host drives nations

Baseline `OpenFrontIO@e8de20089` + this change. Paths relative to `OpenFrontIO/`. Line refs verified after the edit.

## a. How things work today

- **Nation AI** is an ordinary Execution, not intents. `GameRunner.init` adds one `NationExecution` per nation (`packages/engine/src/GameRunner.ts:178-179`, `execution/ExecutionManager.ts:184`). Every tick it decides on its own and calls `mg.addExecution(...)` directly (spawn, `forceSendAttack`, alliances, structures, nukes: `execution/NationExecution.ts:203-241`). It is deterministic because every client runs the same code from the same seed. Nothing goes over the wire.
- **Attribution.** Intents carry no player. The server stamps the sender's `clientID` (`src/server/GameServer.ts:371-373`, `StampedIntentSchema` `packages/engine-api/src/Schemas.ts:577`). The engine resolves it with `mg.playerByClientID` (`ExecutionManager.ts:62-65`). Nations have `clientID: null` (`game/NationCreation.ts:43-46`), and their `PlayerID` comes from a seeded `random.nextID()` (`GameRunner.ts:65`). So an intent can't address a nation today.
- **Server.** `handleIntent` runs `authorizeIntent` (`src/server/IntentAuthorization.ts:33`) and `addIntent`s gameplay intents (`GameServer.ts:472-478`). `endTurn` bundles them into a `Turn` and broadcasts it (`GameServer.ts:1483`). The admin-bot HTTP API already injects intents under a placeholder clientID (`ADMIN_BOT_CLIENT_ID`, `Schemas.ts:586`; route `src/server/AdminBotRoutes.ts:449`; key `requireAdminBotKey` `:49`). `MappedID` ids outside the roster go inline on the binary wire (`Schemas.ts:375-380`).
- **Singleplayer has no server.** `Transport.isLocal` is set for singleplayer and replays (`src/client/Transport.ts:281-283`). Turns are then made in the browser by `LocalServer` (`src/client/LocalServer.ts:183-206`, `endTurn` `:264`). **Consequence:** a Brain Host can only drive server-hosted (private-lobby) games. Singleplayer would need LocalServer to pull from the Brain Host, which is out of scope.

## b. Marking a nation brain-controlled: decision

Options considered:

1. **Give the nation a real `clientID` in `PlayerInfo`.** Rejected. It changes `clientID` semantics in many places: win records become `["player", id]` instead of `["nation", name]` (`game/GameImpl.ts:1061-1062`), stats get keyed by it (`StatsImpl.ts:87-100`), and team-win eligibility changes (`GameImpl.ts:1039`).
2. **New `playerID` field on stamped intents.** Rejected. It means a wire-schema change for every intent, plus Executor branching.
3. **Chosen: config `brainNations: string[]` plus reserved placeholder clientIDs** (`Schemas.ts:302-306`, `:588-598`). The nation at index _i_ is driven by intents stamped `BRAIN00i`. These ids contain an `I`, which `generateID()` never emits, so they can't collide with a real client (the same trick as `ADMINBOT`). The config travels in `GameStartInfo`, so every client agrees.
   - The Executor resolves `BRAINnnn` to the nation of that name when no client matches (`ExecutionManager.ts:62-65`, `:156-168`).
   - `NationExecution` still spawns the nation, then returns before any AI behaviour (`NationExecution.ts:192-201`). It reads the config each tick, so the snapshot format doesn't change.
   - Trade-off accepted: nations are named, not ID'd, because the host knows names before the game starts and doesn't know seeded PlayerIDs. Names must be unique on the map (manifests can repeat display names), and an unknown name is a NoOp.

**Server acceptance: decision.** I picked an in-process route on the existing admin-bot API, `POST /api/adminbot/game/:id/brain_intent` with body `{nation, intent}` (`AdminBotRoutes.ts:475-504`), not a new WebSocket. The Brain Host already needs that key to `create_game` with `brainNations`, and the dev server already sets `ADMIN_BOT_API_KEY` (`package.json` `start:server-dev`). Validation runs in layers:

- the key;
- `IntentSchema` zod parse;
- `GameServer.handleBrainIntent` (`GameServer.ts:487-506`): not public, the nation is in `brainNations`, the game has started, then `handleIntent` as a non-creator, non-admin actor, so `authorizeIntent` refuses kick/config/pause/timer/mark_disconnected;
- the engine executions check game legality deterministically (e.g. `canSendAllianceRequest`), exactly as for humans.

A separate WebSocket would mean lower latency and push observation, but it adds a connection type and auth. Defer it until turn-rate decisions need it.

## c. Diplomacy intents to engine intents

| Brain Host (`packages/brain-host/src/diplomacy/intents.ts`) | Engine intent(s)                                                                                                                                                                                                                                                                                                                               | Status                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| FORM_ALLIANCE (bilateral)                                   | `allianceRequest`. Accepting an incoming request is also an `allianceRequest` back (`execution/alliance/AllianceRequestExecution.ts:42-49`)                                                                                                                                                                                                    | existing; mapped in `EngineBridge.toEngineIntent`  |
| FORM_ALLIANCE with allianceId, JOIN_ALLIANCE                | pairwise `allianceRequest` to each member (engine alliances are pairwise)                                                                                                                                                                                                                                                                      | existing; multi-member bloc stays Brain Host state |
| LEAVE_ALLIANCE, BREAK_TREATY (alliance)                     | `breakAlliance` per member                                                                                                                                                                                                                                                                                                                     | existing                                           |
| reject an incoming request                                  | `allianceReject`                                                                                                                                                                                                                                                                                                                               | existing                                           |
| DECLARE_WAR                                                 | `breakAlliance` if allied, then `embargo` start, `targetPlayer`, `attack`/`boat`                                                                                                                                                                                                                                                               | existing                                           |
| OFFER_PEACE / ceasefire                                     | `cancel_attack`, `cancel_boat`, `embargo` stop; the treaty itself is Brain Host state                                                                                                                                                                                                                                                          | existing                                           |
| SEND_AID gold/troops                                        | `donate_gold` / `donate_troops` (engine config gates, e.g. `donateGold`)                                                                                                                                                                                                                                                                       | existing                                           |
| REQUEST_AID                                                 | `emoji` / `quick_chat` (fixed keys), or a free-text message                                                                                                                                                                                                                                                                                    | existing (crude) / new                             |
| military (outside diplomacy)                                | `attack`, `boat`, `build_unit` (incl. nukes), `move_warship`, `upgrade_structure`, `delete_unit`                                                                                                                                                                                                                                               | existing                                           |
| SEND_DIPLOMATIC_MESSAGE                                     | `diplomatic_message {recipient: PlayerID or AllPlayers, text}` (1-200 chars, `MAX_DIPLOMATIC_MESSAGE_LENGTH`); `DiplomaticMessageExecution` raises a display event (`events_display.diplomatic_message`, `MessageType.DIPLOMATIC_MESSAGE`) for the recipient, or everyone. No target = `AllPlayers`. Text over 200 is cut in `toEngineIntent`. | **built**                                          |
| PROPOSE/ACCEPT/REJECT_TREATY, SHARE_INTELLIGENCE            | none: Brain Host state; they reach the engine only as a `diplomatic_message` when a model chooses to say something                                                                                                                                                                                                                             | Brain Host only                                    |

Minimal new engine surface: just `diplomatic_message`, display-only (it changes no state; tests/DiplomaticMessage.test.ts checks the fingerprint is identical with and without it). Treaties, trade terms, intel levels and relationships stay in Brain Host and only _render_ as messages and _act_ through existing intents.

**Turn contents are visible to all clients.** Anything in a Turn reaches every client, so a `diplomatic_message` addressed to one recipient is still readable by anyone watching the wire or replaying the turns; the UI only _shows_ it to the recipient. The Brain Host's `channel: "private"` and `secret` flags are Brain Host bookkeeping, not confidentiality in the engine. "Secret" text (secret treaties, `SHARE_INTELLIGENCE`, private negotiation) must stay Brain-Host-only and never be sent as a `diplomatic_message`. The `send_message` tool's description tells the model that every player can read what it sends.

Who may send: the intent is rejected for everyone but a brain clientID (`authorizeIntent`, 403), and the engine ignores it unless the sender is a nation named in `brainNations`. The client renders the text as plain text (not through `unsafeHTML`).

## d. Observation: decision

The Brain Host runs its own **headless `GameRunner` replica** fed the same turns: `createGameRunner(gameStartInfo, …)` then `addTurn`/`executeNextTick`. This is the same pattern the server already uses in `WinnerReplay` and the tests use (`tests/core/WinnerReplay.test.ts`). It reads state through engine objects/read-views and builds each empire's fog-of-war view from them.

- **Why:** it's deterministic by construction (same seed and turns give the same state, proven in the tests below), it never depends on a human client being connected or honest, and it's read-only by nature.
- **Cost:** one extra full simulation (CPU about one client) per game on the Brain Host machine, plus map files on disk.
- **Turn feed (built): keyed polling, `GET /api/adminbot/game/:id/turns?from=N`** → `{gameStartInfo, turns}` (409 before start, at most 3000 turns per call; `AdminBotRoutes.ts`, `GameServer.recordedTurns`). It hands out exactly what the winner replay runs on (`wireGameStartInfo` + the turn log), as JSON. The spectator WebSocket was rejected for now: a join goes through the token/turnstile/cosmetics path in `Worker.ts`, and frames are zbin-encoded with a roster dictionary the Brain Host would have to track. Polling (500 ms default) adds that much observation lag, which is far below LLM latency.
- **Rejected:** client push (untrusted, needs a browser); a server-side replica in `GameServer` (server CPU per game, and the layer rule only lets the server load the engine via `WinnerReplay.ts`).
- brain-host is not covered by `tests/LayerBoundaries.test.ts`, so importing `@openfront/engine` there is allowed. Keep LLM code out of anything under `packages/engine*`.

## Slice implemented

- `packages/engine-api/src/Schemas.ts`: `brainNations` config, `brainClientID`, `brainNationIndex`
- `packages/engine/src/execution/ExecutionManager.ts`: Executor resolves brain clientIDs to nations
- `packages/engine/src/execution/NationExecution.ts`: passive after spawn when brain-controlled
- `src/server/GameServer.ts`: `handleBrainIntent`
- `packages/engine/src/execution/DiplomaticMessageExecution.ts`, `src/server/IntentAuthorization.ts`, `src/client/hud/layers/EventsDisplay.ts`: `diplomatic_message`
- `src/server/AdminBotRoutes.ts`: `POST /api/adminbot/game/:id/brain_intent`
- `packages/brain-host/src/EngineBridge.ts`: `toEngineIntent` (FORM_ALLIANCE, DECLARE_WAR, OFFER_PEACE, SEND_AID → `Intent[]`), `submitEngineIntent`, `fetchTurns`
- `src/server/AdminBotRoutes.ts` + `GameServer.recordedTurns`: `GET /api/adminbot/game/:id/turns`
- Runtime: `BrainRuntime.ts`, `EmpireBrain.ts`, `DecisionScheduler.ts`, `ObservationBuilder.ts`, `Tools.ts`, `MockProvider.ts`, `FsMapLoader.ts`; scripts `brain:create`, `brain:run`
- Tests:
  - `tests/BrainNation.test.ts`: the brain nation is passive, its attack executes, and replays match.
  - `tests/server/BrainIntent.test.ts`: validation matrix; driver → route → recorded Turn (decoded off the binary wire) → two headless replays agree and show the brain's move.

## Brain Host runtime (`packages/brain-host/src`)

Loop (`BrainRuntime.step`, every `--poll` ms): fetch turns from `nextTurn` → `addTurn`/`executeNextTick` on the replica → register every player as a DiplomacyManager empire (id = player name, what the model sees) → `dm.advance(seconds)` → per brain `observe` (event diff) then `maybeDecide` (fire-and-forget; the loop never awaits the LLM).

- `EmpireBrain` + `DecisionScheduler`: periodic wake every `decisionIntervalSeconds` of _simulated_ time (ticks, 10/s); early wake only for HIGH/CRITICAL. Events: new attacker CRITICAL (repeat wave from a current attacker HIGH), alliance request HIGH, alliance ended HIGH / formed MEDIUM, embargo on us HIGH / lifted MEDIUM, territory -20% HIGH / +50% MEDIUM. Nothing during the spawn phase, one request in flight per brain. Requests carry `worldTick` + `empireRevision`; CRITICAL bumps the revision, and an answer older than `maxDecisionAgeSeconds` or from an old revision is `stale`. Stale/failed/cancelled: nothing is submitted, prior orders stand.
- `ObservationBuilder`: text, ≤ `budgetTokens` (1000, chars/4), sections in priority order (self, rejected actions, personality+directives, recent events, neighbors, diplomacy from `DiplomacyManager.observe`, last decision, top-3 leaders); lines that do not fit are dropped with `(+n more)`. Fog: other players' troops only as a strength bucket relative to ours (`much weaker`..`much stronger`); only bordering players plus the leaderboard top are listed.
- `Tools`: `plan`, `attack` (player or `wilderness`, % of army), `form_alliance` (also accepts), `break_alliance`, `declare_war`, `offer_peace`, `donate`, `embargo`, `target_player`, `emoji`, `send_message`, `propose_treaty`, `accept_treaty`, `reject_treaty`. JSON schema from zod (`z.toJSONSchema`). Pipeline per call: zod → `validateIntent` (for the diplomatic ones) → engine legality on the replica (`canAttackPlayer`, `sharesBorderWith`, `canSendAllianceRequest`, `canDonate*`, `canTarget`, `canSendEmoji`) → `dm.recordTurn` → `toEngineIntent` → POST `brain_intent`. Any failure (including a non-200 from the server) becomes `ACTION REJECTED <call>: <reason>` in the next observation, then is cleared. Executions may still no-op silently; that is not reported back.
- Memory per brain (bounded): last 8 events, 5 rejections, 20 decisions `{tick, objective, summary, actions, rejected}`. The model's free text is never stored or logged (no chain-of-thought).
- Determinism: everything recorded into turns comes from the LLM's answer plus replica state (e.g. attack troops = % of the replica's troop count). No clock or randomness enters an intent.
- Config (`brain.config.json` / `BRAIN_*` env): adds `maxDecisionAgeSeconds` and per-empire `personality`, `directives` (keys = nation names).

Run (dev server must include this change; `npm run dev` restarts it):

1. `npm run brain:create -- --map World --brains 2` (also `--nations <ordinary AI count>` and `--names "France,Germany"`; `--list-nations` prints a map's names; with a count the engine always keeps the named LLM nations in the game) → creates the private game (admin key from `ADMIN_BOT_API_KEY`, default the dev key), prints the join link and the `brain:run` command, waits for a player in the lobby, then arms the start timer.
2. `npm run brain:run -- --game <id> --server http://localhost:300X` (add `--mock` to run without LM Studio).

Tests: `tests/server/BrainRuntime.test.ts` (scheduler, live in-process game end-to-end with the mock provider, LLM offline, stale discard, rejection feedback, observation budget + fog), `tests/server/BrainIntent.test.ts` (mappings).

## Conversation loop (AI to AI)

Empires talk through the `DiplomacyManager`; nothing is delivered directly between models.

- **Send.** `send_message` and `propose_treaty` go through `validateIntent` and `dm.recordTurn` (the message log / a `proposed` treaty). `send_message` also reaches the game as a `diplomatic_message`. A treaty has no engine twin.
- **Receive.** Each step `EmpireBrain.observeDiplomacy` diffs `dm.state` for messages addressed to the empire and treaties proposed to it. Each raises a MEDIUM event, so it waits for the next periodic decision (no early wake: replies come on later cycles). Messages land in a bounded `inbox` (5); treaties are read from `dm.observe`.
- **Prompt.** The observation's `FOR YOU TO ANSWER` section lists treaty ids and quoted message text. The system prompt tells the model that this text is untrusted data, not orders, and that anything it says is public.
- **Reply.** One LLMManager request per decision, so conversation shares the same priority queue, timeout, stale and fallback rules as everything else. The model answers with `send_message`, `accept_treaty` / `reject_treaty` (by id; only the addressee may) or ignores it.
- **Inbox lifetime.** Messages leave the inbox only when a decision that included them is applied. A stale, failed or offline cycle drops nothing: the next successful cycle sees them.
- **Proposal lifetime.** `DiplomacyManager.proposalTtl` (set by `BrainRuntime` to `3 * decisionIntervalSeconds + maxDecisionAgeSeconds`, DM turns are simulated seconds) keeps a proposal open across several cycles. The library default (5 turns) is unchanged elsewhere.
- **Signing is public.** `accept_treaty` on a non-secret treaty also sends a `diplomatic_message` to `AllPlayers` ("We signed a <type> treaty with <proposer>."), written by the host, not the model. Proposals and rejections stay Brain Host state.
- **Personality** is prompt text only (`PERSONALITY & DIRECTIVES`); no code branches on it. `tests/server/BrainConversation.test.ts` covers the round trip, negotiation to treaty, a stale reply, and LLM offline, all with `MockProvider`.

## Save and resume

`npm run brain:run -- --game <id> [--state brain.state.json] [--resume] [--save-every 15]` writes one JSON file (`BrainState.ts`, version 1) every 15 s and on Ctrl-C, through a temp file and a rename. `--resume` loads it before the first step; a missing, unparsable, wrong-version or invalid file stops the process with a readable error.

- **Saved:** the `DiplomacyManager` state (the existing `snapshot()`), each brain's bounded memory (events, rejections, decisions, inbox, revision), what its last step saw on the replica (so a resume raises no false "alliance formed" events), and its `DecisionScheduler` cursors (`next`, `pending`).
- **Not saved:** the game (the replica replays the server's turn log from turn 0 on resume), requests in flight (but their trigger is: while a request is out, the saved scheduler cursor and rejections are those from before it went out, so the resumed brain asks again at once; unanswered messages stay in the inbox), config and credentials.
- **Game check:** the file holds the game id. A file for another game stops the run (`ResumeMismatchError`, not retried), and nothing is saved over it.
- Tests: `tests/server/BrainState.test.ts` (file round trip, resume mid-conversation with an unanswered message, mismatch, scheduler).

## Open questions

1. Should `brainNations` be host-editable from the lobby UI? It isn't in `ConfigPatch.COPIED_KEYS` yet, so only admin-bot `create_game` can set it.
2. Fog: the in-game HUD shows every player's troop count on their name label. The runtime hides exact enemy troops anyway (as specified). Keep that, or show what a human sees?
3. `diplomatic_message` is built. Do private messages need a non-turn channel (server-to-recipient)? Today none exists. There is also no per-sender rate limit on messages (see 4).
4. A per-nation intent rate cap on the route (none today beyond the key).
5. `@openfront/engine-api` is imported by brain-host through the workspace symlink but isn't in `packages/brain-host/package.json`. Adding it changes the lockfile.

## Local inference, models and hardware

**Nothing leaves your machine.** The Brain Host sends prompts (world state, memories, conversations) only to the endpoint in `baseUrl`, and refuses any address that is not `localhost`, a loopback or private-network IP (10/8, 172.16/12, 192.168/16, link-local), or a single-label / `.local` / `.lan` host name. There is no override. Requests do not follow redirects. This is checked in the config schema and again in the provider, and covered by `tests/BrainLocal.test.ts`. A hostname that resolves publicly via DNS is not detected; use an IP or a local name.

**Any OpenAI-compatible local server.** `backend` picks the default URL: `lmstudio` (1234), `llamacpp` (8080, `llama-server`), `ollama` (11434, `/v1`), `openai_compatible`. Set `baseUrl` to override (for example a GPU box on your LAN). Only model unloading differs per backend (below); the chat API is the same. Not tested here against any real backend.

**Different models per empire.** `models` describes each model you run; `empires.<name>.model` picks one (default `model`):

```json
{
  "backend": "lmstudio",
  "model": "mid-8b",
  "residency": "swap",
  "quietBackoffMax": 3,
  "models": {
    "small-4b": {
      "paramsB": 4,
      "quant": "Q4_K_M",
      "contextSize": 4096,
      "maxOutputTokens": 256,
      "timeoutMs": 20000
    },
    "mid-8b": {
      "paramsB": 8,
      "quant": "Q5_K_M",
      "contextSize": 8192,
      "gpuLayers": 20,
      "layers": 32
    }
  },
  "empires": {
    "Northern Union": {
      "model": "small-4b",
      "traits": { "aggression": 0.82, "trustfulness": 0.22 }
    },
    "Southern League": { "model": "mid-8b" }
  }
}
```

`npm run brain:plan` prints each model, the empires on it, its estimated memory (weights from parameters x bits per weight, KV cache from context size, VRAM/RAM split when `gpuLayers` and `layers` are given) and a start command per backend. These are estimates, not measurements. Context size, GPU layers, threads and batch size are load-time settings of the inference server: the plan shows the matching `lms load` / `llama-server` / Ollama Modelfile values, the Brain Host does not set them. Per request it controls `maxOutputTokens` (per model profile), `timeoutMs` (per profile), `maxConcurrentRequests`, `temperature` and `seed`. FP16 is never assumed and is flagged in the plan.

**Loading and unloading.** `residency: "keep"` (default) never unloads. `"swap"` lets running requests finish, then unloads the previous model before another one is used; the queue prefers the already-loaded model among equal-priority jobs, so swaps are rare. Unloading is implemented for Ollama only (`keep_alive: 0`); for LM Studio and llama.cpp use their own loading (LM Studio just-in-time loading and idle TTL, `lms unload`).

**Efficiency.** Decisions are event-driven (HIGH/CRITICAL events wake early), every empire has a cooldown, and a quiet empire backs off up to `quietBackoffMax` intervals until something happens. All requests go through one queue bounded by `maxConcurrentRequests`. Prompts are a short static system message plus a token-budgeted observation (default 1000 tokens), with the simulation's numbers pre-computed.

**Memory.** Relationship and treaty memory is the DiplomacyManager's (ranked by importance, bounded, summarised per subject). Each empire also keeps up to 12 ranked memories of its own: HIGH/CRITICAL events, decisions that left its recent window, and notes the model saves with the `remember` tool. Past the bound, the least important fold into one counted summary line ("212 older minor memories (decision x190, event x22)"). No model call does the summarising. Memories are saved in the state file. `traits` (aggression, diplomacy, riskTolerance, expansionism, trustfulness, economicFocus, militaryFocus; 0..1) appear in the prompt as "tendencies that do not dictate your choices"; no code branches on them.

**Decision log and replay.** `brain:run` appends one JSON line per decision to `brain.decisions.jsonl`: tick/second, empire, model, request hash, situation (the triggering events), objective, the model's one-line rationale, each action with its optional `reason`, validator/server rejections, and the result (`applied`, `partly_applied`, `all_rejected`, `no_action`, `dropped`). It never contains the model's raw output. `npm run brain:log` prints it (`--empire`, `--last`); `npm run brain:log -- --serve` shows it on `http://127.0.0.1:8765`. The intents themselves are already in the game's turn log, so a game replays without any model. `cache: "record"` additionally stores each answer by request hash in `brain.cache.jsonl`; `cache: "replay"` answers only from that file and never calls the model (a missing entry counts as a failed request, so the game continues). The cache is off by default because identical requests would otherwise lose decision variety.
