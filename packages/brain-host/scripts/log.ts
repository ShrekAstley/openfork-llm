// Usage: npm run brain:log [-- --file brain.decisions.jsonl] [--empire Name] [--last 20]
//        [--serve [--port 8765]]
// Prints the decision log: situation, decision, the model's one-line reason,
// result. --serve shows the same on http://127.0.0.1:<port> (this machine
// only), refreshing every few seconds.
import http from "node:http";
import { parseArgs } from "node:util";
import { describeDecision, readDecisionLog } from "../src/DecisionLog";

const { values: a } = parseArgs({
  options: {
    file: { type: "string", default: "brain.decisions.jsonl" },
    empire: { type: "string" },
    last: { type: "string", default: "20" },
    serve: { type: "boolean", default: false },
    port: { type: "string", default: "8765" },
  },
});
const view = () =>
  readDecisionLog(a.file!)
    .filter((r) => !a.empire || r.empire === a.empire)
    .slice(-Number(a.last))
    .map(describeDecision)
    .join("\n\n");

if (!a.serve) console.log(view() || "no decisions logged yet");
else {
  const esc = (s: string) =>
    s.replace(
      /[&<>]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!,
    );
  http
    .createServer((_, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3><title>Brain decisions</title>` +
          `<body style="font:14px monospace;background:#111;color:#ddd;padding:1rem"><pre style="white-space:pre-wrap">${esc(view() || "no decisions logged yet")}</pre>`,
      );
    })
    .listen(Number(a.port), "127.0.0.1", () =>
      console.log(`decision log at http://127.0.0.1:${a.port}`),
    );
}
