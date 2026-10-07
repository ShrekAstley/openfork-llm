import { loadBrainConfig } from "../src/BrainConfig";
import { testConnection } from "../src/testConnection";

// Usage: npm run brain:check [-- path/to/brain.json]   (env BRAIN_* overrides)
const config = loadBrainConfig(process.argv[2] ?? "brain.config.json");
const report = await testConnection(config);
console.log(
  JSON.stringify(
    { baseUrl: config.baseUrl, model: config.model, ...report },
    null,
    2,
  ),
);
process.exit(report.ok ? 0 : 1);
