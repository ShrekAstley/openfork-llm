// Usage: npm run brain:run -- --game <id or join link> [--server http://localhost:3001]
//        (without --server the worker that has the game is found on 3001-3004)
//        [--config brain.config.json] [--maps resources/maps] [--mock]
//        [--state brain.state.json] [--resume] [--save-every 15]
// The state file (diplomacy, per-empire memory, scheduler cursors) is written
// every --save-every seconds and on Ctrl-C; --resume continues from it.
// env: ADMIN_BOT_API_KEY (default: the dev key), BRAIN_* (see BrainConfig).
import { parseArgs } from "node:util";
import { loadBrainConfig } from "../src/BrainConfig";
import { BrainRuntime } from "../src/BrainRuntime";
import { loadBrainState, saveBrainState } from "../src/BrainState";
import { FsMapLoader } from "../src/FsMapLoader";
import { LMStudioProvider } from "../src/LMStudioProvider";
import { MockProvider } from "../src/MockProvider";

const { values: a } = parseArgs({
  options: {
    game: { type: "string" },
    server: { type: "string" },
    config: { type: "string", default: "brain.config.json" },
    maps: { type: "string", default: "resources/maps" },
    poll: { type: "string", default: "500" },
    mock: { type: "boolean", default: false },
    state: { type: "string", default: "brain.state.json" },
    resume: { type: "boolean", default: false },
    "save-every": { type: "string", default: "15" },
  },
});
if (!a.game) throw new Error("--game <id or join link> is required");
// A pasted join link works too: .../w0/game/<id>?lobby...
const gameID = /\/game\/([A-Za-z0-9]+)/.exec(a.game)?.[1] ?? a.game;
const adminKey =
  process.env.ADMIN_BOT_API_KEY ??
  "WARNING_DEV_ADMIN_BOT_KEY_DO_NOT_USE_IN_PRODUCTION";
// Each game lives on one worker; without --server, find the one that has it.
async function findServer(): Promise<string> {
  if (a.server) return a.server;
  for (const port of [3001, 3002, 3003, 3004]) {
    const url = `http://localhost:${port}`;
    try {
      const r = await fetch(`${url}/api/adminbot/game/${gameID}/roster`, {
        headers: { "x-admin-bot-key": adminKey },
      });
      if (r.ok) return url;
    } catch {
      // nothing listening there
    }
  }
  throw new Error(
    `no game server on localhost:3001-3004 has game ${gameID}; is the lobby open and npm run dev running? (or pass --server)`,
  );
}
const serverUrl = await findServer();

const config = loadBrainConfig(a.config);
config.decisionLog ||= "brain.decisions.jsonl";
const runtime = new BrainRuntime({
  config,
  provider: a.mock
    ? new MockProvider()
    : new LMStudioProvider({ ...config, backend: config.backend }),
  server: {
    serverUrl,
    adminKey,
    gameID,
  },
  maps: new FsMapLoader(a.maps!),
  log: (l) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${l}`),
});
if (a.resume) runtime.restore(loadBrainState(a.state!));
const save = () => {
  const state = runtime.snapshot();
  if (state) saveBrainState(a.state!, state);
};
const saver = setInterval(save, Number(a["save-every"]) * 1000);
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
console.log(
  `brain host: game ${gameID} on ${serverUrl}, LLM ${a.mock ? "mock" : `${config.baseUrl} ${config.model || "(server default)"}`}`,
);
try {
  await runtime.run(Number(a.poll), stop.signal);
} finally {
  clearInterval(saver);
  save();
}
