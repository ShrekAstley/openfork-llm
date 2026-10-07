import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainStateSchema,
  EmpireBrainStateSchema,
} from "../../packages/brain-host/src/BrainState";
import { readDecisionLog } from "../../packages/brain-host/src/DecisionLog";
import { ServerEnv } from "../../src/server/ServerEnv";
import {
  CA,
  callsOf,
  liveDuoGame,
  ok,
  prompt,
  say,
  US,
  who,
} from "../util/BrainHarness";

// What a running Brain Host adds around the model: the decision log, the
// empire's own memory, personality traits as context, and replay without the
// model. MockProvider stands in for the model throughout.

let dir: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(ServerEnv, "workerIndex").mockReturnValue(0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "brainauto-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const plan = (objective: string, summary: string) => ({
  name: "plan",
  arguments: { objective, summary },
});

describe("decision log", () => {
  it("records situation, model, request hash, reasons and result per decision", async () => {
    const file = path.join(dir, "d.jsonl");
    const g = await liveDuoGame(
      (req) =>
        who(req) === US
          ? ok([
              plan("open talks", "Canada is the nearest power."),
              {
                name: "send_message",
                arguments: {
                  target: CA,
                  text: "Shall we talk?",
                  reason: "A neighbour at peace is cheaper than a war",
                },
              },
              { name: "attack", arguments: { target: "Nowhere", percent: 10 } },
            ])
          : ok([plan("wait", "nothing to do")]),
      {
        decisionLog: file,
        model: "small-4b",
        empires: { [CA]: { model: "mid-8b" } },
      },
    );
    await g.until(() => readDecisionLog(file).some((r) => r.empire === US));

    const us = readDecisionLog(file).find((r) => r.empire === US)!;
    expect(us).toMatchObject({
      model: "small-4b",
      status: "ok",
      cached: false,
      objective: "open talks",
      rationale: "Canada is the nearest power.",
      result: "partly_applied",
    });
    expect(us.key).toMatch(/^[0-9a-f]{24}$/);
    expect(us.actions).toContainEqual({
      action: expect.stringContaining("send_message"),
      reason: "A neighbour at peace is cheaper than a war",
    });
    expect(us.rejected[0]).toContain("unknown player");
    expect(us.second).toBe(Math.floor(us.tick / 10));
    // The raw model text is never logged: only the structured fields above.
    expect(JSON.stringify(us)).not.toContain("tool_calls");

    // Canada ran on its own model, and the reason never reached the engine.
    const ca = readDecisionLog(file).find((r) => r.empire === CA)!;
    expect(ca.model).toBe("mid-8b");
    expect(callsOf(g.provider, CA)[0].model).toBe("mid-8b");
    expect(JSON.stringify(g.recorded())).not.toContain("cheaper than a war");
  });

  it("logs an offline model as dropped and the game goes on", async () => {
    const file = path.join(dir, "d.jsonl");
    const g = await liveDuoGame(
      () => ({
        ok: false,
        error: { kind: "offline", message: "ECONNREFUSED" },
      }),
      { decisionLog: file },
    );
    await g.until(() => readDecisionLog(file).length >= 2);
    for (const r of readDecisionLog(file)) {
      expect(r).toMatchObject({ status: "failed", result: "dropped" });
      expect(r.error).toContain("offline");
    }
  });
});

describe("empire memory and personality", () => {
  it("shows traits and ranked memories; notes persist in the saved state", async () => {
    let n = 0;
    const g = await liveDuoGame(
      (req) => {
        if (who(req) !== US) return ok([plan("wait", "w")]);
        n++;
        return ok([
          plan(`goal ${n}`, `step ${n}`),
          ...(n === 1
            ? [
                {
                  name: "remember",
                  arguments: {
                    note: "Canada promised to stay out",
                    importance: 5,
                  },
                },
              ]
            : []),
        ]);
      },
      {
        empires: {
          [US]: {
            personality: "Proud.",
            traits: { aggression: 0.82, trustfulness: 0.22 },
          },
        },
      },
    );
    await g.until(() => callsOf(g.provider, US).length >= 3);

    const first = prompt(callsOf(g.provider, US)[0]);
    expect(first).toContain("aggression 0.82, trustfulness 0.22");
    expect(first).toContain("they do not dictate");
    expect(first).not.toContain("MEMORIES");

    const later = prompt(callsOf(g.provider, US)[2]);
    expect(later).toContain("MEMORIES");
    expect(later).toContain("[5] Canada promised to stay out");

    // The note is in the saved state and survives a restore.
    const state = BrainStateSchema.parse(
      JSON.parse(JSON.stringify(g.rt.snapshot())),
    );
    expect(state.empires[US].memories).toContainEqual(
      expect.objectContaining({ kind: "note", importance: 5 }),
    );
    const brain = g.brain(US);
    brain.memories = [];
    brain.restore(state.empires[US]);
    expect(brain.memories.map((m) => m.text)).toContain(
      "Canada promised to stay out",
    );
  });

  it("a state file from before memories existed still loads", () => {
    const old = {
      revision: 0,
      events: [],
      rejected: [],
      history: [],
      inbox: [],
      scheduler: { next: 0, pending: null },
      seen: {
        messages: [],
        treaties: [],
        attackers: [],
        attackIds: [],
        outgoingIds: [],
        requestors: [],
        allies: [],
        embargoers: [],
        tilesAtDecision: 0,
        territoryNoted: false,
      },
    };
    const parsed = EmpireBrainStateSchema.parse(old);
    expect(parsed.memories).toEqual([]);
    expect(parsed.scheduler.quiet).toBe(0);
  });
});

describe("replay without the model", () => {
  it("a cached game is reproduced from the cache file alone", async () => {
    const cacheFile = path.join(dir, "cache.jsonl");
    const script = (req: any) =>
      who(req) === US
        ? ok([plan("talk", "hello"), say(CA, "Greetings, Canada.")])
        : ok([plan("wait", "w")]);
    const rec = await liveDuoGame(script, {
      cache: "record",
      cacheFile,
      quietBackoffMax: 1,
    });
    await rec.until(() =>
      rec.recorded().some((i) => i.type === "diplomatic_message"),
    );
    expect(fs.readFileSync(cacheFile, "utf8").trim().length).toBeGreaterThan(0);

    // The same game again, with the model off: every answer comes from the file.
    const down = vi.fn(() => ({
      ok: false as const,
      error: { kind: "offline" as const, message: "model is off" },
    }));
    const rep = await liveDuoGame(down as any, {
      cache: "replay",
      cacheFile,
      quietBackoffMax: 1,
    });
    await rep.until(() =>
      rep.recorded().some((i) => i.type === "diplomatic_message"),
    );
    expect(
      rep.recorded().find((i) => i.type === "diplomatic_message"),
    ).toMatchObject({ text: "Greetings, Canada." });
    expect(rep.provider.calls).toHaveLength(0);
  });
});
