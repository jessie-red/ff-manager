/**
 * Rest-of-season value: what a roster spot is actually worth from here on.
 *
 * The ratings' other yardstick (value.ts) is a season-long VORP table keyed on
 * PRESEASON rank. In week 10 that answers the wrong question twice over: it
 * still prices a player by where he was drafted, and it still prices him for a
 * whole season that is more than half gone. This module answers the question
 * the ratings actually ask -- how much does this player win me between now and
 * the end of the year -- from the per-week projections both sources already
 * hand us, averaged (see schedule.ts blendedProjection).
 *
 * The value
 * ---------
 * A roster spot is not worth its points, it is worth its points OVER what the
 * spot would yield if you streamed it. Write `r` for replacement points per
 * game at the position, `W` for the remaining weeks, `g` for the weeks the
 * player is projected to actually play and `P` for his projected points:
 *
 *     holding him   = P + r * (W - g)     (you start a replacement on his byes
 *                                          and his missed weeks)
 *     streaming it  =     r * W
 *     difference    = P - r * g
 *
 * so `vorp = P - r * g`. Two things fall out of that derivation rather than
 * being bolted on. Byes and missed games cost value in exact proportion to the
 * games missed and no more, because those weeks are not empty -- somebody else
 * starts. And the value shrinks as the season runs down, which is correct: two
 * remaining games of RB5-over-RB40 really are worth less than twelve.
 *
 * Rate and availability
 * ---------------------
 * `P` and `g` are kept separately because they are the two things a manager is
 * actually trading off. `ppg = P / g` is the scoring RATE when the player is on
 * the field -- an injured stud and a rookie whose season totals lag both keep a
 * high rate while their `points` collapse -- and `games` is availability. The
 * ratings want `vorp`; a trade view wanting "what am I getting when he's back"
 * wants `ppg`.
 *
 * A week counts as a game for whichever sources project one: Sleeper zeroes a
 * week it has no game for, ESPN zeroes byes, and when the two disagree (Sleeper
 * knows he is out, ESPN has not caught up) the week counts as half a game and
 * carries the halved projection blendedProjection already gives it. No
 * threshold to tune.
 *
 * Replacement level
 * -----------------
 * Read off the league, not a table: rank the position by rest-of-season POINTS,
 * take the player at the replacement rank from value.ts (league-wide starters
 * plus one bench body per team; K and D/ST get no bench body), and use his ppg.
 *
 * Ranking by points and reading a rate off the result is deliberate. `r` is a
 * rate, but the question "who is the marginal rosterable body at this position"
 * is a question about total worth: a backup QB projected to start twice scores
 * at a starter's rate for those two weeks and is nobody's replacement, yet on a
 * ppg ladder he sits among the QB2s and drags the whole position's replacement
 * up with him. Ranked by points he falls where he belongs. Having identified
 * the body that way, his ppg is what the spot yields on a week you start him.
 *
 * The band of ranks either side contributes its MEDIAN ppg, not its mean, so a
 * neighbour on a short season -- high rate, few games, correctly placed by
 * points -- can't reprice the position either.
 *
 * The ladder has to include FREE AGENTS, not just rostered players. Rostered
 * players don't reach the replacement rank at the thin positions -- a 14-team
 * league rosters ~25 QBs against a replacement rank of 28 -- and the tail that
 * does reach it at the deep ones is handcuffs and stashes projected for
 * nothing, which is not who you would actually stream. Both mistakes read
 * replacement too low and inflate every value at the position. Sleeper is the
 * only source here that covers unrostered players, so freeAgents() completes
 * the ladder from its projections; without it the baseline falls back to the
 * rostered population and the note above applies.
 */
import type { EspnLeague } from "../espn/types.js";
import { nameKey, type SleeperProjections } from "../sleeper/client.js";
import type { Player } from "./player.js";
import { blendedProjection, unplayedWeeks } from "./schedule.js";
import { replacementRanks } from "./value.js";

/** One player's rest-of-season projection, in league scoring. */
export interface RosProjection {
  /** Projected points over the remaining weeks, ESPN and Sleeper averaged. */
  points: number;
  /** Remaining weeks he is projected to play; byes and missed weeks don't count, split weeks count a half. */
  games: number;
  /** points / games: the scoring rate while active, independent of how many games he'll get. */
  ppg: number;
  /** points - replacement ppg * games. Not floored: below-replacement bench players stay ordered. */
  vorp: number;
}

/** Everything behind the rest-of-season values, and the values themselves. */
export interface RosValuation {
  /** Scoring periods the projections cover. */
  weeks: number[];
  /** Replacement-level points per game, by position. */
  replacement: Record<string, number>;
  /** Positional rank each replacement level was read at. */
  replacementRank: Record<string, number>;
  /** By ESPN player id. */
  byPlayer: Map<number, RosProjection>;
}

/** Ranks taken either side of the replacement rank, so one bad projection can't reprice a position. */
const SMOOTH = 1;

/** Remaining scoring periods to project: unplayed regular-season weeks from `week` on. */
export function rosWeeks(league: EspnLeague, week: number): number[] {
  const weeks = unplayedWeeks(league).filter((w) => w >= week);
  return weeks.length ? weeks : [week];
}

