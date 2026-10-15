import { fetchProSchedules, playerGame, type PlayerGame } from "../espn/games.js";
import { scoreSnapshot } from "./scores.js";
import { POSITION_NAMES, PRO_TEAMS } from "../espn/constants.js";

export interface MatchupTeam {
  teamId: number;
  name: string;
  points: number | null;
  /** Current-week roster actuals, not cumulative multi-week matchup totals. */
  players: { playerId: number; name: string; position: string; nflTeam: string; slotId: number; actual: number | null; injuryStatus: string; game: PlayerGame | null }[] | null;
}
import { fetchLeague, type EspnAuth } from "../espn/client.js";
import type { EspnLeague, EspnMatchupSide, EspnProTeam } from "../espn/types.js";

export interface MatchupResponse {
  league: number;
  season: number;
  week: number;
  matchupPeriod: number;
  fetchedAt: string;
  scheduleError?: string;
  matchups: {
    id: number;
    status: "active" | "final" | "bye";
    mine: MatchupTeam;
    opponent: MatchupTeam | null;
  }[];
}

/** Matchup totals are authoritative, including multi-week playoff matchups. */
export function matchupSnapshot(league: EspnLeague, teamId: number, schedules: EspnProTeam[] = []): MatchupResponse {
  if (!league.teams.some((t) => t.id === teamId)) throw new Error(`Team ${teamId} is not in this league.`);
  if (!league.schedule) throw new Error("ESPN did not return the matchup schedule.");
  const week = Math.max(1, league.scoringPeriodId);
  const mapped = Object.entries(league.settings.scheduleSettings?.matchupPeriods ?? {})
    .find(([, weeks]) => weeks.includes(week));
  const matchupPeriod = league.status?.currentMatchupPeriod ?? (mapped ? Number(mapped[0]) : week);
  const side = (s: EspnMatchupSide): MatchupTeam => {
    const team = league.teams.find((t) => t.id === s.teamId);
    const actuals = team?.roster ? new Map(scoreSnapshot(league, s.teamId).players.map((p) => [p.playerId, p.actual])) : null;
    return {
      teamId: s.teamId,
      name: team?.name.trim() || `Team ${s.teamId}`,
      points: typeof s.totalPointsLive === "number" && Number.isFinite(s.totalPointsLive) ? s.totalPointsLive
        : typeof s.totalPoints === "number" && Number.isFinite(s.totalPoints) ? s.totalPoints : null,
      players: team?.roster?.entries.map((e) => ({
        playerId: e.playerId, slotId: e.lineupSlotId,
        name: e.playerPoolEntry.player.fullName,
        injuryStatus: e.playerPoolEntry.player.injuryStatus ?? e.injuryStatus ?? "ACTIVE",
        game: playerGame(schedules, e.playerPoolEntry.player.proTeamId, week),
        position: POSITION_NAMES[e.playerPoolEntry.player.defaultPositionId] ?? "–",
        nflTeam: PRO_TEAMS[e.playerPoolEntry.player.proTeamId] ?? "–",
        actual: actuals?.get(e.playerId) ?? null,
      })) ?? null,
    };
  };
  return {
    league: league.id, season: league.seasonId, week, matchupPeriod, fetchedAt: new Date().toISOString(),
    matchups: league.schedule.filter((m) => m.matchupPeriodId === matchupPeriod &&
      (m.home.teamId === teamId || m.away?.teamId === teamId)).map((m) => {
      const mine = m.home.teamId === teamId ? m.home : m.away!;
      const opponent = m.home.teamId === teamId ? m.away : m.home;
      return { id: m.id, mine: side(mine), opponent: opponent ? side(opponent) : null,
        status: !opponent ? "bye" : ["HOME", "AWAY", "TIE"].includes(m.winner) ? "final" : "active" };
    }),
  };
}

export async function fetchLiveMatchup(league: number, season: number, teamId: number, auth: EspnAuth) {
  const [data, schedules] = await Promise.all([
    fetchLeague(league, season, auth, ["mTeam", "mMatchup", "mSettings", "mRoster", "mMatchupScore"], AbortSignal.timeout(15_000)),
    fetchProSchedules(season).then((teams) => ({ teams, error: undefined as string | undefined }),
      () => ({ teams: [] as EspnProTeam[], error: "Game times unavailable" })),
  ]);
  return { ...matchupSnapshot(data, teamId, schedules.teams), scheduleError: schedules.error };
}
