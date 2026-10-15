/**
 * Turn a positional rank into a cross-position value.
 *
 * Rating teams on raw projected points has two failure modes: a bench QB2's
 * 17 ppg counts the same as a starting RB's, though he never starts, and a
 * player whose projection is dragged down by games he's expected to miss is
 * still a top-tier asset for the rest of the season. Consensus positional
 * ranks answer both; what they lack is a way to compare a QB12 to an RB30.
 *
 * The answer is value over replacement: a player is worth how far he sits
 * above the best player of his position nobody would start. The replacement
 * rank per position is the number of league-wide starters at that position
 * (flex slots split evenly among eligible positions) plus one bench body per
 * team, except at K and D/ST where nobody carries a backup.
 *
 * How far above is measured in points, using history: over the last ten
 * seasons the RB1 has averaged so many points per game, the RB2 so many, and
 * so on (see nflverse/curve.ts). A player ranked r is worth the historical
 * points at rank r minus the historical points at the first rank past
 * replacement, floored at zero. So the RB1/RB2 gap is as big as the RB1/RB2
 * scoring gap has actually been, and a QB12 and an RB30 are compared in the
 * same currency. Without curves (history unavailable) value falls back to
 * linear in rank: `replacement + 1 - rank`.
 */
import { SLOT_POSITIONS } from "../espn/constants.js";
import type { EspnLeague } from "../espn/types.js";

/** Points per team-game at each finishing rank (index 0 = rank 1), by position. Built in nflverse/curve.ts. */
export type Curves = Record<string, number[]>;

/** Points per team-game at a (possibly fractional) rank, interpolated; flat past the curve's end. */
export function curvePoints(curve: number[], rank: number): number {
  if (!curve.length) return 0;
  const r = Math.max(1, rank) - 1;
  const lo = Math.min(Math.floor(r), curve.length - 1);
  const hi = Math.min(lo + 1, curve.length - 1);
  const t = r - lo;
  return curve[lo]! * (1 - t) + curve[hi]! * t;
}

/** Bench players per team that still hold value at each position; 1 for anything not listed. */
const BENCH_ALLOWANCE: Record<string, number> = { K: 0, "D/ST": 0 };

/** Everything needed to value a player; plain data so the web client can use it too. */
export interface Valuation {
  /** Rank at which a position's value hits zero, by position label. */
  replacement: Record<string, number>;
  /** Historical points per team-game by finishing rank, or null for the linear fallback. */
  curves: Curves | null;
  /**
   * Season value of each Boris Chen tier (index 0 = tier 1) for every position
   * the VORP table covers (QB, RB, WR, TE, K, D/ST), or null when tiers
   * couldn't be loaded and every position is valued by rank instead.
   */
  tiers: Record<string, number[]> | null;
  /**
   * False keeps below-replacement value negative (the draft analysis, where
   * the pool is deep enough that the sign carries information); omitted or
   * true floors every value at zero, as the ratings do.
   */
  floor?: boolean;
}

/**
 * Value of each tier: the VORP table averaged over the ranks the tier spans.
 * Tier 1 holding WR1-WR4 and tier 2 WR5-WR9 makes every tier-2 WR worth the
 * mean VORP of WR5 through WR9. Ranks past the table's depth take its last
 * row; the result is floored at zero (unless `floor` is false), since a
 * below-replacement starter is worth no less than an empty slot. Positions
 * the table lacks get no entry and stay on rank value.
 *
 * `anchor` re-bases a position's table on a different replacement rank: the
 * table's own VORP at that rank is subtracted from every row, so the anchor
 * rank is worth zero and everything above it is worth its lead over that
 * player (the draft analysis anchors on the draft itself, see draft.ts).
 */
export function tierValues(
  sizes: Record<string, number[]>,
  vorp: Record<string, number[]>,
  opts: { anchor?: Record<string, number>; floor?: boolean } = {},
): Record<string, number[]> {
  const floor = opts.floor ?? true;
  const out: Record<string, number[]> = {};
  for (const [pos, counts] of Object.entries(sizes)) {
    const table = vorp[pos];
    if (!table?.length) continue;
    const at = (rank: number) => table[Math.min(Math.max(1, rank), table.length) - 1]!;
    const base = opts.anchor?.[pos] !== undefined ? at(opts.anchor[pos]!) : 0;
    let rank = 1;
    out[pos] = counts.map((n) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += at(rank++) - base;
      const v = n ? sum / n : 0;
      return floor ? Math.max(0, v) : v;
    });
  }
  return out;
}

/**
 * Rest-of-season value: the player's tier value at positions with tier values
 * (untiered = 0); rank value at positions the table lacks, and everywhere when
 * tiers aren't loaded.
 */
export function playerValue(v: Valuation, p: { pos: string; rosRank: number | undefined; tier: number | undefined }): number {
  const tv = v.tiers?.[p.pos];
  if (!tv) return rankValue(v, p.pos, p.rosRank);
  return p.tier === undefined ? 0 : (tv[p.tier - 1] ?? 0);
}

/** How far above replacement a rank sits (per game); zero for unranked players and positions the league doesn't start. */
export function rankValue(v: Pick<Valuation, "replacement" | "curves" | "floor">, pos: string, rank: number | undefined): number {
  const r = v.replacement[pos];
  if (rank === undefined || r === undefined) return 0;
  const curve = v.curves?.[pos];
  const raw = curve ? curvePoints(curve, rank) - curvePoints(curve, r + 1) : r + 1 - rank;
  return v.floor === false ? raw : Math.max(0, raw);
}

/**
 * Replacement rank per position from the league's lineup slots and team count.
 * With `bench` false the rank is the last starter league-wide (QB14 in a
 * 14-team one-QB league) rather than the last rosterable body.
 */
export function replacementRanks(league: EspnLeague, slots: Map<number, number>, bench = true): Record<string, number> {
  const teams = league.teams.length;
  const starters = new Map<string, number>();
  for (const [slotId, count] of slots) {
    const positions = SLOT_POSITIONS[slotId] ?? [];
    for (const pos of positions) starters.set(pos, (starters.get(pos) ?? 0) + count / positions.length);
  }
  const replacement: Record<string, number> = {};
  for (const [pos, perTeam] of starters) {
    replacement[pos] = Math.round(teams * perTeam) + (bench ? teams * (BENCH_ALLOWANCE[pos] ?? 1) : 0);
  }
  return replacement;
}
