// Usage: npm run brain:plan [-- path/to/brain.json] [--empires A,B,C]
// Prints each configured model, which empires use it, its estimated memory and
// the command that starts it. Nothing is sent anywhere.
import { parseArgs } from "node:util";
import { loadBrainConfig } from "../src/BrainConfig";
import { peakGB, planModels } from "../src/ModelPlan";

const { values: a, positionals } = parseArgs({
  options: { empires: { type: "string" } },
  allowPositionals: true,
});
const config = loadBrainConfig(positionals[0] ?? "brain.config.json");
const empires = a.empires ? a.empires.split(",") : Object.keys(config.empires);
const rows = planModels(config, empires.length ? empires : ["(default)"]);
console.log(
  `backend ${config.backend} at ${config.baseUrl}, residency ${config.residency}`,
);
for (const r of rows) {
  console.log(`\n${r.model || "(server default)"}  <- ${r.empires.join(", ")}`);
  if (!r.estimate || !r.profile) {
    console.log("  no profile in config.models: memory unknown");
    continue;
  }
  const e = r.estimate;
  console.log(
    `  ${r.profile.paramsB}B ${r.profile.quant}, context ${r.profile.contextSize}: ~${e.totalGB} GB (weights ${e.weightsGB} + KV cache ${e.kvCacheGB})` +
      (e.vramGB !== undefined ? `, VRAM ~${e.vramGB} / RAM ~${e.ramGB}` : ""),
  );
  if (e.warning) console.log(`  warning: ${e.warning}`);
  console.log(`  start: ${r.launch?.[config.backend] ?? r.launch?.lmstudio}`);
}
console.log(
  `\nexpected peak: ~${peakGB(rows, config.residency)} GB (${config.residency === "swap" ? "largest single model" : "all models resident"}); parallel requests: ${config.maxConcurrentRequests}`,
);
