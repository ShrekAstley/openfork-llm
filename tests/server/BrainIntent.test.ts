import {
  AllPlayers,
  GameMapSize,
  GameMapType,
  GameType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  brainClientID,
  GameStartInfo,
  Intent,
  MAX_DIPLOMATIC_MESSAGE_LENGTH,
} from "@openfront/engine-api/Schemas";
import { createGameRunner, GameRunner } from "@openfront/engine/GameRunner";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import { ServerStartGameMessage } from "@openfront/shared/WireSchemas";
import { createGameWireContext } from "@openfront/shared/ZbinWire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  submitEngineIntent,
  toEngineIntent,
} from "../../packages/brain-host/src/EngineBridge";
import { registerAdminBotRoutes } from "../../src/server/AdminBotRoutes";
import { GameServer } from "../../src/server/GameServer";
import { ServerEnv } from "../../src/server/ServerEnv";
import {
  cid,
  makeClient,
  makeGame,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";
import { TestDataMapLoader } from "../util/ScriptedGame";

const GAME_ID = cid("brain");
const HUMAN = cid("human");
const CONFIG = {
  gameMapSize: GameMapSize.Compact,
  nations: 2,
  bots: 0,
} as const;
const ROUTE = "/api/adminbot/game/:id/brain_intent";

// The admin-bot route table, with the key check (AdminBotAuth.test) skipped.
function routes(game: GameServer) {
  const table: Record<string, (req: any, res: any) => void> = {};
  const app: any = {
    get: () => {},
    post(path: string, ...h: ((req: any, res: any) => void)[]) {
      table[path] = h[h.length - 1];
    },
  };
  const gm: any = { game: () => game };
  const log: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  registerAdminBotRoutes({ app, gm, workerId: 0, log });
  return table;
}

// A fetch that lands on the route in-process: the Brain Host driver talks to
// the real route and GameServer, just without a socket.
function fetchInto(game: GameServer): typeof fetch {
  const table = routes(game);
  return (async (url: string, init: RequestInit) => {
    const res: any = {
      statusCode: 200,
      body: undefined,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: unknown) {
        res.body = payload;
        return res;
      },
    };
    const id = /\/game\/([^/]+)\/brain_intent$/.exec(url)![1];
    table[ROUTE]({ params: { id }, body: JSON.parse(String(init.body)) }, res);
    return new Response(JSON.stringify(res.body), { status: res.statusCode });
  }) as unknown as typeof fetch;
}

const mapFiles = () =>
  loadMapFiles(
    new TestDataMapLoader("world"),
    GameMapType.World,
    GameMapSize.Compact,
  );

// Nation names are a pure function of the game id and the human count, so a
// probe runner names the nation the server game hands to the brain.
async function probeNationName(): Promise<string> {
  const start: GameStartInfo = {
    gameID: GAME_ID,
    lobbyCreatedAt: 0,
    config: makeGame({ config: CONFIG }).gameConfig,
    players: [{ clientID: HUMAN, username: "human", clanTag: null }],
  };
  const runner = await createGameRunner(
    start,
    undefined,
    await mapFiles(),
    () => {},
  );
  return runner.game.nations()[0].playerInfo.name;
}

