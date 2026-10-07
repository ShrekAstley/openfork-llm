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
import { DiplomacyManager } from "./diplomacy/DiplomacyManager";
import { EmpireBrain } from "./EmpireBrain";
import {
  type EngineTarget,
  fetchTurns,
  submitEngineIntent,
} from "./EngineBridge";
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
  private nextTurn = 0;
  private inflight = new Set<Promise<void>>();
  private log: (line: string) => void;

  constructor(private o: RuntimeOptions) {
    this.log = o.log ?? ((l) => console.log(l));
    this.llm = new LLMManager(o.provider, {
      maxConcurrent: o.config.maxConcurrentRequests,
      isStale: (m) => {
        const b = this.brains.find((x) => x.o.name === m.empireId);
        const now = this.runner?.game.ticks() ?? 0;
        return !b || b.isStale(m.worldTick, m.empireRevision, now);
      },
    });
  }

  private async init(start: GameStartInfo) {
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
      this.brains.push(
        new EmpireBrain({
          name,
          personality: e?.personality ?? "",
          directives: e?.directives ?? [],
          intervalTicks: c.decisionIntervalSeconds * TICKS_PER_SECOND,
          maxAgeTicks: c.maxDecisionAgeSeconds * TICKS_PER_SECOND,
          temperature: c.temperature,
          maxTokens: c.maxOutputTokens,
          model: modelFor(c, name) || undefined,
        }),
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
        this.log(`feed error: ${String((e as Error)?.message ?? e)}`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
