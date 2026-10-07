import * as Alliances from "./alliances";
import { type DiplomaticIntent, IntentSchema, validateIntent } from "./intents";
import * as Memory from "./memory";
import * as Negotiations from "./negotiation";
import { visibleTo as negotiationVisibleTo } from "./negotiation";
import { applyEvent, decayRecent } from "./relationships";
import {
  allocId,
  type DiplomacyEvent,
  type DiplomacyState,
  DiplomacyStateSchema,
  type Empire,
  empireIds,
  mkEvent,
  newState,
  type Treaty,
} from "./schemas";
import * as Treaties from "./treaties";
import * as Wars from "./wars";

export const MAX_MESSAGES = 200;
export const MAX_KNOWLEDGE = 200;

export interface TurnSubmission {
  empireId: string;
  intents: unknown[];
}
export interface TurnResult {
  turn: number;
  accepted: { empireId: string; index: number; intent: DiplomaticIntent }[];
  rejected: {
    empireId: string;
    index: number;
    intent: unknown;
    reason: string;
    details: Record<string, string | number>;
  }[];
}

/** Facade: owns the state and wires every manager module together. */
export class DiplomacyManager {
  state: DiplomacyState;

  constructor(empires: Empire[] = []) {
    this.state = newState(empires);
  }

  // ---- events: relationships + memory + consequences -----------------------
  /** Applies an event and every consequence it triggers (violations, betrayal). */
  ingest(first: DiplomacyEvent): void {
    const s = this.state;
    const queue = [first];
    for (let i = 0; i < queue.length; i++) {
      const e = queue[i];
      applyEvent(s, e);
      Memory.rememberEvent(s, e);
      if (e.type === "attack" || e.type === "war_declared") {
        Wars.breakCeasefire(s, e.actor, e.target);
        Wars.startWar(s, e.turn, e.actor, e.target);
        for (const t of Treaties.detectViolations(s, e))
          queue.push(...Treaties.violate(s, e.turn, t.id, e.actor));
        queue.push(...Alliances.betray(s, e.turn, e.actor, e.target));
      }
    }
  }

  private ingestAll(evs: DiplomacyEvent[]) {
    for (const e of evs) this.ingest(e);
  }

  private activated(turn: number, t: Treaty) {
    const [a, b] = t.parties;
    const war = Wars.warBetween(this.state, a, b);
    if (!war) return;
    if (t.type === "peace") Wars.endWar(turn, war);
    else if (t.type === "ceasefire")
      Wars.startCeasefire(this.state, turn, war, t);
  }

  /** Accepts the latest proposal of a negotiation, creating the real object. */
  acceptNegotiation(turn: number, id: string, by: string) {
    const r = Negotiations.accept(this.state, turn, id, by);
    this.ingestAll(r.events);
    if (r.treatyId) this.activated(turn, this.state.treaties[r.treatyId]);
    return r;
  }

  /** Moves time forward: expiry, timeouts and the documented recent* decay. */
  advance(turn: number): void {
    const s = this.state;
    if (turn <= s.turn) return;
    decayRecent(s, turn - s.turn);
    s.turn = turn;
    this.ingestAll(Treaties.expire(s, turn));
    Wars.expireCeasefires(s, turn);
    Negotiations.timeout(s, turn);
  }

  // ---- intents -------------------------------------------------------------
  recordTurn(turn: number, empireId: string, intents: unknown[]): TurnResult {
    this.advance(turn);
    const out: TurnResult = { turn, accepted: [], rejected: [] };
    intents.forEach((raw, index) => {
      const v = validateIntent(this.state, empireId, raw);
      if (!v.ok) {
        out.rejected.push({
          empireId,
          index,
          intent: raw,
          reason: v.reason,
          details: v.details,
        });
        return;
      }
      const intent = IntentSchema.parse(raw);
      this.apply(turn, empireId, intent);
      out.accepted.push({ empireId, index, intent });
    });
    return out;
  }

