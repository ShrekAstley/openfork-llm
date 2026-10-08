// Where a nation can build, decided by the Brain Host so the model never has
// to name a tile. The replica's own rules (Player.canBuild) judge every
// candidate; the server and the execution still have the final word.
import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type { Game, Player } from "@openfront/engine/game/Game";

export const STRUCTURES = {
  city: UnitType.City,
  port: UnitType.Port,
  factory: UnitType.Factory,
  defense_post: UnitType.DefensePost,
  sam_launcher: UnitType.SAMLauncher,
  missile_silo: UnitType.MissileSilo,
} as const;
export type StructureName = keyof typeof STRUCTURES;
export const STRUCTURE_NAMES = Object.keys(STRUCTURES) as [
  StructureName,
  ...StructureName[],
];

/** Gold and sites already promised by earlier builds in the same decision. */
export interface BuildBudget {
  spent: bigint;
  tiles: TileRef[];
}

export type BuildPlan =
  | { ok: true; name: StructureName; cost: bigint; tile: TileRef }
  | { ok: false; name: StructureName; cost: bigint; why: string };

const SAMPLE = 150;
const MIN_SEPARATION_SQ = 36;

/** Every `step`-th tile of a set, so the scan is bounded and repeatable. */
function sample(tiles: Iterable<TileRef>, size: number, max: number) {
  const step = Math.max(1, Math.floor(size / max));
  const out: TileRef[] = [];
  let i = 0;
  for (const t of tiles) if (i++ % step === 0) out.push(t);
  return out;
}

export function planBuild(
  game: Game,
  me: Player,
  name: StructureName,
  budget: BuildBudget = { spent: 0n, tiles: [] },
): BuildPlan {
  const unit = STRUCTURES[name];
  const cost = me.buildableUnits(null, [unit])[0].cost;
  const fail = (why: string): BuildPlan => ({ ok: false, name, cost, why });
  if (me.gold() - budget.spent < cost)
    return fail(`costs ${cost} gold, you have ${me.gold() - budget.spent}`);

  // Interior sites for most structures, the border for the rest (ports need
  // a shore, defense posts a front); canBuild decides either way.
  const pool = new Set<TileRef>([
    ...sample(me.borderTiles(), me.borderTiles().size, SAMPLE),
    ...sample(me.tiles(), me.tiles().size, SAMPLE),
  ]);
  const own = me.units(unit).map((u) => u.tile());
  const taken = [...own, ...budget.tiles];
  const apart = (t: TileRef) =>
    taken.reduce(
      (m, o) => Math.min(m, game.euclideanDistSquared(t, o)),
      Number.MAX_SAFE_INTEGER,
    );
  let best: { tile: TileRef; score: number } | null = null;
  for (const t of pool) {
    const site = me.canBuild(unit, t);
    if (site === false) continue;
    const score = apart(site);
    if (score < MIN_SEPARATION_SQ && taken.length > 0) continue;
    if (
      best === null ||
      score > best.score ||
      (score === best.score && site < best.tile)
    )
      best = { tile: site, score };
  }
  if (best === null) return fail("no valid site on your land");
  return { ok: true, name, cost, tile: best.tile };
}

/** One line per structure for the observation: what can be built now, and what is out of reach. */
export function buildOptions(game: Game, me: Player): string[] {
  const can: string[] = [];
  const cannot: string[] = [];
  const k = (n: bigint) =>
    n >= 1_000_000n
      ? `${(Number(n) / 1e6).toFixed(1)}M`
      : n >= 1000n
        ? `${(Number(n) / 1e3).toFixed(0)}k`
        : `${n}`;
  for (const name of STRUCTURE_NAMES) {
    // Defensive and nuclear structures are never the first thing to offer.
    const p = planBuild(game, me, name);
    if (p.ok) can.push(`${name} (${k(p.cost)})`);
    else if (p.cost > me.gold()) cannot.push(`${name} ${k(p.cost)}`);
  }
  return [
    can.length
      ? `Build now with the build tool (gold ${k(me.gold())}): ${can.join(", ")}.`
      : "",
    cannot.length ? `Not affordable yet: ${cannot.join(", ")}.` : "",
  ].filter(Boolean);
}
