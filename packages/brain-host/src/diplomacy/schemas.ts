import { z } from "zod";

/**
 * Diplomacy data model. Pure data: everything is JSON-serializable, time is an
 * integer `turn`, ids come from the `nextId` counter in the state.
 */
const Id = z.string().min(1);
const Turn = z.number().int().min(0);

export const EmpireSchema = z.object({
  id: Id,
  name: z.string(),
  /** Free-form prompt context. Never used for branching logic. */
  personality: z.string().default(""),
});
export type Empire = z.infer<typeof EmpireSchema>;

// ---- relationships (directed: the `from` empire's view of `to`) ------------
export const BIPOLAR_DIMS = [
  "trust",
  "respect",
  "economic",
  "military",
  "diplomatic",
  "ideological",
  "reliability",
] as const; // -100..100
export const UNIPOLAR_DIMS = [
  "fear",
  "hostility",
  "grievance",
  "recentCooperation",
  "recentAggression",
  "perceivedThreat",
] as const; // 0..100
export type RelDim =
  | (typeof BIPOLAR_DIMS)[number]
  | (typeof UNIPOLAR_DIMS)[number];

const bi = z.number().int().min(-100).max(100).default(0);
const uni = z.number().int().min(0).max(100).default(0);
export const RelationshipSchema = z.object({
  from: Id,
  to: Id,
  trust: bi,
  respect: bi,
  economic: bi,
  military: bi,
  diplomatic: bi,
  ideological: bi,
  reliability: bi,
  fear: uni,
  hostility: uni,
  grievance: uni,
  recentCooperation: uni,
  recentAggression: uni,
  perceivedThreat: uni,
});
export type Relationship = z.infer<typeof RelationshipSchema>;

// ---- events ----------------------------------------------------------------
export const EVENT_TYPES = [
  "aid_sent",
  "treaty_signed",
  "treaty_honored",
  "treaty_broken",
  "attack",
  "war_declared",
  "betrayal",
  "trade",
  "threat",
  "peace",
  "alliance_formed",
  "alliance_left",
  "intelligence_shared",
] as const;
export const EventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  turn: Turn,
  actor: Id,
  target: Id,
  /** Secret events are visible only to actor, target and `witnesses`. */
  secret: z.boolean().default(false),
  witnesses: z.array(Id).default([]),
  summary: z.string().optional(),
});
export type DiplomacyEvent = z.infer<typeof EventSchema>;

// ---- treaties / alliances / coalitions -------------------------------------
export const TreatyTermsSchema = z.object({
  resource_transfer: z
    .object({
      from: Id,
      to: Id,
      resource: z.string(),
      amount: z.number().int().min(0),
      per_turn: z.boolean().default(false),
    })
    .optional(),
  territorial_restriction: z
    .object({
      empire: Id,
      region: z.string(),
      kind: z.string().default("no_entry"),
    })
    .optional(),
  mutual_defense: z.boolean().default(false),
  /** Omitted = open-ended. */
  duration_turns: z.number().int().positive().optional(),
});
export type TreatyTerms = z.infer<typeof TreatyTermsSchema>;

export const TREATY_TYPES = [
  "non_aggression",
  "trade",
  "peace",
  "ceasefire",
  "mutual_defense",
  "custom",
] as const;
export const TreatySchema = z.object({
  id: Id,
  type: z.enum(TREATY_TYPES),
  parties: z.array(Id).min(2),
  proposer: Id,
  terms: TreatyTermsSchema,
  status: z.enum([
    "proposed",
    "active",
    "rejected",
    "expired",
    "violated",
    "withdrawn",
  ]),
  createdTurn: Turn,
  /** Proposal lapse turn while proposed; end of the treaty while active. */
  expiresTurn: Turn.nullable(),
  secret: z.boolean().default(false),
});
export type Treaty = z.infer<typeof TreatySchema>;

export const AllianceTermsSchema = z.object({
  mutual_defense: z.boolean().default(true),
  trade_bonus: z.boolean().default(false),
  intelligence_sharing: z.boolean().default(false),
  military_assistance: z.boolean().default(false),
  duration: z.number().int().positive().optional(),
});
export type AllianceTerms = z.infer<typeof AllianceTermsSchema>;

export const AllianceSchema = z.object({
  id: Id,
  members: z.array(Id),
  /** Invited by a member, waiting to accept. */
  invited: z.array(Id).default([]),
  /** Asked to join, waiting for a member's approval. */
  applicants: z.array(Id).default([]),
  createdTurn: Turn,
  terms: AllianceTermsSchema,
  status: z.enum(["proposed", "active", "collapsed"]),
});
export type Alliance = z.infer<typeof AllianceSchema>;

export const CoalitionSchema = z.object({
  id: Id,
  name: z.string(),
  members: z.array(Id),
  reason: z.string(),
  createdTurn: Turn,
  status: z.enum(["active", "dissolved"]),
});
export type Coalition = z.infer<typeof CoalitionSchema>;

