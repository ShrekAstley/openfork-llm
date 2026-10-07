// An append-only record of every decision: who decided, with which model, from
// which request (hash), what they chose and why, and what happened. The "why"
// is the model's one-line rationale, never its private reasoning. Lines are
// JSON so a viewer, a benchmark or a replay can read them without the model.
import fs from "node:fs";

export interface DecisionRecord {
  /** Simulation tick and the second it corresponds to. */
  tick: number;
  second: number;
  empire: string;
  model: string;
  /** Request hash: also the LLM cache key. */
  key: string;
  status: "ok" | "stale" | "failed" | "cancelled";
  cached: boolean;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  /** What the situation was, in a few words (the wake-up events). */
  situation: string[];
  objective: string;
  rationale: string;
  /** Each accepted action with its own one-line reason, when given. */
  actions: { action: string; reason?: string }[];
  /** Validator rejections, and server refusals. */
  rejected: string[];
  /** What the simulation did with it. */
  result:
    | "applied"
    | "partly_applied"
    | "all_rejected"
    | "no_action"
    | "dropped";
  error?: string;
}

export class DecisionLog {
  constructor(private file: string) {}

  write(r: DecisionRecord): void {
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, JSON.stringify(r) + "\n");
    } catch {
      // A full disk must not stop the game.
    }
  }
}

export function readDecisionLog(file: string): DecisionRecord[] {
  if (!fs.existsSync(file)) return [];
  const out: DecisionRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // torn last line
    }
  }
  return out;
}

export function describeDecision(r: DecisionRecord): string {
  return [
    `TURN ${r.second}  ${r.empire}  [${r.model || "default"} ${r.status}${r.cached ? " cached" : ""} ${r.latencyMs}ms]`,
    r.situation.length ? `  Situation: ${r.situation.join("; ")}` : "",
    r.objective ? `  Goal: ${r.objective}` : "",
    ...r.actions.map(
      (a) => `  Decision: ${a.action}${a.reason ? `  (${a.reason})` : ""}`,
    ),
    r.rationale ? `  Why: ${r.rationale}` : "",
    r.rejected.length ? `  Rejected: ${r.rejected.join(" | ")}` : "",
    `  Result: ${r.result}${r.error ? ` (${r.error})` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}
