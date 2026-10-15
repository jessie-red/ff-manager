/**
 * Historical stat lines from nflverse, reshaped into the Sleeper-style stat
 * names that `sleeper/scoring.ts` scores with a league's ESPN rules.
 *
 * Sources (github.com/nflverse/nflverse-data releases, no auth):
 *   stats_player/stats_player_week_{season}.csv   every player-game, regular season
 *   stats_team/stats_team_week_{season}.csv       every team-game (for D/ST)
 *   nflverse/nfldata games.csv                    final scores (points allowed)
 *
 * Players are summed to one line per season, with ESPN's per-game yardage
 * bonuses (100/200 rush, 100/200 rec, 300/400 pass) counted from the weekly
 * rows. D/ST stays per game because points- and yards-allowed brackets are
 * scored game by game. Raw CSVs (~9 MB/season) and the reduced lines (~1 MB)
 * are cached under .cache/nflverse.
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./csv.js";
import type { Stats } from "../sleeper/scoring.js";

const CACHE = fileURLToPath(new URL("../../.cache/nflverse/", import.meta.url));
const RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";
const GAMES_URL = "https://github.com/nflverse/nfldata/raw/master/data/games.csv";
/** Bump when the reduction below changes so stale lines_*.json get rebuilt. */
const LINES_VERSION = 1;

/** Fantasy positions we rank; nflverse's FB folds into RB. */
const POSITIONS: Record<string, string> = { QB: "QB", RB: "RB", FB: "RB", WR: "WR", TE: "TE", K: "K" };

