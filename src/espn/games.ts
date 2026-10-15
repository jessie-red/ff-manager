import type { EspnProTeam } from "./types.js";

export interface PlayerGame {
  kickoff: number | null;
  opponent: string | null;
  away: boolean;
  bye: boolean;
}

/** Share one public schedule read across dashboard cards for a minute. */
const cache = new Map<number, { expires: number; promise: Promise<EspnProTeam[]> }>();
export async function fetchProSchedules(season: number): Promise<EspnProTeam[]> {
  const existing = cache.get(season);
  if (existing && existing.expires > Date.now()) return existing.promise;
  const promise = (async () => {
    const response = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}?view=proTeamSchedules_wl`,
      { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`ESPN schedule ${response.status}`);
    const data = await response.json() as { settings?: { proTeams?: EspnProTeam[] } };
    if (!data.settings?.proTeams) throw new Error("ESPN schedule unavailable");
    return data.settings.proTeams;
  })();
  cache.set(season, { expires: Date.now() + 60_000, promise });
  try { return await promise; }
  catch (error) { if (cache.get(season)?.promise === promise) cache.delete(season); throw error; }
}

export function playerGame(teams: EspnProTeam[], teamId: number, week: number): PlayerGame | null {
  const team = teams.find((t) => t.id === teamId);
  if (!team) return null;
  if (team.byeWeek === week) return { kickoff: null, opponent: null, away: false, bye: true };
  const game = team.proGamesByScoringPeriod?.[week]?.[0];
  if (!game) return null;
  const away = game.awayProTeamId === teamId;
  return {
    kickoff: !game.startTimeTBD && Number.isFinite(game.date) ? game.date : null,
    opponent: teams.find((t) => t.id === (away ? game.homeProTeamId : game.awayProTeamId))?.abbrev ?? null,
    away, bye: false,
  };
}
