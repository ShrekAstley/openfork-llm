// What the configured models are expected to cost in memory, and the command
// that starts each one, so the user sees the bill before launching a game.
// Estimates, not measurements: weights from parameters x bits per weight, KV
// cache from context size. Real use varies with the backend and its buffers.
import type { BrainConfig, ModelProfile } from "./BrainConfig";
import { modelFor } from "./BrainConfig";

/** Approximate bits per weight of common GGUF quantisations. */
const BITS: Record<string, number> = {
  Q2_K: 3.0,
  Q3_K_M: 3.9,
  Q4_0: 4.5,
  Q4_K_S: 4.6,
  Q4_K_M: 4.85,
  Q5_K_S: 5.55,
  Q5_K_M: 5.7,
  Q6_K: 6.6,
  Q8_0: 8.5,
  F16: 16,
  FP16: 16,
  BF16: 16,
};
const DEFAULT_BITS = 4.85;
/** KV bytes per token per billion parameters (fp16 cache, grouped-query attention). */
const KV_PER_B = 16 * 1024;
const GB = 1024 ** 3;

export interface MemoryEstimate {
  weightsGB: number;
  kvCacheGB: number;
  totalGB: number;
  /** Set when gpuLayers and layers are both known. */
  vramGB?: number;
  ramGB?: number;
  /** FP16 and the like on small machines; shown, never silently applied. */
  warning?: string;
}

export function estimateMemory(p: ModelProfile): MemoryEstimate {
  const bits = BITS[p.quant.toUpperCase()] ?? DEFAULT_BITS;
  const weightsGB = (p.paramsB * 1e9 * bits) / 8 / GB;
  const kvCacheGB =
    ((p.kvBytesPerToken ?? p.paramsB * KV_PER_B) * p.contextSize) / GB;
  const totalGB = weightsGB + kvCacheGB;
  const r = (n: number) => Math.round(n * 100) / 100;
  const out: MemoryEstimate = {
    weightsGB: r(weightsGB),
    kvCacheGB: r(kvCacheGB),
    totalGB: r(totalGB),
  };
  if (p.gpuLayers !== undefined && p.layers) {
    const share = Math.min(1, p.gpuLayers / p.layers);
    out.vramGB = r(totalGB * share);
    out.ramGB = r(totalGB * (1 - share));
  }
  if (bits >= 16)
    out.warning =
      "full precision: a Q4/Q5/Q6 quantisation needs far less memory";
  return out;
}

export interface ModelRow {
  model: string;
  empires: string[];
  profile?: ModelProfile;
  estimate?: MemoryEstimate;
  /** Commands that start it on each backend. Hints; check your install's flags. */
  launch?: Record<string, string>;
}

export function launchHints(
  model: string,
  p: ModelProfile,
): Record<string, string> {
  const gpu =
    p.gpuLayers !== undefined
      ? ` --gpu ${p.gpuLayers >= (p.layers ?? 1e9) ? "max" : "auto"}`
      : "";
  const lms = `lms load ${model} --context-length ${p.contextSize}${gpu}`;
  const llama =
    `llama-server -m <${model}.gguf> -c ${p.contextSize}` +
    (p.gpuLayers !== undefined ? ` -ngl ${p.gpuLayers}` : "") +
    (p.threads ? ` -t ${p.threads}` : "") +
    (p.batchSize ? ` -b ${p.batchSize}` : "");
  return {
    lmstudio: lms,
    llamacpp: llama,
    ollama: `ollama run ${model}  # set PARAMETER num_ctx ${p.contextSize}${p.gpuLayers !== undefined ? `, num_gpu ${p.gpuLayers}` : ""} in a Modelfile`,
  };
}

/** One row per distinct model across the empires (and the default). */
export function planModels(c: BrainConfig, empires: string[]): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const name of empires) {
    const model = modelFor(c, name);
    const row = rows.get(model) ?? { model, empires: [] };
    row.empires.push(name);
    rows.set(model, row);
  }
  return [...rows.values()].map((r) => {
    const profile = c.models[r.model];
    return profile
      ? {
          ...r,
          profile,
          estimate: estimateMemory(profile),
          launch: launchHints(r.model, profile),
        }
      : r;
  });
}

/** Peak memory: everything resident at once (keep) or the largest model (swap). */
export function peakGB(rows: ModelRow[], residency: "keep" | "swap"): number {
  const sizes = rows.flatMap((r) => (r.estimate ? [r.estimate.totalGB] : []));
  if (sizes.length === 0) return 0;
  const n =
    residency === "swap"
      ? Math.max(...sizes)
      : sizes.reduce((a, b) => a + b, 0);
  return Math.round(n * 100) / 100;
}
