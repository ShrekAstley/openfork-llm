// One empire's own memory, outside the model: bounded, ranked by importance,
// and compressed rather than dropped. Relationship memory (who betrayed whom,
// treaties honoured) lives in the DiplomacyManager; this holds what the empire
// itself went through and decided. Deterministic: no model call summarises it.
export type MemoryKind = "event" | "decision" | "note" | "summary";

export interface Memory {
  tick: number;
  /** 1 (noise) .. 5 (betrayal, war, collapse). */
  importance: number;
  kind: MemoryKind;
  text: string;
  /** For summaries: how many memories were folded in. */
  count?: number;
  /** For summaries: the tick range they cover. */
  from?: number;
}

export const MAX_MEMORIES = 12;
/** Memories shown to the model per decision. */
export const SHOWN_MEMORIES = 6;

/**
 * Adds a memory. Over the bound, the least important (then oldest) fold into
 * one summary line, so 500 events become a handful of lines, not 500 or none.
 */
export function remember(
  list: Memory[],
  m: Memory,
  max = MAX_MEMORIES,
): Memory[] {
  // The same fact twice is one memory, at the higher importance.
  const dup = list.find(
    (x) => x.kind === m.kind && x.text === m.text && x.kind !== "summary",
  );
  if (dup) {
    dup.importance = Math.max(dup.importance, m.importance);
    dup.tick = Math.max(dup.tick, m.tick);
    return list;
  }
  const next = [...list, m];
  if (next.length <= max) return next;
  const order = [...next].sort(
    (a, b) =>
      a.importance - b.importance ||
      a.tick - b.tick ||
      (a.kind === "summary" ? -1 : 0) - (b.kind === "summary" ? -1 : 0),
  );
  // Folding n entries yields one, so fold (over + 1) of them.
  const fold = new Set(order.slice(0, next.length - max + 1));
  const folded = next.filter((x) => fold.has(x));
  const kept = next.filter((x) => !fold.has(x));
  const count = folded.reduce((n, x) => n + (x.count ?? 1), 0);
  const from = Math.min(...folded.map((x) => x.from ?? x.tick));
  const to = Math.max(...folded.map((x) => x.tick));
  const kinds: Record<string, number> = {};
  for (const x of folded)
    if (x.kind !== "summary") kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
  const mix = Object.keys(kinds)
    .sort()
    .map((k) => `${k} x${kinds[k]}`)
    .join(", ");
  kept.push({
    tick: to,
    importance: 1,
    kind: "summary",
    text: `${count} older minor memories${mix ? ` (${mix})` : ""}`,
    count,
    from,
  });
  return kept;
}

/** The lines to show: most important (then newest) first picked, shown oldest first. */
export function recall(list: Memory[], n = SHOWN_MEMORIES): string[] {
  return [...list]
    .sort((a, b) => b.importance - a.importance || b.tick - a.tick)
    .slice(0, n)
    .sort((a, b) => a.tick - b.tick)
    .map((m) =>
      m.kind === "summary"
        ? `t${m.from}-t${m.tick}: ${m.text}`
        : `t${m.tick} [${m.importance}] ${m.text}`,
    );
}
