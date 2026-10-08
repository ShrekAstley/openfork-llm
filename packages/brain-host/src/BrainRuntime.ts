// The Brain Host loop for one game: poll the server's turn log, replay it on a
// headless GameRunner (the observation replica), let each brain nation notice
// events and, when due, ask the LLM. The loop never waits on the LLM.
import type { GameStartInfo } from "@openfront/engine-api/Schemas";
import {
  createGameRunner,
  type GameRunner,
} from "@openfront/engine/GameRunner";
import {
  type GameMapLoader,
  loadMapFiles,
} from "@openfront/shared/GameMapLoader";
import { type BrainConfig, isEmpireEnabled, modelFor } from "./BrainConfig";
import {
  BRAIN_STATE_VERSION,
  type BrainState,
  ResumeMismatchError,
} from "./BrainState";
import { DecisionLog } from "./DecisionLog";
import { DiplomacyManager } from "./diplomacy/DiplomacyManager";
import { EmpireBrain } from "./EmpireBrain";
import {
  type EngineTarget,
  fetchTurns,
  submitEngineIntent,
} from "./EngineBridge";
import { LLMCache } from "./LLMCache";
import { LLMManager } from "./LLMManager";
import type { LLMProvider } from "./types";

const TICKS_PER_SECOND = 10; // ServerEnv.turnIntervalMs() = 100
const MAX_LAG_TURNS = 100; // ~10s of game time; a bigger poll batch means we're catching up

export interface RuntimeOptions {
  config: BrainConfig;
  provider: LLMProvider;
  server: Omit<EngineTarget, "nation">;
  maps: GameMapLoader;
  log?: (line: string) => void;
}

export class BrainRuntime {
  runner?: GameRunner;
  dm = new DiplomacyManager();
  brains: EmpireBrain[] = [];
  readonly llm: LLMManager;
  private decisions: DecisionLog;
  private nextTurn = 0;
  private inflight = new Set<Promise<void>>();
  private log: (line: string) => void;

  constructor(private o: RuntimeOptions) {
    this.log = o.log ?? ((l) => console.log(l));
    this.decisions = new DecisionLog(o.config.decisionLog);
    this.llm = new LLMManager(o.provider, {
      maxConcurrent: o.config.maxConcurrentRequests,
      seed: o.config.seed,
      residency: o.config.residency,
      unload: o.provider.unload?.bind(o.provider),
      cache: new LLMCache(o.config.cache, o.config.cacheFile),
      isStale: (m) => {
        const b = this.brains.find((x) => x.o.name === m.empireId);
        const now = this.runner?.game.ticks() ?? 0;
        return !b || b.isStale(m.worldTick, m.empireRevision, now);
      },
    });
  }

  private resumeFrom?: BrainState;
  private gameID?: string;

  /**
   * Continue from a saved state. Call before the first step: it is applied
   * when the game's start info arrives, and refused if it belongs to a
   * different game.
   */
  restore(state: BrainState): void {
    this.resumeFrom = state;
  }

  /** The state to save; null until the game has started. */
  snapshot(): BrainState | null {
    if (!this.runner) return null;
    return {
      version: BRAIN_STATE_VERSION,
      gameID: this.gameID!,
      savedAtTick: this.runner.game.ticks(),
      diplomacy: this.dm.snapshot(),
      empires: Object.fromEntries(
        this.brains.map((b) => [b.o.name, b.snapshot()]),
      ),
    };
  }

  private async init(start: GameStartInfo) {
    this.gameID = start.gameID;
    const saved = this.resumeFrom;
    if (saved && saved.gameID !== start.gameID)
      throw new ResumeMismatchError(
        `saved brain state is for game ${saved.gameID}, not ${start.gameID}`,
      );
    // A proposal outlives a few decision cycles plus the age an answer may
    // have, so its recipient can reply on a later cycle.
    this.dm.proposalTtl = Math.ceil(
      3 * this.o.config.decisionIntervalSeconds +
        this.o.config.maxDecisionAgeSeconds,
    );
    const { gameMap, gameMapSize } = start.config;
    this.runner = await createGameRunner(
      start,
      undefined,
      await loadMapFiles(this.o.maps, gameMap, gameMapSize),
      () => {},
    );
    const c = this.o.config;
    const names = start.config.brainNations ?? [];
    for (const name of names.filter((n) => isEmpireEnabled(c, n))) {
      const e = c.empires[name];
      const model = modelFor(c, name);
      const profile = c.models[model];
      this.brains.push(
        new EmpireBrain({
          name,
          personality: e?.personality ?? "",
          traits: e?.traits,
          backoffMax: c.quietBackoffMax,
          directives: e?.directives ?? [],
          intervalTicks: c.decisionIntervalSeconds * TICKS_PER_SECOND,
          maxAgeTicks: c.maxDecisionAgeSeconds * TICKS_PER_SECOND,
          temperature: c.temperature,
          maxTokens: profile?.maxOutputTokens ?? c.maxOutputTokens,
          timeoutMs: profile?.timeoutMs,
          model: model || undefined,
        }),
      );
    }
    if (saved) {
      this.dm.restore(saved.diplomacy);
      for (const b of this.brains) {
        const e = saved.empires[b.o.name];
        if (e) b.restore(e);
      }
      this.log(
        `resumed from tick ${saved.savedAtTick}: ${Object.keys(saved.empires).length} empires, ${saved.diplomacy.messages.length} messages`,
      );
    }
    this.log(
      `replica up: ${gameMap} ${gameMapSize}, brains ${JSON.stringify(this.brains.map((b) => b.o.name))}`,
    );
  }

  /** One poll: catch the replica up, then let brains react. Returns false before start. */
  async step(): Promise<boolean> {
    const feed = await fetchTurns(this.o.server, this.nextTurn);
    if (feed === null) return false;
    if (!this.runner) await this.init(feed.gameStartInfo);
    const runner = this.runner!;
    for (const turn of feed.turns) {
      if (turn.turnNumber !== this.nextTurn) continue;
      runner.addTurn(turn);
      runner.executeNextTick();
      this.nextTurn++;
    }
    const game = runner.game;
    // Still replaying a backlog (late join): don't decide on stale state.
    if (feed.turns.length > MAX_LAG_TURNS) return true;
    // Diplomacy empires are player names (what the model sees and says).
    for (const p of game.allPlayers())
      if (!this.dm.state.empires[p.name()])
        this.dm.state.empires[p.name()] = {
          id: p.name(),
          name: p.name(),
          personality: "",
        };
    this.dm.advance(Math.floor(game.ticks() / TICKS_PER_SECOND));

    const world = {
      game,
      dm: this.dm,
      llm: this.llm,
      log: this.log,
      decisions: this.decisions,
    };
    for (const b of this.brains) {
      b.observe({ ...world, submit: () => Promise.resolve() });
      const p = b.maybeDecide({
        ...world,
        submit: (intent) =>
          submitEngineIntent({ ...this.o.server, nation: b.o.name }, intent),
      });
      if (p) {
        this.inflight.add(p);
        void p.finally(() => this.inflight.delete(p));
      }
    }
    return true;
  }

  /** Resolves once every decision in flight has been applied or dropped. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  async run(pollMs: number, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        if (!(await this.step())) this.log("waiting for the game to start");
      } catch (e) {
        // Retrying cannot fix a state file for another game.
        if (e instanceof ResumeMismatchError) throw e;
        this.log(`feed error: ${String((e as Error)?.message ?? e)}`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
