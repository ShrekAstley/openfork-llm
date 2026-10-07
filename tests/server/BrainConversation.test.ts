import { GameMapSize } from "@openfront/engine-api/game/GameTypes";
import { brainClientID, Turn } from "@openfront/engine-api/Schemas";
import { createGameWireContext } from "@openfront/shared/ZbinWire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainConfigSchema } from "../../packages/brain-host/src/BrainConfig";
import { BrainRuntime } from "../../packages/brain-host/src/BrainRuntime";
import { MockProvider } from "../../packages/brain-host/src/MockProvider";
import type {
  ChatRequest,
  ChatResult,
  Result,
  ToolCall,
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

// Two brain nations talk to each other through the DiplomacyManager, each
// answering on its own decision cycles, driven by a scripted MockProvider.
// No real model is involved.

const US = "United States";
const CA = "Canada";
const ok = MockProvider.tools;
const plan: ToolCall = {
  name: "plan",
  arguments: { objective: "talk", summary: "diplomacy" },
};
const say = (target: string, text: string): ToolCall => ({
  name: "send_message",
  arguments: { target, text },
});

/** The empire a request is for, read off its observation. */
const who = (req: ChatRequest) =>
  /^You are ([^.]+)\./.exec(req.messages[1].content)![1];
const prompt = (req: ChatRequest) => req.messages[1].content;
const callsOf = (p: MockProvider, empire: string) =>
  p.calls.filter((c) => who(c) === empire);

type Respond = (
  req: ChatRequest,
  n: number,
) => Result<ChatResult> | Promise<Result<ChatResult>>;

async function liveGame(respond: Respond, over: Record<string, unknown> = {}) {
  const provider = new MockProvider(respond);
  const game = makeGame({
    id: cid("brconv"),
    config: {
      gameMapSize: GameMapSize.Compact,
      nations: "default",
      bots: 0,
      brainNations: [US, CA],
    },
  });
  const human = makeClient({ clientID: cid("human"), username: "human" });
  game.joinClient(human);
  const logs: string[] = [];
  const rt = new BrainRuntime({
    config: BrainConfigSchema.parse({
      decisionIntervalSeconds: 1,
      maxConcurrentRequests: 2,
      ...over,
    }),
    provider,
    server: {
      serverUrl: "http://in-process",
      adminKey: "k",
      gameID: cid("brconv"),
      fetch: fetchInto(game),
    },
    maps: new TestDataMapLoader("world"),
    log: (l) => logs.push(l),
  });
  startGame(game);
  const players = (
    mockWsOf(human)
      .sent()
      .find((m) => m.type === "start") as any
  ).gameStartInfo.players;
  // One turn per step; waits for every decision in flight.
  const tick = async (n: number) => {
    for (let i = 0; i < n; i++) {
      vi.advanceTimersByTime(100);
      await rt.step();
      await rt.settled();
    }
  };
  // Like tick, but never waits on a decision a test is holding back.
  const tickNoWait = async (n: number) => {
    for (let i = 0; i < n; i++) {
      vi.advanceTimersByTime(100);
      await rt.step();
    }
  };
  const until = async (done: () => boolean, max = 600) => {
    for (let i = 0; i < max && !done(); i++) await tick(1);
    expect(done()).toBe(true);
  };
  // Until the replica is out of the spawn phase (brains don't decide before).
  const pastSpawn = async () => {
    for (
      let i = 0;
      i < 1000 && (!rt.runner || rt.runner.game.inSpawnPhase());
      i++
    )
      await tick(1);
  };
  const recorded = () =>
    mockWsOf(human)
      .sent(createGameWireContext(players))
      .flatMap((m) => (m.type === "turn" ? ([m.turn] as Turn[]) : []))
      .flatMap((t) => t.intents);
  const idOf = (name: string) =>
    rt
      .runner!.game.players()
      .find((p) => p.name() === name)!
      .id();
  const brain = (name: string) => rt.brains.find((b) => b.o.name === name)!;
  return {
    rt,
    provider,
    logs,
    tick,
    tickNoWait,
    until,
    pastSpawn,
    recorded,
    idOf,
    brain,
  };
}

describe("Brain Host conversation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(ServerEnv, "workerIndex").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("round-trips a message: sent, read on a later cycle, answered", async () => {
    let usSpoke = false;
    let caReplied = false;
    const g = await liveGame((req) => {
      const text = prompt(req);
      if (who(req) === US && !usSpoke) {
        usSpoke = true;
        return ok([
          plan,
          say(CA, "Greetings from the US. Shall we talk trade?"),
        ]);
      }
      if (
        who(req) === CA &&
        !caReplied &&
        text.includes("Greetings from the US")
      ) {
        caReplied = true;
        return ok([plan, say(US, "Canada hears you. Let us talk.")]);
      }
      return ok([plan]);
    });
    await g.until(() =>
      g.provider.calls.some(
        (c) => who(c) === US && prompt(c).includes("Canada hears you"),
      ),
    );

    // Canada first saw it on a later cycle than its first request, in the
    // section for things to answer, with the sender's name.
    const ca = callsOf(g.provider, CA);
    const seen = ca.findIndex((c) =>
      prompt(c).includes('Message from United States: "Greetings from the US'),
    );
    expect(seen).toBeGreaterThan(0);
    expect(prompt(ca[seen])).toContain("FOR YOU TO ANSWER");
    // Both sides are in the DiplomacyManager, addressed to each other.
    expect(
      g.rt.dm.state.messages.map((m) => [m.from, m.to, m.channel]),
    ).toEqual([
      [US, CA, "private"],
      [CA, US, "private"],
    ]);
    // Answered messages leave the inbox: no repeat in later requests.
    const later = ca.slice(seen + 1);
    expect(later.length).toBeGreaterThan(0);
    for (const c of later)
      expect(prompt(c)).not.toContain("Message from United States");
    expect(g.brain(CA).inbox).toEqual([]);

    // And both reached the game as display-only engine intents.
    expect(g.recorded().filter((i) => i.type === "diplomatic_message")).toEqual(
      [
        {
          type: "diplomatic_message",
          recipient: g.idOf(CA),
          text: "Greetings from the US. Shall we talk trade?",
          clientID: brainClientID(0),
        },
        {
          type: "diplomatic_message",
          recipient: g.idOf(US),
          text: "Canada hears you. Let us talk.",
          clientID: brainClientID(1),
        },
      ],
    );
  });

  it("turns a proposal into a treaty once the other side accepts", async () => {
    let proposed = false;
    const g = await liveGame((req) => {
      if (who(req) === US && !proposed) {
        proposed = true;
        return ok([
          plan,
          {
            name: "propose_treaty",
            arguments: {
              target: CA,
              treatyType: "non_aggression",
              durationSeconds: 300,
            },
          },
        ]);
      }
      const m =
        /Treaty (t\d+): United States proposes non_aggression for 300s/.exec(
          prompt(req),
        );
      if (who(req) === CA && m)
        return ok([
          plan,
          { name: "accept_treaty", arguments: { treatyId: m[1] } },
        ]);
      return ok([plan]);
    });
    await g.until(() =>
      Object.values(g.rt.dm.state.treaties).some((t) => t.status === "active"),
    );

    const treaty = Object.values(g.rt.dm.state.treaties)[0];
    expect(treaty).toMatchObject({
      type: "non_aggression",
      proposer: US,
      parties: [US, CA],
      status: "active",
      terms: { duration_turns: 300 },
    });
    // The proposal stayed open across decision cycles: its lifetime is
    // derived from the decision interval and the maximum answer age.
    expect(g.rt.dm.proposalTtl).toBe(3 * 1 + 30);
    // The proposer sees the signed treaty in its next request.
    await g.tick(15);
    const usCalls = callsOf(g.provider, US);
    const last = usCalls[usCalls.length - 1];
    expect(prompt(last)).toContain(`Treaty ${treaty.id} non_aggression active`);
    // A treaty has no engine twin: nothing reached the game.
    expect(g.recorded().filter((i) => i.clientID.startsWith("BRAIN"))).toEqual(
      [],
    );
  });

  it("lets the recipient reject a proposal", async () => {
    let proposed = false;
    const g = await liveGame((req) => {
      if (who(req) === US && !proposed) {
        proposed = true;
        return ok([
          plan,
          {
            name: "propose_treaty",
            arguments: { target: CA, treatyType: "trade" },
          },
        ]);
      }
      const m = /Treaty (t\d+): United States proposes trade/.exec(prompt(req));
      if (who(req) === CA && m)
        return ok([
          plan,
          { name: "reject_treaty", arguments: { treatyId: m[1] } },
        ]);
      return ok([plan]);
    });
    await g.until(() =>
      Object.values(g.rt.dm.state.treaties).some(
        (t) => t.status === "rejected",
      ),
    );
    // Only the addressee can answer: the proposer's own accept is refused.
    expect(
      Object.values(g.rt.dm.state.treaties).every((t) => t.status !== "active"),
    ).toBe(true);
  });

  it("refuses to answer a treaty that was not proposed to you", async () => {
    let proposed = false;
    let tried = false;
    const g = await liveGame((req) => {
      if (who(req) === US && !proposed) {
        proposed = true;
        return ok([
          plan,
          {
            name: "propose_treaty",
            arguments: { target: CA, treatyType: "trade" },
          },
        ]);
      }
      if (who(req) === US && proposed && !tried && g0.rt.dm.state.treaties.t1) {
        tried = true;
        return ok([
          plan,
          { name: "accept_treaty", arguments: { treatyId: "t1" } },
        ]);
      }
      return ok([plan]);
    });
    const g0 = g;
    await g.until(() => tried);
    await g.tick(15);
    expect(g.rt.dm.state.treaties.t1.status).toBe("proposed");
    expect(
      callsOf(g.provider, US).some((c) =>
        prompt(c).includes("treaty_not_proposed_to_you"),
      ),
    ).toBe(true);
  });

  it("discards a reply that arrives too late, and answers on a later cycle", async () => {
    let release!: (r: Result<ChatResult>) => void;
    let hold = true;
    const g = await liveGame(
      (req) => {
        if (who(req) === CA && hold && prompt(req).includes("Message from")) {
          hold = false;
          return new Promise((r) => (release = r));
        }
        if (
          who(req) === CA &&
          prompt(req).includes("Message from United States")
        )
          return ok([plan, say(US, "Better late than never.")]);
        return ok([plan]);
      },
      { maxDecisionAgeSeconds: 2 },
    );
    await g.pastSpawn();
    g.rt.dm.recordTurn(g.rt.dm.state.turn, US, [
      {
        type: "SEND_DIPLOMATIC_MESSAGE",
        target: CA,
        text: "Are you there?",
        channel: "private",
      },
    ]);
    for (let i = 0; i < 400 && !release; i++) await g.tickNoWait(1);
    expect(release).toBeDefined();
    await g.tickNoWait(30); // 3 simulated seconds: older than maxDecisionAge
    release(ok([plan, say(US, "A reply nobody should see.")]));
    await vi.waitFor(() =>
      expect(g.logs.some((l) => l.startsWith(`${CA}: stale`))).toBe(true),
    );
    expect(g.rt.dm.state.messages.some((m) => m.from === CA)).toBe(false);
    // The message is still waiting; the next cycle answers it.
    expect(g.brain(CA).inbox.map((m) => m.text)).toEqual(["Are you there?"]);
    await g.until(() => g.rt.dm.state.messages.some((m) => m.from === CA));
    expect(g.rt.dm.state.messages.find((m) => m.from === CA)!.text).toBe(
      "Better late than never.",
    );
    expect(g.brain(CA).inbox).toEqual([]);
  });

  it("keeps the game going while the LLM is offline, then catches up", async () => {
    let online = false;
    const g = await liveGame((req) =>
      online
        ? who(req) === CA && prompt(req).includes("Message from United States")
          ? ok([plan, say(US, "Sorry, we were down.")])
          : ok([plan])
        : ({
            ok: false,
            error: { kind: "offline", message: "ECONNREFUSED" },
          } as const),
    );
    await g.pastSpawn();
    g.rt.dm.recordTurn(g.rt.dm.state.turn, US, [
      {
        type: "SEND_DIPLOMATIC_MESSAGE",
        target: CA,
        text: "Anyone home?",
        channel: "private",
      },
    ]);
    const t = g.rt.runner!.game.ticks();
    await g.tick(40);
    expect(g.rt.runner!.game.ticks()).toBe(t + 40); // the replica keeps up
    expect(g.logs.some((l) => l.includes("failed (offline"))).toBe(true);
    expect(g.rt.dm.state.messages.filter((m) => m.from === CA)).toEqual([]);
    expect(g.brain(CA).inbox.map((m) => m.text)).toEqual(["Anyone home?"]);
    expect(g.recorded().some((i) => i.clientID.startsWith("BRAIN"))).toBe(
      false,
    );

    online = true; // LM Studio comes back
    await g.until(() => g.rt.dm.state.messages.some((m) => m.from === CA));
    expect(g.rt.dm.state.messages.find((m) => m.from === CA)!.text).toBe(
      "Sorry, we were down.",
    );
  });

  it("gives each empire its personality as prompt text only", async () => {
    const g = await liveGame(() => ok([plan]), {
      empires: {
        [US]: { personality: "Blunt isolationist." },
        [CA]: { personality: "Warm, talkative trader." },
      },
    });
    await g.pastSpawn();
    await g.tick(5);
    const us = callsOf(g.provider, US)[0];
    const ca = callsOf(g.provider, CA)[0];
    expect(prompt(us)).toContain("Blunt isolationist.");
    expect(prompt(us)).not.toContain("talkative trader");
    expect(prompt(ca)).toContain("Warm, talkative trader.");
    expect(prompt(ca)).not.toContain("isolationist");
    // The system prompt is the same for everyone but the name: no behavior
    // is selected by personality.
    expect(us.messages[0].content.replace(US, "X")).toBe(
      ca.messages[0].content.replace(CA, "X"),
    );
  });
});
