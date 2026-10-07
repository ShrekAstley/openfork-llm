// @vitest-environment node
import { describe, expect, test } from "vitest";
import * as Alliances from "../packages/brain-host/src/diplomacy/alliances";
import { DiplomacyManager } from "../packages/brain-host/src/diplomacy/DiplomacyManager";
import { validateIntent } from "../packages/brain-host/src/diplomacy/intents";
import * as Memory from "../packages/brain-host/src/diplomacy/memory";
import * as Negotiations from "../packages/brain-host/src/diplomacy/negotiation";
import { getRelationship } from "../packages/brain-host/src/diplomacy/relationships";
import { mkEvent } from "../packages/brain-host/src/diplomacy/schemas";
import * as Treaties from "../packages/brain-host/src/diplomacy/treaties";

const empires = ["A", "B", "C", "D"].map((id) => ({
  id,
  name: `Empire ${id}`,
  personality: "",
}));
const make = () => new DiplomacyManager(empires);
const lastTreaty = (dm: DiplomacyManager) =>
  Object.keys(dm.state.treaties).pop()!;
const rel = (dm: DiplomacyManager, from: string, to: string) =>
  getRelationship(dm.state, from, to);

function allied(dm: DiplomacyManager, a: string, b: string) {
  const al = Alliances.create(dm.state, 1, a, [b]);
  Alliances.accept(dm.state, 1, al.id, b);
  return al;
}

describe("alliances", () => {
  test("create, invite, accept, join by application, leave, collapse", () => {
    const dm = make();
    const s = dm.state;
    const al = Alliances.create(s, 1, "A", ["B"]);
    expect(al.status).toBe("proposed");
    const evs = Alliances.accept(s, 2, al.id, "B");
    expect(s.alliances[al.id].status).toBe("active");
    expect(s.alliances[al.id].members).toEqual(["A", "B"]);
    dm.ingest(evs[0]);
    expect(rel(dm, "A", "B").trust).toBeGreaterThan(0);

    Alliances.requestJoin(s, al.id, "C");
    expect(s.alliances[al.id].applicants).toEqual(["C"]);
    Alliances.approve(s, 3, al.id, "A", "C");
    expect(s.alliances[al.id].members).toEqual(["A", "B", "C"]);

    Alliances.leave(s, 4, al.id, "C");
    expect(s.alliances[al.id].status).toBe("active");
    Alliances.leave(s, 5, al.id, "B");
    expect(s.alliances[al.id].status).toBe("collapsed");
  });

  test("reject invitation; modify terms", () => {
    const dm = make();
    const al = Alliances.create(dm.state, 1, "A", ["B"]);
    Alliances.reject(dm.state, al.id, "B");
    expect(dm.state.alliances[al.id].invited).toEqual([]);
    Alliances.modifyTerms(dm.state, al.id, "A", { trade_bonus: true });
    expect(dm.state.alliances[al.id].terms.trade_bonus).toBe(true);
    expect(() => Alliances.modifyTerms(dm.state, al.id, "C", {})).toThrow();
  });

  test("obligations only list who is obligated and never act", () => {
    const dm = make();
    const al = allied(dm, "A", "B");
    const before = JSON.stringify(dm.state);
    const attack = mkEvent("attack", 3, "C", "B");
    expect(Alliances.obligations(dm.state, al.id, attack)).toEqual(["A"]);
    expect(JSON.stringify(dm.state)).toBe(before);
    // member attacking member: nobody is obligated
    expect(
      Alliances.obligations(dm.state, al.id, mkEvent("attack", 3, "A", "B")),
    ).toEqual([]);
    Alliances.modifyTerms(dm.state, al.id, "A", { mutual_defense: false });
    expect(Alliances.obligations(dm.state, al.id, attack)).toEqual([]);
  });

  test("coalitions are independent of alliances", () => {
    const dm = make();
    const c = Alliances.formCoalition(
      dm.state,
      1,
      "Stop C",
      ["A", "B"],
      "C grows",
    );
    Alliances.joinCoalition(dm.state, c.id, "D");
    expect(dm.state.coalitions[c.id].members).toEqual(["A", "B", "D"]);
    Alliances.leaveCoalition(dm.state, c.id, "D");
    expect(dm.state.coalitions[c.id].status).toBe("active");
    Alliances.leaveCoalition(dm.state, c.id, "B");
    expect(dm.state.coalitions[c.id].status).toBe("dissolved");
    expect(Object.keys(dm.state.alliances)).toEqual([]);
  });
});

