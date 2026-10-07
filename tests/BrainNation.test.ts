import { GameType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  brainClientID,
  brainNationIndex,
  GameStartInfo,
  Turn,
} from "@openfront/engine-api/Schemas";
import { Player } from "@openfront/engine/game/Game";
import { GameRunner } from "@openfront/engine/GameRunner";
import { describe, expect, it } from "vitest";
import { createScriptedRunner, scriptedGameStart } from "./util/ScriptedGame";

// Two nations, no humans, a 200-tick spawn phase.
function gameStart(brainNations?: string[]): GameStartInfo {
  return {
    ...scriptedGameStart({
      gameType: GameType.Private,
      nations: 2,
      bots: 0,
      doomsdayClock: { enabled: false, speed: "veryfast" },
      brainNations,
    }),
    players: [],
  };
}

const AFTER_SPAWN = 210;
const ATTACK_TICK = 240;
const END = 280;

// The Brain Host's one move: expand into terra nullius.
const brainTurns = (): Turn[] => [
  {
    turnNumber: ATTACK_TICK,
    intents: [
      {
        type: "attack",
        targetID: null,
        troops: null,
        clientID: brainClientID(0),
      },
      // An index brainNations doesn't have: a NoOp, not a crash.
      { type: "attack", targetID: null, troops: null, clientID: "BRAIN007" },
    ],
  },
];

async function play(
  start: GameStartInfo,
  turns: Turn[],
  untilTick: number,
  onTick: (runner: GameRunner) => void = () => {},
): Promise<GameRunner> {
  const runner = await createScriptedRunner("world", start);
  for (let tick = 0; tick < untilTick; tick++) {
    const turn = turns.find((t) => t.turnNumber === tick);
    runner.addTurn(turn ?? { turnNumber: tick, intents: [] });
    if (!runner.executeNextTick()) throw new Error(`tick ${tick} failed`);
    onTick(runner);
  }
  return runner;
}

// Nation names are a pure function of the game id, so a probe runner names
// the nation the real run hands to the brain.
const probeNationName = async () =>
  (await createScriptedRunner("world", gameStart())).game.nations()[0]
    .playerInfo.name;

const nations = (runner: GameRunner): Player[] =>
  runner.game.allPlayers().filter((p) => p.type() === PlayerType.Nation);

const fingerprint = (runner: GameRunner) =>
  runner.game
    .allPlayers()
    .map((p) => [p.id(), p.numTilesOwned(), p.troops(), p.gold().toString()]);

describe("brain-controlled nations", () => {
  it("parses only brain clientIDs", () => {
    expect(brainClientID(7)).toBe("BRAIN007");
    expect(brainNationIndex("BRAIN007")).toBe(7);
    expect(brainNationIndex("HUMAN001")).toBe(-1);
  });

  it("stays passive until its intent arrives, then executes it", async () => {
    const brainName = await probeNationName();

    let tilesAfterSpawn = 0;
    let tilesBeforeAttack = 0;
    const runner = await play(
      gameStart([brainName]),
      brainTurns(),
      END,
      (r) => {
        const brain = nations(r).find((p) => p.name() === brainName)!;
        if (r.game.ticks() === AFTER_SPAWN)
          tilesAfterSpawn = brain.numTilesOwned();
        if (r.game.ticks() === ATTACK_TICK)
          tilesBeforeAttack = brain.numTilesOwned();
      },
    );

    const brain = nations(runner).find((p) => p.name() === brainName)!;
    const ai = nations(runner).find((p) => p.name() !== brainName)!;
    expect(tilesAfterSpawn).toBeGreaterThan(0);
    // No AI of its own: no expansion while the AI nation expands.
    expect(tilesBeforeAttack).toBe(tilesAfterSpawn);
    expect(ai.numTilesOwned()).toBeGreaterThan(tilesAfterSpawn);
    // The Brain Host's attack ran as the brain nation.
    expect(brain.numTilesOwned()).toBeGreaterThan(tilesBeforeAttack);
  });

  it("replays identically from the same turns", async () => {
    const brainName = await probeNationName();
    const live = await play(gameStart([brainName]), brainTurns(), END);
    const replay = await play(gameStart([brainName]), brainTurns(), END);
    expect(fingerprint(replay)).toEqual(fingerprint(live));
  });
});
