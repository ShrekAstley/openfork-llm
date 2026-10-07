import { GameMapSize } from "@openfront/engine-api/game/GameTypes";
import { brainClientID, Turn } from "@openfront/engine-api/Schemas";
import { createGameWireContext } from "@openfront/shared/ZbinWire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainConfigSchema } from "../../packages/brain-host/src/BrainConfig";
import { BrainRuntime } from "../../packages/brain-host/src/BrainRuntime";
import {
  DecisionScheduler,
  Importance,
} from "../../packages/brain-host/src/DecisionScheduler";
import { MockProvider } from "../../packages/brain-host/src/MockProvider";
import {
  buildObservation,
  estTokens,
} from "../../packages/brain-host/src/ObservationBuilder";
import type {
  ChatResult,
  LLMProvider,
  Result,
} from "../../packages/brain-host/src/types";
import { ServerEnv } from "../../src/server/ServerEnv";
import { fetchInto } from "../util/BrainHarness";
import {
  cid,
  makeClient,
  makeGame,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";
import { TestDataMapLoader } from "../util/ScriptedGame";

const GAME_ID = cid("brainrt");

const ok = MockProvider.tools;
const plan = (summary: string) => ({
  name: "plan",
  arguments: { objective: "test", summary },
});

// A live private game on the server with its first nation brain-controlled,
// and a Brain Host runtime polling it every turn.
async function liveGame(provider: LLMProvider, interval = 1) {
  const brainName = "United States"; // world test map's first manifest nation
  const game = makeGame({
    id: GAME_ID,
    config: {
      gameMapSize: GameMapSize.Compact,
      nations: "default",
      bots: 0,
      brainNations: [brainName],
    },
  });
  const human = makeClient({ clientID: cid("human"), username: "human" });
  game.joinClient(human);
  const logs: string[] = [];
  const rt = new BrainRuntime({
    config: BrainConfigSchema.parse({
      decisionIntervalSeconds: interval,
      quietBackoffMax: 1,
      empires: {
        [brainName]: {
          personality: "Cautious expansionist.",
          directives: ["Never attack humans first."],
        },
      },
    }),
    provider,
    server: {
      serverUrl: "http://in-process",
      adminKey: "k",
      gameID: GAME_ID,
      fetch: fetchInto(game),
    },
    maps: new TestDataMapLoader("world"),
    log: (l) => logs.push(l),
  });
  const tick = async (n: number) => {
    for (let i = 0; i < n; i++) {
      vi.advanceTimersByTime(100);
      await rt.step();
      await rt.settled();
    }
  };
  let players: any;
  // Start the server game; read the start frame before any turn frame (those
  // need the roster's dictionary).
  const begin = () => {
    startGame(game);
    players = (
      mockWsOf(human)
        .sent()
        .find((m) => m.type === "start") as any
    ).gameStartInfo.players;
  };
  const recorded = (): Turn[] =>
    mockWsOf(human)
      .sent(createGameWireContext(players))
      .flatMap((m) => (m.type === "turn" ? [m.turn] : []));
  // Ticks until the spawn phase is over on the replica, then `extra` more.
  const pastSpawn = async (extra: number) => {
    for (
      let i = 0;
      i < 1000 && (!rt.runner || rt.runner.game.inSpawnPhase());
      i++
    )
      await tick(1);
    await tick(extra);
  };
  const brain = () =>
    rt.runner!.game.players().find((p) => p.name() === brainName)!;
  return { rt, logs, tick, begin, pastSpawn, recorded, brain };
}

describe("DecisionScheduler", () => {
  it("wakes periodically, early only for HIGH+, never while busy", () => {
    const s = new DecisionScheduler(100);
    expect(s.poll(0, false)).toBe(Importance.LOW);
    expect(s.poll(50, false)).toBeNull();
    s.notify(Importance.MEDIUM);
    expect(s.poll(60, false)).toBeNull(); // MEDIUM waits for the period
    expect(s.poll(100, false)).toBe(Importance.MEDIUM);
    s.notify(Importance.HIGH);
    expect(s.poll(110, true)).toBeNull(); // busy
    s.notify(Importance.CRITICAL);
    expect(s.poll(120, false)).toBe(Importance.CRITICAL);
    expect(s.poll(130, false)).toBeNull(); // trigger consumed, period restarted
    expect(s.poll(220, false)).toBe(Importance.LOW);
  });
});

describe("Brain Host runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(ServerEnv, "workerIndex").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("serves the turn feed only after start", async () => {
    const { rt, begin } = await liveGame(new MockProvider());
    expect(await rt.step()).toBe(false);
    begin();
    vi.advanceTimersByTime(300);
    expect(await rt.step()).toBe(true);
    expect(rt.runner!.game.ticks()).toBeGreaterThan(0);
  });

  it("a mock decision lands in a recorded turn and executes", async () => {
    const provider = new MockProvider();
    const { rt, tick, begin, pastSpawn, recorded, brain, logs } =
      await liveGame(provider);
    begin();
    await pastSpawn(1);
    const before = brain().numTilesOwned();
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(rt.brains[0].history[0]).toMatchObject({
      objective: "expand",
      summary: "grab land",
    });
    // No raw model text is kept, only the structured decision.
    expect(JSON.stringify(rt.brains[0].history)).not.toContain("content");
    await tick(30);

    const brainAttacks = recorded()
      .flatMap((t) => t.intents)
      .filter((i) => i.clientID === brainClientID(0) && i.type === "attack");
    expect(brainAttacks.length).toBeGreaterThan(0);
    expect(brainAttacks[0]).toMatchObject({ targetID: null });
    expect(brain().numTilesOwned()).toBeGreaterThan(before);
    expect(logs.some((l) => l.includes("grab land"))).toBe(true);
  });

  it("keeps the game going when the LLM is offline", async () => {
    const offline: LLMProvider = {
      chat: async () => ({
        ok: false,
        error: { kind: "offline", message: "ECONNREFUSED" },
      }),
      listModels: async () => ({
        ok: false,
        error: { kind: "offline", message: "ECONNREFUSED" },
      }),
    };
    const { rt, begin, pastSpawn, recorded, logs } = await liveGame(offline);
    begin();
    await pastSpawn(20);
    const t = rt.runner!.game.ticks();
    await pastSpawn(20);
    expect(rt.runner!.game.ticks()).toBe(t + 20); // the replica keeps up
    expect(logs.some((l) => l.includes("failed (offline"))).toBe(true);
    expect(rt.brains[0].history).toEqual([]);
    expect(
      recorded()
        .flatMap((t) => t.intents)
        .some((i) => i.clientID === brainClientID(0)),
    ).toBe(false);
  });

  it("discards a stale answer and keeps prior orders", async () => {
    let release!: (r: Result<ChatResult>) => void;
    const slow: LLMProvider = {
      chat: () => new Promise((r) => (release = r)),
      listModels: async () => ({ ok: true, value: [] }),
    };
    const { rt, tick, begin, recorded, logs } = await liveGame(slow, 1000);
    begin();
    // Run until the first request goes out (without waiting on it).
    for (let i = 0; i < 1000 && !release; i++) {
      vi.advanceTimersByTime(100);
      await rt.step();
    }
    expect(release).toBeDefined();
    rt.brains[0].revision++; // what a CRITICAL event does
    release(
      ok([
        { name: "attack", arguments: { target: "wilderness", percent: 50 } },
      ]),
    );
    await rt.settled();
    await tick(5);
    expect(logs.some((l) => l.includes("stale, keeping prior orders"))).toBe(
      true,
    );
    expect(rt.brains[0].history).toEqual([]);
    expect(
      recorded()
        .flatMap((t) => t.intents)
        .some((i) => i.clientID === brainClientID(0)),
    ).toBe(false);
  });

  it("feeds rejected actions back in the next observation", async () => {
    const provider = new MockProvider((_req, n) =>
      n === 0
        ? ok([
            plan("probe"),
            { name: "attack", arguments: { target: "Atlantis", percent: 10 } },
            {
              name: "attack",
              arguments: { target: "wilderness", percent: 500 },
            },
            { name: "offer_peace", arguments: { target: "Canada" } },
          ])
        : ok([plan("ok")]),
    );
    const { begin, pastSpawn } = await liveGame(provider);
    begin();
    await pastSpawn(25);
    expect(provider.calls.length).toBeGreaterThan(2);
    const second = provider.calls[1].messages[1].content;
    expect(second).toContain('ACTION REJECTED attack {"target":"Atlantis"');
    expect(second).toContain('unknown player "Atlantis"');
    expect(second).toMatch(/percent: .*100/);
    expect(second).toContain("not_at_war"); // DiplomacyManager.validateIntent
    // Shown once, then cleared.
    expect(
      provider.calls[provider.calls.length - 1].messages[1].content,
    ).not.toContain("ACTION REJECTED");
  });

  it("builds a fog-limited observation under the token budget", async () => {
    const { rt, begin, pastSpawn, brain } = await liveGame(new MockProvider());
    begin();
    await pastSpawn(1);
    const g = rt.runner!.game;
    const me = brain();
    const others = g.players().filter((p) => p !== me && p.isAlive());
    for (const p of others) p.setTroops(123456);
    const input = {
      game: g,
      me,
      diplomacy: rt.dm.observe(me.name()),
      personality: "Cautious expansionist.",
      directives: ["Never attack humans first."],
      events: Array.from({ length: 50 }, (_, i) => `event ${i} `.repeat(20)),
      rejected: ["ACTION REJECTED x: y"],
    };
    const full = buildObservation(input);
    expect(estTokens(full)).toBeLessThanOrEqual(1000);
    expect(full).toContain("You are United States");
    expect(full).toContain("ACTION REJECTED x: y");
    expect(full).toContain("Never attack humans first.");
    expect(full).toMatch(/army (much )?(weaker|stronger)|army similar/);
    // True enemy troop counts never appear.
    expect(full).not.toContain("123456");
    expect(full).not.toContain("123.5k");
    for (const line of full.split("\n").filter((l) => l.startsWith("- ")))
      expect(line.replace(/land [\d.]+%/, "")).not.toMatch(/\d/);

    const tiny = buildObservation({ ...input, budgetTokens: 60 });
    expect(estTokens(tiny)).toBeLessThanOrEqual(60);
    expect(tiny).toContain("You are United States"); // most important first
  });
});
