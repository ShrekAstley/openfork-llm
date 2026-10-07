import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainStateSchema,
  loadBrainState,
  ResumeMismatchError,
  saveBrainState,
} from "../../packages/brain-host/src/BrainState";
import {
  DecisionScheduler,
  Importance,
} from "../../packages/brain-host/src/DecisionScheduler";
import type { ChatResult, Result } from "../../packages/brain-host/src/types";
import { ServerEnv } from "../../src/server/ServerEnv";
import {
  CA,
  callsOf,
  liveDuoGame,
  ok,
  plan,
  prompt,
  say,
  US,
  who,
  type Respond,
} from "../util/BrainHarness";

// Saving a Brain Host and resuming it in a fresh process, with MockProvider
// standing in for the model.

let dir: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(ServerEnv, "workerIndex").mockReturnValue(0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "brainstate-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** How an unanswered message from the US reads in Canada's prompt. */
const INBOX = (text: string) => `Message from ${US}: "${text}`;

const offline = {
  ok: false,
  error: { kind: "offline", message: "ECONNREFUSED" },
} as const;

describe("DecisionScheduler state", () => {
  it("resumes on the same cursors", () => {
    const a = new DecisionScheduler(100);
    a.poll(0, false);
    a.notify(Importance.MEDIUM);
    const b = new DecisionScheduler(100);
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    for (const s of [a, b]) {
      expect(s.poll(60, false)).toBeNull(); // MEDIUM waits for the period
      expect(s.poll(100, false)).toBe(Importance.MEDIUM);
      expect(s.poll(150, false)).toBeNull();
    }
  });
});

describe("Brain state file", () => {
  it("round-trips and leaves no temp file", async () => {
    const g = await liveDuoGame(() => ok([plan]));
    await g.pastSpawn();
    await g.tick(5);
    const state = g.rt.snapshot()!;
    const file = path.join(dir, "brain.state.json");
    saveBrainState(file, state);
    expect(fs.readdirSync(dir)).toEqual(["brain.state.json"]);
    expect(loadBrainState(file)).toEqual(BrainStateSchema.parse(state));
    expect(Object.keys(state.empires).sort()).toEqual([CA, US].sort());
  });

  it("has nothing to save before the game starts", async () => {
    const g = await liveDuoGame(() => ok([plan]));
    expect(g.rt.snapshot()).toBeNull();
  });

  it("says what is wrong with a missing, broken or foreign file", async () => {
    const file = path.join(dir, "s.json");
    expect(() => loadBrainState(file)).toThrow(/no brain state/);
    fs.writeFileSync(file, "{nope");
    expect(() => loadBrainState(file)).toThrow(/not valid JSON/);
    fs.writeFileSync(file, JSON.stringify({ version: 99 }));
    expect(() => loadBrainState(file)).toThrow(/version 99, expected 1/);
    fs.writeFileSync(file, JSON.stringify({ version: 1, gameID: "x" }));
    expect(() => loadBrainState(file)).toThrow(/is invalid: savedAtTick/);
  });
});

describe("Brain Host resume", () => {
  it("continues a conversation, including an unanswered message", async () => {
    let caOnline = true;
    const respond: Respond = (req) => {
      if (who(req) === CA && !caOnline) return offline;
      if (who(req) === US && req.messages.length > 0 && !usSpoke) {
        usSpoke = true;
        return ok([plan, say(CA, "First hello.")]);
      }
      if (who(req) === CA && prompt(req).includes(INBOX("First hello")))
        return ok([plan, say(US, "First reply.")]);
      if (who(req) === CA && prompt(req).includes(INBOX("Second hello")))
        return ok([plan, say(US, "Second reply.")]);
      return ok([plan]);
    };
    let usSpoke = false;
    const g = await liveDuoGame(respond);
    await g.until(() => g.rt.dm.state.messages.length >= 2);

    // Canada's model goes down; a second message arrives and sits unanswered.
    caOnline = false;
    g.rt.dm.recordTurn(g.rt.dm.state.turn, US, [
      {
        type: "SEND_DIPLOMATIC_MESSAGE",
        target: CA,
        text: "Second hello.",
        channel: "private",
      },
    ]);
    await g.until(() => g.brain(CA).inbox.length === 1);
    await g.tick(15);

    // Save, then "crash": the file is all a new process gets.
    const file = path.join(dir, "brain.state.json");
    saveBrainState(file, g.rt.snapshot()!);
    const saved = loadBrainState(file);
    expect(saved.empires[CA].inbox.map((m) => m.text)).toEqual([
      "Second hello.",
    ]);
    expect(saved.empires[US].history.length).toBeGreaterThan(0);
    expect(saved.diplomacy.messages.map((m) => m.text)).toEqual([
      "First hello.",
      "First reply.",
      "Second hello.",
    ]);

    caOnline = true;
    g.restart(respond);
    g.rt.restore(loadBrainState(file));
    await g.tick(1); // replays the whole turn log into a fresh replica

    // Everything came back: diplomacy, memory, scheduler cursors.
    expect(g.rt.dm.snapshot()).toEqual(saved.diplomacy);
    for (const name of [US, CA])
      expect(g.brain(name).snapshot()).toEqual(saved.empires[name]);
    expect(g.logs.some((l) => l.includes("resumed from tick"))).toBe(true);

    // And the conversation goes on: the unanswered message gets its reply,
    // the answered one is not asked again.
    await g.until(() => g.rt.dm.state.messages.length >= 4);
    expect(g.rt.dm.state.messages[3]).toMatchObject({
      from: CA,
      to: US,
      text: "Second reply.",
    });
    expect(
      g.provider.calls.every(
        (c) => !prompt(c).includes('Message from United States: "First hello'),
      ),
    ).toBe(true);
    expect(g.brain(CA).inbox).toEqual([]);
  });

  it("does not lose a decision that was in flight at the save", async () => {
    let release!: (r: Result<ChatResult>) => void;
    let hold = false;
    const g = await liveDuoGame((req) => {
      if (hold && who(req) === CA) return new Promise((r) => (release = r));
      return ok([plan]);
    });
    await g.pastSpawn();
    await g.tick(3);
    hold = true;
    for (let i = 0; i < 100 && !release; i++) await g.tickNoWait(1);
    expect(release).toBeDefined();
    const brain = g.brain(CA);
    expect(brain.busy).toBe(true);
    // Mid-request: the saved cursor is the one that woke it, not the next one.
    const inFlight = brain.snapshot().scheduler;
    const after = brain.scheduler.snapshot();
    expect(inFlight.next).toBeLessThan(after.next);
    const state = g.rt.snapshot()!;
    release(ok([plan]));
    await g.rt.settled();

    // Crash and resume: the lost request is asked again straight away.
    g.restart(() => ok([plan]));
    g.rt.restore(state);
    await g.tick(1);
    const before = callsOf(g.provider, CA).length;
    await g.tick(3);
    expect(callsOf(g.provider, CA).length).toBeGreaterThan(before);
  });

  it("refuses a state saved for another game, and keeps it intact", async () => {
    const g = await liveDuoGame(() => ok([plan]));
    await g.pastSpawn();
    const state = g.rt.snapshot()!;
    const file = path.join(dir, "other.json");
    saveBrainState(file, { ...state, gameID: "OTHERGAME" });

    g.restart(() => ok([plan]));
    g.rt.restore(loadBrainState(file));
    await expect(g.rt.step()).rejects.toBeInstanceOf(ResumeMismatchError);
    // run() does not retry it forever, and nothing half-started can be saved
    // over the file.
    await expect(g.rt.run(10)).rejects.toThrow(/OTHERGAME/);
    expect(g.rt.snapshot()).toBeNull();
    expect(loadBrainState(file).gameID).toBe("OTHERGAME");
  });
});
