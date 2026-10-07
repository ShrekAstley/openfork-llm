import {
  type Alliance,
  type AllianceTerms,
  AllianceTermsSchema,
  allocId,
  type Coalition,
  type DiplomacyEvent,
  type DiplomacyState,
  mkEvent,
} from "./schemas";

const get = (s: DiplomacyState, id: string): Alliance => {
  const a = s.alliances[id];
  if (!a || a.status === "collapsed") throw new Error(`no live alliance ${id}`);
  return a;
};
const isMember = (a: Alliance, e: string) => a.members.includes(e);
const without = (xs: string[], e: string) => xs.filter((x) => x !== e);

/** Active alliance containing both empires, if any. */
export function sharedAlliance(
  s: DiplomacyState,
  a: string,
  b: string,
): Alliance | undefined {
  return Object.values(s.alliances).find(
    (x) => x.status === "active" && isMember(x, a) && isMember(x, b),
  );
}

export function create(
  s: DiplomacyState,
  turn: number,
  founder: string,
  invitees: string[],
  terms: Partial<AllianceTerms> = {},
): Alliance {
  const a: Alliance = {
    id: allocId(s, "a"),
    members: [founder],
    invited: [...new Set(invitees)].filter((i) => i !== founder),
    applicants: [],
    createdTurn: turn,
    terms: AllianceTermsSchema.parse(terms),
    status: "proposed",
  };
  s.alliances[a.id] = a;
  return a;
}

export function invite(s: DiplomacyState, id: string, by: string, who: string) {
  const a = get(s, id);
  if (!isMember(a, by)) throw new Error(`${by} is not a member of ${id}`);
  if (!isMember(a, who) && !a.invited.includes(who)) a.invited.push(who);
}

/** Non-member asks to join; a member must approve. */
export function requestJoin(s: DiplomacyState, id: string, who: string) {
  const a = get(s, id);
  if (!isMember(a, who) && !a.applicants.includes(who)) a.applicants.push(who);
}

function join(
  s: DiplomacyState,
  turn: number,
  a: Alliance,
  who: string,
): DiplomacyEvent[] {
  const old = [...a.members];
  a.members.push(who);
  a.invited = without(a.invited, who);
  a.applicants = without(a.applicants, who);
  a.status = "active";
  return old.map((m) => mkEvent("alliance_formed", turn, who, m));
}

/** The invitee accepts its invitation. */
export function accept(
  s: DiplomacyState,
  turn: number,
  id: string,
  who: string,
): DiplomacyEvent[] {
  const a = get(s, id);
  if (!a.invited.includes(who))
    throw new Error(`${who} is not invited to ${id}`);
  return join(s, turn, a, who);
}

/** A member approves an applicant. */
export function approve(
  s: DiplomacyState,
  turn: number,
  id: string,
  by: string,
  applicant: string,
): DiplomacyEvent[] {
  const a = get(s, id);
  if (!isMember(a, by) || !a.applicants.includes(applicant))
    throw new Error(`cannot approve ${applicant} for ${id}`);
  return join(s, turn, a, applicant);
}

/** Declines an invitation or an application. */
export function reject(s: DiplomacyState, id: string, who: string) {
  const a = get(s, id);
  a.invited = without(a.invited, who);
  a.applicants = without(a.applicants, who);
}

export function modifyTerms(
  s: DiplomacyState,
  id: string,
  by: string,
  terms: Partial<AllianceTerms>,
) {
  const a = get(s, id);
  if (!isMember(a, by)) throw new Error(`${by} is not a member of ${id}`);
  a.terms = AllianceTermsSchema.parse({ ...a.terms, ...terms });
}

function remove(a: Alliance, who: string) {
  a.members = without(a.members, who);
  if (a.members.length < 2) {
    a.status = "collapsed";
    a.invited = [];
    a.applicants = [];
  }
}

export function leave(
  s: DiplomacyState,
  turn: number,
  id: string,
  who: string,
): DiplomacyEvent[] {
  const a = get(s, id);
  if (!isMember(a, who)) throw new Error(`${who} is not a member of ${id}`);
  remove(a, who);
  return a.members.map((m) => mkEvent("alliance_left", turn, who, m));
}

/** A member attacked a fellow member: they are expelled and it is a betrayal. */
export function betray(
  s: DiplomacyState,
  turn: number,
  attacker: string,
  victim: string,
): DiplomacyEvent[] {
  const a = sharedAlliance(s, attacker, victim);
  if (!a) return [];
  remove(a, attacker);
  return [mkEvent("betrayal", turn, attacker, victim)];
}

/**
 * Who is obligated (by the alliance terms) when a member is attacked from
 * outside. Information only: it never acts.
 */
export function obligations(
  s: DiplomacyState,
  id: string,
  e: DiplomacyEvent,
): string[] {
  const a = s.alliances[id];
  if (!a || a.status !== "active") return [];
  if (e.type !== "attack" && e.type !== "war_declared") return [];
  if (!isMember(a, e.target) || isMember(a, e.actor)) return [];
  if (!a.terms.mutual_defense && !a.terms.military_assistance) return [];
  return without(a.members, e.target).sort();
}

// ---- coalitions: independent of alliances ------------------------------------
const coal = (s: DiplomacyState, id: string): Coalition => {
  const c = s.coalitions[id];
  if (!c || c.status === "dissolved")
    throw new Error(`no live coalition ${id}`);
  return c;
};

export function formCoalition(
  s: DiplomacyState,
  turn: number,
  name: string,
  founders: string[],
  reason: string,
): Coalition {
  const c: Coalition = {
    id: allocId(s, "c"),
    name,
    members: [...new Set(founders)],
    reason,
    createdTurn: turn,
    status: "active",
  };
  s.coalitions[c.id] = c;
  return c;
}

export function joinCoalition(s: DiplomacyState, id: string, who: string) {
  const c = coal(s, id);
  if (!c.members.includes(who)) c.members.push(who);
}

export function leaveCoalition(s: DiplomacyState, id: string, who: string) {
  const c = coal(s, id);
  c.members = without(c.members, who);
  if (c.members.length < 2) c.status = "dissolved";
}

export function dissolveCoalition(s: DiplomacyState, id: string) {
  coal(s, id).status = "dissolved";
}
