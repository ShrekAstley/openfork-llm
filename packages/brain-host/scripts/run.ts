// Usage: npm run brain:run -- --game <id> [--server http://localhost:3001]
//        [--config brain.config.json] [--maps resources/maps] [--mock]
// env: ADMIN_BOT_API_KEY (default: the dev key), BRAIN_* (see BrainConfig).
import { parseArgs } from "node:util";
import { loadBrainConfig } from "../src/BrainConfig";
import { BrainRuntime } from "../src/BrainRuntime";
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
  },
});
if (!a.game) throw new Error("--game <id> is required");

const config = loadBrainConfig(a.config);
const runtime = new BrainRuntime({
  config,
  provider: a.mock ? new MockProvider() : new LMStudioProvider(config),
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
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
console.log(
  `brain host: game ${a.game} on ${a.server}, LLM ${a.mock ? "mock" : `${config.baseUrl} ${config.model || "(server default)"}`}`,
);
await runtime.run(Number(a.poll), stop.signal);
