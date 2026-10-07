import {
  AllPlayers,
  MessageType,
  PlayerID,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

export const DIPLOMATIC_MESSAGE_KEY = "events_display.diplomatic_message";

// Display-only free text from a brain-controlled nation: it changes no game
// state. Shown to the recipient, or to everyone for AllPlayers. Anyone
// replaying the turns can read it, whoever it was addressed to.
export class DiplomaticMessageExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(
    private sender: Player,
    private recipientID: PlayerID | typeof AllPlayers,
    private text: string,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    const brainNations = mg.config().gameConfig().brainNations ?? [];
    if (
      this.sender.type() !== PlayerType.Nation ||
      !brainNations.includes(this.sender.name())
    ) {
      console.warn(
        `DiplomaticMessageExecution: ${this.sender.name()} is not brain-controlled`,
      );
      this.active = false;
      return;
    }
    if (this.recipientID !== AllPlayers && !mg.hasPlayer(this.recipientID)) {
      console.warn(
        `DiplomaticMessageExecution: recipient ${this.recipientID} not found`,
      );
      this.active = false;
    }
  }

  tick(ticks: number): void {
    this.active = false;
    if (!this.sender.isAlive()) return;
    this.mg.displayMessage(
      DIPLOMATIC_MESSAGE_KEY,
      MessageType.DIPLOMATIC_MESSAGE,
      this.recipientID === AllPlayers ? null : this.recipientID,
      undefined,
      { name: this.sender.displayName(), text: this.text },
      undefined,
      this.sender.id(),
    );
  }

  owner(): Player {
    return this.sender;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DiplomaticMessageExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      sender: w.player(this.sender),
      recipientID: this.recipientID,
      text: this.text,
    });
  }

  restoreSnapshot(s: DiplomaticMessageState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.sender = r.player(s.sender);
    this.recipientID = s.recipientID;
    this.text = s.text;
  }
}

const DiplomaticMessageStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  sender: zPlayerRef(),
  recipientID: z.string(),
  text: z.string(),
});
type DiplomaticMessageState = z.infer<typeof DiplomaticMessageStateSchema>;

export const DiplomaticMessageExecutionSnapshot = execSnapshotType({
  name: "DiplomaticMessage",
  version: 1,
  schema: DiplomaticMessageStateSchema,
  cls: () => DiplomaticMessageExecution,
});