export interface PlayerLine {
  id: string;
  name: string;
  /** Position label as used in the rest of the app ("QB", "RB", ... "D/ST"). */
  pos: string;
  /** Regular-season games with a stat line. */
  games: number;
  stats: Stats;
}
export interface DstWeek {
  team: string;
  week: number;
  stats: Stats;
}
export interface SeasonLines {
  season: number;
  /** Regular-season weeks in the schedule (17 through 2020, 18 since). */
  weeks: number;
  players: PlayerLine[];
  dst: DstWeek[];
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function cached(name: string, url: string): Promise<string> {
  const path = CACHE + name;
  if (!(await exists(path))) {
    await mkdir(CACHE, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`nflverse: ${url} -> ${res.status}`);
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
  }
  return readFile(path, "utf8");
}

const n = (s: string | undefined): number => (s === undefined || s === "" || s === "NA" ? 0 : Number(s));
const add = (t: Stats, k: string, v: number) => {
  if (v) t[k] = (t[k] ?? 0) + v;
};

/** One player-game reduced to Sleeper stat names, including ESPN's per-game bonuses. */
function playerWeekStats(r: Record<string, string>): Stats {
  const s: Stats = {};
  const passYd = n(r.passing_yards), rushYd = n(r.rushing_yards), recYd = n(r.receiving_yards);
  add(s, "pass_att", n(r.attempts)); add(s, "pass_cmp", n(r.completions)); add(s, "pass_inc", n(r.attempts) - n(r.completions));
  add(s, "pass_yd", passYd); add(s, "pass_td", n(r.passing_tds)); add(s, "pass_int", n(r.passing_interceptions));
  add(s, "pass_2pt", n(r.passing_2pt_conversions)); add(s, "pass_sack", n(r.sacks_suffered));
  add(s, "rush_att", n(r.carries)); add(s, "rush_yd", rushYd); add(s, "rush_td", n(r.rushing_tds)); add(s, "rush_2pt", n(r.rushing_2pt_conversions));
  add(s, "rec", n(r.receptions)); add(s, "rec_tgt", n(r.targets)); add(s, "rec_yd", recYd); add(s, "rec_td", n(r.receiving_tds)); add(s, "rec_2pt", n(r.receiving_2pt_conversions));
  add(s, "fum", n(r.fumbles_total)); add(s, "fum_lost", n(r.fumbles_lost_total));
  add(s, "bonus_pass_yd_300", passYd >= 300 ? 1 : 0); add(s, "bonus_pass_yd_400", passYd >= 400 ? 1 : 0);
  add(s, "bonus_rush_yd_100", rushYd >= 100 ? 1 : 0); add(s, "bonus_rush_yd_200", rushYd >= 200 ? 1 : 0);
  add(s, "bonus_rec_yd_100", recYd >= 100 ? 1 : 0); add(s, "bonus_rec_yd_200", recYd >= 200 ? 1 : 0);
  // Kicking. ESPN counts a blocked kick as a miss.
  add(s, "fgm", n(r.fg_made)); add(s, "fga", n(r.fg_att)); add(s, "fgmiss", n(r.fg_missed) + n(r.fg_blocked));
  add(s, "fgm_0_19", n(r.fg_made_0_19)); add(s, "fgm_20_29", n(r.fg_made_20_29)); add(s, "fgm_30_39", n(r.fg_made_30_39));
  add(s, "fgm_40_49", n(r.fg_made_40_49)); add(s, "fgm_50_59", n(r.fg_made_50_59)); add(s, "fgm_60p", n(r.fg_made_60_));
  add(s, "fgmiss_0_19", n(r.fg_missed_0_19)); add(s, "fgmiss_20_29", n(r.fg_missed_20_29)); add(s, "fgmiss_30_39", n(r.fg_missed_30_39));
  add(s, "fgmiss_40_49", n(r.fg_missed_40_49)); add(s, "fgmiss_50p", n(r.fg_missed_50_59) + n(r.fg_missed_60_));
  add(s, "xpm", n(r.pat_made)); add(s, "xpa", n(r.pat_att)); add(s, "xpmiss", n(r.pat_missed) + n(r.pat_blocked));
  return s;
}

/** One team-game as a D/ST line. `opp` is the opponent's row from the same game. */
function dstWeekStats(r: Record<string, string>, opp: Record<string, string>, ptsAllowed: number): Stats {
  const s: Stats = {};
  add(s, "sack", n(r.def_sacks)); add(s, "int", n(r.def_interceptions)); add(s, "fum_rec", n(r.fumble_recovery_opp));
  add(s, "ff", n(r.def_fumbles_forced)); add(s, "safe", n(r.def_safeties));
  add(s, "blk_kick", n(r.def_punt_blocks) + n(r.def_pat_blocks) + n(r.def_fg_blocks));
  add(s, "def_td", n(r.def_tds) + n(r.fumble_recovery_tds)); add(s, "st_td", n(r.special_teams_tds));
  add(s, "def_kr_yd", n(r.kickoff_return_yards)); add(s, "pr_yd", n(r.punt_return_yards));
  s.pts_allow = ptsAllowed;
  // nflverse passing yards are gross; sack_yards_lost is already negative.
  s.yds_allow = n(opp.passing_yards) + n(opp.sack_yards_lost) + n(opp.rushing_yards);
  return s;
}

async function reduceSeason(season: number): Promise<SeasonLines> {
  const [playerCsv, teamCsv, gamesCsv] = await Promise.all([
    cached(`stats_player_week_${season}.csv`, `${RELEASE}/stats_player/stats_player_week_${season}.csv`),
    cached(`stats_team_week_${season}.csv`, `${RELEASE}/stats_team/stats_team_week_${season}.csv`),
    cached("games.csv", GAMES_URL),
  ]);

  const players = new Map<string, PlayerLine>();
  for (const r of parseCsv(playerCsv)) {
    if (r.season_type !== "REG") continue;
    const pos = POSITIONS[r.position ?? ""];
    if (!pos) continue;
    const line = players.get(r.player_id!) ?? { id: r.player_id!, name: r.player_display_name ?? "", pos, games: 0, stats: {} };
    line.games++;
    for (const [k, v] of Object.entries(playerWeekStats(r))) add(line.stats, k, v!);
    players.set(line.id, line);
  }

  const scores = new Map<string, Record<string, number>>();
  for (const g of parseCsv(gamesCsv)) {
    if (Number(g.season) !== season) continue;
    scores.set(g.game_id!, { [g.home_team!]: n(g.away_score), [g.away_team!]: n(g.home_score) });
  }
  const teamRows = parseCsv(teamCsv).filter((r) => r.season_type === "REG");
  const byGame = new Map<string, Record<string, string>[]>();
  for (const r of teamRows) byGame.set(r.game_id!, [...(byGame.get(r.game_id!) ?? []), r]);
  const dst: DstWeek[] = [];
  let weeks = 0;
  for (const r of teamRows) {
    const opp = byGame.get(r.game_id!)?.find((o) => o.team === r.opponent_team);
    const allowed = scores.get(r.game_id!)?.[r.team!];
    if (!opp || allowed === undefined) continue;
    weeks = Math.max(weeks, Number(r.week));
    dst.push({ team: r.team!, week: Number(r.week), stats: dstWeekStats(r, opp, allowed) });
  }
  return { season, weeks, players: [...players.values()], dst };
}

/** Reduced stat lines for one regular season, built from the CSVs on first use. */
export async function loadSeason(season: number): Promise<SeasonLines> {
  const path = `${CACHE}lines_v${LINES_VERSION}_${season}.json`;
  if (await exists(path)) return JSON.parse(await readFile(path, "utf8")) as SeasonLines;
  const lines = await reduceSeason(season);
  await mkdir(CACHE, { recursive: true });
  await writeFile(path, JSON.stringify(lines));
  return lines;
}