// ---- messages / proposals / negotiations -----------------------------------
export const MessageSchema = z.object({
  id: Id,
  turn: Turn,
  from: Id,
  /** Absent on public broadcasts. */
  to: Id.optional(),
  text: z.string(),
  channel: z.enum(["public", "private"]),
  secret: z.boolean(),
  proposalId: Id.optional(),
});
export type DiplomaticMessage = z.infer<typeof MessageSchema>;

export const PROPOSAL_TYPES = [
  "TREATY_PROPOSAL",
  "ALLIANCE",
  "PEACE",
  "CEASEFIRE",
  "AID_REQUEST",
] as const;
export const ProposalSchema = z.object({
  id: Id,
  type: z.enum(PROPOSAL_TYPES),
  from: Id,
  to: Id,
  /** Treaty type for TREATY_PROPOSAL. */
  treatyType: z.enum(TREATY_TYPES).optional(),
  terms: TreatyTermsSchema,
  allianceTerms: AllianceTermsSchema.optional(),
  status: z.enum(["proposed", "accepted", "rejected", "countered", "expired"]),
  createdTurn: Turn,
  expiresTurn: Turn,
  secret: z.boolean(),
});
export type DiplomaticProposal = z.infer<typeof ProposalSchema>;

export const NegotiationSchema = z.object({
  id: Id,
  parties: z.tuple([Id, Id]),
  /** Proposal ids, oldest first. */
  proposals: z.array(Id),
  status: z.enum(["open", "accepted", "rejected", "expired"]),
  openedTurn: Turn,
  lastTurn: Turn,
  secret: z.boolean(),
  /** Treaty/Alliance created when accepted. */
  resultId: Id.optional(),
});
export type Negotiation = z.infer<typeof NegotiationSchema>;

// ---- war / ceasefire --------------------------------------------------------
export const WarSchema = z.object({
  id: Id,
  aggressor: Id,
  defender: Id,
  startedTurn: Turn,
  status: z.enum(["active", "ceasefire", "ended"]),
  endedTurn: Turn.optional(),
});
export type War = z.infer<typeof WarSchema>;

export const CeasefireSchema = z.object({
  id: Id,
  warId: Id,
  parties: z.tuple([Id, Id]),
  createdTurn: Turn,
  expiresTurn: Turn.nullable(),
  status: z.enum(["active", "expired", "broken"]),
});
export type Ceasefire = z.infer<typeof CeasefireSchema>;

// ---- memory / knowledge -----------------------------------------------------
export const MemorySchema = z.object({
  id: Id,
  turn: Turn,
  /** subjects[0] is the actor, subjects[1] (if any) the target. */
  subjects: z.array(Id).min(1),
  kind: z.string(),
  summary: z.string(),
  importance: z.number().int().min(1).max(5),
  visibleTo: z.array(Id),
  secret: z.boolean(),
});
export type MemoryEntry = z.infer<typeof MemorySchema>;

export const KnowledgeSchema = z.object({
  observer: Id,
  subject: Id,
  topic: z.string(),
  level: z.enum(["known", "suspected", "unknown"]),
  confidence: z.number().int().min(0).max(100),
  turn: Turn,
});
export type KnowledgeItem = z.infer<typeof KnowledgeSchema>;

// ---- state ------------------------------------------------------------------
export const DiplomacyStateSchema = z.object({
  turn: Turn,
  nextId: z.number().int().min(1),
  empires: z.record(z.string(), EmpireSchema),
  /** Keyed "from>to"; missing = all zeros. */
  relationships: z.record(z.string(), RelationshipSchema),
  treaties: z.record(z.string(), TreatySchema),
  alliances: z.record(z.string(), AllianceSchema),
  coalitions: z.record(z.string(), CoalitionSchema),
  messages: z.array(MessageSchema),
  proposals: z.record(z.string(), ProposalSchema),
  negotiations: z.record(z.string(), NegotiationSchema),
  wars: z.record(z.string(), WarSchema),
  ceasefires: z.record(z.string(), CeasefireSchema),
  memory: z.array(MemorySchema),
  knowledge: z.array(KnowledgeSchema),
});
export type DiplomacyState = z.infer<typeof DiplomacyStateSchema>;

export function newState(empires: Empire[] = []): DiplomacyState {
  return {
    turn: 0,
    nextId: 1,
    empires: Object.fromEntries(
      empires.map((e) => [e.id, EmpireSchema.parse(e)]),
    ),
    relationships: {},
    treaties: {},
    alliances: {},
    coalitions: {},
    messages: [],
    proposals: {},
    negotiations: {},
    wars: {},
    ceasefires: {},
    memory: [],
    knowledge: [],
  };
}

export function allocId(s: DiplomacyState, prefix: string): string {
  return `${prefix}${s.nextId++}`;
}

export const empireIds = (s: DiplomacyState) => Object.keys(s.empires).sort();

export function mkEvent(
  type: DiplomacyEvent["type"],
  turn: number,
  actor: string,
  target: string,
  opts: { secret?: boolean; witnesses?: string[]; summary?: string } = {},
): DiplomacyEvent {
  return {
    type,
    turn,
    actor,
    target,
    secret: opts.secret ?? false,
    witnesses: opts.witnesses ?? [],
    ...(opts.summary ? { summary: opts.summary } : {}),
  };
}
