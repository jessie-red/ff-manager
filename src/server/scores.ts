import { fetchLeague, type EspnAuth } from "../espn/client.js";
import { fetchProSchedules, playerGame, type PlayerGame } from "../espn/games.js";
import type { EspnLeague, EspnProTeam } from "../espn/types.js";
import { isStarter } from "../model/management.js";

export interface ScoresResponse {
  league: number;
  season: number;
  teamId: number;
  week: number;
  fetchedAt: string;
  scheduleError?: string;
  players: { playerId: number; slotId: number; actual: number | null; game: PlayerGame | null }[];
  /** Saved ESPN starters only; null when any starter has no actual stat line. */
  starterTotal: number | null;
}

export function scoreSnapshot(league: EspnLeague, teamId: number, schedules: EspnProTeam[] = []): ScoresResponse {
  const team = league.teams.find((t) => t.id === teamId);
  if (!team) throw new Error(`Team ${teamId} is not in this league.`);
  if (!team.roster) throw new Error("ESPN did not return this team's roster. Try refreshing.");
  const week = Math.max(1, league.scoringPeriodId);
  const players = team.roster.entries.map((entry) => {
    const stat = entry.playerPoolEntry.player.stats?.find((s) =>
      s.statSourceId === 0 && s.statSplitTypeId === 1 &&
      s.seasonId === league.seasonId && s.scoringPeriodId === week);
    const value = stat?.appliedTotal;
    return { playerId: entry.playerId, slotId: entry.lineupSlotId,
      game: playerGame(schedules, entry.playerPoolEntry.player.proTeamId, week),
      actual: typeof value === "number" && Number.isFinite(value) ? value : null };
  });
  const starters = players.filter((p) => isStarter(p.slotId));
  return {
    league: league.id, season: league.seasonId, teamId, week,
    fetchedAt: new Date().toISOString(), players,
    starterTotal: starters.some((p) => p.actual === null) ? null
      : starters.reduce((sum, p) => sum + p.actual!, 0),
  };
}

/** A fresh read, separate from roster editing and the expensive rating pipeline. */
export async function fetchLiveScores(leagueId: number, season: number, teamId: number, auth: EspnAuth): Promise<ScoresResponse> {
  const [league, schedules] = await Promise.all([
    fetchLeague(leagueId, season, auth, ["mTeam", "mRoster"], AbortSignal.timeout(15_000)),
    fetchProSchedules(season).then((teams) => ({ teams, error: undefined as string | undefined }),
      () => ({ teams: [] as EspnProTeam[], error: "Game times unavailable" })),
  ]);
  return { ...scoreSnapshot(league, teamId, schedules.teams), scheduleError: schedules.error };
}
