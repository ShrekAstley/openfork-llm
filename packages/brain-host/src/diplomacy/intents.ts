import { z } from "zod";
import * as Alliances from "./alliances";
import {
  AllianceTermsSchema,
  type DiplomacyState,
  TREATY_TYPES,
  TreatyTermsSchema,
} from "./schemas";
import { warBetween } from "./wars";

const Id = z.string().min(1);
const Amount = z.number().int().positive();

export const IntentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SEND_DIPLOMATIC_MESSAGE"),
    /** Required for private messages. */
    target: Id.optional(),
    text: z.string().min(1).max(1000),
    channel: z.enum(["public", "private"]).default("private"),
    proposalId: Id.optional(),
  }),
  z.object({
    type: z.literal("PROPOSE_TREATY"),
    target: Id,
    treatyType: z.enum(TREATY_TYPES),
    terms: TreatyTermsSchema.partial().default({}),
    secret: z.boolean().default(false),
  }),
  z.object({ type: z.literal("ACCEPT_TREATY"), treatyId: Id }),
  z.object({ type: z.literal("REJECT_TREATY"), treatyId: Id }),
  z.object({ type: z.literal("DECLARE_WAR"), target: Id }),
  z.object({
    type: z.literal("OFFER_PEACE"),
    target: Id,
    ceasefire: z.boolean().default(false),
    terms: TreatyTermsSchema.partial().default({}),
  }),
  z.object({
    type: z.literal("FORM_ALLIANCE"),
    target: Id,
    terms: AllianceTermsSchema.partial().default({}),
    /** Invite target into this existing alliance (or approve its application). */
    allianceId: Id.optional(),
  }),
  z.object({ type: z.literal("JOIN_ALLIANCE"), allianceId: Id }),
  z.object({ type: z.literal("LEAVE_ALLIANCE"), allianceId: Id }),
  z.object({ type: z.literal("BREAK_TREATY"), treatyId: Id }),
  z.object({
    type: z.literal("REQUEST_AID"),
    target: Id,
    resource: z.string().min(1),
    amount: Amount,
  }),
  z.object({
    type: z.literal("SEND_AID"),
    target: Id,
    resource: z.string().min(1),
    amount: Amount,
  }),
  z.object({
    type: z.literal("SHARE_INTELLIGENCE"),
    target: Id,
    /** The empire the intelligence is about. */
    about: Id,
    claim: z.string().min(1).max(500),
    level: z.enum(["known", "suspected"]).default("suspected"),
    confidence: z.number().int().min(0).max(100).default(50),
    secret: z.boolean().default(true),
  }),
]);
export type DiplomaticIntent = z.infer<typeof IntentSchema>;

export type Validation =
  | { ok: true }
  | { ok: false; reason: string; details: Record<string, string | number> };

const no = (
  reason: string,
  details: Record<string, string | number> = {},
): Validation => ({ ok: false, reason, details });
const OK: Validation = { ok: true };

export function validateIntent(
  s: DiplomacyState,
  empireId: string,
  raw: unknown,
): Validation {
  if (!s.empires[empireId]) return no("unknown_empire", { empire: empireId });
  const parsed = IntentSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return no("invalid_intent", { path: i.path.join("."), message: i.message });
  }
  const i = parsed.data;

  const target = (id: string | undefined): Validation => {
    if (!id || !s.empires[id])
      return no("unknown_target", { target: id ?? "" });
    if (id === empireId) return no("self_target", { target: id });
    return OK;
  };
  const treaty = (id: string) => {
    const t = s.treaties[id];
    // A secret treaty does not exist for non-parties.
    return t && (!t.secret || t.parties.includes(empireId)) ? t : undefined;
  };
  const alliance = (id: string) => {
    const a = s.alliances[id];
    return a && a.status !== "collapsed" ? a : undefined;
  };

  switch (i.type) {
    case "SEND_DIPLOMATIC_MESSAGE": {
      if (i.channel === "private" || i.target) {
        const v = target(i.target);
        if (!v.ok) return v;
      }
      if (i.proposalId && !s.proposals[i.proposalId])
        return no("unknown_proposal", { proposalId: i.proposalId });
      return OK;
    }
    case "PROPOSE_TREATY":
    case "REQUEST_AID":
    case "SEND_AID":
    case "DECLARE_WAR":
    case "OFFER_PEACE": {
      const v = target(i.target);
      if (!v.ok) return v;
      if (
        i.type === "DECLARE_WAR" &&
        warBetween(s, empireId, i.target)?.status === "active"
      )
        return no("already_at_war", { target: i.target });
      if (i.type === "OFFER_PEACE" && !warBetween(s, empireId, i.target))
        return no("not_at_war", { target: i.target });
      return OK;
    }
    case "ACCEPT_TREATY":
    case "REJECT_TREATY": {
      const t = treaty(i.treatyId);
      if (!t) return no("unknown_treaty", { treatyId: i.treatyId });
      if (t.status !== "proposed")
        return no("treaty_not_proposed", { treatyId: t.id, status: t.status });
      if (t.proposer === empireId || !t.parties.includes(empireId))
        return no("treaty_not_proposed_to_you", { treatyId: t.id });
      return OK;
    }
    case "BREAK_TREATY": {
      const t = treaty(i.treatyId);
      if (!t) return no("unknown_treaty", { treatyId: i.treatyId });
      if (!t.parties.includes(empireId))
        return no("not_a_party", { treatyId: t.id });
      if (t.status !== "active")
        return no("treaty_not_active", { treatyId: t.id, status: t.status });
      return OK;
    }
    case "FORM_ALLIANCE": {
      const v = target(i.target);
      if (!v.ok) return v;
      if (Alliances.sharedAlliance(s, empireId, i.target))
        return no("already_allied", { target: i.target });
      if (i.allianceId) {
        const a = alliance(i.allianceId);
        if (!a) return no("unknown_alliance", { allianceId: i.allianceId });
        if (!a.members.includes(empireId))
          return no("not_a_member", { allianceId: a.id });
        if (a.members.includes(i.target))
          return no("already_member", { target: i.target });
      }
      return OK;
    }
    case "JOIN_ALLIANCE": {
      const a = alliance(i.allianceId);
      if (!a) return no("unknown_alliance", { allianceId: i.allianceId });
      if (a.members.includes(empireId))
        return no("already_member", { allianceId: a.id });
      return OK;
    }
    case "LEAVE_ALLIANCE": {
      const a = alliance(i.allianceId);
      if (!a) return no("unknown_alliance", { allianceId: i.allianceId });
      if (!a.members.includes(empireId))
        return no("not_a_member", { allianceId: a.id });
      return OK;
    }
    case "SHARE_INTELLIGENCE": {
      const v = target(i.target);
      if (!v.ok) return v;
      if (!s.empires[i.about]) return no("unknown_subject", { about: i.about });
      if (i.about === i.target)
        return no("subject_is_recipient", { about: i.about });
      return OK;
    }
  }
}
