import * as Alliances from "./alliances";
import {
  type AllianceTerms,
  allocId,
  type DiplomacyEvent,
  type DiplomacyState,
  type DiplomaticProposal,
  type Negotiation,
  type TreatyTerms,
  TreatyTermsSchema,
} from "./schemas";
import * as Treaties from "./treaties";

export interface ProposalSpec {
  type: DiplomaticProposal["type"];
  treatyType?: DiplomaticProposal["treatyType"];
  terms?: Partial<TreatyTerms>;
  allianceTerms?: Partial<AllianceTerms>;
}

export interface Accepted {
  events: DiplomacyEvent[];
  treatyId?: string;
  allianceId?: string;
}

function addProposal(
  s: DiplomacyState,
  turn: number,
  from: string,
  to: string,
  spec: ProposalSpec,
  secret: boolean,
  ttl: number,
): DiplomaticProposal {
  const p: DiplomaticProposal = {
    id: allocId(s, "p"),
    type: spec.type,
    from,
    to,
    ...(spec.treatyType ? { treatyType: spec.treatyType } : {}),
    terms: TreatyTermsSchema.parse(spec.terms ?? {}),
    ...(spec.allianceTerms
      ? { allianceTerms: spec.allianceTerms as AllianceTerms }
      : {}),
    status: "proposed",
    createdTurn: turn,
    expiresTurn: turn + ttl,
    secret,
  };
  s.proposals[p.id] = p;
  return p;
}

const latest = (s: DiplomacyState, n: Negotiation) =>
  s.proposals[n.proposals[n.proposals.length - 1]];

function openNeg(s: DiplomacyState, id: string): Negotiation {
  const n = s.negotiations[id];
  if (!n || n.status !== "open")
    throw new Error(`negotiation ${id} is not open`);
  return n;
}

export function open(
  s: DiplomacyState,
  turn: number,
  from: string,
  to: string,
  spec: ProposalSpec,
  opts: { secret?: boolean; ttl?: number } = {},
): Negotiation {
  const secret = opts.secret ?? false;
  const p = addProposal(
    s,
    turn,
    from,
    to,
    spec,
    secret,
    opts.ttl ?? Treaties.PROPOSAL_TTL,
  );
  const n: Negotiation = {
    id: allocId(s, "n"),
    parties: [from, to],
    proposals: [p.id],
    status: "open",
    openedTurn: turn,
    lastTurn: turn,
    secret,
  };
  s.negotiations[n.id] = n;
  return n;
}

/** The recipient of the latest proposal answers with a new one. */
export function counter(
  s: DiplomacyState,
  turn: number,
  id: string,
  by: string,
  spec: ProposalSpec,
  ttl = Treaties.PROPOSAL_TTL,
): DiplomaticProposal {
  const n = openNeg(s, id);
  const last = latest(s, n);
  if (last.to !== by) throw new Error(`${by} cannot counter in ${id}`);
  last.status = "countered";
  const p = addProposal(s, turn, by, last.from, spec, n.secret, ttl);
  n.proposals.push(p.id);
  n.lastTurn = turn;
  return p;
}

export function reject(s: DiplomacyState, id: string, by: string): void {
  const n = openNeg(s, id);
  const last = latest(s, n);
  if (last.to !== by) throw new Error(`${by} cannot reject in ${id}`);
  last.status = "rejected";
  n.status = "rejected";
}

/** Accepting turns the proposal into a real Treaty / Alliance. */
export function accept(
  s: DiplomacyState,
  turn: number,
  id: string,
  by: string,
): Accepted {
  const n = openNeg(s, id);
  const p = latest(s, n);
  if (p.to !== by) throw new Error(`${by} cannot accept in ${id}`);
  p.status = "accepted";
  n.status = "accepted";
  n.lastTurn = turn;
  const out: Accepted = { events: [] };
  if (p.type === "ALLIANCE") {
    const a = Alliances.create(s, turn, p.from, [by], p.allianceTerms);
    out.events = Alliances.accept(s, turn, a.id, by);
    out.allianceId = n.resultId = a.id;
  } else if (p.type !== "AID_REQUEST") {
    const type =
      p.type === "PEACE"
        ? "peace"
        : p.type === "CEASEFIRE"
          ? "ceasefire"
          : (p.treatyType ?? "custom");
    const t = Treaties.propose(s, turn, p.from, [by], type, p.terms, {
      secret: n.secret,
    });
    out.events = Treaties.accept(s, turn, t.id, by);
    out.treatyId = n.resultId = t.id;
  }
  return out;
}

/** Open negotiations whose latest proposal has lapsed time out. */
export function timeout(s: DiplomacyState, turn: number): void {
  for (const n of Object.values(s.negotiations)) {
    if (n.status !== "open") continue;
    const p = latest(s, n);
    if (p.expiresTurn <= turn) {
      p.status = "expired";
      n.status = "expired";
    }
  }
}

export const visibleTo = (n: Negotiation, empire: string) =>
  !n.secret || n.parties.includes(empire);
