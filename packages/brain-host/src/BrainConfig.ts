import fs from "fs";
import { z } from "zod";

import { remoteEndpointReason } from "./LocalEndpoint";

/** Which local server speaks the OpenAI-compatible API; picks the default URL. */
export const BACKENDS = {
  lmstudio: "http://localhost:1234/v1",
  llamacpp: "http://localhost:8080/v1",
  ollama: "http://localhost:11434/v1",
  openai_compatible: "http://localhost:1234/v1",
} as const;
export type Backend = keyof typeof BACKENDS;

/** A model as the user runs it. Sizes feed memory estimates and launch hints. */
export const ModelProfileSchema = z.object({
  /** Parameters in billions, e.g. 4, 8, 12. */
  paramsB: z.number().positive(),
  /** GGUF quantisation, e.g. Q4_K_M. Never assumed to be FP16. */
  quant: z.string().default("Q4_K_M"),
  contextSize: z.number().int().positive().default(4096),
  /** Layers offloaded to the GPU; omitted = backend default. */
  gpuLayers: z.number().int().min(0).optional(),
  /** Total transformer layers, to split a partial offload between VRAM and RAM. */
  layers: z.number().int().positive().optional(),
  threads: z.number().int().positive().optional(),
  batchSize: z.number().int().positive().optional(),
  /** KV cache bytes per context token, if known (else estimated from size). */
  kvBytesPerToken: z.number().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const TRAITS = [
  "aggression",
  "diplomacy",
  "riskTolerance",
  "expansionism",
  "trustfulness",
  "economicFocus",
  "militaryFocus",
] as const;

const BASE_URL = z
  .string()
  .url()
  .superRefine((v, ctx) => {
    const why = remoteEndpointReason(v);
    if (why) ctx.addIssue({ code: "custom", message: why });
  });

const BaseSchema = z.object({
  backend: z
    .enum(["lmstudio", "llamacpp", "ollama", "openai_compatible"])
    .default("lmstudio"),
  /** Defaults to the backend's usual local address. Must be local or private. */
  baseUrl: BASE_URL.optional(),
  /** Empty = let the server pick its loaded model. Never hardcoded. */
  model: z.string().default(""),
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.3),
  maxOutputTokens: z.number().int().positive().default(512),
  timeoutMs: z.number().int().positive().default(30000),
  maxConcurrentRequests: z.number().int().positive().default(1),
  /** Simulated seconds between periodic decisions (HIGH+ events wake earlier). */
  decisionIntervalSeconds: z.number().positive().default(10),
  /** A decision older than this (simulated seconds) when it returns is dropped. */
  maxDecisionAgeSeconds: z.number().positive().default(30),
  toolCalling: z.boolean().default(true),
  /** Sent to the server as the sampling seed when set, for repeatable runs. */
  seed: z.number().int().optional(),
  /** Model name -> size/quantisation/context. Empires reference these by model name. */
  models: z.record(z.string(), ModelProfileSchema).default({}),
  /** keep: leave models loaded. swap: unload the previous model when another one is needed (Ollama). */
  residency: z.enum(["keep", "swap"]).default("keep"),
  /** off | record (write, reuse) | replay (reuse only, never call the model). */
  cache: z.enum(["off", "record", "replay"]).default("off"),
  cacheFile: z.string().default("brain.cache.jsonl"),
  /** Append every decision (model, prompt hash, rationale, result) here; empty = off (brain:run defaults it to brain.decisions.jsonl). */
  decisionLog: z.string().default(""),
  /** Quiet periodic decisions back off up to this multiple of the interval. 1 = off. */
  quietBackoffMax: z.number().int().min(1).max(10).default(3),
  empires: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(true),
        model: z.string().optional(),
        personality: z.string().max(600).default(""),
        /** Tendencies 0..1, shown to the model as context, never as rules. */
        traits: z
          .partialRecord(z.enum(TRAITS), z.number().min(0).max(1))
          .default({}),
        /** Standing orders shown in every observation. */
        directives: z.array(z.string().max(300)).max(5).default([]),
      }),
    )
    .default({}),
});

export const BrainConfigSchema = BaseSchema.transform((c) => ({
  ...c,
  baseUrl: c.baseUrl ?? BACKENDS[c.backend],
}));

export type BrainConfig = z.infer<typeof BrainConfigSchema>;

const ENV: Record<string, [string, "string" | "number" | "bool"]> = {
  BRAIN_BACKEND: ["backend", "string"],
  BRAIN_BASE_URL: ["baseUrl", "string"],
  BRAIN_SEED: ["seed", "number"],
  BRAIN_CACHE: ["cache", "string"],
  BRAIN_MODEL: ["model", "string"],
  BRAIN_API_KEY: ["apiKey", "string"],
  BRAIN_TEMPERATURE: ["temperature", "number"],
  BRAIN_MAX_OUTPUT_TOKENS: ["maxOutputTokens", "number"],
  BRAIN_TIMEOUT_MS: ["timeoutMs", "number"],
  BRAIN_MAX_CONCURRENT: ["maxConcurrentRequests", "number"],
  BRAIN_DECISION_INTERVAL_SECONDS: ["decisionIntervalSeconds", "number"],
  BRAIN_MAX_DECISION_AGE_SECONDS: ["maxDecisionAgeSeconds", "number"],
  BRAIN_TOOL_CALLING: ["toolCalling", "bool"],
};

/** Defaults < JSON file (optional) < env. Throws ZodError on invalid values. */
export function loadBrainConfig(
  file?: string,
  env: Record<string, string | undefined> = process.env,
): BrainConfig {
  const raw: Record<string, unknown> =
    file !== undefined && fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : {};
  for (const [name, [key, type]] of Object.entries(ENV)) {
    const v = env[name];
    if (v === undefined || v === "") continue;
    raw[key] =
      type === "number" ? Number(v) : type === "bool" ? v === "true" : v;
  }
  return BrainConfigSchema.parse(raw);
}

export function isEmpireEnabled(c: BrainConfig, empireId: string): boolean {
  return c.empires[empireId]?.enabled ?? true;
}

export function modelFor(c: BrainConfig, empireId: string): string {
  return c.empires[empireId]?.model ?? c.model;
}
