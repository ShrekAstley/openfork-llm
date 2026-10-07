import type { BrainConfig } from "./BrainConfig";
import { LMStudioProvider } from "./LMStudioProvider";
import type { LLMError } from "./types";

export interface ConnectionReport {
  ok: boolean;
  latencyMs: number;
  /** config.model is listed by the server (or, when model is empty, any model is listed). */
  modelFound: boolean;
  error?: LLMError;
}

/** GET /models, then a tiny chat. ok = both succeeded (a missing model does not fail it: servers may JIT-load). */
export async function testConnection(
  config: BrainConfig,
  fetchImpl?: typeof fetch,
): Promise<ConnectionReport> {
  const t0 = performance.now();
  const p = new LMStudioProvider({ ...config, fetch: fetchImpl });
  const done = (r: Omit<ConnectionReport, "latencyMs">) => ({
    ...r,
    latencyMs: Math.round(performance.now() - t0),
  });
  const models = await p.listModels();
  if (!models.ok)
    return done({ ok: false, modelFound: false, error: models.error });
  const modelFound = config.model
    ? models.value.includes(config.model)
    : models.value.length > 0;
  const chat = await p.chat({
    messages: [{ role: "user", content: "Reply with: ok" }],
    temperature: 0,
    maxTokens: 8,
  });
  return chat.ok
    ? done({ ok: true, modelFound })
    : done({ ok: false, modelFound, error: chat.error });
}
