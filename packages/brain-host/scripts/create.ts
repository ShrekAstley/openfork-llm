// Creates a private game whose first N map nations are brain-controlled,
// prints the join link and the brain:run command, then starts the game once a
// player has joined the lobby.
// Usage: npm run brain:create -- [--map World] [--size Normal] [--brains 2]
//        [--nations "France,Germany"] [--server http://localhost:3001]
import { GameMapSize, GameMapType } from "@openfront/engine-api/game/GameTypes";
import fs from "fs";
import { parseArgs } from "node:util";
import path from "path";

const { values: a } = parseArgs({
  options: {
    map: { type: "string", default: "World" },
    size: { type: "string", default: GameMapSize.Normal },
    brains: { type: "string", default: "2" },
    nations: { type: "string" },
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
// Private games with nations "default" spawn every manifest nation by name.
const brainNations = a.nations
  ? a.nations.split(",").map((s) => s.trim())
  : (manifest.nations as { name: string }[])
      .slice(0, Number(a.brains))
      .map((n) => n.name);

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
  brainNations,
});
console.log(`game ${game.gameID}, brain nations: ${brainNations.join(", ")}`);
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
