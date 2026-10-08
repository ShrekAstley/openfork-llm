// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BACKENDS,
  BrainConfigSchema,
  loadBrainConfig,
} from "../packages/brain-host/src/BrainConfig";
import {
  DecisionLog,
  describeDecision,
  readDecisionLog,
  type DecisionRecord,
} from "../packages/brain-host/src/DecisionLog";
import {
  DecisionScheduler,
  Importance,
} from "../packages/brain-host/src/DecisionScheduler";
import {
  MAX_MEMORIES,
  recall,
  remember,
  type Memory,
} from "../packages/brain-host/src/EmpireMemory";
import { LLMCache, requestKey } from "../packages/brain-host/src/LLMCache";
import { LLMManager } from "../packages/brain-host/src/LLMManager";
import { LMStudioProvider } from "../packages/brain-host/src/LMStudioProvider";
import { remoteEndpointReason } from "../packages/brain-host/src/LocalEndpoint";
import { MockProvider } from "../packages/brain-host/src/MockProvider";
import {
  estimateMemory,
  peakGB,
  planModels,
} from "../packages/brain-host/src/ModelPlan";
import { traitLine } from "../packages/brain-host/src/ObservationBuilder";
import { resolveAction, toolDefs } from "../packages/brain-host/src/Tools";
import type { ChatRequest } from "../packages/brain-host/src/types";

