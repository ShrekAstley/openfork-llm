// One brain nation: notices events on the replica, decides when to think,
// asks the LLM, and turns the answer into validated engine intents. Never
// awaited by the turn loop; a stale, failed or cancelled answer changes
// nothing (the nation keeps doing whatever its last orders set in motion).
import type { Intent } from "@openfront/engine-api/Schemas";
import type { Game, Player } from "@openfront/engine/game/Game";
import { DecisionScheduler, Importance } from "./DecisionScheduler";
import type { DiplomacyManager } from "./diplomacy/DiplomacyManager";
import { mkEvent } from "./diplomacy/schemas";
import type { InferenceResult, LLMManager } from "./LLMManager";
import { buildObservation } from "./ObservationBuilder";
import { resolveAction, toolDefs } from "./Tools";
import type { ChatRequest } from "./types";

/** What later UI may show. Never the model's raw text (no chain-of-thought). */
export interface Decision {
  tick: number;
  objective: string;
  summary: string;
  actions: string[];
  rejected: string[];
}

export interface BrainWorld {
  game: Game;
  dm: DiplomacyManager;
  llm: LLMManager;
  submit: (intent: Intent) => Promise<void>;
  log: (line: string) => void;
}

export interface EmpireBrainOptions {
  name: string;
  personality: string;
  directives: string[];
  intervalTicks: number;
  maxAgeTicks: number;
  temperature: number;
  maxTokens: number;
  model?: string;
  budgetTokens?: number;
}

const MAX_EVENTS = 8;
const MAX_REJECTED = 5;
const MAX_HISTORY = 20;
const SYSTEM = (name: string) =>
  `You command the nation ${name} in OpenFront, a real-time territory strategy game. ` +
  "Each message is your current situation. Act only through the tools; use player names exactly as shown. " +
  "Call plan once with your objective and a one-line summary. No explanations.";

export class EmpireBrain {
  readonly scheduler: DecisionScheduler;
  revision = 0;
  busy = false;
  events: string[] = [];
  rejected: string[] = [];
  history: Decision[] = [];

  // Last seen replica state, diffed every step for event triggers.
  private attackers = new Set<string>();
  private attackIds = new Set<string>();
  private outgoingIds = new Set<string>();
  private requestors = new Set<string>();
  private allies = new Set<string>();
  private embargoers = new Set<string>();
  private tilesAtDecision = 0;
  private territoryNoted = false;

  constructor(readonly o: EmpireBrainOptions) {
    this.scheduler = new DecisionScheduler(o.intervalTicks);
  }

  me(game: Game): Player | undefined {
    return game.players().find((p) => p.name() === this.o.name);
  }

  isStale(worldTick: number, revision: number, nowTick: number): boolean {
    return (
      revision !== this.revision || nowTick - worldTick > this.o.maxAgeTicks
    );
  }

  private event(w: BrainWorld, imp: Importance, text: string) {
    this.events.push(`[${Math.floor(w.game.ticks() / 10)}s] ${text}`);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.scheduler.notify(imp);
    // A new threat makes any answer in flight obsolete.
    if (imp === Importance.CRITICAL) this.revision++;
  }

  /** Diff the replica against what we saw last step; raise event triggers. */
  observe(w: BrainWorld): void {
    const me = this.me(w.game);
    if (!me) return;
    const turn = Math.floor(w.game.ticks() / 10);

    const attacks = me.incomingAttacks();
    const attackers = new Set<string>();
    for (const a of attacks) {
      const by = a.attacker().name();
      attackers.add(by);
      if (this.attackIds.has(a.id())) continue;
      w.dm.ingest(mkEvent("attack", turn, by, me.name()));
      this.event(
        w,
        this.attackers.has(by) ? Importance.HIGH : Importance.CRITICAL,
        `${by} attacked you.`,
      );
    }
    this.attackIds = new Set(attacks.map((a) => a.id()));
    this.attackers = attackers;

    const outgoing = me.outgoingAttacks();
    for (const a of outgoing) {
      const t = a.target();
      if (!this.outgoingIds.has(a.id()) && t.isPlayer())
        w.dm.ingest(mkEvent("attack", turn, me.name(), t.name()));
    }
    this.outgoingIds = new Set(outgoing.map((a) => a.id()));

    const requestors = new Set(
      me.incomingAllianceRequests().map((r) => r.requestor().name()),
    );
    for (const r of requestors)
      if (!this.requestors.has(r))
        this.event(w, Importance.HIGH, `${r} requested an alliance.`);
    this.requestors = requestors;

    const allies = new Set(me.allies().map((p) => p.name()));
    for (const a of allies)
      if (!this.allies.has(a))
        this.event(w, Importance.MEDIUM, `Alliance with ${a} formed.`);
    for (const a of this.allies)
      if (!allies.has(a))
        this.event(w, Importance.HIGH, `Alliance with ${a} ended.`);
    this.allies = allies;

    const embargoers = new Set(
      w.game
        .players()
        .filter((p) => p !== me && p.hasEmbargoAgainst(me))
        .map((p) => p.name()),
    );
    for (const e of embargoers)
      if (!this.embargoers.has(e))
        this.event(w, Importance.HIGH, `${e} embargoed you (hostile).`);
    for (const e of this.embargoers)
      if (!embargoers.has(e))
        this.event(w, Importance.MEDIUM, `${e} lifted their embargo.`);
    this.embargoers = embargoers;

    const tiles = me.numTilesOwned();
    if (!this.territoryNoted && this.tilesAtDecision > 0) {
      const change = (tiles - this.tilesAtDecision) / this.tilesAtDecision;
      if (change <= -0.2 || change >= 0.5) {
        this.territoryNoted = true;
        this.event(
          w,
          change < 0 ? Importance.HIGH : Importance.MEDIUM,
          `Territory ${change < 0 ? "lost" : "gained"} ${Math.round(Math.abs(change) * 100)}% since last decision.`,
        );
      }
    }
  }

