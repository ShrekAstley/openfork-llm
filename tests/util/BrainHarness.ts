import { GameMapSize } from "@openfront/engine-api/game/GameTypes";
import type { Turn } from "@openfront/engine-api/Schemas";
import { createGameWireContext } from "@openfront/shared/ZbinWire";
import { vi } from "vitest";
import { BrainConfigSchema } from "../../packages/brain-host/src/BrainConfig";
import { BrainRuntime } from "../../packages/brain-host/src/BrainRuntime";
import { MockProvider } from "../../packages/brain-host/src/MockProvider";
import type {
  ChatRequest,
  ChatResult,
  Result,
  ToolCall,
} from "../../packages/brain-host/src/types";
import { registerAdminBotRoutes } from "../../src/server/AdminBotRoutes";
import { GameServer } from "../../src/server/GameServer";
import {
  cid,
  makeClient,
  makeGame,
  mockWsOf,
  startGame,
} from "./GameServerHarness";
import { TestDataMapLoader } from "./ScriptedGame";

// The admin-bot routes (key check skipped, see AdminBotAuth.test) behind a
// fetch, so the Brain Host talks to the real routes and GameServer in-process.
export function fetchInto(game: GameServer): typeof fetch {
  const table: Record<string, (req: any, res: any) => void> = {};
  const add =
    (method: string) =>
    (path: string, ...h: ((req: any, res: any) => void)[]) => {
      table[`${method} ${path}`] = h[h.length - 1];
    };
  const log: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  registerAdminBotRoutes({
    app: { get: add("GET"), post: add("POST") } as any,
    gm: { game: () => game } as any,
    workerId: 0,
    log,
  });
  return (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const m = /^\/api\/adminbot\/game\/([^/]+)\/(\w+)$/.exec(u.pathname)!;
    const route = `${init.method ?? "GET"} /api/adminbot/game/:id/${m[2]}`;
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
    table[route](
      {
        params: { id: m[1] },
        query: Object.fromEntries(u.searchParams),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      },
      res,
    );
    return new Response(JSON.stringify(res.body), { status: res.statusCode });
  }) as unknown as typeof fetch;
}

export const US = "United States";
export const CA = "Canada";
export const ok = MockProvider.tools;
export const plan: ToolCall = {
  name: "plan",
  arguments: { objective: "talk", summary: "diplomacy" },
};
export const say = (target: string, text: string): ToolCall => ({
  name: "send_message",
  arguments: { target, text },
});

/** The empire a request is for, read off its observation. */
export const who = (req: ChatRequest) =>
  /^You are ([^.]+)\./.exec(req.messages[1].content)![1];
export const prompt = (req: ChatRequest) => req.messages[1].content;
export const callsOf = (p: MockProvider, empire: string) =>
  p.calls.filter((c) => who(c) === empire);

export type Respond = (
  req: ChatRequest,
  n: number,
) => Result<ChatResult> | Promise<Result<ChatResult>>;

/**
 * A live private game with both nations brain-controlled and a Brain Host
 * runtime polling it. `restart` swaps in a fresh runtime (as after a Brain
 * Host crash) against the same running game.
 */
export async function liveDuoGame(
  respond: Respond,
  over: Record<string, unknown> = {},
) {
  const GAME = cid("brconv");
  const game = makeGame({
    id: GAME,
    config: {
      gameMapSize: GameMapSize.Compact,
      nations: "default",
      bots: 0,
      brainNations: [US, CA],
    },
  });
  const human = makeClient({ clientID: cid("human"), username: "human" });
  game.joinClient(human);
  const build = (r: Respond, o: Record<string, unknown>) => {
    const provider = new MockProvider(r);
    const logs: string[] = [];
    const rt = new BrainRuntime({
      config: BrainConfigSchema.parse({
        decisionIntervalSeconds: 1,
        maxConcurrentRequests: 2,
        ...o,
      }),
      provider,
      server: {
        serverUrl: "http://in-process",
        adminKey: "k",
        gameID: GAME,
        fetch: fetchInto(game),
      },
      maps: new TestDataMapLoader("world"),
      log: (l) => logs.push(l),
    });
    return { rt, provider, logs };
  };
  startGame(game);
  const players = (
    mockWsOf(human)
      .sent()
      .find((m) => m.type === "start") as any
  ).gameStartInfo.players;

  const g = {
    ...build(respond, over),
    restart(r: Respond, o: Record<string, unknown> = over) {
      Object.assign(g, build(r, o));
      return g;
    },
    // One turn per step; waits for every decision in flight.
    async tick(n: number) {
      for (let i = 0; i < n; i++) {
        vi.advanceTimersByTime(100);
        await g.rt.step();
        await g.rt.settled();
      }
    },
    // Like tick, but never waits on a decision a test is holding back.
    async tickNoWait(n: number) {
      for (let i = 0; i < n; i++) {
        vi.advanceTimersByTime(100);
        await g.rt.step();
      }
    },
    async until(done: () => boolean, max = 600) {
      for (let i = 0; i < max && !done(); i++) await g.tick(1);
      if (!done()) throw new Error("condition not reached");
    },
    // Until the replica is out of the spawn phase (brains don't decide before).
    async pastSpawn() {
      for (
        let i = 0;
        i < 1000 && (!g.rt.runner || g.rt.runner.game.inSpawnPhase());
        i++
      )
        await g.tick(1);
    },
    recorded: () =>
      mockWsOf(human)
        .sent(createGameWireContext(players))
        .flatMap((m) => (m.type === "turn" ? ([m.turn] as Turn[]) : []))
        .flatMap((t) => t.intents),
    idOf: (name: string) =>
      g.rt
        .runner!.game.players()
        .find((p) => p.name() === name)!
        .id(),
    brain: (name: string) => g.rt.brains.find((b) => b.o.name === name)!,
  };
  return g;
}
