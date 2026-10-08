// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  BrainConfigSchema,
  loadBrainConfig,
  modelFor,
} from "../packages/brain-host/src/BrainConfig";
import type { RequestMeta } from "../packages/brain-host/src/LLMManager";
import { LLMManager } from "../packages/brain-host/src/LLMManager";
import {
  extractJson,
  LMStudioProvider,
} from "../packages/brain-host/src/LMStudioProvider";
import { testConnection } from "../packages/brain-host/src/testConnection";
import type { LLMProvider } from "../packages/brain-host/src/types";

const config = BrainConfigSchema.parse({ model: "m1", timeoutMs: 200 });
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status });
const completion = (message: object) => json({ choices: [{ message }] });
const req = {
  messages: [{ role: "user" as const, content: "hi" }],
  temperature: 0,
  maxTokens: 16,
};
const tools = [{ name: "attack", description: "d", parameters: {} }];
const provider = (f: typeof fetch, toolCalling = true) =>
  new LMStudioProvider({ ...config, toolCalling, fetch: f });
const meta = (p: Partial<RequestMeta> = {}): RequestMeta => ({
  empireId: "a",
  worldTick: 0,
  simTime: 0,
  empireRevision: 0,
  priority: 0,
  ...p,
});

describe("BrainConfig", () => {
  test("defaults and no hardcoded model", () => {
    const c = BrainConfigSchema.parse({});
    expect(c.baseUrl).toBe("http://localhost:1234/v1");
    expect(c.maxConcurrentRequests).toBe(1);
    expect(c.model).toBe("");
  });
  test("rejects invalid values", () => {
    expect(() => BrainConfigSchema.parse({ timeoutMs: -1 })).toThrow();
    expect(() => BrainConfigSchema.parse({ baseUrl: "nope" })).toThrow();
  });
  test("env overrides and per-empire model", () => {
    const c = loadBrainConfig(undefined, {
      BRAIN_MODEL: "x",
      BRAIN_MAX_CONCURRENT: "3",
      BRAIN_TOOL_CALLING: "false",
    });
    expect(c.model).toBe("x");
    expect(c.maxConcurrentRequests).toBe(3);
    expect(c.toolCalling).toBe(false);
    const e = BrainConfigSchema.parse({
      model: "x",
      empires: { b: { model: "y" } },
    });
    expect(modelFor(e, "b")).toBe("y");
    expect(modelFor(e, "z")).toBe("x");
  });
});

describe("parsing", () => {
  test("extractJson handles plain, fenced and embedded", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('ok:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('sure {"a":"}"} done')).toEqual({ a: "}" });
    expect(extractJson("nothing")).toBeUndefined();
  });
  test("native tool_calls", async () => {
    const r = await provider(async () =>
      completion({
        content: null,
        tool_calls: [
          {
            id: "1",
            function: { name: "attack", arguments: '{"target":"b"}' },
          },
        ],
      }),
    ).chat({ ...req, tools });
    expect(r).toEqual({
      ok: true,
      value: {
        content: "",
        toolCalls: [{ id: "1", name: "attack", arguments: { target: "b" } }],
      },
    });
  });
  test("JSON-in-content fallback (toolCalling off sends no tools)", async () => {
    let body: any;
    const r = await provider(async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return completion({
        content: '```json\n{"name":"attack","arguments":{"target":"b"}}\n```',
      });
    }, false).chat({ ...req, tools });
    expect(body.tools).toBeUndefined();
    expect(r.ok && r.value.toolCalls).toEqual([
      { name: "attack", arguments: { target: "b" } },
    ]);
  });
  test("sends Bearer key and model override", async () => {
    let init: any;
    await new LMStudioProvider({
      ...config,
      apiKey: "k",
      toolCalling: true,
      fetch: async (_u, i) => ((init = i), completion({ content: "x" })),
    }).chat({ ...req, model: "other" });
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body).model).toBe("other");
  });
});

