import type { EspnLeague } from "../espn/types.js";
import { toPlayer, startingSlots, type Player } from "./player.js";
import { optimalLineup, type Lineup } from "./lineup.js";
import { playerValue, rankValue, replacementRanks, tierValues, type Curves, type Valuation } from "./value.js";
import type { Tiers } from "../tiers/lookup.js";
import type { VorpTable } from "../tiers/vorp.js";
import type { SleeperProjections } from "../sleeper/client.js";
import type { WeeklyProjections } from "../espn/client.js";
import { projectRecords, type ProjectedRecord } from "./schedule.js";
import type { Estimate } from "./simulation.js";
import { annotateRos, buildRos, type RosValuation } from "./ros.js";

/**
 * Positions that count toward the overall rating but get no position grade of
 * their own: their tier values are in the VORP table, so they belong in the
 * total, but a kicker ranking is noise nobody needs to see.
 */
export const HIDDEN_POSITIONS = new Set(["K", "D/ST"]);

export interface PositionScore {
  slot: string;
  /** Summed value of the team's starters in this slot type (K and D/ST get no entry; see HIDDEN_POSITIONS). */
  value: number;
  z: number;
  grade: string;
}

export interface TeamRating {
  teamId: number;
  abbrev: string;
  name: string;
  /** Manager's real name from their ESPN profile, or "" if they haven't set one. */
  owner: string;
  isMe: boolean;
  logo: string | undefined;
  record: string;
  championshipOdds?: import("./simulation.js").Estimate;
  /**
   * Mean regular-season record over the same simulated seasons the championship
   * odds come from, so the two columns tell one story. Absent whenever the
   * simulation didn't run; see championshipError.
   */
  simulatedRecord?: { wins: Estimate; losses: Estimate; ties: Estimate };
  championshipError?: string;
  /**
   * Regular-season record with unplayed matchups decided by optimal lineups
   * under the ESPN/Sleeper blended weekly projections (see schedule.ts), or
   * null when per-week projections weren't loaded. The deterministic
   * single-path projection; simulatedRecord is the sampled mean.
   */
  projected: ProjectedRecord | null;
  espnProjectedRank: number | undefined;
  /**
   * Optimal lineup by rest-of-season value over replacement (ros.ts) when the
   * per-week projections were loaded, and by tier value (rank value without
   * tiers) otherwise. `points` on it is each player's blended ESPN/Sleeper ROS
   * points per game (ESPN's season projection per game without ros.ts), so the
   * lineup total is the team's projected ppg.
   */
  ros: Lineup;
  /** Optimal lineup for the week by rank value from ESPN's weekly consensus ranks. */
  week: Lineup;
  /** Optimal lineups by Sleeper's projected points, or null when Sleeper data wasn't loaded. */
  sleeperRos: Lineup | null;
  sleeperWeek: Lineup | null;
  /** Rostered players ESPN projects for points but Sleeper has no match for. */
  sleeperUnmatched: string[];
  /**
   * Every bench player's value, K and D/ST excluded, graded on its own and not
   * part of `overall`. Unfloored rest-of-season VORP where that's available, so
   * a bench of near-replacement bodies still orders; rank value otherwise (tier
   * value zeroes out nearly every bench, which is why it isn't used here).
   */
  benchTotal: number;
  benchZ: number;
  benchGrade: string;
  /** Every starter's value, K and D/ST included. The bench doesn't count: it mostly measured who had a startable backup QB. */
  overall: number;
  overallZ: number;
  grade: string;
  positions: PositionScore[];
  rank: number;
}