  /** Canonical order: empire id, then original index. Same input, same JSON. */
  processIntents(turn: number, submissions: TurnSubmission[]): TurnResult {
    const out: TurnResult = { turn, accepted: [], rejected: [] };
    const sorted = [...submissions].sort((a, b) =>
      a.empireId < b.empireId ? -1 : a.empireId > b.empireId ? 1 : 0,
    );
    for (const sub of sorted) {
      const r = this.recordTurn(turn, sub.empireId, sub.intents);
      out.accepted.push(...r.accepted);
      out.rejected.push(...r.rejected);
    }
    return out;
  }

  private apply(turn: number, me: string, i: DiplomaticIntent): void {
    const s = this.state;
    switch (i.type) {
      case "SEND_DIPLOMATIC_MESSAGE":
        s.messages.push({
          id: allocId(s, "msg"),
          turn,
          from: me,
          ...(i.target ? { to: i.target } : {}),
          text: i.text,
          channel: i.channel,
          secret: i.channel === "private",
          ...(i.proposalId ? { proposalId: i.proposalId } : {}),
        });
        if (s.messages.length > MAX_MESSAGES)
          s.messages = s.messages.slice(-MAX_MESSAGES);
        return;
      case "PROPOSE_TREATY":
        Treaties.propose(s, turn, me, [i.target], i.treatyType, i.terms, {
          secret: i.secret,
        });
        return;
      case "ACCEPT_TREATY": {
        this.ingestAll(Treaties.accept(s, turn, i.treatyId, me));
        this.activated(turn, s.treaties[i.treatyId]);
        return;
      }
      case "REJECT_TREATY":
        Treaties.reject(s, i.treatyId, me);
        return;
      case "DECLARE_WAR":
        this.ingest(mkEvent("war_declared", turn, me, i.target));
        return;
      case "OFFER_PEACE":
        Treaties.propose(
          s,
          turn,
          me,
          [i.target],
          i.ceasefire ? "ceasefire" : "peace",
          i.terms,
        );
        return;
      case "FORM_ALLIANCE": {
        const a = i.allianceId ? s.alliances[i.allianceId] : undefined;
        if (!a) Alliances.create(s, turn, me, [i.target], i.terms);
        else if (a.applicants.includes(i.target))
          this.ingestAll(Alliances.approve(s, turn, a.id, me, i.target));
        else Alliances.invite(s, a.id, me, i.target);
        return;
      }
      case "JOIN_ALLIANCE": {
        const a = s.alliances[i.allianceId];
        if (a.invited.includes(me))
          this.ingestAll(Alliances.accept(s, turn, a.id, me));
        else Alliances.requestJoin(s, a.id, me);
        return;
      }
      case "LEAVE_ALLIANCE":
        this.ingestAll(Alliances.leave(s, turn, i.allianceId, me));
        return;
      case "BREAK_TREATY": {
        const t = s.treaties[i.treatyId];
        const evs = Treaties.violate(s, turn, t.id, me);
        if (t.type === "ceasefire")
          for (const p of t.parties) Wars.breakCeasefire(s, me, p);
        this.ingestAll(evs);
        return;
      }
      case "REQUEST_AID":
        Negotiations.open(s, turn, me, i.target, {
          type: "AID_REQUEST",
          terms: {
            resource_transfer: {
              from: i.target,
              to: me,
              resource: i.resource,
              amount: i.amount,
              per_turn: false,
            },
          },
        });
        return;
      case "SEND_AID":
        this.ingest(
          mkEvent("aid_sent", turn, me, i.target, {
            summary: `${me} sent ${i.amount} ${i.resource} to ${i.target}`,
          }),
        );
        return;
      case "SHARE_INTELLIGENCE":
        s.knowledge.push({
          observer: i.target,
          subject: i.about,
          topic: i.claim,
          level: i.level,
          confidence: i.confidence,
          turn,
        });
        if (s.knowledge.length > MAX_KNOWLEDGE)
          s.knowledge = s.knowledge.slice(-MAX_KNOWLEDGE);
        this.ingest(
          mkEvent("intelligence_shared", turn, me, i.target, {
            secret: i.secret,
            summary: `${me} told ${i.target} about ${i.about}: ${i.claim}`,
          }),
        );
        return;
    }
  }

