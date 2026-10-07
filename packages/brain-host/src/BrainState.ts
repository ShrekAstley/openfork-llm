// What a Brain Host keeps across a restart, as one JSON file: the diplomacy
// state, each empire's bounded memory, and its decision-scheduler cursors.
// Never the model's raw text (only what the brains already keep), never
// config or credentials. The game itself is not saved: on resume the replica
// replays the server's turn log from the start.
import fs from "fs";
import { z } from "zod";
import { DiplomacyStateSchema } from "./diplomacy/schemas";

export const BRAIN_STATE_VERSION = 1;

export const SchedulerStateSchema = z.object({
  next: z.number().int().min(0),
  pending: z.number().int().min(0).max(3).nullable(),
});
export type SchedulerState = z.infer<typeof SchedulerStateSchema>;

const strings = z.array(z.string());

export const EmpireBrainStateSchema = z.object({
  revision: z.number().int().min(0),
  events: strings,
  rejected: strings,
  history: z.array(
    z.object({
      tick: z.number().int().min(0),
      objective: z.string(),
      summary: z.string(),
      actions: strings,
      rejected: strings,
    }),
  ),
  inbox: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      text: z.string(),
      turn: z.number().int().min(0),
    }),
  ),
  scheduler: SchedulerStateSchema,
  /** What the last step saw on the replica, so a resume raises no false events. */
  seen: z.object({
    messages: strings,
    treaties: strings,
    attackers: strings,
    attackIds: strings,
    outgoingIds: strings,
    requestors: strings,
    allies: strings,
    embargoers: strings,
    tilesAtDecision: z.number().int().min(0),
    territoryNoted: z.boolean(),
  }),
});
export type EmpireBrainState = z.infer<typeof EmpireBrainStateSchema>;

export const BrainStateSchema = z.object({
  version: z.literal(BRAIN_STATE_VERSION),
  gameID: z.string().min(1),
  /** Replica tick when saved. */
  savedAtTick: z.number().int().min(0),
  diplomacy: DiplomacyStateSchema,
  /** Keyed by nation name. */
  empires: z.record(z.string(), EmpireBrainStateSchema),
});
export type BrainState = z.infer<typeof BrainStateSchema>;

/** The saved state is for a different game than the one being driven. */
export class ResumeMismatchError extends Error {}

/** Writes through a temp file and a rename, so a crash never leaves half a file. */
export function saveBrainState(file: string, state: BrainState): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(BrainStateSchema.parse(state)));
  fs.renameSync(tmp, file);
}

/** Throws a readable error for a missing, unparsable or wrong-version file. */
export function loadBrainState(file: string): BrainState {
  if (!fs.existsSync(file)) throw new Error(`no brain state at ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`brain state ${file} is not valid JSON`);
  }
  const v = (raw as { version?: unknown } | null)?.version;
  if (v !== BRAIN_STATE_VERSION)
    throw new Error(
      `brain state ${file} has version ${String(v)}, expected ${BRAIN_STATE_VERSION}`,
    );
  const parsed = BrainStateSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `brain state ${file} is invalid: ${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}`,
    );
  return parsed.data;
}
