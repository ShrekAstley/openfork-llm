import fs from "fs";
import { z } from "zod";

export const BrainConfigSchema = z.object({
  baseUrl: z.string().url().default("http://localhost:1234/v1"),
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
  empires: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(true),
        model: z.string().optional(),
        personality: z.string().max(600).default(""),
        /** Standing orders shown in every observation. */
        directives: z.array(z.string().max(300)).max(5).default([]),
      }),
    )
    .default({}),
});

export type BrainConfig = z.infer<typeof BrainConfigSchema>;

const ENV: Record<string, [keyof BrainConfig, "string" | "number" | "bool"]> = {
  BRAIN_BASE_URL: ["baseUrl", "string"],
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
