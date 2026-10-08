// The Brain Host's only way into a game: engine intents for its
// brain-controlled nations (GameConfig.brainNations), posted to the game
// server, which stamps them into turns like any player's; and the turn log it
// replays to observe. See ENGINE_INTEGRATION.md.
import { AllPlayers } from "@openfront/engine-api/game/GameTypes";
import {
  type GameStartInfo,
  type Intent,
  MAX_DIPLOMATIC_MESSAGE_LENGTH,
  type Turn,
} from "@openfront/engine-api/Schemas";
import type { DiplomaticIntent } from "./diplomacy/intents";

/** Fit text to the engine's message bound without splitting a surrogate pair. */
function boundedText(text: string): string {
  let out = text.trim().slice(0, MAX_DIPLOMATIC_MESSAGE_LENGTH);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * The engine intents a diplomatic intent maps to; [] when it has no engine
 * twin (it stays Brain Host state). `playerID` maps a Brain empire id to the
 * engine PlayerID.
 */
export function toEngineIntent(
  intent: DiplomaticIntent,
  playerID: (empireId: string) => string,
): Intent[] {
  switch (intent.type) {
    case "FORM_ALLIANCE":
      // Engine alliances are pairwise; joining a bloc is Brain Host state.
      // Requesting back also accepts an incoming request.
      return intent.allianceId === undefined
        ? [{ type: "allianceRequest", recipient: playerID(intent.target) }]
        : [];
    case "DECLARE_WAR": {
      const id = playerID(intent.target);
      return [
        { type: "embargo", targetID: id, action: "start" },
        { type: "targetPlayer", target: id },
      ];
    }
    case "OFFER_PEACE":
      return [
        { type: "embargo", targetID: playerID(intent.target), action: "stop" },
      ];
    case "SEND_AID": {
      const recipient = playerID(intent.target);
      if (intent.resource === "gold")
        return [{ type: "donate_gold", recipient, gold: intent.amount }];
      if (intent.resource === "troops")
        return [{ type: "donate_troops", recipient, troops: intent.amount }];
      return [];
    }
    case "SEND_DIPLOMATIC_MESSAGE": {
      // Display-only, and every client can read the turn: the engine shows
      // the text to the recipient (or all), but nothing in it is secret.
      const text = boundedText(intent.text);
      if (text.length === 0) return [];
      return [
        {
          type: "diplomatic_message",
          recipient:
            intent.target === undefined ? AllPlayers : playerID(intent.target),
          text,
        },
      ];
    }
    default:
      // Treaties, blocs, intel: Brain Host state only.
      return [];
  }
}

export interface EngineTarget {
  serverUrl: string; // e.g. http://localhost:3001 (the game's worker)
  adminKey: string; // ADMIN_BOT_API_KEY
  gameID: string;
  nation: string; // a name from the game's brainNations
  fetch?: typeof fetch;
}

const headers = (t: { adminKey: string }) => ({
  "content-type": "application/json",
  "x-admin-bot-key": t.adminKey,
});

export async function submitEngineIntent(
  target: EngineTarget,
  intent: Intent,
): Promise<void> {
  const res = await (target.fetch ?? fetch)(
    `${target.serverUrl}/api/adminbot/game/${target.gameID}/brain_intent`,
    {
      method: "POST",
      headers: headers(target),
      body: JSON.stringify({ nation: target.nation, intent }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `brain_intent ${intent.type} rejected: ${res.status} ${await res.text()}`,
    );
  }
}

export interface TurnFeed {
  gameStartInfo: GameStartInfo;
  turns: Turn[];
}

/** The game's start info and recorded turns from `from` on; null until it starts. */
export async function fetchTurns(
  target: Omit<EngineTarget, "nation">,
  from: number,
): Promise<TurnFeed | null> {
  const res = await (target.fetch ?? fetch)(
    `${target.serverUrl}/api/adminbot/game/${target.gameID}/turns?from=${from}`,
    { headers: headers(target) },
  );
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`turns: ${res.status} ${await res.text()}`);
  return (await res.json()) as TurnFeed;
}
