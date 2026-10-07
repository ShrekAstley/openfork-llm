import { eventVisibleTo } from "./relationships";
import {
  allocId,
  type DiplomacyEvent,
  type DiplomacyState,
  type MemoryEntry,
} from "./schemas";

export const MAX_MEMORY = 500;

const IMPORTANCE: Record<DiplomacyEvent["type"], number> = {
  aid_sent: 3,
  treaty_signed: 3,
  treaty_honored: 3,
  treaty_broken: 5,
  attack: 4,
  war_declared: 5,
  betrayal: 5,
  trade: 2,
  threat: 3,
  peace: 4,
  alliance_formed: 4,
  alliance_left: 3,
  intelligence_shared: 2,
};

const maxTurn = (s: DiplomacyState) =>
  s.memory.reduce((m, e) => Math.max(m, e.turn), s.turn);

/** Drops the least important, then oldest, entries beyond the bound. */
export function prune(s: DiplomacyState, max = MAX_MEMORY): void {
  if (s.memory.length <= max) return;
  const drop = new Set(
    [...s.memory]
      .sort(
        (a, b) =>
          a.importance - b.importance ||
          a.turn - b.turn ||
          a.id.localeCompare(b.id),
      )
      .slice(0, s.memory.length - max)
      .map((e) => e.id),
  );
  s.memory = s.memory.filter((e) => !drop.has(e.id));
}

export function remember(
  s: DiplomacyState,
  e: Omit<MemoryEntry, "id">,
  max = MAX_MEMORY,
): MemoryEntry {
  const entry = { id: allocId(s, "m"), ...e };
  s.memory.push(entry);
  prune(s, max);
  return entry;
}

/** Records a diplomatic event as a memory, visible per the event's visibility. */
export function rememberEvent(s: DiplomacyState, e: DiplomacyEvent) {
  return remember(s, {
    turn: e.turn,
    subjects: [e.actor, e.target],
    kind: e.type,
    summary: e.summary ?? `${e.actor} ${e.type} ${e.target}`,
    importance: IMPORTANCE[e.type],
    visibleTo: eventVisibleTo(s, e),
    secret: e.secret,
  });
}

const visible = (s: DiplomacyState, observer: string) =>
  s.memory.filter((m) => m.visibleTo.includes(observer));

const line = (m: MemoryEntry) => `t${m.turn} [${m.importance}] ${m.summary}`;

/**
 * Lines about `subject` the observer can see, oldest first. When there are more
 * than `maxEntries`, the most important (then most recent) stay verbatim and
 * the rest collapse into one leading summary line.
 */
export function summarize(
  s: DiplomacyState,
  observer: string,
  subject: string,
  maxEntries: number,
): string[] {
  const all = visible(s, observer)
    .filter((m) => m.subjects.includes(subject))
    .sort((a, b) => a.turn - b.turn || a.id.localeCompare(b.id));
  if (all.length <= maxEntries) return all.map(line);
  const keepN = Math.max(0, maxEntries - 1);
  const keep = new Set(
    [...all]
      .sort(
        (a, b) =>
          b.importance - a.importance ||
          b.turn - a.turn ||
          a.id.localeCompare(b.id),
      )
      .slice(0, keepN)
      .map((m) => m.id),
  );
  const rest = all.filter((m) => !keep.has(m.id));
  const counts: Record<string, number> = {};
  for (const m of rest) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
  const kinds = Object.keys(counts)
    .sort()
    .map((k) => `${k} x${counts[k]}`)
    .join(", ");
  const summary = `t${rest[0].turn}-t${rest[rest.length - 1].turn}: ${rest.length} older minor events (${kinds})`;
  return [summary, ...all.filter((m) => keep.has(m.id)).map(line)];
}

/** Ranks the observer's visible memories by subject match, kind match, importance, recency. */
export function retrieveRelevant(
  s: DiplomacyState,
  observer: string,
  situation: { subject?: string; kind?: string },
  limit: number,
): MemoryEntry[] {
  const now = maxTurn(s);
  const score = (m: MemoryEntry) =>
    (situation.subject && m.subjects.includes(situation.subject) ? 100 : 0) +
    (situation.kind && m.kind === situation.kind ? 50 : 0) +
    m.importance * 10 +
    Math.max(0, 10 - Math.floor((now - m.turn) / 5));
  return visible(s, observer)
    .map((m) => [score(m), m] as const)
    .sort(
      (a, b) =>
        b[0] - a[0] || b[1].turn - a[1].turn || a[1].id.localeCompare(b[1].id),
    )
    .slice(0, limit)
    .map(([, m]) => m);
}

// ---- reputation: one observer's view, from what that observer saw ---------
export interface ReputationFacts {
  observer: string;
  subject: string;
  treatiesHonored: number;
  treatiesBroken: number;
  betrayals: number;
  aidGiven: number;
  warsStarted: number;
  attacks: number;
  /** Percent of concluded treaties the subject broke; null if none seen. */
  brokenRatePct: number | null;
  text: string;
}

export function reputation(
  s: DiplomacyState,
  observer: string,
  subject: string,
): ReputationFacts {
  const mine = visible(s, observer).filter((m) => m.subjects[0] === subject);
  const n = (k: string) => mine.filter((m) => m.kind === k).length;
  const treatiesHonored = n("treaty_honored");
  const treatiesBroken = n("treaty_broken");
  const betrayals = n("betrayal");
  const aidGiven = n("aid_sent");
  const warsStarted = n("war_declared");
  const attacks = n("attack");
  const concluded = treatiesHonored + treatiesBroken;
  const brokenRatePct = concluded
    ? Math.floor((treatiesBroken * 100) / concluded)
    : null;
  const text = mine.length
    ? `${subject} as seen by ${observer}: honored ${treatiesHonored} and broke ${treatiesBroken} treaties` +
      (brokenRatePct === null ? "" : ` (${brokenRatePct}% broken)`) +
      `; betrayals ${betrayals}; aid given ${aidGiven}; wars started ${warsStarted}; attacks ${attacks}.`
    : `${subject}: no observed history.`;
  return {
    observer,
    subject,
    treatiesHonored,
    treatiesBroken,
    betrayals,
    aidGiven,
    warsStarted,
    attacks,
    brokenRatePct,
    text,
  };
}