describe("treaties", () => {
  test("accept, reject, withdraw, expire", () => {
    const dm = make();
    const s = dm.state;
    const t1 = Treaties.propose(s, 1, "A", ["B"], "trade", {
      duration_turns: 10,
    });
    expect(() => Treaties.accept(s, 2, t1.id, "A")).toThrow();
    const evs = Treaties.accept(s, 2, t1.id, "B");
    expect(evs[0].type).toBe("treaty_signed");
    expect(s.treaties[t1.id]).toMatchObject({
      status: "active",
      expiresTurn: 12,
    });

    const t2 = Treaties.propose(s, 1, "A", ["C"], "non_aggression");
    Treaties.reject(s, t2.id, "C");
    expect(s.treaties[t2.id].status).toBe("rejected");

    const t3 = Treaties.propose(s, 1, "A", ["D"], "non_aggression");
    Treaties.withdraw(s, t3.id, "A");
    expect(s.treaties[t3.id].status).toBe("withdrawn");

    const t4 = Treaties.propose(s, 1, "C", ["D"], "custom"); // lapses at 6
    expect(Treaties.expire(s, 5)).toEqual([]);
    expect(s.treaties[t4.id].status).toBe("proposed");
    expect(Treaties.expire(s, 6)).toEqual([]);
    expect(s.treaties[t4.id].status).toBe("expired");

    const honored = Treaties.expire(s, 12);
    expect(s.treaties[t1.id].status).toBe("expired");
    expect(honored.map((e) => e.type)).toEqual([
      "treaty_honored",
      "treaty_honored",
    ]);
  });

  test("violation detection and emitted events", () => {
    const dm = make();
    const t = Treaties.propose(dm.state, 1, "A", ["B"], "non_aggression");
    Treaties.accept(dm.state, 1, t.id, "B");
    const attack = mkEvent("attack", 2, "A", "B");
    expect(
      Treaties.detectViolations(dm.state, attack).map((x) => x.id),
    ).toEqual([t.id]);
    expect(
      Treaties.detectViolations(dm.state, mkEvent("attack", 2, "A", "C")),
    ).toEqual([]);
    const evs = Treaties.violate(dm.state, 2, t.id, "A");
    expect(evs).toMatchObject([
      { type: "treaty_broken", actor: "A", target: "B" },
    ]);
    expect(dm.state.treaties[t.id].status).toBe("violated");
  });
});

