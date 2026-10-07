import {
  BIPOLAR_DIMS,
  type DiplomacyEvent,
  type DiplomacyState,
  empireIds,
  type Relationship,
  RelationshipSchema,
  type RelDim,
} from "./schemas";

type Delta = Partial<Record<RelDim, number>>;
/**
 * Deterministic, event-caused deltas.
 * recv: the target's view of the actor, self: the actor's view of the target,
 * witness: each third party that can see the event, toward the actor.
 */
interface Effect {
  recv?: Delta;
  self?: Delta;
  witness?: Delta;
}

const COOP_PAIR: Delta = {
  trust: 8,
  diplomatic: 8,
  reliability: 3,
  recentCooperation: 15,
};

export const EVENT_EFFECTS: Record<DiplomacyEvent["type"], Effect> = {
  aid_sent: {
    recv: {
      trust: 10,
      respect: 3,
      economic: 5,
      reliability: 8,
      hostility: -5,
      recentCooperation: 20,
    },
    self: { economic: 3, recentCooperation: 10 },
    witness: { respect: 2, reliability: 2 },
  },
  treaty_signed: { recv: COOP_PAIR, self: COOP_PAIR },
  treaty_honored: {
    recv: { trust: 6, reliability: 10 },
    self: { trust: 4 },
    witness: { reliability: 3 },
  },
  treaty_broken: {
    recv: {
      trust: -40,
      reliability: -40,
      hostility: 20,
      grievance: 30,
      recentAggression: 15,
      perceivedThreat: 5,
    },
    self: {},
    witness: { trust: -10, reliability: -15 },
  },
  attack: {
    recv: {
      trust: -20,
      hostility: 25,
      fear: 15,
      grievance: 25,
      recentAggression: 30,
      perceivedThreat: 20,
      military: -5,
    },
    self: { hostility: 8, military: -3 },
    witness: { trust: -3, perceivedThreat: 5, fear: 3 },
  },
  war_declared: {
    recv: {
      trust: -15,
      hostility: 30,
      fear: 10,
      grievance: 20,
      diplomatic: -20,
      perceivedThreat: 25,
      recentAggression: 20,
    },
    self: { hostility: 15, diplomatic: -10 },
    witness: { trust: -5, perceivedThreat: 5 },
  },
  betrayal: {
    recv: {
      trust: -60,
      respect: -30,
      reliability: -50,
      hostility: 35,
      grievance: 50,
      recentAggression: 30,
      perceivedThreat: 20,
      diplomatic: -30,
    },
    self: { hostility: 5 },
    witness: { trust: -20, respect: -10, reliability: -30 },
  },
  trade: {
    recv: { trust: 3, economic: 10, recentCooperation: 10 },
    self: { trust: 3, economic: 10, recentCooperation: 10 },
    witness: { economic: 1 },
  },
  threat: {
    recv: {
      fear: 20,
      hostility: 10,
      trust: -10,
      perceivedThreat: 15,
      recentAggression: 10,
    },
    self: { hostility: 3 },
    witness: { perceivedThreat: 2 },
  },
  peace: {
    recv: {
      hostility: -20,
      trust: 5,
      diplomatic: 10,
      grievance: -5,
      recentCooperation: 10,
    },
    self: {
      hostility: -20,
      trust: 5,
      diplomatic: 10,
      grievance: -5,
      recentCooperation: 10,
    },
  },
  alliance_formed: {
    recv: {
      trust: 15,
      military: 15,
      diplomatic: 10,
      ideological: 5,
      reliability: 3,
    },
    self: {
      trust: 15,
      military: 15,
      diplomatic: 10,
      ideological: 5,
      reliability: 3,
    },
    witness: { perceivedThreat: 3 },
  },
  alliance_left: {
    recv: { trust: -5, military: -10, diplomatic: -5 },
    self: {},
  },
  intelligence_shared: {
    recv: { trust: 5, diplomatic: 3, recentCooperation: 10 },
    self: {},
  },
};

export const relKey = (from: string, to: string) => `${from}>${to}`;

const bipolar = new Set<string>(BIPOLAR_DIMS);
const clamp = (dim: string, v: number) =>
  Math.max(bipolar.has(dim) ? -100 : 0, Math.min(100, v));

export function getRelationship(
  s: DiplomacyState,
  from: string,
  to: string,
): Relationship {
  return (
    s.relationships[relKey(from, to)] ?? RelationshipSchema.parse({ from, to })
  );
}

function bump(s: DiplomacyState, from: string, to: string, d?: Delta) {
  if (!d || Object.keys(d).length === 0 || from === to) return;
  const rel = { ...getRelationship(s, from, to) };
  for (const [dim, v] of Object.entries(d)) {
    rel[dim as RelDim] = clamp(dim, rel[dim as RelDim] + (v as number));
  }
  s.relationships[relKey(from, to)] = rel;
}

/** Empires that can see the event: actor, target, and (if public) everyone. */
export function eventVisibleTo(s: DiplomacyState, e: DiplomacyEvent): string[] {
  const ids = e.secret
    ? [e.actor, e.target, ...e.witnesses]
    : [...empireIds(s), e.actor, e.target];
  return [...new Set(ids)].sort();
}

export function applyEvent(s: DiplomacyState, e: DiplomacyEvent): void {
  const fx = EVENT_EFFECTS[e.type];
  bump(s, e.target, e.actor, fx.recv);
  bump(s, e.actor, e.target, fx.self);
  for (const o of eventVisibleTo(s, e)) {
    if (o !== e.actor && o !== e.target) bump(s, o, e.actor, fx.witness);
  }
}

/**
 * The only passive change: recentCooperation / recentAggression fall by
 * 1 per elapsed turn (floor 0).
 */
export function decayRecent(s: DiplomacyState, turns: number): void {
  if (turns <= 0) return;
  for (const rel of Object.values(s.relationships)) {
    rel.recentCooperation = Math.max(0, rel.recentCooperation - turns);
    rel.recentAggression = Math.max(0, rel.recentAggression - turns);
  }
}
