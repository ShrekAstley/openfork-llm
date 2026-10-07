// What the model may do, and the strict path from a tool call to engine
// intents: schema -> DiplomacyManager.validateIntent -> engine legality
// (checked on the replica with the engine's own can* rules; the server and
// the executions still have the final word). Any failure is a short
// "ACTION REJECTED ..." line for the next observation.
import { AllPlayers } from "@openfront/engine-api/game/GameTypes";
import {
  flattenedEmojiTable,
  type Intent,
} from "@openfront/engine-api/Schemas";
import type { Game, Player } from "@openfront/engine/game/Game";
import { z } from "zod";
import type { DiplomacyManager } from "./diplomacy/DiplomacyManager";
import { type DiplomaticIntent, validateIntent } from "./diplomacy/intents";
import { TREATY_TYPES } from "./diplomacy/schemas";
import { toEngineIntent } from "./EngineBridge";
import type { ToolCall, ToolDef } from "./types";

const target = z.string().min(1).max(64).describe("player name as shown");
const T = z.object({ target });
const TOOLS = {
  plan: [
    "Call once per decision: your objective and a one-line summary.",
    z.object({ objective: z.string().max(200), summary: z.string().max(300) }),
  ],
  attack: [
    "Send a share of your army at a neighbor, or target 'wilderness' to expand into unclaimed land.",
    z.object({ target, percent: z.number().int().min(1).max(100) }),
  ],
  form_alliance: ["Request an alliance, or accept a pending request.", T],
  break_alliance: ["Break an alliance (marks you a traitor).", T],
  declare_war: ["Declare war: embargo the player and mark them as target.", T],
  offer_peace: ["Offer peace to a player you are at war with.", T],
  donate: [
    "Give gold or troops to a player.",
    z.object({
      target,
      resource: z.enum(["gold", "troops"]),
      amount: z.number().int().positive(),
    }),
  ],
  embargo: [
    "Start or stop trade embargo against a player.",
    z.object({ target, stop: z.boolean().default(false) }),
  ],
  target_player: ["Mark a player as your target (visible to allies).", T],
  emoji: [
    "Send an emoji to a player, or target 'all'.",
    z.object({ target, emoji: z.enum(flattenedEmojiTable) }),
  ],
  send_message: [
    "Send a short diplomatic message. Every player can read it, so put nothing secret in it.",
    z.object({ target, text: z.string().min(1).max(200) }),
  ],
  propose_treaty: [
    "Propose a treaty to a player. They answer on one of their later turns; it only binds you both once accepted. Use offer_peace for ending a war.",
    z.object({
      target,
      treatyType: z.enum(
        TREATY_TYPES.filter((t) => t !== "peace" && t !== "ceasefire") as [
          string,
          ...string[],
        ],
      ),
      durationSeconds: z.number().int().min(10).max(3600).optional(),
    }),
  ],
  accept_treaty: [
    "Accept a treaty proposed to you, by its id (see FOR YOU TO ANSWER).",
    z.object({ treatyId: z.string().min(1).max(32) }),
  ],
  reject_treaty: [
    "Reject a treaty proposed to you, by its id.",
    z.object({ treatyId: z.string().min(1).max(32) }),
  ],
} as const satisfies Record<string, readonly [string, z.ZodType]>;
export type ToolName = keyof typeof TOOLS;

export const toolDefs = (): ToolDef[] =>
  Object.entries(TOOLS).map(([name, [description, schema]]) => ({
    name,
    description,
    parameters: z.toJSONSchema(schema) as Record<string, unknown>,
  }));

export type Action =
  | { kind: "plan"; objective: string; summary: string }
  | { kind: "act"; label: string; engine: Intent[] }
  | { kind: "rejected"; text: string };

export interface ActionContext {
  game: Game;
  me: Player;
  /** Empire ids are player names. */
  dm: DiplomacyManager;
  turn: number;
}

/**
 * Validates one tool call and, when it passes, records its diplomatic part in
 * the DiplomacyManager and returns the engine intents to submit.
 */
