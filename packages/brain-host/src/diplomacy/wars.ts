import {
  allocId,
  type Ceasefire,
  type DiplomacyState,
  type Treaty,
  type War,
} from "./schemas";

export function warBetween(
  s: DiplomacyState,
  a: string,
  b: string,
): War | undefined {
  return Object.values(s.wars).find(
    (w) =>
      w.status !== "ended" &&
      ((w.aggressor === a && w.defender === b) ||
        (w.aggressor === b && w.defender === a)),
  );
}

export function startWar(
  s: DiplomacyState,
  turn: number,
  aggressor: string,
  defender: string,
): War {
  const existing = warBetween(s, aggressor, defender);
  if (existing) {
    existing.status = "active";
    return existing;
  }
  const w: War = {
    id: allocId(s, "w"),
    aggressor,
    defender,
    startedTurn: turn,
    status: "active",
  };
  s.wars[w.id] = w;
  return w;
}

export function endWar(turn: number, war: War) {
  war.status = "ended";
  war.endedTurn = turn;
}

export function startCeasefire(
  s: DiplomacyState,
  turn: number,
  war: War,
  treaty: Treaty,
): Ceasefire {
  war.status = "ceasefire";
  const c: Ceasefire = {
    id: allocId(s, "cf"),
    warId: war.id,
    parties: [war.aggressor, war.defender],
    createdTurn: turn,
    expiresTurn: treaty.expiresTurn,
    status: "active",
  };
  s.ceasefires[c.id] = c;
  return c;
}

/** Ceasefires that ran out put the war back to active. */
export function expireCeasefires(s: DiplomacyState, turn: number) {
  for (const c of Object.values(s.ceasefires)) {
    if (
      c.status === "active" &&
      c.expiresTurn !== null &&
      c.expiresTurn <= turn
    ) {
      c.status = "expired";
      const w = s.wars[c.warId];
      if (w.status === "ceasefire") w.status = "active";
    }
  }
}

/** An attack during a ceasefire breaks it. */
export function breakCeasefire(s: DiplomacyState, a: string, b: string) {
  for (const c of Object.values(s.ceasefires)) {
    if (
      c.status === "active" &&
      c.parties.includes(a) &&
      c.parties.includes(b)
    ) {
      c.status = "broken";
      s.wars[c.warId].status = "active";
    }
  }
}
