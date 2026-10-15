import type { EspnLeague, EspnPlayer, EspnPoolEntry, EspnProTeam } from "./types.js";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

export interface EspnAuth {
  swid: string;
  espnS2: string;
}

export function authFromEnv(): EspnAuth {
  const swid = process.env.ESPN_SWID;
  const espnS2 = process.env.ESPN_S2;
  if (!swid || !espnS2) {
    throw new Error("ESPN_SWID and ESPN_S2 must be set (see .env.example)");
  }
  return { swid, espnS2 };
}

export async function fetchLeague(
  leagueId: number,
  season: number,
  auth: EspnAuth,
  views: string[] = ["mTeam", "mRoster", "mSettings", "mMatchup"],
  signal?: AbortSignal,
): Promise<EspnLeague> {
  const url = new URL(`${BASE}/seasons/${season}/segments/0/leagues/${leagueId}`);
  for (const v of views) url.searchParams.append("view", v);

  const res = await fetch(url, {
    signal,
    headers: {
      Cookie: `SWID=${auth.swid}; espn_s2=${auth.espnS2}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ESPN ${res.status} for league ${leagueId}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as EspnLeague;
  if (!data.teams) throw new Error(`League ${leagueId}: response has no teams (private league / bad cookies?)`);
  return data;
}

/** Projected points by player id, then by scoring period, in league scoring. */
export type WeeklyProjections = Map<number, Map<number, number>>;

/**
 * ESPN's per-week projections for a set of players. The roster payload only
 * carries the current scoring period's projection, but the player-info view
 * serves any week when asked with `scoringPeriodId`, so this makes one request
 * per week (in parallel; ~1 MB and ~100 ms each for a full league's rosters).
 */
export async function fetchWeeklyProjections(
  league: EspnLeague,
  playerIds: number[],
  weeks: number[],
  auth: EspnAuth,
): Promise<WeeklyProjections> {
  const out: WeeklyProjections = new Map();
  if (!playerIds.length || !weeks.length) return out;
  const url = new URL(`${BASE}/seasons/${league.seasonId}/segments/0/leagues/${league.id}`);
  url.searchParams.set("view", "kona_player_info");
  await Promise.all(
    weeks.map(async (week) => {
      const u = new URL(url);
      u.searchParams.set("scoringPeriodId", String(week));
      const filter = { players: { filterIds: { value: playerIds }, filterStatsForCurrentSeasonScoringPeriodId: { value: [week] } } };
      const res = await fetch(u, {
        headers: {
          Cookie: `SWID=${auth.swid}; espn_s2=${auth.espnS2}`,
          Accept: "application/json",
          "x-fantasy-filter": JSON.stringify(filter),
        },
      });
      if (!res.ok) throw new Error(`ESPN ${res.status} for week ${week} projections: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      const data = (await res.json()) as { players?: { player: EspnPlayer }[] };
      for (const { player } of data.players ?? []) {
        const stat = (player.stats ?? []).find(
          (s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.seasonId === league.seasonId && s.scoringPeriodId === week,
        );
        if (!stat) continue;
        const byWeek = out.get(player.id) ?? new Map<number, number>();
        byWeek.set(week, stat.appliedTotal ?? 0);
        out.set(player.id, byWeek);
      }
    }),
  );
  return out;
}

/**
 * Full player records (ranks, projections, eligibility) for a set of player
 * ids, whether or not they're on a roster. One request; the league context
 * makes the projections come back in league scoring.
 */
export async function fetchPlayers(league: EspnLeague, playerIds: number[], auth: EspnAuth): Promise<Map<number, EspnPlayer>> {
  const out = new Map<number, EspnPlayer>();
  if (!playerIds.length) return out;
  const url = new URL(`${BASE}/seasons/${league.seasonId}/segments/0/leagues/${league.id}`);
  url.searchParams.set("view", "kona_player_info");
  const filter = { players: { filterIds: { value: playerIds } } };
  const res = await fetch(url, {
    headers: {
      Cookie: `SWID=${auth.swid}; espn_s2=${auth.espnS2}`,
      Accept: "application/json",
      "x-fantasy-filter": JSON.stringify(filter),
    },
  });
  if (!res.ok) throw new Error(`ESPN ${res.status} for player info: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { players?: { player: EspnPlayer }[] };
  for (const { player } of data.players ?? []) out.set(player.id, player);
  return out;
}

/** Lineup slots the pool is drawn from: the six positions a fantasy football league starts. */
const POOL_SLOTS = [0, 2, 4, 6, 16, 17];

/**
 * The top of the league's player pool, rostered or not, in ESPN's pre-draft
 * rank order: the first `limit` players by draft rank at QB/RB/WR/TE/K/D-ST
 * with full records (ranks, projections, ADP) in league scoring. ~1 MB and
 * ~100 ms for 500 players. Each entry says which fantasy team rosters the
 * player, which after a draft is who drafted them.
 */
export async function fetchPlayerPool(league: EspnLeague, auth: EspnAuth, limit = 500, week?: number): Promise<EspnPoolEntry[]> {
  const url = new URL(`${BASE}/seasons/${league.seasonId}/segments/0/leagues/${league.id}`);
  url.searchParams.set("view", "kona_player_info");
  if (week !== undefined) url.searchParams.set("scoringPeriodId", String(week));
  const rankType = league.settings.scoringSettings?.playerRankType ?? "PPR";
  const filter = {
    players: {
      filterSlotIds: { value: POOL_SLOTS },
      ...(week === undefined ? {} : { filterStatsForCurrentSeasonScoringPeriodId: { value: [week] } }),
      limit,
      offset: 0,
      sortDraftRanks: { sortPriority: 1, sortAsc: true, value: rankType },
    },
  };
  const res = await fetch(url, {
    headers: {
      Cookie: `SWID=${auth.swid}; espn_s2=${auth.espnS2}`,
      Accept: "application/json",
      "x-fantasy-filter": JSON.stringify(filter),
    },
  });
  if (!res.ok) throw new Error(`ESPN ${res.status} for player pool: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { players?: EspnPoolEntry[] };
  return data.players ?? [];
}

/** Bye week by pro team id for a season, from ESPN's season-level schedule view. */
export async function fetchByeWeeks(season: number, auth: EspnAuth): Promise<Map<number, number>> {
  const res = await fetch(`${BASE}/seasons/${season}?view=proTeamSchedules_wl`, {
    headers: { Cookie: `SWID=${auth.swid}; espn_s2=${auth.espnS2}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`ESPN ${res.status} for pro team schedules: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { settings?: { proTeams?: EspnProTeam[] } };
  const out = new Map<number, number>();
  for (const t of data.settings?.proTeams ?? []) if (t.byeWeek) out.set(t.id, t.byeWeek);
  return out;
}

/** One fantasy football team the logged-in user manages, from ESPN's fan preferences. */
export interface MyTeam {
  leagueId: number;
  leagueName: string;
  leagueSize: number;
  season: number;
  teamId: number;
  teamName: string;
  logo: string | undefined;
}

interface FanPreference {
  type?: { code?: string };
  metaData?: {
    entry?: {
      abbrev?: string;
      seasonId: number;
      entryId: number;
      entryMetadata?: { teamName?: string };
      logoUrl?: string;
      groups?: { groupId: number; groupName: string; groupSize?: number }[];
    };
  };
}

export async function fetchMyTeams(auth: EspnAuth): Promise<MyTeam[]> {
  const url = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(auth.swid)}?platform=web&source=espncom-fantasy`;
  const res = await fetch(url, {
    headers: { Cookie: `SWID=${auth.swid}; espn_s2=${auth.espnS2}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`ESPN fan API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { preferences?: FanPreference[] };

  const out: MyTeam[] = [];
  for (const p of data.preferences ?? []) {
    const e = p.metaData?.entry;
    if (p.type?.code !== "fantasy" || !e || e.abbrev !== "FFL") continue;
    for (const g of e.groups ?? []) {
      out.push({
        leagueId: g.groupId,
        leagueName: g.groupName,
        leagueSize: g.groupSize ?? 0,
        season: e.seasonId,
        teamId: e.entryId,
        teamName: e.entryMetadata?.teamName ?? `Team ${e.entryId}`,
        logo: e.logoUrl,
      });
    }
  }
  return out.sort((a, b) => b.season - a.season || a.leagueName.localeCompare(b.leagueName));
}