export function resolveAction(call: ToolCall, c: ActionContext): Action {
  const label = `${call.name} ${JSON.stringify(call.arguments)}`.slice(0, 160);
  const no = (why: string): Action => ({
    kind: "rejected",
    text: `ACTION REJECTED ${label}: ${why}`,
  });
  const entry = (TOOLS as Record<string, readonly [string, z.ZodType]>)[
    call.name
  ];
  if (!entry) return no("unknown tool");
  const parsed = entry[1].safeParse(call.arguments);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return no(`${i.path.join(".") || "arguments"}: ${i.message}`);
  }
  const a = parsed.data as any;
  if (call.name === "plan")
    return { kind: "plan", objective: a.objective, summary: a.summary };

  const { game, me } = c;

  // Answering a treaty names it by id, not by player.
  if (call.name === "accept_treaty" || call.name === "reject_treaty") {
    const dip: DiplomaticIntent = {
      type: call.name === "accept_treaty" ? "ACCEPT_TREATY" : "REJECT_TREATY",
      treatyId: a.treatyId,
    };
    const v = validateIntent(c.dm.state, me.name(), dip);
    if (!v.ok)
      return no(
        `${v.reason}${Object.keys(v.details).length ? " " + JSON.stringify(v.details) : ""}`,
      );
    c.dm.recordTurn(c.turn, me.name(), [dip]);
    return { kind: "act", label, engine: [] };
  }

  const wild = String(a.target).toLowerCase() === "wilderness";
  const all = call.name === "emoji" && String(a.target).toLowerCase() === "all";
  const p =
    wild || all
      ? undefined
      : game
          .players()
          .find((x) => x.name().toLowerCase() === a.target.toLowerCase());
  if (!wild && !all) {
    if (!p) return no(`unknown player "${a.target}"`);
    if (p === me) return no("cannot target yourself");
  } else if (wild && call.name !== "attack") {
    return no("wilderness is only an attack target");
  }

  // Diplomatic twin, if any: validated before anything is recorded.
  let dip: DiplomaticIntent | undefined;
  switch (call.name as ToolName) {
    case "form_alliance":
      dip = { type: "FORM_ALLIANCE", target: p!.name(), terms: {} };
      break;
    case "declare_war":
      dip = { type: "DECLARE_WAR", target: p!.name() };
      break;
    case "offer_peace":
      dip = {
        type: "OFFER_PEACE",
        target: p!.name(),
        ceasefire: false,
        terms: {},
      };
      break;
    case "donate":
      dip = {
        type: "SEND_AID",
        target: p!.name(),
        resource: a.resource,
        amount: a.amount,
      };
      break;
    case "propose_treaty":
      dip = {
        type: "PROPOSE_TREATY",
        target: p!.name(),
        treatyType: a.treatyType,
        terms:
          a.durationSeconds === undefined
            ? {}
            : { duration_turns: a.durationSeconds },
        secret: false,
      };
      break;
    case "send_message":
      dip = {
        type: "SEND_DIPLOMATIC_MESSAGE",
        target: p!.name(),
        text: a.text,
        channel: "private",
      };
      break;
  }
  if (dip) {
    const v = validateIntent(c.dm.state, me.name(), dip);
    if (!v.ok)
      return no(
        `${v.reason}${Object.keys(v.details).length ? " " + JSON.stringify(v.details) : ""}`,
      );
  }

  // Engine legality on the replica.
  let engine: Intent[] = [];
  const id = (name: string) =>
    game
      .players()
      .find((x) => x.name() === name)!
      .id();
  switch (call.name as ToolName) {
    case "attack": {
      const troops = Math.floor((me.troops() * a.percent) / 100);
      if (wild) {
        if (!me.sharesBorderWith(game.terraNullius()))
          return no("no unclaimed land borders you");
      } else {
        if (!me.sharesBorderWith(p!))
          return no("does not border you (naval attacks unsupported)");
        if (!me.canAttackPlayer(p!))
          return no("cannot attack an ally/immune player");
      }
      engine = [{ type: "attack", targetID: wild ? null : p!.id(), troops }];
      break;
    }
    case "form_alliance":
      if (me.isAlliedWith(p!)) return no("already allied");
      if (
        !me.incomingAllianceRequests().some((r) => r.requestor() === p) &&
        !me.canSendAllianceRequest(p!)
      )
        return no("cannot send an alliance request now");
      break;
    case "break_alliance":
      if (!me.isAlliedWith(p!)) return no("not allied");
      engine = [{ type: "breakAlliance", recipient: p!.id() }];
      break;
    case "declare_war":
      if (me.isAlliedWith(p!)) return no("allied: break_alliance first");
      break;
    case "donate":
      if (
        a.resource === "gold" ? !me.canDonateGold(p!) : !me.canDonateTroops(p!)
      )
        return no(`cannot donate ${a.resource} to them`);
      if (a.amount > (a.resource === "gold" ? Number(me.gold()) : me.troops()))
        return no(`not enough ${a.resource}`);
      break;
    case "embargo":
      engine = [
        {
          type: "embargo",
          targetID: p!.id(),
          action: a.stop ? "stop" : "start",
        },
      ];
      break;
    case "target_player":
      if (!me.canTarget(p!)) return no("cannot target them now");
      engine = [{ type: "targetPlayer", target: p!.id() }];
      break;
    case "emoji":
      if (!me.canSendEmoji(all ? AllPlayers : p!))
        return no("emoji on cooldown");
      engine = [
        {
          type: "emoji",
          recipient: all ? AllPlayers : p!.id(),
          emoji: flattenedEmojiTable.indexOf(a.emoji),
        },
      ];
      break;
  }
  if (dip) {
    c.dm.recordTurn(c.turn, me.name(), [dip]);
    engine = toEngineIntent(dip, id);
  }
  return { kind: "act", label, engine };
}