/**
 * Whether a week is a game, as the sources see it: 1 when every source that
 * covers the week projects points, 0 when none does, 0.5 when they split.
 * Mirrors blendedProjection, so points and games stay in the same currency.
 */
function weekGames(p: Player, week: number): number {
  const played = (pts: number | undefined) => (pts === undefined ? undefined : pts > 0 ? 1 : 0);
  const espn = played(p.espnByWeek[week]);
  const sleeper = played(p.sleeper?.byWeek[week]);
  if (espn !== undefined && sleeper !== undefined) return (espn + sleeper) / 2;
  return espn ?? sleeper ?? 0;
}

/** Points and games a player is projected for over `weeks`, before any replacement level is applied. */
export function rosProjection(p: Player, weeks: number[]): Omit<RosProjection, "vorp"> {
  let points = 0;
  let games = 0;
  for (const w of weeks) {
    points += blendedProjection(p, w);
    games += weekGames(p, w);
  }
  return { points, games, ppg: games ? points / games : 0 };
}

/** A rung of a positional ladder: a projection plus the position it's ranked at. */
export interface RosPoolEntry extends Omit<RosProjection, "vorp"> {
  pos: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Replacement points per game at each position the league starts: rank the
 * players projected to play by rest-of-season POINTS, then take the median ppg
 * of the band around the replacement rank. Positions with nobody deep enough
 * take their last body. This ranking is internal to the valuation -- the rank
 * a player is shown at is still ESPN's consensus (Player.rosRank), and the
 * replacement rank reported is still value.ts's.
 */
function replacementPpg(
  pool: RosPoolEntry[],
  ranks: Record<string, number>,
): { ppg: Record<string, number>; rank: Record<string, number> } {
  const byPos = new Map<string, RosPoolEntry[]>();
  for (const e of pool) {
    if (e.games <= 0 || ranks[e.pos] === undefined) continue;
    const list = byPos.get(e.pos) ?? [];
    list.push(e);
    byPos.set(e.pos, list);
  }
  const ppg: Record<string, number> = {};
  const rank: Record<string, number> = {};
  for (const [pos, target] of Object.entries(ranks)) {
    const sorted = (byPos.get(pos) ?? []).sort((a, b) => b.points - a.points);
    if (!sorted.length) {
      ppg[pos] = 0;
      rank[pos] = target;
      continue;
    }
    const at = Math.min(target, sorted.length);
    const lo = Math.max(1, at - SMOOTH);
    const hi = Math.min(sorted.length, at + SMOOTH);
    ppg[pos] = median(sorted.slice(lo - 1, hi).map((e) => e.ppg));
    rank[pos] = at;
  }
  return { ppg, rank };
}

/**
 * Everyone Sleeper projects who isn't on a roster, as replacement-level
 * candidates. `rostered` holds the poolKey() of every rostered player, since
 * they're already in the ladder with better (blended) numbers.
 */
export function freeAgents(sleeper: SleeperProjections, rostered: Set<string>, weeks: number[]): RosPoolEntry[] {
  const out: RosPoolEntry[] = [];
  for (const p of sleeper.all) {
    if (rostered.has(p.key)) continue;
    let points = 0;
    let games = 0;
    for (const w of weeks) {
      const pts = p.proj.byWeek[w] ?? 0;
      if (pts <= 0) continue;
      points += pts;
      games++;
    }
    if (games) out.push({ pos: p.pos, points, games, ppg: points / games });
  }
  return out;
}

/** How a rostered player is matched to Sleeper's list: position and normalized name, D/ST by team. */
export function poolKey(p: Pick<Player, "pos" | "name" | "team">): string {
  return `${p.pos}:${p.pos === "D/ST" ? p.team : nameKey(p.name)}`;
}

/**
 * Rest-of-season values for every rostered player in the league.
 * `extra` adds unrostered players to the replacement-level population only;
 * they get no entry in `byPlayer`.
 */
export function buildRos(
  league: EspnLeague,
  week: number,
  rosters: Player[][],
  slots: Map<number, number>,
  sleeper?: SleeperProjections,
): RosValuation {
  const weeks = rosWeeks(league, week);
  const byPlayer = new Map<number, RosProjection>();
  const pool: RosPoolEntry[] = [];
  const rostered = new Set<string>();
  for (const players of rosters) {
    for (const p of players) {
      if (byPlayer.has(p.id)) continue;
      const proj = rosProjection(p, weeks);
      byPlayer.set(p.id, { ...proj, vorp: 0 });
      pool.push({ pos: p.pos, ...proj });
      rostered.add(poolKey(p));
    }
  }
  if (sleeper) pool.push(...freeAgents(sleeper, rostered, weeks));

  const ranks = replacementRanks(league, slots);
  const { ppg: replacement, rank: replacementRank } = replacementPpg(pool, ranks);

  for (const players of rosters) {
    for (const p of players) {
      const proj = byPlayer.get(p.id)!;
      const r = replacement[p.pos];
      proj.vorp = r === undefined ? 0 : proj.points - r * proj.games;
    }
  }
  return { weeks, replacement, replacementRank, byPlayer };
}

/** Hang each player's projection on the Player, so the API response carries it without a second index. */
export function annotateRos(ros: RosValuation, rosters: Player[][]): void {
  for (const players of rosters) for (const p of players) p.ros = ros.byPlayer.get(p.id);
}
