import {
  allocId,
  type DiplomacyEvent,
  type DiplomacyState,
  mkEvent,
  type Treaty,
  type TreatyTerms,
  TreatyTermsSchema,
} from "./schemas";

export const PROPOSAL_TTL = 5;

export function propose(
  s: DiplomacyState,
  turn: number,
  proposer: string,
  others: string[],
  type: Treaty["type"],
  terms: Partial<TreatyTerms> = {},
  opts: { secret?: boolean; ttl?: number } = {},
): Treaty {
  const t: Treaty = {
    id: allocId(s, "t"),
    type,
    parties: [proposer, ...others],
    proposer,
    terms: TreatyTermsSchema.parse(terms),
    status: "proposed",
    createdTurn: turn,
    expiresTurn: turn + (opts.ttl ?? PROPOSAL_TTL),
    secret: opts.secret ?? false,
  };
  s.treaties[t.id] = t;
  return t;
}

const need = (s: DiplomacyState, id: string, status: Treaty["status"]) => {
  const t = s.treaties[id];
  if (!t || t.status !== status)
    throw new Error(`treaty ${id} is not ${status}`);
  return t;
};

/** A non-proposing party accepts; the treaty becomes active. */
export function accept(
  s: DiplomacyState,
  turn: number,
  id: string,
  by: string,
): DiplomacyEvent[] {
  const t = need(s, id, "proposed");
  if (by === t.proposer || !t.parties.includes(by))
    throw new Error(`${by} cannot accept treaty ${id}`);
  t.status = "active";
  t.expiresTurn = t.terms.duration_turns ? turn + t.terms.duration_turns : null;
  const o = { secret: t.secret };
  const evs = [mkEvent("treaty_signed", turn, by, t.proposer, o)];
  if (t.type === "peace") evs.push(mkEvent("peace", turn, by, t.proposer, o));
  return evs;
}

export function reject(s: DiplomacyState, id: string, by: string): void {
  const t = need(s, id, "proposed");
  if (by === t.proposer || !t.parties.includes(by))
    throw new Error(`${by} cannot reject treaty ${id}`);
  t.status = "rejected";
}

/** Proposer takes back a still-pending proposal. */
export function withdraw(s: DiplomacyState, id: string, by: string): void {
  const t = need(s, id, "proposed");
  if (by !== t.proposer) throw new Error(`${by} did not propose treaty ${id}`);
  t.status = "withdrawn";
}

/** Lapses stale proposals; natural end of an active treaty counts as honored. */
export function expire(s: DiplomacyState, turn: number): DiplomacyEvent[] {
  const evs: DiplomacyEvent[] = [];
  for (const t of Object.values(s.treaties)) {
    if (t.expiresTurn === null || t.expiresTurn > turn) continue;
    if (t.status === "proposed") t.status = "expired";
    else if (t.status === "active") {
      t.status = "expired";
      for (const p of t.parties)
        for (const q of t.parties)
          if (p !== q)
            evs.push(
              mkEvent("treaty_honored", turn, p, q, { secret: t.secret }),
            );
    }
  }
  return evs;
}

/** `by` breaks an active treaty (allowed; has consequences). */
export function violate(
  s: DiplomacyState,
  turn: number,
  id: string,
  by: string,
): DiplomacyEvent[] {
  const t = need(s, id, "active");
  if (!t.parties.includes(by)) throw new Error(`${by} is not a party of ${id}`);
  t.status = "violated";
  return t.parties
    .filter((p) => p !== by)
    .map((p) => mkEvent("treaty_broken", turn, by, p, { secret: t.secret }));
}

/** Active treaties between actor and target that this event breaks. */
export function detectViolations(
  s: DiplomacyState,
  e: DiplomacyEvent,
): Treaty[] {
  if (e.type !== "attack" && e.type !== "war_declared") return [];
  return Object.values(s.treaties).filter(
    (t) =>
      t.status === "active" &&
      t.parties.includes(e.actor) &&
      t.parties.includes(e.target),
  );
}