describe("provider errors", () => {
  test.each([
    ["offline", async () => Promise.reject(new TypeError("fetch failed"))],
    ["bad_status", async () => json({}, 500)],
    ["malformed", async () => completion({ content: "no json here" })],
  ])("%s", async (kind, f) => {
    const r = await provider(f as typeof fetch).chat({ ...req, tools });
    expect(r.ok === false && r.error.kind).toBe(kind);
  });
  test("a bad status carries the server's explanation", async () => {
    const r = await provider((async () =>
      json(
        { error: "No models loaded. Please load a model." },
        400,
      )) as typeof fetch).chat(req);
    expect(r.ok === false && r.error.status).toBe(400);
    expect(r.ok === false && r.error.message).toMatch(
      /^HTTP 400: .*No models loaded/,
    );
  });
  test("timeout", async () => {
    const hang = (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_, rej) =>
        init!.signal!.addEventListener("abort", () => rej(new Error("abort"))),
      );
    const r = await provider(hang as typeof fetch).chat(req);
    expect(r.ok === false && r.error.kind).toBe("timeout");
  });
});

describe("LLMManager", () => {
  const stub = (log: string[], delay = 10): LLMProvider => ({
    listModels: async () => ({ ok: true, value: [] }),
    chat: async (r) => {
      log.push(r.messages[0].content);
      await new Promise((res) => setTimeout(res, delay));
      return { ok: true, value: { content: "done", toolCalls: [] } };
    },
  });
  const msg = (s: string) => ({
    ...req,
    messages: [{ role: "user" as const, content: s }],
  });

  test("priority ordering, FIFO ties, concurrency limit", async () => {
    const log: string[] = [];
    let live = 0;
    let peak = 0;
    const p = stub(log);
    const inner = p.chat;
    p.chat = async (r) => {
      peak = Math.max(peak, ++live);
      const x = await inner(r);
      live--;
      return x;
    };
    const m = new LLMManager(p, { maxConcurrent: 1 });
    const hs = [
      m.submit(meta({ priority: 0 }), msg("first")), // starts immediately
      m.submit(meta({ priority: 1 }), msg("low1")),
      m.submit(meta({ priority: 5 }), msg("high")),
      m.submit(meta({ priority: 1 }), msg("low2")),
    ];
    const rs = await Promise.all(hs.map((h) => h.promise));
    expect(log).toEqual(["first", "high", "low1", "low2"]);
    expect(peak).toBe(1);
    expect(rs[0].status).toBe("ok");
    expect(rs[0].tokensIn).toBe(2);
    expect(rs[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("stale responses are flagged and fall back", async () => {
    let rev = 0;
    const m = new LLMManager(stub([]), {
      maxConcurrent: 2,
      isStale: (x) => x.empireRevision < rev,
    });
    const h = m.submit(meta({ empireRevision: 0 }), msg("x"));
    rev = 1; // world moved on while in flight
    const r = await h.promise;
    expect(r.status).toBe("stale");
    expect(r.result).toEqual({ content: "", toolCalls: [] });
  });

  test("cancel queued and in-flight", async () => {
    const real = provider(
      ((_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_, rej) =>
          init!.signal!.addEventListener("abort", () => rej(new Error("a"))),
        )) as typeof fetch,
    );
    const m = new LLMManager(real, { maxConcurrent: 1 });
    const a = m.submit(meta(), req);
    const b = m.submit(meta(), req);
    b.cancel();
    a.cancel();
    expect((await b.promise).status).toBe("cancelled");
    expect((await a.promise).status).toBe("cancelled");
  });

  test.each([
    ["timeout", async () => new Promise<Response>(() => {}), "timeout"],
    ["offline", async () => Promise.reject(new TypeError("x")), "offline"],
    ["malformed", async () => completion({ content: "{oops" }), "malformed"],
  ])("%s resolves with fallback", async (_n, f, kind) => {
    const fallback = { content: "idle", toolCalls: [] };
    const m = new LLMManager(
      new LMStudioProvider({
        ...config,
        timeoutMs: 30,
        toolCalling: true,
        fetch: ((u: unknown, init?: RequestInit) =>
          kind === "timeout"
            ? new Promise((_, rej) =>
                init!.signal!.addEventListener("abort", () =>
                  rej(new Error("a")),
                ),
              )
            : (f as () => Promise<Response>)()) as typeof fetch,
      }),
      { maxConcurrent: 1, fallback },
    );
    const r = await m.submit(meta(), { ...req, tools }).promise;
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe(kind);
    expect(r.result).toEqual(fallback);
  });
});

describe("testConnection", () => {
  const route = (models: string[]) =>
    (async (url: string) =>
      url.endsWith("/models")
        ? json({ data: models.map((id) => ({ id })) })
        : completion({ content: "ok" })) as unknown as typeof fetch;

  test("ok and modelFound", async () => {
    const r = await testConnection(config, route(["m1"]));
    expect(r).toMatchObject({ ok: true, modelFound: true });
    expect((await testConnection(config, route(["z"]))).modelFound).toBe(false);
  });
  test("offline", async () => {
    const r = await testConnection(config, (async () => {
      throw new TypeError("refused");
    }) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("offline");
  });
});

describe("LMStudioProvider: replies without tool calls", () => {
  const ask = (message: object, finish = "stop") =>
    provider((async () =>
      json({
        choices: [{ message, finish_reason: finish }],
      })) as typeof fetch).chat({
      ...req,
      tools,
    });

  test("says what the model did say, and why it may have been cut off", async () => {
    const r = await ask({ content: "I would attack Canada." });
    expect(r).toMatchObject({ ok: false, error: { kind: "malformed" } });
    expect((r as any).error.message).toContain(
      'model said: "I would attack Canada."',
    );
    const cut = await ask({ content: "" }, "length");
    expect((cut as any).error.message).toContain("empty reply");
    expect((cut as any).error.message).toContain("raise it");
  });

  test("reports reasoning that ate the budget", async () => {
    const r = await ask(
      { content: "", reasoning_content: "Let me think..." },
      "length",
    );
    expect((r as any).error.message).toContain("15 chars of reasoning");
  });

  test("takes the tool call from the reasoning field when content is empty", async () => {
    const r = await ask({
      content: "",
      reasoning_content:
        'Plan: {"name":"attack","arguments":{"target":"wilderness","percent":20}}',
    });
    expect(r).toMatchObject({
      ok: true,
      value: { toolCalls: [{ name: "attack" }] },
    });
  });
});

describe("LMStudioProvider: models that cannot call tools", () => {
  const call = {
    name: "attack",
    arguments: { target: "wilderness", percent: 5 },
  };
  const plain = () => completion({ content: 'send_message "attack"' });
  const json_ = () =>
    completion({ content: JSON.stringify({ tool_calls: [call] }) });

  test("a native miss is retried at once as constrained JSON, then stays in JSON mode", async () => {
    const bodies: any[] = [];
    const p = provider((async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      bodies.push(b);
      return b.tools ? plain() : json_();
    }) as unknown as typeof fetch);
    for (let i = 0; i < 3; i++) {
      const r = await p.chat({ ...req, tools });
      expect(r).toMatchObject({
        ok: true,
        value: { toolCalls: [{ name: "attack" }] },
      });
    }
    // Calls 1-2: native then JSON. Call 3: JSON only.
    expect(bodies.map((b) => (b.tools ? "native" : "json"))).toEqual([
      "native",
      "json",
      "native",
      "json",
      "json",
    ]);
    const rf = bodies[1].response_format;
    expect(rf.type).toBe("json_schema");
    const names = rf.json_schema.schema.properties.tool_calls.items.anyOf.map(
      (o: any) => o.properties.name.const,
    );
    expect(names).toEqual(["attack"]);
    expect(JSON.stringify(rf)).not.toContain("$schema");
  });

  test("a server that rejects response_format gets prompt-only JSON", async () => {
    const seen: boolean[] = [];
    const p = provider(
      (async (_u: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body));
        seen.push(!!b.response_format);
        return b.response_format
          ? new Response("response_format not supported", { status: 400 })
          : json_();
      }) as unknown as typeof fetch,
      false,
    );
    expect(await p.chat({ ...req, tools })).toMatchObject({ ok: true });
    expect(await p.chat({ ...req, tools })).toMatchObject({ ok: true });
    expect(seen).toEqual([true, false, false]);
  });

  test("structuredOutput off sends no response_format", async () => {
    let body: any;
    const p = new LMStudioProvider({
      ...config,
      toolCalling: false,
      structuredOutput: false,
      fetch: (async (_u: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return json_();
      }) as unknown as typeof fetch,
    });
    await p.chat({ ...req, tools });
    expect(body.response_format).toBeUndefined();
  });
});