const req = (content: string, model?: string): ChatRequest => ({
  messages: [{ role: "user", content }],
  temperature: 0.3,
  maxTokens: 32,
  model,
});
const meta = (priority = 0) => ({
  empireId: "a",
  worldTick: 0,
  simTime: 0,
  empireRevision: 0,
  priority,
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "brainlocal-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("local-only inference", () => {
  test.each([
    "http://localhost:1234/v1",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:11434/v1",
    "http://192.168.1.20:1234/v1",
    "http://10.0.0.5:1234/v1",
    "http://172.20.0.9:1234/v1",
    "http://gpu-box:1234/v1",
    "http://gpu-box.local:1234/v1",
  ])("accepts %s", (url) => {
    expect(remoteEndpointReason(url)).toBeNull();
  });

  test.each([
    "https://api.openai.com/v1",
    "https://api.anthropic.com/v1",
    "http://8.8.8.8/v1",
    "http://172.32.0.1/v1",
    "http://example.com/v1",
    "http://localhost.evil.com/v1",
  ])("refuses %s", (url) => {
    expect(remoteEndpointReason(url)).toMatch(/not a local/);
  });

  test("config and provider both refuse a public endpoint", () => {
    expect(() =>
      BrainConfigSchema.parse({ baseUrl: "https://api.openai.com/v1" }),
    ).toThrow(/not a local or private-network/);
    expect(
      () =>
        new LMStudioProvider({
          baseUrl: "https://api.openai.com/v1",
          model: "",
          timeoutMs: 100,
          toolCalling: true,
        }),
    ).toThrow(/refusing/);
    expect(() =>
      loadBrainConfig(undefined, { BRAIN_BASE_URL: "http://1.1.1.1/v1" }),
    ).toThrow();
  });

  test("backends pick their local default URL; any local one can be set", () => {
    expect(BrainConfigSchema.parse({}).baseUrl).toBe(BACKENDS.lmstudio);
    expect(BrainConfigSchema.parse({ backend: "ollama" }).baseUrl).toBe(
      "http://localhost:11434/v1",
    );
    expect(BrainConfigSchema.parse({ backend: "llamacpp" }).baseUrl).toBe(
      "http://localhost:8080/v1",
    );
    expect(
      BrainConfigSchema.parse({
        backend: "ollama",
        baseUrl: "http://192.168.0.4:11434/v1",
      }).baseUrl,
    ).toBe("http://192.168.0.4:11434/v1");
  });

  test("requests never follow redirects and carry the seed and timeout", async () => {
    const seen: { init: RequestInit; body: any }[] = [];
    const p = new LMStudioProvider({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      timeoutMs: 5000,
      toolCalling: false,
      seed: 7,
      fetch: (async (_u: string, init: RequestInit) => {
        seen.push({ init, body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
        );
      }) as unknown as typeof fetch,
    });
    const r = await p.chat(req("x"));
    expect(r.ok).toBe(true);
    expect(seen[0].init.redirect).toBe("error");
    expect(seen[0].body.seed).toBe(7);
  });

  test("Ollama unload sends keep_alive 0 to its own host; others do nothing", async () => {
    const urls: string[] = [];
    const f = (async (u: string, init: RequestInit) => {
      urls.push(`${u} ${init.body}`);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const base = {
      model: "",
      timeoutMs: 100,
      toolCalling: true,
      fetch: f,
    };
    await new LMStudioProvider({
      ...base,
      baseUrl: "http://localhost:11434/v1",
      backend: "ollama",
    }).unload("small");
    await new LMStudioProvider({
      ...base,
      baseUrl: "http://localhost:1234/v1",
      backend: "lmstudio",
    }).unload("small");
    expect(urls).toEqual([
      'http://localhost:11434/api/generate {"model":"small","keep_alive":0}',
    ]);
  });
});

describe("model profiles and memory estimates", () => {
  const cfg = BrainConfigSchema.parse({
    model: "mid-8b",
    models: {
      "small-4b": { paramsB: 4, quant: "Q4_K_M", contextSize: 4096 },
      "mid-8b": {
        paramsB: 8,
        quant: "Q5_K_M",
        contextSize: 8192,
        gpuLayers: 20,
        layers: 32,
      },
      "fp16-8b": { paramsB: 8, quant: "F16", contextSize: 4096 },
    },
    empires: {
      A: { model: "small-4b" },
      B: {},
      C: { model: "small-4b" },
      D: { model: "fp16-8b" },
    },
  });

  test("bigger and heavier quantisations cost more; FP16 is flagged", () => {
    const p = cfg.models;
    const small = estimateMemory(p["small-4b"]);
    const mid = estimateMemory(p["mid-8b"]);
    expect(small.weightsGB).toBeCloseTo(2.26, 1);
    expect(mid.totalGB).toBeGreaterThan(small.totalGB);
    expect(mid.vramGB! + mid.ramGB!).toBeCloseTo(mid.totalGB, 1);
    expect(mid.vramGB).toBeLessThan(mid.totalGB);
    expect(small.warning).toBeUndefined();
    expect(estimateMemory(p["fp16-8b"]).warning).toMatch(/full precision/);
  });

  test("different empires get different models; peak depends on residency", () => {
    const rows = planModels(cfg, ["A", "B", "C", "D"]);
    expect(rows.map((r) => [r.model, r.empires])).toEqual([
      ["small-4b", ["A", "C"]],
      ["mid-8b", ["B"]],
      ["fp16-8b", ["D"]],
    ]);
    expect(rows[0].launch!.llamacpp).toContain("-c 4096");
    const keep = peakGB(rows, "keep");
    const swap = peakGB(rows, "swap");
    expect(swap).toBe(Math.max(...rows.map((r) => r.estimate!.totalGB)));
    expect(keep).toBeGreaterThan(swap);
  });

  test("a model with no profile is listed, not guessed", () => {
    const rows = planModels(BrainConfigSchema.parse({ model: "x" }), ["A"]);
    expect(rows[0].estimate).toBeUndefined();
  });
});

describe("LLMManager: cache, affinity, residency", () => {
  test("record then replay: identical requests are answered without the model", async () => {
    const file = path.join(dir, "cache.jsonl");
    const p = new MockProvider(() =>
      MockProvider.tools([
        { name: "plan", arguments: { objective: "o", summary: "s" } },
      ]),
    );
    const rec = new LLMManager(p, {
      maxConcurrent: 1,
      cache: new LLMCache("record", file),
    });
    const a = await rec.submit(meta(), req("same")).promise;
    const b = await rec.submit(meta(), req("same")).promise;
    expect([a.cached, b.cached]).toEqual([false, true]);
    expect(p.calls).toHaveLength(1);
    expect(b.result).toEqual(a.result);
    expect(a.key).toBe(requestKey(req("same")));

    // A fresh process with the file in replay mode never calls the model.
    const offline = new MockProvider(() => {
      throw new Error("must not be called");
    });
    const rep = new LLMManager(offline, {
      maxConcurrent: 1,
      cache: new LLMCache("replay", file),
    });
    expect((await rep.submit(meta(), req("same")).promise).result).toEqual(
      a.result,
    );
    const miss = await rep.submit(meta(), req("different")).promise;
    expect(miss.status).toBe("failed");
    expect(miss.error?.message).toMatch(/no recorded answer/);
    expect(offline.calls).toHaveLength(0);
  });

  test("the key changes with model, temperature and seed", () => {
    const k = requestKey(req("x", "a"));
    expect(requestKey(req("x", "b"))).not.toBe(k);
    expect(requestKey({ ...req("x", "a"), temperature: 0.9 })).not.toBe(k);
    expect(requestKey(req("x", "a"), 5)).not.toBe(k);
  });

  test("cache off by default: nothing is stored", async () => {
    const p = new MockProvider(() => MockProvider.tools([]));
    const m = new LLMManager(p, { maxConcurrent: 1 });
    await m.submit(meta(), req("x")).promise;
    await m.submit(meta(), req("x")).promise;
    expect(p.calls).toHaveLength(2);
  });

  test("equal priority prefers the model already loaded; priority still wins", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = new MockProvider(async (r) => {
      order.push(`${r.model}:${r.messages[0].content}`);
      if (r.messages[0].content === "first") await gate;
      return MockProvider.tools([]);
    });
    const m = new LLMManager(p, { maxConcurrent: 1 });
    const jobs = [
      m.submit(meta(), req("first", "A")).promise,
      m.submit(meta(), req("b1", "B")).promise,
      m.submit(meta(), req("a2", "A")).promise,
      m.submit(meta(), req("b2", "B")).promise,
      m.submit(meta(Importance.CRITICAL), req("urgent", "B")).promise,
    ];
    release();
    await Promise.all(jobs);
    expect(order).toEqual([
      "A:first",
      "B:urgent", // priority beats affinity
      "B:b1", // then stay on B
      "B:b2",
      "A:a2",
    ]);
  });

  test("swap unloads the previous model once the loaded one is idle", async () => {
    const events: string[] = [];
    const p = new MockProvider(async (r) => {
      events.push(`run ${r.model}`);
      await new Promise((r) => setTimeout(r, 5));
      return MockProvider.tools([]);
    });
    const m = new LLMManager(p, {
      maxConcurrent: 2,
      residency: "swap",
      unload: async (model) => void events.push(`unload ${model}`),
    });
    await Promise.all([
      m.submit(meta(), req("1", "A")).promise,
      m.submit(meta(), req("2", "B")).promise,
    ]);
    expect(events).toEqual(["run A", "unload A", "run B"]);
  });

  test("keep never unloads", async () => {
    const events: string[] = [];
    const m = new LLMManager(new MockProvider(() => MockProvider.tools([])), {
      maxConcurrent: 1,
      residency: "keep",
      unload: async (model) => void events.push(model),
    });
    await m.submit(meta(), req("1", "A")).promise;
    await m.submit(meta(), req("2", "B")).promise;
    expect(events).toEqual([]);
  });
});

describe("EmpireMemory", () => {
  const mem = (
    tick: number,
    importance: number,
    text = `e${tick}`,
  ): Memory => ({
    tick,
    importance,
    kind: "event",
    text,
  });

  test("500 events become a bounded, ranked set; the important ones survive", () => {
    let list: Memory[] = [];
    for (let i = 0; i < 500; i++)
      list = remember(list, mem(i, i === 123 ? 5 : i % 3 === 0 ? 3 : 1));
    expect(list.length).toBeLessThanOrEqual(MAX_MEMORIES);
    expect(list.some((m) => m.tick === 123 && m.importance === 5)).toBe(true);
    const summary = list.find((m) => m.kind === "summary")!;
    expect(summary.count).toBeGreaterThan(300);
    // Every event is either kept or counted in the summary.
    const kept = list.filter((m) => m.kind !== "summary").length;
    expect(kept + summary.count!).toBe(500);
  });

  test("a repeated fact is one memory at its highest importance", () => {
    let list = remember([], mem(1, 2, "Canada betrayed us"));
    list = remember(list, mem(9, 5, "Canada betrayed us"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tick: 9, importance: 5 });
  });

  test("recall picks by importance and reads oldest first", () => {
    const list = [mem(1, 1), mem(2, 5), mem(3, 4), mem(4, 2), mem(5, 5)];
    expect(recall(list, 3)).toEqual(["t2 [5] e2", "t3 [4] e3", "t5 [5] e5"]);
  });
});

describe("DecisionScheduler backoff", () => {
  test("a quiet empire waits longer; any event resets it", () => {
    const s = new DecisionScheduler(100, 3);
    expect(s.poll(0, false)).toBe(Importance.LOW); // next = 200
    expect(s.poll(100, false)).toBeNull();
    expect(s.poll(200, false)).toBe(Importance.LOW); // next = 200 + 300
    expect(s.poll(499, false)).toBeNull();
    expect(s.poll(500, false)).toBe(Importance.LOW); // capped at 3x
    expect(s.poll(799, false)).toBeNull();
    s.notify(Importance.MEDIUM);
    expect(s.poll(800, false)).toBe(Importance.MEDIUM);
    expect(s.snapshot().quiet).toBe(0);
    expect(s.poll(899, false)).toBeNull();
    expect(s.poll(900, false)).toBe(Importance.LOW);
  });

  test("backoffMax 1 keeps the fixed interval", () => {
    const s = new DecisionScheduler(100, 1);
    s.poll(0, false);
    expect(s.poll(100, false)).toBe(Importance.LOW);
    expect(s.poll(200, false)).toBe(Importance.LOW);
  });

  test("the streak survives a save", () => {
    const a = new DecisionScheduler(100, 3);
    a.poll(0, false);
    const b = new DecisionScheduler(100, 3);
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.snapshot()).toEqual(a.snapshot());
  });
});

describe("tools: reasons, notes, traits", () => {
  test("every action tool offers an optional reason; plan and answers do not", () => {
    const defs = Object.fromEntries(toolDefs().map((t) => [t.name, t]));
    expect((defs.attack.parameters as any).properties.reason).toBeDefined();
    expect(
      (defs.send_message.parameters as any).properties.reason,
    ).toBeDefined();
    expect((defs.plan.parameters as any).properties.reason).toBeUndefined();
    expect((defs.remember.parameters as any).properties.reason).toBeUndefined();
    expect((defs.remember.parameters as any).properties.note).toBeDefined();
  });

  test("remember validates; reason is stripped before validation", () => {
    const c = {} as any;
    expect(
      resolveAction(
        { name: "remember", arguments: { note: "Canada broke its word" } },
        c,
      ),
    ).toEqual({
      kind: "remember",
      note: "Canada broke its word",
      importance: 3,
    });
    expect(
      resolveAction(
        { name: "remember", arguments: { note: "x".repeat(141) } },
        c,
      ).kind,
    ).toBe("rejected");
  });

  test("traits render as context, in a stable order", () => {
    expect(traitLine({})).toBe("");
    const line = traitLine({ aggression: 0.82, trustfulness: 0.2 });
    expect(line).toContain("aggression 0.82, trustfulness 0.20");
    expect(line).toContain("do not dictate");
    expect(() =>
      BrainConfigSchema.parse({
        empires: { A: { traits: { aggression: 2 } } },
      }),
    ).toThrow();
    expect(() =>
      BrainConfigSchema.parse({ empires: { A: { traits: { honor: 0.5 } } } }),
    ).toThrow();
  });
});

describe("DecisionLog", () => {
  const rec: DecisionRecord = {
    tick: 1830,
    second: 183,
    empire: "Northern Union",
    model: "small-4b",
    key: "abc",
    status: "ok",
    cached: false,
    latencyMs: 812,
    tokensIn: 700,
    tokensOut: 60,
    situation: ["Border tension with Empire C"],
    objective: "secure food",
    rationale: "Trade is cheaper than military intervention.",
    actions: [
      { action: 'propose_treaty {"target":"B"}', reason: "B has surplus food" },
    ],
    rejected: [],
    result: "applied",
  };

  test("round trips through a file and reads like the decision report", () => {
    const f = path.join(dir, "d.jsonl");
    const log = new DecisionLog(f);
    log.write(rec);
    log.write({ ...rec, second: 190 });
    fs.appendFileSync(f, '{"torn":'); // a crash mid-write
    const rows = readDecisionLog(f);
    expect(rows.map((r) => r.second)).toEqual([183, 190]);
    const text = describeDecision(rows[0]);
    expect(text).toContain("TURN 183  Northern Union");
    expect(text).toContain("Situation: Border tension with Empire C");
    expect(text).toContain("B has surplus food");
    expect(text).toContain("Why: Trade is cheaper");
    expect(text).toContain("Result: applied");
  });

  test("an unwritable path never throws", () => {
    expect(() =>
      new DecisionLog(path.join(dir, "no", "such", "dir.jsonl")).write(rec),
    ).not.toThrow();
  });
});

describe("tool list", () => {
  test("treaty answers are offered only while a treaty is pending", () => {
    const names = (o?: { treatyPending?: boolean }) =>
      toolDefs(o).map((t) => t.name);
    expect(names()).toContain("accept_treaty");
    expect(names({ treatyPending: true })).toContain("reject_treaty");
    const none = names({ treatyPending: false });
    expect(none).not.toContain("accept_treaty");
    expect(none).not.toContain("reject_treaty");
    expect(none).toContain("attack");
    expect(none).toContain("send_message");
  });
});
