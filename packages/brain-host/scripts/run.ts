// Usage: npm run brain:run -- --game <id> [--server http://localhost:3001]
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
    server: { type: "string", default: "http://localhost:3001" },
    config: { type: "string", default: "brain.config.json" },
    maps: { type: "string", default: "resources/maps" },
    poll: { type: "string", default: "500" },
    mock: { type: "boolean", default: false },
    state: { type: "string", default: "brain.state.json" },
    resume: { type: "boolean", default: false },
    "save-every": { type: "string", default: "15" },
  },
});
if (!a.game) throw new Error("--game <id> is required");

const config = loadBrainConfig(a.config);
config.decisionLog ||= "brain.decisions.jsonl";
const runtime = new BrainRuntime({
  config,
  provider: a.mock
    ? new MockProvider()
    : new LMStudioProvider({ ...config, backend: config.backend }),
  server: {
    serverUrl: a.server!,
    adminKey:
      process.env.ADMIN_BOT_API_KEY ??
      "WARNING_DEV_ADMIN_BOT_KEY_DO_NOT_USE_IN_PRODUCTION",
    gameID: a.game,
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
  `brain host: game ${a.game} on ${a.server}, LLM ${a.mock ? "mock" : `${config.baseUrl} ${config.model || "(server default)"}`}`,
);
try {
  await runtime.run(Number(a.poll), stop.signal);
} finally {
  clearInterval(saver);
  save();
}