describe("events, betrayal and reputation", () => {
  test("aid raises receiver trust and giver reliability perception", () => {
    const dm = make();
    dm.ingest(mkEvent("aid_sent", 1, "A", "B"));
    expect(rel(dm, "B", "A").trust).toBe(10);
    expect(rel(dm, "B", "A").reliability).toBe(8);
    expect(rel(dm, "A", "B").trust).toBe(0);
    expect(rel(dm, "C", "A").respect).toBe(2); // public: C witnessed
  });

  test("attack after treaty and alliance: consequences, observer-specific", () => {
    const dm = make();
    const s = dm.state;
    const t = Treaties.propose(s, 1, "A", ["B"], "non_aggression");
    dm.ingest(Treaties.accept(s, 1, t.id, "B")[0]);
    allied(dm, "A", "B");
    const trustBefore = rel(dm, "B", "A").trust;
    dm.ingest(mkEvent("attack", 5, "A", "B"));

    expect(s.treaties[t.id].status).toBe("violated");
    expect(Object.values(s.alliances)[0].status).toBe("collapsed");
    const b = rel(dm, "B", "A");
    expect(b.trust).toBeLessThan(trustBefore - 60);
    expect(b.hostility).toBeGreaterThan(50);
    expect(b.fear).toBeGreaterThan(0);
    expect(b.grievance).toBeGreaterThan(50);
    expect(Object.values(s.wars)).toMatchObject([
      { aggressor: "A", defender: "B" },
    ]);

    // third party saw it publicly
    expect(rel(dm, "C", "A").trust).toBeLessThan(0);
    expect(Memory.reputation(s, "C", "A").betrayals).toBe(1);
    expect(Memory.reputation(s, "C", "A").treatiesBroken).toBe(1);
  });

  test("secret events leave no trace for outsiders", () => {
    const dm = make();
    dm.ingest(mkEvent("betrayal", 5, "A", "B", { secret: true }));
    expect(rel(dm, "B", "A").trust).toBeLessThan(0);
    expect(rel(dm, "C", "A").trust).toBe(0);
    expect(Memory.reputation(dm.state, "B", "A").betrayals).toBe(1);
    expect(Memory.reputation(dm.state, "C", "A").betrayals).toBe(0);
    expect(JSON.stringify(dm.observe("C"))).not.toContain("betrayal");
    expect(JSON.stringify(dm.observe("B"))).toContain("A betrayal B");
  });

  test("reputation differs between observers and has no global score", () => {
    const dm = make();
    dm.ingest(mkEvent("treaty_broken", 2, "A", "B", { secret: true }));
    dm.ingest(mkEvent("treaty_honored", 3, "A", "C"));
    dm.ingest(mkEvent("treaty_honored", 4, "A", "C"));
    const b = Memory.reputation(dm.state, "B", "A");
    const c = Memory.reputation(dm.state, "C", "A");
    expect([b.treatiesBroken, b.treatiesHonored]).toEqual([1, 2]); // B sees public honors too
    expect([c.treatiesBroken, c.treatiesHonored]).toEqual([0, 2]);
    expect(b.brokenRatePct).toBe(33);
    expect(c.brokenRatePct).toBe(0);
    expect(b.text).not.toBe(c.text);
    expect(Memory.reputation(dm.state, "D", "A").brokenRatePct).toBe(0);
  });

  test("recent* fields decay by 1 per turn, nothing else drifts", () => {
    const dm = make();
    dm.ingest(mkEvent("attack", 1, "A", "B"));
    const before = { ...rel(dm, "B", "A") };
    dm.advance(11);
    const after = rel(dm, "B", "A");
    expect(after.recentAggression).toBe(before.recentAggression - 11);
    expect({ ...after, recentAggression: 0 }).toEqual({
      ...before,
      recentAggression: 0,
    });
  });
});

describe("diplomatic memory", () => {
  const seeded = () => {
    const dm = make();
    for (let t = 1; t <= 6; t++)
      dm.ingest(mkEvent("trade", t, "A", "B", { secret: true })); // importance 2
    dm.ingest(mkEvent("attack", 7, "A", "B", { secret: true })); // importance 4
    return dm;
  };

  test("summarize compresses old low-importance entries", () => {
    const dm = seeded();
    const lines = Memory.summarize(dm.state, "B", "A", 3);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("older minor events");
    expect(lines.some((l) => l.includes("attack"))).toBe(true);
    expect(Memory.summarize(dm.state, "B", "A", 50)).toHaveLength(7);
    expect(Memory.summarize(dm.state, "C", "A", 50)).toEqual([]);
  });

  test("retrieveRelevant ranks by subject, kind, importance, recency", () => {
    const dm = seeded();
    dm.ingest(
      mkEvent("trade", 8, "C", "D", { witnesses: ["B"], secret: true }),
    );
    const r = Memory.retrieveRelevant(
      dm.state,
      "B",
      { subject: "A", kind: "trade" },
      3,
    );
    expect(r).toHaveLength(3);
    expect(r.every((m) => m.subjects.includes("A"))).toBe(true);
    // the attack outranks equal-subject trade entries on importance (4*10 vs 50+20)? kind match wins
    expect(r[0].kind).toBe("trade");
    expect(r[0].turn).toBe(6);
    const byAttack = Memory.retrieveRelevant(
      dm.state,
      "B",
      { subject: "A", kind: "attack" },
      1,
    );
    expect(byAttack[0].kind).toBe("attack");
    // D saw only the public C-D event, nothing about A
    expect(
      Memory.retrieveRelevant(dm.state, "D", { subject: "A" }, 5).every(
        (m) => !m.subjects.includes("A"),
      ),
    ).toBe(true);
  });

  test("prune keeps the bound, dropping low importance then oldest", () => {
    const dm = seeded();
    Memory.prune(dm.state, 3);
    expect(dm.state.memory).toHaveLength(3);
    expect(dm.state.memory.some((m) => m.kind === "attack")).toBe(true);
    expect(dm.state.memory.map((m) => m.turn)).toEqual(
      [5, 6, 7].sort((a, b) => a - b),
    );
  });
});

