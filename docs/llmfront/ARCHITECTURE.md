# OpenFrontIO architecture (pre-change notes)

Baseline: `OpenFrontIO/` @ `e8de20089`. Paths below are relative to that repo. Source: scout pass over the code; line refs are approximate, re-verify before editing.

## Layout
| Part | Location | Role |
|---|---|---|
| engine-api | `packages/engine-api` | intent/config schemas (`src/Schemas.ts`), game types/enums (`game/GameTypes.ts`), worker protocol, read-view interfaces |
| engine-lib | `packages/engine-lib` | tile grid, `Config` rules, `PseudoRandom`, `DetMath` |
| engine | `packages/engine` | simulation: `GameRunner`, `game/GameImpl`, `game/PlayerImpl`, `execution/*`, worker entry |
| shared | `packages/shared` | wire/HTTP schemas, env, map loaders |
| client | `src/client` | Pixi/Lit UI, `Transport.ts` (WebSocket), settings UI in `hud/layers/SettingsModal.ts` |
| server | `src/server` | `GameServer.ts`: intent relay, turn bundling |

Layer rules are enforced by `tests/LayerBoundaries.test.ts`. The engine may not use `Math.random`, `Date.now`, fetch, or host APIs, so **LLM/HTTP code cannot live in the engine**.

## Key flows
- **State**: `GameImpl` / `PlayerImpl` (`packages/engine/src/game/`). Tiles are `TileRef` ints in typed arrays; gold is `bigint`.
- **Tick**: `GameRunner.addTurn()` queues a Turn; `executeNextTick()` turns the Turn's intents into Executions (`execution/ExecutionManager.ts`), runs `game.executeNextTick()`, and posts updates back. Runs in a Web Worker (`worker/Worker.worker.ts`).
- **Intents**: client action -> `Transport.ts` -> `GameServer.handleIntent()` -> `endTurn()` bundles a Turn -> relayed to all clients -> `GameRunner.addTurn()`.
- **Lockstep**: the sim runs on every client; the server only relays intents. State must be a pure function of (seed, Turn sequence).
- **Existing AI**: `NationExecution` plus behaviors in `execution/nation/` (alliance, warship, nuke, structure, attack). Bots/nations emit actions via the same execution path as humans.
- **Diplomacy today**: alliance requests/alliances, embargo, donate gold/troops, emoji, quick-chat (all Executions). No free-text messaging, treaties, or trade agreements.
- **Economy**: `PlayerExecution` per-tick gold/troop income; `ConstructionExecution` spends gold.
- **Headless**: `tests/util/Setup.ts` builds a game without a browser; `npm run perf:game` / `replay:game` drive full games.

## Design consequences for LLMFront
1. LLM output must enter as **recorded Intents in a Turn**, never as direct engine calls (determinism/replay).
2. LLM calls (async, nondeterministic) live **outside the engine**, in a new module that observes state through read-views and submits intents through the same path as a human client. This also keeps the "simulation never waits for the LLM" requirement.
3. Because the sim is lockstep, exactly **one** place must decide for each empire (otherwise every client would query the LLM). Candidate: a single brain host that submits intents (server side or a designated client). **Open question — decide before Phase 2.**
4. Observation/fog-of-war is built from engine read-views only (`engine-api/game/ReadViews.ts`).
5. Features with no engine support yet (text messages, treaties, trade, intel levels) need new intent types + executions in engine (with tests, per CLAUDE.md), not a parallel system.

## Local run notes
- Requires node `>=24.15 <25` and **npm `>=12.1 <13`** (npm 12.1.0 installed globally).
- `npm run inst`, then `npm run dev` -> client http://localhost:9000, workers on 3001/3002.
- `localhost:8787` (closed-source API) errors in the server log are expected and harmless for solo play.
