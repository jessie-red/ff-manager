/**
 * Projected records: who is supposed to win each remaining regular-season
 * matchup if every manager starts their best lineup. Each team's score for a
 * week is its optimal lineup by the average of ESPN's and Sleeper's weekly
 * projections (whichever of the two a player has); played matchups keep
 * their real result.
 */
import type { EspnLeague } from "../espn/types.js";
import { optimalLineup } from "./lineup.js";
import type { Player } from "./player.js";

export interface ProjectedGame {
  /** Matchup period (regular-season week). */
  week: number;
  opponentId: number;
  opponent: string;
  home: boolean;
  points: number;
  opponentPoints: number;
  result: "W" | "L" | "T";
  /** True when the matchup has been played and this is the real result. */
  actual: boolean;
}

export interface ProjectedRecord {
  wins: number;
  losses: number;
  ties: number;
  games: ProjectedGame[];
}

/** Regular-season matchups only: playoff games are seeded later and aren't on anyone's record. */
function regularSeason(league: EspnLeague) {
  const count = league.settings.scheduleSettings?.matchupPeriodCount ?? Infinity;
  return (league.schedule ?? []).filter((m) => m.matchupPeriodId <= count
    && (!m.playoffTierType || m.playoffTierType === "NONE") && m.away);
}

/** Scoring periods making up a matchup period; a plain week unless the league doubles up. */
function scoringPeriods(league: EspnLeague, matchupPeriod: number): number[] {
  return league.settings.scheduleSettings?.matchupPeriods?.[String(matchupPeriod)] ?? [matchupPeriod];
}

/** Every scoring period still to be projected: those of regular-season matchups without a result yet. */
export function unplayedWeeks(league: EspnLeague): number[] {
  const weeks = new Set<number>();
  for (const m of regularSeason(league)) {
    if (m.winner !== "UNDECIDED") continue;
    for (const w of scoringPeriods(league, m.matchupPeriodId)) weeks.add(w);
  }
  return [...weeks].sort((a, b) => a - b);
}

/**
 * Average of ESPN's and Sleeper's projections for a week, or whichever exists.
 * A player neither source projects (not fetched, or absent that week) is 0.
 */
export function blendedProjection(p: Player, week: number): number {
  const espn = p.espnByWeek[week];
  const sleeper = p.sleeper?.byWeek[week];
  if (espn !== undefined && sleeper !== undefined) return (espn + sleeper) / 2;
  return espn ?? sleeper ?? 0;
}

export function projectRecords(
  league: EspnLeague,
  rosters: Map<number, Player[]>,
  slots: Map<number, number>,
  projection: (p: Player, week: number) => number = blendedProjection,
): Map<number, ProjectedRecord> {
  const abbrev = new Map(league.teams.map((t) => [t.id, t.abbrev]));
  const records = new Map<number, ProjectedRecord>();
  const record = (id: number) => {
    let r = records.get(id);
    if (!r) records.set(id, (r = { wins: 0, losses: 0, ties: 0, games: [] }));
    return r;
  };
  const projectedPoints = (teamId: number, matchupPeriod: number) =>
    scoringPeriods(league, matchupPeriod).reduce((sum, week) => {
      const players = rosters.get(teamId) ?? [];
      const pts = (p: Player) => projection(p, week);
      return sum + optimalLineup(players, slots, { value: pts, points: pts }).points;
    }, 0);

  const matchups = regularSeason(league).sort((a, b) => a.matchupPeriodId - b.matchupPeriodId);
  for (const m of matchups) {
    const away = m.away!;
    const actual = m.winner !== "UNDECIDED";
    const homePts = actual ? m.home.totalPoints : projectedPoints(m.home.teamId, m.matchupPeriodId);
    const awayPts = actual ? away.totalPoints : projectedPoints(away.teamId, m.matchupPeriodId);
    const outcome = (mine: number, theirs: number): ProjectedGame["result"] =>
      mine > theirs ? "W" : mine < theirs ? "L" : "T";
    const homeResult: ProjectedGame["result"] = actual
      ? m.winner === "HOME" ? "W" : m.winner === "AWAY" ? "L" : "T"
      : outcome(homePts, awayPts);
    const awayResult: ProjectedGame["result"] = homeResult === "W" ? "L" : homeResult === "L" ? "W" : "T";

    for (const [side, opp, mine, theirs, result, home] of [
      [m.home, away, homePts, awayPts, homeResult, true],
      [away, m.home, awayPts, homePts, awayResult, false],
    ] as const) {
      const r = record(side.teamId);
      r.games.push({
        week: m.matchupPeriodId,
        opponentId: opp.teamId,
        opponent: abbrev.get(opp.teamId) ?? String(opp.teamId),
        home,
        points: mine,
        opponentPoints: theirs,
        result,
        actual,
      });
      if (result === "W") r.wins++;
      else if (result === "L") r.losses++;
      else r.ties++;
    }
  }
  for (const t of league.teams) record(t.id);
  return records;
}

export const recordLabel = (r: ProjectedRecord) => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`;