describe("negotiation", () => {
  test("counter then accept creates a real treaty; hidden when private", () => {
    const dm = make();
    const s = dm.state;
    const n = Negotiations.open(
      s,
      1,
      "A",
      "B",
      {
        type: "TREATY_PROPOSAL",
        treatyType: "trade",
        terms: { duration_turns: 5 },
      },
      { secret: true },
    );
    expect(Negotiations.visibleTo(n, "C")).toBe(false);
    expect(dm.observe("C").negotiations).toEqual([]);
    expect(dm.observe("A").negotiations).toHaveLength(1);
    expect(() => Negotiations.accept(s, 2, n.id, "A")).toThrow();
    Negotiations.counter(s, 2, n.id, "B", {
      type: "TREATY_PROPOSAL",
      treatyType: "trade",
      terms: { duration_turns: 8 },
    });
    expect(s.proposals[n.proposals[0]].status).toBe("countered");
    const r = dm.acceptNegotiation(3, n.id, "A");
    expect(s.negotiations[n.id].status).toBe("accepted");
    expect(s.treaties[r.treatyId!]).toMatchObject({
      type: "trade",
      status: "active",
      secret: true,
      expiresTurn: 11,
    });
    expect(JSON.stringify(dm.observe("C"))).not.toContain(r.treatyId!);
    expect(dm.observe("B").treaties).toHaveLength(1);
  });

  test("alliance proposal, rejection, timeout", () => {
    const dm = make();
    const s = dm.state;
    const n = Negotiations.open(s, 1, "A", "B", { type: "ALLIANCE" });
    const r = dm.acceptNegotiation(2, n.id, "B");
    expect(s.alliances[r.allianceId!].members).toEqual(["A", "B"]);

    const n2 = Negotiations.open(s, 2, "A", "C", { type: "PEACE" });
    Negotiations.reject(s, n2.id, "C");
    expect(s.negotiations[n2.id].status).toBe("rejected");

    const n3 = Negotiations.open(
      s,
      2,
      "A",
      "D",
      { type: "AID_REQUEST" },
      { ttl: 2 },
    );
    dm.advance(3);
    expect(s.negotiations[n3.id].status).toBe("open");
    dm.advance(4);
    expect(s.negotiations[n3.id].status).toBe("expired");
  });
});