  /** Wake if due; fire the request and return without waiting for it. */
  maybeDecide(w: BrainWorld): Promise<void> | null {
    const me = this.me(w.game);
    if (!me || !me.isAlive() || w.game.inSpawnPhase()) return null;
    const wake = this.scheduler.poll(w.game.ticks(), this.busy);
    if (wake === null) return null;

    const last = this.history[this.history.length - 1];
    const observation = buildObservation({
      game: w.game,
      me,
      diplomacy: w.dm.observe(me.name()),
      personality: this.o.personality,
      directives: this.o.directives,
      events: this.events,
      rejected: this.rejected,
      lastDecision: last && `${last.objective}: ${last.summary}`,
      budgetTokens: this.o.budgetTokens,
    });
    this.rejected = [];
    this.tilesAtDecision = me.numTilesOwned();
    this.territoryNoted = false;

    const req: ChatRequest = {
      messages: [
        { role: "system", content: SYSTEM(this.o.name) },
        { role: "user", content: observation },
      ],
      tools: toolDefs(),
      temperature: this.o.temperature,
      maxTokens: this.o.maxTokens,
      model: this.o.model,
    };
    this.busy = true;
    const tick = w.game.ticks();
    return w.llm
      .submit(
        {
          empireId: this.o.name,
          worldTick: tick,
          simTime: tick / 10,
          empireRevision: this.revision,
          priority: wake,
        },
        req,
      )
      .promise.then((r) => this.apply(w, r))
      .catch((e) => w.log(`${this.o.name}: ${String(e)}`))
      .finally(() => {
        this.busy = false;
      });
  }

  private async apply(w: BrainWorld, r: InferenceResult): Promise<void> {
    if (r.status !== "ok") {
      w.log(
        `${this.o.name}: ${r.status}${r.error ? ` (${r.error.kind}: ${r.error.message})` : ""}, keeping prior orders`,
      );
      return;
    }
    const me = this.me(w.game);
    if (!me) return;
    const d: Decision = {
      tick: w.game.ticks(),
      objective: "",
      summary: "",
      actions: [],
      rejected: [],
    };
    const intents: Intent[] = [];
    for (const call of r.result.toolCalls) {
      const a = resolveAction(call, {
        game: w.game,
        me,
        dm: w.dm,
        turn: Math.floor(w.game.ticks() / 10),
      });
      if (a.kind === "plan") {
        d.objective = a.objective;
        d.summary = a.summary;
      } else if (a.kind === "rejected") d.rejected.push(a.text);
      else {
        d.actions.push(a.label);
        intents.push(...a.engine);
      }
    }
    for (const intent of intents) {
      try {
        await w.submit(intent);
      } catch (e) {
        d.rejected.push(
          `ACTION REJECTED ${intent.type}: ${String((e as Error).message ?? e).slice(0, 160)}`,
        );
      }
    }
    this.rejected = [...this.rejected, ...d.rejected].slice(-MAX_REJECTED);
    this.history.push(d);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    w.log(
      `${this.o.name} @${d.tick}: ${d.objective || "-"} | ${d.summary || "-"} | do ${JSON.stringify(d.actions)}${d.rejected.length ? ` | rejected ${JSON.stringify(d.rejected)}` : ""}`,
    );
  }
}
