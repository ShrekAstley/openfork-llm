// Creates a private game with --nations ordinary AI nations plus --brains
// LLM-controlled ones, prints the join link and the brain:run command, then
// starts the game once a player has joined the lobby.
// Usage: npm run brain:create -- [--map World] [--size Normal]
//        [--nations 10] [--brains 2] [--names "France,Germany"]
//        [--server http://localhost:3001]
// --names picks which map nations the LLM controls (optional; default: the
// first --brains nations in the map's list). --nations is the number of
// ordinary AI nations on top of those (default: the rest of the map's nations).
// --list-nations prints the names a map offers.
import { GameMapSize, GameMapType } from "@openfront/engine-api/game/GameTypes";
import fs from "fs";
import { parseArgs } from "node:util";
import path from "path";

// An empty variable counts as unset.
const env = (name: string) =>
  process.env[name] === "" ? undefined : process.env[name];

const { values: a } = parseArgs({
  options: {
    map: { type: "string", default: "World" },
    size: { type: "string", default: GameMapSize.Normal },
    // The .bat passes these as environment variables (names contain spaces).
    brains: { type: "string", default: env("BRAIN_COUNT") ?? "2" },
    nations: {
      type: "string",
      default: env("BRAIN_NATIONS"),
    },
    names: { type: "string", default: env("BRAIN_NAMES") },
    "list-nations": { type: "boolean", default: false },
    bots: { type: "string", default: "0" },
    server: { type: "string", default: "http://localhost:3001" },
    client: { type: "string", default: "http://localhost:9000" },
    maps: { type: "string", default: "resources/maps" },
  },
});
const key = (Object.keys(GameMapType) as (keyof typeof GameMapType)[]).find(
  (k) => k.toLowerCase() === a.map!.toLowerCase() || GameMapType[k] === a.map,
);
if (!key) throw new Error(`unknown map ${a.map}`);
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(a.maps!, key.toLowerCase(), "manifest.json"),
    "utf8",
  ),
);
const mapNations = (manifest.nations as { name: string }[]).map((n) => n.name);
if (a["list-nations"]) {
  console.log(mapNations.join("\n"));
  process.exit(0);
}
const intArg = (name: string, v: string, max: number) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max)
    throw new Error(`--${name} must be a whole number from 0 to ${max}`);
  return n;
};
let brainNations: string[];
if (a.names) {
  brainNations = a.names
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((want) => {
      const found = mapNations.find(
        (n) => n.toLowerCase() === want.toLowerCase(),
      );
      if (!found)
        throw new Error(
          `${a.map} has no nation "${want}". Try: ${mapNations.slice(0, 15).join(", ")}... (npm run brain:create -- --map ${a.map} --list-nations)`,
        );
      return found;
    });
  if (new Set(brainNations).size !== brainNations.length)
    throw new Error("--names lists a nation twice");
} else {
  brainNations = mapNations.slice(0, intArg("brains", a.brains!, 32));
}
if (brainNations.length === 0) throw new Error("need at least one LLM nation");
if (brainNations.length > 32) throw new Error("at most 32 LLM nations");
// Ordinary AI nations on top of the LLM ones. The engine keeps the LLM
// nations in any numeric count; with no count, every map nation spawns.
const ordinary =
  a.nations === undefined
    ? undefined
    : intArg("nations", a.nations, 400 - brainNations.length);

const adminKey =
  process.env.ADMIN_BOT_API_KEY ??
  "WARNING_DEV_ADMIN_BOT_KEY_DO_NOT_USE_IN_PRODUCTION";
const call = async (p: string, body?: unknown) => {
  const res = await fetch(`${a.server}${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-bot-key": adminKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
  return res.json();
};

const game = await call("/api/adminbot/create_game", {
  gameMap: GameMapType[key],
  gameMapSize: a.size,
  bots: Number(a.bots),
  nations: ordinary === undefined ? "default" : ordinary + brainNations.length,
  brainNations,
});
console.log(
  `game ${game.gameID}, LLM nations: ${brainNations.join(", ")}, ordinary AI nations: ${ordinary ?? "all the rest"}`,
);
console.log(`join:  ${a.client}/${game.workerPath}/game/${game.gameID}`);
console.log(
  `brain: npm run brain:run -- --game ${game.gameID} --server ${a.server}`,
);
console.log("waiting for a player to join, then starting...");
for (;;) {
  const { players } = await call(`/api/adminbot/game/${game.gameID}/roster`);
  if (players.length > 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await call(`/api/adminbot/game/${game.gameID}/intent`, {
  type: "toggle_game_start_timer",
});
console.log("start timer armed.");
