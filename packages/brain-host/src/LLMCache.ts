// Identical requests get the identical recorded answer. Off by default: with a
// temperature above zero the cache trades decision variety for repeatability,
// which is what replays, tests and benchmarks want and a live game does not.
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { ChatRequest, ChatResult } from "./types";

export type CacheMode = "off" | "record" | "replay";

/** Hash of everything that shapes the answer. Also logged per decision. */
export function requestKey(req: ChatRequest, seed?: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        req.model ?? "",
        req.temperature,
        req.maxTokens,
        seed ?? null,
        req.messages.map((m) => [m.role, m.content]),
        (req.tools ?? []).map((t) => t.name),
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}

export class LLMCache {
  private entries = new Map<string, ChatResult>();

  constructor(
    readonly mode: CacheMode,
    private file?: string,
  ) {
    if (mode === "off" || !file || !fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { key: string; result: ChatResult };
        this.entries.set(e.key, e.result);
      } catch {
        // a torn last line from a crash: skip it
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): ChatResult | undefined {
    return this.mode === "off" ? undefined : this.entries.get(key);
  }

  set(key: string, result: ChatResult): void {
    if (this.mode !== "record" || this.entries.has(key)) return;
    this.entries.set(key, result);
    if (this.file)
      fs.appendFileSync(this.file, JSON.stringify({ key, result }) + "\n");
  }
}
