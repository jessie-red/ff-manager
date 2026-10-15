/**
 * Historical value curves: what a player who finishes the season at
 * positional rank r has scored, on average, over the last N seasons.
 *
 * For each season every player is scored with the league's rules, ranked
 * within his position by total points, and the totals are divided by the
 * regular-season length so 16- and 17-game seasons compare. Averaging across
 * seasons by rank gives one curve per position, in points per team-game.
 */
import { loadSeason, type SeasonLines } from "./data.js";
import type { Scorer } from "../sleeper/scoring.js";
import type { Curves } from "../model/value.js";

export { curvePoints, type Curves } from "../model/value.js";

/** Deepest rank kept per position; well past any league's replacement level. */
const DEPTH: Record<string, number> = { QB: 48, RB: 96, WR: 120, TE: 48, K: 40, "D/ST": 32 };
/** Sleeper's position label for D/ST, which the scorer keys its defensive table on. */
const SCORER_POS: Record<string, string> = { "D/ST": "DEF" };

/** Ranked points per team-game for one season. */
export function seasonCurves(lines: SeasonLines, scorer: Scorer): Curves {
  const totals = new Map<string, number[]>();
  const push = (pos: string, pts: number) => totals.set(pos, [...(totals.get(pos) ?? []), pts]);
  for (const p of lines.players) push(p.pos, scorer(p.stats, SCORER_POS[p.pos] ?? p.pos));
  const dst = new Map<string, number>();
  for (const d of lines.dst) dst.set(d.team, (dst.get(d.team) ?? 0) + scorer(d.stats, "DEF"));
  for (const pts of dst.values()) push("D/ST", pts);
  const out: Curves = {};
  for (const [pos, pts] of totals) {
    out[pos] = pts
      .sort((a, b) => b - a)
      .slice(0, DEPTH[pos] ?? 100)
      .map((x) => x / lines.weeks);
  }
  return out;
}

/** Rank-by-rank mean of several seasons' curves; a rank counts only in seasons that reached it. */
export function averageCurves(seasons: Curves[]): Curves {
  const out: Curves = {};
  for (const pos of new Set(seasons.flatMap((s) => Object.keys(s)))) {
    const depth = Math.max(...seasons.map((s) => s[pos]?.length ?? 0));
    out[pos] = Array.from({ length: depth }, (_, i) => {
      const xs = seasons.map((s) => s[pos]?.[i]).filter((x): x is number => x !== undefined);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    });
  }
  return out;
}

/** The `count` completed seasons before `season`, e.g. 2016-2025 for a 2026 league. */
export function historySeasons(season: number, count = 10): number[] {
  return Array.from({ length: count }, (_, i) => season - count + i);
}

export async function buildCurves(scorer: Scorer, seasons: number[]): Promise<Curves> {
  const lines = await Promise.all(seasons.map(loadSeason));
  return averageCurves(lines.map((l) => seasonCurves(l, scorer)));
}