  // ---- persistence ----------------------------------------------------------
  snapshot(): DiplomacyState {
    return JSON.parse(JSON.stringify(this.state));
  }

  restore(snapshot: unknown): void {
    this.state = DiplomacyStateSchema.parse(snapshot);
  }

  // ---- fog-of-war view for an LLM prompt -------------------------------------
  observe(me: string, opts: { messages?: number; memoryLines?: number } = {}) {
    const s = this.state;
    const self = s.empires[me];
    if (!self) throw new Error(`unknown empire ${me}`);
    const others = empireIds(s).filter((id) => id !== me);
    const party = (parties: string[]) => parties.includes(me);
    const memoryLines = opts.memoryLines ?? 3;
    return {
      empire: { id: me, name: self.name, personality: self.personality },
      turn: s.turn,
      others: others.map((id) => ({ id, name: s.empires[id].name })),
      relationships: Object.fromEntries(
        others
          .map((id) => [id, s.relationships[`${me}>${id}`]] as const)
          .filter(([, r]) => r)
          .map(([id, r]) => {
            const dims: Record<string, unknown> = { ...r };
            delete dims.from;
            delete dims.to;
            return [id, dims];
          }),
      ),
      treaties: Object.values(s.treaties)
        .filter(
          (t) =>
            (t.status === "active" || t.status === "proposed") &&
            (!t.secret || party(t.parties)),
        )
        .map((t) => ({
          id: t.id,
          type: t.type,
          parties: t.parties,
          proposer: t.proposer,
          status: t.status,
          expiresTurn: t.expiresTurn,
          terms: t.terms,
          secret: t.secret,
        })),
      alliances: Object.values(s.alliances)
        .filter((a) => a.status !== "collapsed")
        .map((a) => ({
          id: a.id,
          members: a.members,
          status: a.status,
          terms: a.terms,
          ...(party(a.members) || a.invited.includes(me)
            ? { invited: a.invited, applicants: a.applicants }
            : {}),
        })),
      coalitions: Object.values(s.coalitions)
        .filter((c) => c.status === "active")
        .map((c) => ({
          id: c.id,
          name: c.name,
          members: c.members,
          reason: c.reason,
        })),
      wars: Object.values(s.wars)
        .filter((w) => w.status !== "ended")
        .map((w) => ({
          id: w.id,
          aggressor: w.aggressor,
          defender: w.defender,
          status: w.status,
        })),
      negotiations: Object.values(s.negotiations)
        .filter((n) => n.status === "open" && negotiationVisibleTo(n, me))
        .map((n) => {
          const p = s.proposals[n.proposals[n.proposals.length - 1]];
          return {
            id: n.id,
            parties: n.parties,
            openedTurn: n.openedTurn,
            lastTurn: n.lastTurn,
            latest: {
              type: p.type,
              from: p.from,
              to: p.to,
              treatyType: p.treatyType,
              terms: p.terms,
              expiresTurn: p.expiresTurn,
            },
          };
        }),
      messages: s.messages
        .filter((m) => !m.secret || m.from === me || m.to === me)
        .slice(-(opts.messages ?? 10))
        .map((m) => ({
          id: m.id,
          turn: m.turn,
          from: m.from,
          to: m.to,
          channel: m.channel,
          text: m.text,
          proposalId: m.proposalId,
        })),
      memory: Object.fromEntries(
        others.map((id) => [id, Memory.summarize(s, me, id, memoryLines)]),
      ),
      reputation: Object.fromEntries(
        others.map((id) => [id, Memory.reputation(s, me, id).text]),
      ),
      knowledge: s.knowledge.filter((k) => k.observer === me),
    };
  }
}
