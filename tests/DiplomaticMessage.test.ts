import {
  AllPlayers,
  GameType,
  MessageType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  brainClientID,
  GameStartInfo,
  Intent,
  IntentSchema,
  MAX_DIPLOMATIC_MESSAGE_LENGTH,
  Turn,
} from "@openfront/engine-api/Schemas";
import { Player } from "@openfront/engine/game/Game";
import { GameRunner } from "@openfront/engine/GameRunner";
import { describe, expect, it, vi } from "vitest";
import en from "../resources/lang/en.json";
import { createScriptedRunner, scriptedGameStart } from "./util/ScriptedGame";

// Two nations, one human, a 200-tick spawn phase.
function gameStart(brainNations?: string[]): GameStartInfo {
  return scriptedGameStart({
    gameType: GameType.Private,
    nations: 2,
    bots: 0,
    doomsdayClock: { enabled: false, speed: "veryfast" },
    brainNations,
  });
}

const SAY_TICK = 240;
const END = 250;

// Nation names are a pure function of the game id and the human count, so a
// probe runner names the nations the real run hands out.
async function nationNames(): Promise<string[]> {
  const probe = await createScriptedRunner("world", gameStart());
  return probe.game.nations().map((n) => n.playerInfo.name);
}

const nation = (runner: GameRunner, name: string): Player =>
  runner.game.allPlayers().find((p) => p.name() === name)!;

type Say = Extract<Intent, { type: "diplomatic_message" }>;

// Plays to END with `intents` in the turn at SAY_TICK; returns the display
// events raised and the final state.
async function play(
  brainNations: string[],
  intents: (runner: GameRunner) => (Intent & { clientID: string })[],
) {
  const runner = await createScriptedRunner("world", gameStart(brainNations));
  const events: any[] = [];
  const addUpdate = runner.game.addUpdate.bind(runner.game);
  vi.spyOn(runner.game, "addUpdate").mockImplementation((u) => {
    if (u.type === GameUpdateType.DisplayEvent) events.push(u);
    addUpdate(u);
  });
  for (let tick = 0; tick < END; tick++) {
    const turn: Turn = {
      turnNumber: tick,
      intents: tick === SAY_TICK ? (intents(runner) as Turn["intents"]) : [],
    };
    runner.addTurn(turn);
    if (!runner.executeNextTick()) throw new Error(`tick ${tick} failed`);
  }
  const messages = events.filter(
    (e) => e.messageType === MessageType.DIPLOMATIC_MESSAGE,
  );
  const fingerprint = runner.game
    .allPlayers()
    .map((p) => [p.id(), p.numTilesOwned(), p.troops(), p.gold().toString()]);
  return { runner, messages, fingerprint };
}

const say = (recipient: string, text: string): Say => ({
  type: "diplomatic_message",
  recipient,
  text,
});

describe("diplomatic_message", () => {
  it("shows a brain nation's message to its recipient only", async () => {
    const [brainName, otherName] = await nationNames();
    const { runner, messages } = await play([brainName], (r) => [
      {
        ...say(nation(r, otherName).id(), "Peace, friend {name} <b>!"),
        clientID: brainClientID(0),
      },
    ]);
    const brain = nation(runner, brainName);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      message: "events_display.diplomatic_message",
      playerID: nation(runner, otherName).smallID(),
      focusPlayerID: brain.smallID(),
      // Verbatim: the client renders it as plain text, never ICU or HTML.
      params: { name: brain.displayName(), text: "Peace, friend {name} <b>!" },
    });
  });

  it("shows a broadcast to everyone", async () => {
    const [brainName] = await nationNames();
    const { messages } = await play([brainName], () => [
      { ...say(AllPlayers, "To all"), clientID: brainClientID(0) },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].playerID).toBeNull();
    expect(messages[0].params.text).toBe("To all");
  });

  it("ignores a sender that is not brain-controlled", async () => {
    const [brainName, otherName] = await nationNames();
    const humanSays = (r: GameRunner) => [
      {
        ...say(nation(r, otherName).id(), "free text"),
        clientID: "HUMAN001",
      },
    ];
    // A human's stamp, and a brain index that names no nation.
    expect((await play([brainName], humanSays)).messages).toHaveLength(0);
    const { messages } = await play([brainName], () => [
      { ...say(AllPlayers, "who?"), clientID: "BRAIN007" },
    ]);
    expect(messages).toHaveLength(0);
    // No brainNations at all: even a brain stamp does nothing.
    expect(
      (
        await play([], () => [
          { ...say(AllPlayers, "nope"), clientID: brainClientID(0) },
        ])
      ).messages,
    ).toHaveLength(0);
  });

  it("ignores an unknown recipient", async () => {
    const [brainName] = await nationNames();
    const { messages } = await play([brainName], () => [
      { ...say("nobody00", "hello?"), clientID: brainClientID(0) },
    ]);
    expect(messages).toHaveLength(0);
  });

  it("changes no game state and replays identically", async () => {
    const [brainName, otherName] = await nationNames();
    const talk = (r: GameRunner) => [
      { ...say(AllPlayers, "hi"), clientID: brainClientID(0) },
      {
        ...say(nation(r, otherName).id(), "psst"),
        clientID: brainClientID(0),
      },
    ];
    const a = await play([brainName], talk);
    const b = await play([brainName], talk);
    const silent = await play([brainName], () => []);
    expect(a.messages).toHaveLength(2);
    expect(b.fingerprint).toEqual(a.fingerprint);
    expect(a.fingerprint).toEqual(silent.fingerprint);
    expect(nation(a.runner, brainName).type() === PlayerType.Nation).toBe(true);
  });

  it("bounds the text and has a translation", () => {
    const parse = (text: string) =>
      IntentSchema.safeParse(say(AllPlayers, text)).success;
    expect(parse("x".repeat(MAX_DIPLOMATIC_MESSAGE_LENGTH))).toBe(true);
    expect(parse("x".repeat(MAX_DIPLOMATIC_MESSAGE_LENGTH + 1))).toBe(false);
    expect(parse("")).toBe(false);
    expect(en.events_display.diplomatic_message).toBe("{name}: {text}");
  });
});