describe("intents", () => {
  test("validation rejections are compact and specific", () => {
    const dm = make();
    const s = dm.state;
    const why = (e: string, i: unknown) => {
      const v = validateIntent(s, e, i);
      return v.ok ? "ok" : v.reason;
    };
    expect(why("Z", { type: "DECLARE_WAR", target: "A" })).toBe(
      "unknown_empire",
    );
    expect(why("A", { type: "DECLARE_WAR", target: "Q" })).toBe(
      "unknown_target",
    );
    expect(why("A", { type: "DECLARE_WAR", target: "A" })).toBe("self_target");
    expect(why("A", { type: "NOPE" })).toBe("invalid_intent");
    expect(why("A", { type: "OFFER_PEACE", target: "B" })).toBe("not_at_war");
    expect(why("A", { type: "ACCEPT_TREATY", treatyId: "t99" })).toBe(
      "unknown_treaty",
    );

    const t = Treaties.propose(s, 1, "A", ["B"], "trade");
    expect(why("A", { type: "ACCEPT_TREATY", treatyId: t.id })).toBe(
      "treaty_not_proposed_to_you",
    );
    expect(why("C", { type: "ACCEPT_TREATY", treatyId: t.id })).toBe(
      "treaty_not_proposed_to_you",
    );
    expect(why("B", { type: "ACCEPT_TREATY", treatyId: t.id })).toBe("ok");
    expect(why("B", { type: "BREAK_TREATY", treatyId: t.id })).toBe(
      "treaty_not_active",
    );
    expect(why("C", { type: "BREAK_TREATY", treatyId: t.id })).toBe(
      "not_a_party",
    );

    const sec = Treaties.propose(
      s,
      1,
      "A",
      ["B"],
      "trade",
      {},
      { secret: true },
    );
    expect(why("C", { type: "ACCEPT_TREATY", treatyId: sec.id })).toBe(
      "unknown_treaty",
    );

    const al = allied(dm, "A", "B");
    expect(why("A", { type: "FORM_ALLIANCE", target: "B" })).toBe(
      "already_allied",
    );
    expect(why("A", { type: "JOIN_ALLIANCE", allianceId: al.id })).toBe(
      "already_member",
    );
    expect(why("C", { type: "LEAVE_ALLIANCE", allianceId: al.id })).toBe(
      "not_a_member",
    );
    expect(
      why("C", { type: "SEND_AID", target: "A", resource: "gold", amount: 0 }),
    ).toBe("invalid_intent");
    expect(
      why("C", {
        type: "SHARE_INTELLIGENCE",
        target: "A",
        about: "A",
        claim: "x",
      }),
    ).toBe("subject_is_recipient");
    expect(why("C", { type: "SEND_DIPLOMATIC_MESSAGE", text: "hi" })).toBe(
      "unknown_target",
    );
    expect(
      why("C", {
        type: "SEND_DIPLOMATIC_MESSAGE",
        text: "hi",
        channel: "public",
      }),
    ).toBe("ok");
  });

  const submissions = () => [
    {
      empireId: "B",
      intents: [
        { type: "ACCEPT_TREATY", treatyId: "t1" },
        { type: "DECLARE_WAR", target: "B" },
      ],
    },
    {
      empireId: "A",
      intents: [
        { type: "PROPOSE_TREATY", target: "B", treatyType: "non_aggression" },
        { type: "SEND_DIPLOMATIC_MESSAGE", target: "B", text: "peace?" },
        { type: "FORM_ALLIANCE", target: "C" },
      ],
    },
  ];

  test("processIntents is canonical, mutates only via intents, and is deterministic", () => {
    const run = () => {
      const dm = make();
      const r = dm.processIntents(1, submissions());
      return { r, snap: dm.snapshot() };
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // A is processed before B, so B can accept A's treaty in the same turn
    expect(a.r.accepted.map((x) => `${x.empireId}${x.index}`)).toEqual([
      "A0",
      "A1",
      "A2",
      "B0",
    ]);
    expect(a.r.rejected).toMatchObject([
      { empireId: "B", index: 1, reason: "self_target" },
    ]);
    expect(a.snap.treaties.t1.status).toBe("active");
    expect(a.snap.messages).toHaveLength(1);
  });

  test("messages alone change no relationships", () => {
    const dm = make();
    dm.processIntents(1, [
      {
        empireId: "A",
        intents: [
          {
            type: "SEND_DIPLOMATIC_MESSAGE",
            target: "B",
            text: "I will crush you",
          },
        ],
      },
    ]);
    expect(dm.state.relationships).toEqual({});
  });

  test("breaking a treaty and attacking an ally are allowed and have consequences", () => {
    const dm = make();
    dm.processIntents(1, [
      {
        empireId: "A",
        intents: [
          { type: "PROPOSE_TREATY", target: "B", treatyType: "non_aggression" },
        ],
      },
    ]);
    dm.processIntents(1, [
      { empireId: "B", intents: [{ type: "ACCEPT_TREATY", treatyId: "t1" }] },
    ]);
    const r = dm.processIntents(2, [
      { empireId: "A", intents: [{ type: "BREAK_TREATY", treatyId: "t1" }] },
    ]);
    expect(r.rejected).toEqual([]);
    expect(dm.state.treaties.t1.status).toBe("violated");
    expect(rel(dm, "B", "A").reliability).toBeLessThan(-30);
    expect(Memory.reputation(dm.state, "C", "A").treatiesBroken).toBe(1);
  });

  test("peace treaty ends a war; ceasefire pauses it and breaks on attack", () => {
    const dm = make();
    dm.processIntents(1, [
      { empireId: "A", intents: [{ type: "DECLARE_WAR", target: "B" }] },
    ]);
    const war = Object.values(dm.state.wars)[0];
    expect(war.status).toBe("active");
    dm.processIntents(2, [
      {
        empireId: "B",
        intents: [
          {
            type: "OFFER_PEACE",
            target: "A",
            ceasefire: true,
            terms: { duration_turns: 5 },
          },
        ],
      },
    ]);
    dm.processIntents(2, [
      {
        empireId: "A",
        intents: [{ type: "ACCEPT_TREATY", treatyId: lastTreaty(dm) }],
      },
    ]);
    expect(war.status).toBe("ceasefire");
    dm.ingest(mkEvent("attack", 3, "A", "B"));
    expect(Object.values(dm.state.ceasefires)[0].status).toBe("broken");
    expect(war.status).toBe("active");
    dm.processIntents(4, [
      { empireId: "A", intents: [{ type: "OFFER_PEACE", target: "B" }] },
    ]);
    dm.processIntents(4, [
      {
        empireId: "B",
        intents: [{ type: "ACCEPT_TREATY", treatyId: lastTreaty(dm) }],
      },
    ]);
    expect(war.status).toBe("ended");
  });

  test("observe hides secret messages, treaties, intel; snapshot/restore roundtrips", () => {
    const dm = make();
    dm.processIntents(1, [
      {
        empireId: "A",
        intents: [
          { type: "SEND_DIPLOMATIC_MESSAGE", target: "B", text: "psst" },
          {
            type: "SEND_DIPLOMATIC_MESSAGE",
            text: "hello all",
            channel: "public",
          },
          {
            type: "PROPOSE_TREATY",
            target: "B",
            treatyType: "trade",
            secret: true,
          },
          {
            type: "SHARE_INTELLIGENCE",
            target: "B",
            about: "D",
            claim: "D arms up",
            confidence: 80,
          },
        ],
      },
    ]);
    const c = JSON.stringify(dm.observe("C"));
    expect(c).toContain("hello all");
    expect(c).not.toContain("psst");
    expect(c).not.toContain("trade");
    expect(c).not.toContain("D arms up");
    const b = dm.observe("B");
    expect(JSON.stringify(b)).toContain("psst");
    expect(b.treaties).toHaveLength(1);
    expect(b.knowledge).toMatchObject([
      { subject: "D", level: "suspected", confidence: 80 },
    ]);
    expect(b.relationships.A.trust).toBe(5);

    const snap = dm.snapshot();
    const copy = make();
    copy.restore(JSON.parse(JSON.stringify(snap)));
    expect(JSON.stringify(copy.snapshot())).toBe(JSON.stringify(snap));
    expect(JSON.stringify(copy.observe("B"))).toBe(
      JSON.stringify(dm.observe("B")),
    );
    // ids continue after restore
    copy.processIntents(2, [
      { empireId: "B", intents: [{ type: "ACCEPT_TREATY", treatyId: "t3" }] },
    ]);
    expect(copy.state.treaties.t3.status).toBe("active");
  });
});