export function zToGrade(z: number): string {
  if (z >= 1.5) return "A+";
  if (z >= 1.0) return "A";
  if (z >= 0.6) return "A-";
  if (z >= 0.3) return "B+";
  if (z >= 0.0) return "B";
  if (z >= -0.3) return "B-";
  if (z >= -0.6) return "C+";
  if (z >= -1.0) return "C";
  if (z >= -1.5) return "C-";
  return "D";
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stdev(xs: number[]): number {
  const m = mean(xs);
  const v = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(v) || 1;
}

/** Manager's real name by (lower-cased) member id, from their ESPN profiles. */
export function memberNames(league: EspnLeague): Map<string, string> {
  return new Map(
    (league.members ?? []).map((m) => [m.id.toLowerCase(), [m.firstName, m.lastName].filter(Boolean).join(" ").trim()]),
  );
}

/** Replacement ranks, curves and (when loaded) the season value of every Boris tier, sized from the tier lists. */
export function buildValuation(
  league: EspnLeague,
  slots: Map<number, number>,
  curves: Curves | null,
  tiers?: { tiers: Tiers; vorp: VorpTable },
): Valuation {
  const base = { replacement: replacementRanks(league, slots), curves };
  if (!tiers) return { ...base, tiers: null };
  const sizes = Object.fromEntries(Object.entries(tiers.tiers.tiers).map(([pos, ts]) => [pos, ts.map((t) => t.length)]));
  return { ...base, tiers: tierValues(sizes, tiers.vorp) };
}

export interface LeagueRating {
  /** Tier values, replacement ranks and historical curves behind every value (see value.ts). */
  valuation: Valuation;
  /**
   * Rest-of-season replacement levels and per-player projections (see ros.ts),
   * or null when no per-week projections were loaded and the ratings fell back
   * to `valuation`'s tier values.
   */
  ros: RosValuation | null;
  ratings: TeamRating[];
}

export function rateLeague(
  league: EspnLeague,
  week: number,
  mySwid?: string,
  sleeper?: SleeperProjections,
  curves: Curves | null = null,
  weekly?: WeeklyProjections,
  tiers?: { tiers: Tiers; vorp: VorpTable },
): LeagueRating {
  const slots = startingSlots(league);
  const rosters = new Map(
    league.teams.map((t) => [t.id, (t.roster?.entries ?? []).map((e) => toPlayer(e, league, week, sleeper, weekly, tiers?.tiers))]),
  );
  const projected = weekly ? projectRecords(league, rosters, slots) : null;
  const valuation = buildValuation(league, slots, curves, tiers);
  // Rest-of-season value needs per-week projections from at least one source;
  // with neither, every player would project zero games and the ratings fall
  // back to the preseason tier table.
  const ros = weekly || sleeper ? buildRos(league, week, [...rosters.values()], slots, sleeper) : null;
  if (ros) annotateRos(ros, [...rosters.values()]);
  const memberName = memberNames(league);
  const me = mySwid?.toLowerCase();

  const partial = league.teams.map((t) => {
    const players: Player[] = rosters.get(t.id) ?? [];
    const rosValue = ros ? (p: Player) => Math.max(0, p.ros?.vorp ?? 0) : (p: Player) => playerValue(valuation, p);
    // Points on the ROS lineup are the blended per-game rate the values were
    // built from, so the lineup's total reads as the team's ROS ppg; without
    // ros.ts there's no blend and ESPN's season average stands in.
    const rosPoints = ros ? (p: Player) => p.ros?.ppg ?? 0 : (p: Player) => p.rosPpg;
    const rosLineup = optimalLineup(players, slots, { value: rosValue, points: rosPoints, rank: (p) => p.rosRank });
    const wk = optimalLineup(players, slots, {
      value: (p) => rankValue(valuation, p.pos, p.weekRank),
      points: (p) => p.weekProj,
      rank: (p) => p.weekRank,
    });
    const sleeperPts = (f: (s: NonNullable<Player["sleeper"]>) => number) => (p: Player) => (p.sleeper ? f(p.sleeper) : 0);
    const sleeperRos = sleeper
      ? optimalLineup(players, slots, { value: sleeperPts((s) => s.rosPpg), points: sleeperPts((s) => s.rosPpg) })
      : null;
    const sleeperWeek = sleeper
      ? optimalLineup(players, slots, { value: sleeperPts((s) => s.weekProj), points: sleeperPts((s) => s.weekProj) })
      : null;
    const sleeperUnmatched = sleeper ? players.filter((p) => !p.sleeper && p.rosPpg > 0).map((p) => p.name) : [];
    const benchValue = ros ? (p: Player) => p.ros?.vorp ?? 0 : (p: Player) => rankValue(valuation, p.pos, p.rosRank);
    const benchTotal = rosLineup.bench.filter((p) => !HIDDEN_POSITIONS.has(p.pos)).reduce((a, p) => a + benchValue(p), 0);
    const startersValue = rosLineup.starters.reduce((a, s) => a + s.value, 0);
    const rec = t.record?.overall;
    const owners = (t.owners ?? []).map((o) => o.toLowerCase());
    return {
      teamId: t.id,
      abbrev: t.abbrev,
      name: t.name,
      owner: memberName.get(owners[0] ?? "") ?? "",
      isMe: me !== undefined && owners.includes(me),
      logo: t.logo,
      record: rec ? `${rec.wins}-${rec.losses}${rec.ties ? `-${rec.ties}` : ""}` : "",
      projected: projected?.get(t.id) ?? null,
      espnProjectedRank: t.currentProjectedRank,
      ros: rosLineup,
      week: wk,
      sleeperRos,
      sleeperWeek,
      sleeperUnmatched,
      benchTotal,
      overall: startersValue,
    };
  });

  // Positional groups: sum of starter value per slot type, compared across the league.
  // Hidden positions are in the overall but get no group of their own.
  const slotNames = [...new Set(partial.flatMap((t) => t.ros.starters.map((s) => s.slotName)))].filter(
    (name) => !HIDDEN_POSITIONS.has(name),
  );
  const slotTotals = new Map<string, number[]>();
  for (const name of slotNames) {
    slotTotals.set(
      name,
      partial.map((t) => t.ros.starters.filter((s) => s.slotName === name).reduce((a, s) => a + s.value, 0)),
    );
  }
  const slotStats = new Map([...slotTotals].map(([k, v]) => [k, { m: mean(v), sd: stdev(v) }]));

  const overalls = partial.map((t) => t.overall);
  const om = mean(overalls);
  const osd = stdev(overalls);
  const benches = partial.map((t) => t.benchTotal);
  const bm = mean(benches);
  const bsd = stdev(benches);

  const rated: TeamRating[] = partial.map((t) => {
    const overallZ = (t.overall - om) / osd;
    const benchZ = (t.benchTotal - bm) / bsd;
    const positions: PositionScore[] = slotNames.map((name) => {
      const value = t.ros.starters.filter((s) => s.slotName === name).reduce((a, s) => a + s.value, 0);
      const st = slotStats.get(name)!;
      const z = (value - st.m) / st.sd;
      return { slot: name, value, z, grade: zToGrade(z) };
    });
    return { ...t, overallZ, grade: zToGrade(overallZ), benchZ, benchGrade: zToGrade(benchZ), positions, rank: 0 };
  });

  rated.sort((a, b) => b.overall - a.overall);
  rated.forEach((t, i) => (t.rank = i + 1));
  return { valuation, ros, ratings: rated };
}