describe("Brain Host intents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(ServerEnv, "workerIndex").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  const attack: Intent = { type: "attack", targetID: null, troops: null };

  function brainGame(brainNations: string[], gameType = GameType.Private) {
    const game = makeGame({
      id: GAME_ID,
      config: { ...CONFIG, gameType, brainNations },
    });
    const human = makeClient({ clientID: HUMAN, username: "human" });
    game.joinClient(human);
    return { game, human };
  }

  it("validates who may act, and what", () => {
    const { game } = brainGame(["Atlantis"]);
    expect(game.handleBrainIntent("Atlantis", attack).status).toBe(409);
    startGame(game);
    expect(game.handleBrainIntent("Atlantis", attack).status).toBe(200);
    expect(game.handleBrainIntent("Lemuria", attack).status).toBe(403);
    for (const intent of [
      { type: "toggle_pause", paused: true },
      { type: "kick_player", targetClientID: HUMAN },
      { type: "update_game_config", config: { bots: 1 } },
      { type: "mark_disconnected", isDisconnected: true },
    ] as Intent[]) {
      expect(game.handleBrainIntent("Atlantis", intent).status).not.toBe(200);
    }

    const pub = brainGame(["Atlantis"], GameType.Public).game;
    startGame(pub);
    expect(pub.handleBrainIntent("Atlantis", attack).status).toBe(403);
  });

  it("takes a diplomatic message from a brain, bounded in length", () => {
    const { game } = brainGame(["Atlantis"]);
    startGame(game);
    const say = (text: string): Intent => ({
      type: "diplomatic_message",
      recipient: "AllPlayers",
      text,
    });
    expect(game.handleBrainIntent("Atlantis", say("hello")).status).toBe(200);
    expect(game.handleBrainIntent("Lemuria", say("hello")).status).toBe(403);
    // A player's own socket is turned away (authorizeIntent table covers more).
    expect(
      game.handleIntent(say("hello"), {
        clientID: HUMAN,
        isLobbyCreator: true,
        isAdmin: false,
        isAdminBot: false,
      }).status,
    ).toBe(403);
  });

  it("rejects an over-long diplomatic message at the route", async () => {
    const { game } = brainGame(["Atlantis"]);
    startGame(game);
    const target = {
      serverUrl: "http://x",
      adminKey: "k",
      gameID: GAME_ID,
      nation: "Atlantis",
      fetch: fetchInto(game),
    };
    const say = (text: string) =>
      ({ type: "diplomatic_message", recipient: AllPlayers, text }) as Intent;
    await expect(
      submitEngineIntent(
        target,
        say("x".repeat(MAX_DIPLOMATIC_MESSAGE_LENGTH + 1)),
      ),
    ).rejects.toThrow(/400/);
    await expect(submitEngineIntent(target, say(""))).rejects.toThrow(/400/);
    await submitEngineIntent(
      target,
      say("x".repeat(MAX_DIPLOMATIC_MESSAGE_LENGTH)),
    );
  });

  it("rejects a malformed intent at the route", async () => {
    const { game } = brainGame(["Atlantis"]);
    startGame(game);
    const target = {
      serverUrl: "http://x",
      adminKey: "k",
      gameID: GAME_ID,
      nation: "Atlantis",
      fetch: fetchInto(game),
    };
    await expect(
      submitEngineIntent(target, { type: "attack", troops: -1 } as any),
    ).rejects.toThrow(/400/);
  });

  it("maps diplomatic intents to existing engine intents", () => {
    const id = (e: string) => `${e}0000000`;
    expect(
      toEngineIntent({ type: "FORM_ALLIANCE", target: "b", terms: {} }, id),
    ).toEqual([{ type: "allianceRequest", recipient: "b0000000" }]);
    expect(
      toEngineIntent(
        { type: "FORM_ALLIANCE", target: "b", terms: {}, allianceId: "x" },
        id,
      ),
    ).toEqual([]);
    expect(toEngineIntent({ type: "DECLARE_WAR", target: "b" }, id)).toEqual([
      { type: "embargo", targetID: "b0000000", action: "start" },
      { type: "targetPlayer", target: "b0000000" },
    ]);
    expect(
      toEngineIntent(
        { type: "SEND_AID", target: "b", resource: "gold", amount: 5 },
        id,
      ),
    ).toEqual([{ type: "donate_gold", recipient: "b0000000", gold: 5 }]);
    // Messages: a display-only engine intent, to one player or to everyone.
    expect(
      toEngineIntent(
        {
          type: "SEND_DIPLOMATIC_MESSAGE",
          target: "b",
          text: " hi ",
          channel: "private",
        },
        id,
      ),
    ).toEqual([
      { type: "diplomatic_message", recipient: "b0000000", text: "hi" },
    ]);
    expect(
      toEngineIntent(
        { type: "SEND_DIPLOMATIC_MESSAGE", text: "all", channel: "public" },
        id,
      ),
    ).toEqual([
      { type: "diplomatic_message", recipient: AllPlayers, text: "all" },
    ]);
    // Over the engine's bound: cut, never split a surrogate pair.
    const cut = toEngineIntent(
      {
        type: "SEND_DIPLOMATIC_MESSAGE",
        text: "x".repeat(MAX_DIPLOMATIC_MESSAGE_LENGTH - 1) + "😀",
        channel: "public",
      },
      id,
    )[0] as { text: string };
    expect(cut.text).toBe("x".repeat(MAX_DIPLOMATIC_MESSAGE_LENGTH - 1));
    expect(
      toEngineIntent(
        { type: "SEND_DIPLOMATIC_MESSAGE", text: "   ", channel: "public" },
        id,
      ),
    ).toEqual([]);
    // Treaties have no engine twin: Brain Host state only.
    expect(
      toEngineIntent(
        {
          type: "PROPOSE_TREATY",
          target: "b",
          treatyType: "non_aggression",
          terms: {},
          secret: true,
        } as any,
        id,
      ),
    ).toEqual([]);
  });

  it("records the driver's intent in a turn that replays identically", async () => {
    const brainName = await probeNationName();
    const { game, human } = brainGame([brainName]);
    startGame(game);
    // Read before any turn frame: those need the roster's dictionary.
    const start = mockWsOf(human)
      .sent()
      .find((m): m is ServerStartGameMessage => m.type === "start")!;

    await submitEngineIntent(
      {
        serverUrl: "http://localhost:3001",
        adminKey: "k",
        gameID: GAME_ID,
        nation: brainName,
        fetch: fetchInto(game),
      },
      attack,
    );
    vi.advanceTimersByTime(1000);

    // What a player receives: the start info carries brainNations, and the
    // intent rides a turn stamped with the nation's brain clientID.
    expect(start.gameStartInfo.config.brainNations).toEqual([brainName]);
    const turns = mockWsOf(human)
      .sent(createGameWireContext(start.gameStartInfo.players))
      .flatMap((m) => (m.type === "turn" ? [m.turn] : []));
    expect(turns.flatMap((t) => t.intents)).toContainEqual({
      ...attack,
      clientID: brainClientID(0),
    });

    // Two headless replays of those turns: the brain nation sits still after
    // the spawn phase until its attack fires, and both agree on the result.
    const replay = async () => {
      const runner = await createGameRunner(
        start.gameStartInfo,
        undefined,
        await mapFiles(),
        () => {},
      );
      let tilesAfterSpawn = 0;
      for (let tick = 0; tick < 280; tick++) {
        runner.addTurn(
          turns.find((t) => t.turnNumber === tick) ?? {
            turnNumber: tick,
            intents: [],
          },
        );
        runner.executeNextTick();
        if (tick === 200) tilesAfterSpawn = brain(runner).numTilesOwned();
      }
      return { runner, tilesAfterSpawn };
    };
    const brain = (r: GameRunner) =>
      r.game
        .allPlayers()
        .find((p) => p.type() === PlayerType.Nation && p.name() === brainName)!;
    const fingerprint = (r: GameRunner) =>
      r.game.allPlayers().map((p) => [p.id(), p.numTilesOwned(), p.troops()]);

    const a = await replay();
    const b = await replay();
    expect(a.tilesAfterSpawn).toBeGreaterThan(0);
    expect(brain(a.runner).numTilesOwned()).toBeGreaterThan(a.tilesAfterSpawn);
    expect(fingerprint(b.runner)).toEqual(fingerprint(a.runner));
  });
});
