import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nameKey, parseClay, POSITIONS, type Position, type PreseasonRecord,
  type StatLine, type WeeklyRecord } from "./data.js";

export const DATA_ROOT = fileURLToPath(new URL("../../data/uncertainty/", import.meta.url));
interface FeedRow {
  player_id: string; season: string; week: number; season_type: string;
  player?: { first_name: string; last_name: string; position: string; fantasy_positions?: string[] };
  stats?: StatLine; team?: string; game_id?: string; date?: string; last_modified?: number;
}
// Reviewed against the downloaded Sleeper identities. Never guess matches by fuzzy distance.
const ALIASES: Record<string, string> = {
  "Nathan Carter": "Nate Carter", "Josh Palmer": "Joshua Palmer", "Andrew Ogletree": "Drew Ogletree",
  "D'Wayne Eskridge": "Dee Eskridge", "Kyle T. Williams": "Kyle Williams", "Kenneth Gainwell": "Kenny Gainwell",
  "Ken Walker III": "Kenneth Walker", "Cameron Ward": "Cam Ward", "Chigoziem Okonkwo": "Chig Okonkwo",
  "Bill Croskey-Merritt": "Jacory Croskey-Merritt",
};
// Clay's 2025 offensive roles, versus mutable current Sleeper roster positions.
const POSITION_2025: Record<string, Position> = { "10994": "RB", "8181": "TE" };
function positionOf(row: FeedRow, season: number): Position | undefined {
  return (season === 2025 ? POSITION_2025[row.player_id] : undefined)
    ?? row.player?.fantasy_positions?.find(p => POSITIONS.includes(p as Position)) as Position | undefined
    ?? (POSITIONS.includes(row.player?.position as Position) ? row.player!.position as Position : undefined);
}
function sumStats(lines: StatLine[]): StatLine {
  const result: StatLine = {};
  // Season totals only for additive quantities: don't sum ranks, longest plays, or rates.
  const additive = new Set(["gp", "gms_active", "gs", "off_snp", "pass_att", "pass_cmp", "pass_yd",
    "pass_td", "pass_int", "pass_sack", "rush_att", "rush_yd", "rush_td", "rec_tgt", "rec", "rec_yd",
    "rec_td", "fum", "fum_lost", "pass_2pt", "rush_2pt", "rec_2pt", "pts_std", "pts_half_ppr", "pts_ppr"]);
  for (const line of lines) for (const [k, v] of Object.entries(line)) {
    if (additive.has(k)) result[k] = (result[k] ?? 0) + v;
  }
  return result;
}
function participating(row: FeedRow): boolean {
  const s = row.stats ?? {};
  if (row.player?.position === "DEF") return s.gp === 1;
  if (row.player?.position === "K") return s.gp === 1 && (s.gms_active ?? 1) === 1;
  return (s.off_snp ?? 0) > 0 || (s.pass_att ?? 0) > 0 || (s.rush_att ?? 0) > 0 || (s.rec_tgt ?? 0) > 0;
}

export async function prepare(): Promise<{ weekly: WeeklyRecord[]; preseason: PreseasonRecord[]; audit: object }> {
  const sources = JSON.parse(await readFile(DATA_ROOT + "sources.json", "utf8")) as
    { path: string; sha256: string }[];
  for (const source of sources) {
    const bytes = await readFile(DATA_ROOT + source.path);
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
      throw new Error(`Source checksum mismatch: ${source.path}`);
    }
  }
  const manifest = new Set(sources.map(s => s.path));
  const requireSource = (path: string) => {
    if (!manifest.has(path)) throw new Error(`Missing source provenance: ${path}; run uncertainty:download`);
  };
  const weekly: WeeklyRecord[] = [];
  const names = new Map<string, Set<string>>();
  const excluded = { unsupportedPosition: 0, noGameOrStatLine: 0 };
  for (const season of [2023, 2024, 2025]) for (let week = 1; week <= 18; week++) {
    const load = async (kind: string) => {
      const path = `raw/sleeper-${kind}-${season}-${week}.json.gz`;
      requireSource(path);
      const rows = JSON.parse(gunzipSync(await readFile(DATA_ROOT + path)).toString()) as FeedRow[];
      if (!Array.isArray(rows) || !rows.length) throw new Error(`Empty feed: ${path}`);
      const map = new Map<string, FeedRow>();
      for (const row of rows) {
        if (+row.season !== season || row.week !== week || row.season_type !== "regular") {
          throw new Error(`Wrong season/week: ${path}`);
        }
        const position = positionOf(row, season);
        if (!position) { excluded.unsupportedPosition++; continue; }
        if (season === 2025) {
          const key = `${position}:${nameKey(`${row.player!.first_name} ${row.player!.last_name}`)}`;
          if (!names.has(key)) names.set(key, new Set());
          names.get(key)!.add(row.player_id);
        }
        if (!row.stats || !row.game_id || !row.date || row.stats.gp !== 1) {
          excluded.noGameOrStatLine++; continue;
        }
        if (Object.values(row.stats).some(v => typeof v !== "number" || !Number.isFinite(v))) {
          throw new Error(`Non-numeric stats: ${path}/${row.player_id}`);
        }
        if (map.has(row.player_id)) throw new Error(`Duplicate feed row: ${path}/${row.player_id}`);
        map.set(row.player_id, row);
      }
      return map;
    };
    const [proj, actual] = await Promise.all([load("projections"), load("stats")]);
    for (const id of new Set([...proj.keys(), ...actual.keys()])) {
      const p = proj.get(id), a = actual.get(id), row = a ?? p!;
      // Use game-record team, never today's team or today's injury status from .player.
      weekly.push({ season, week, playerId: id,
        name: `${row.player!.first_name} ${row.player!.last_name}`, position: positionOf(row, season)!,
        team: row.team ?? null, gameId: row.game_id ?? null, date: row.date ?? null,
        projectionGameId: p?.game_id ?? null, gameMismatch: !!(p && a && p.game_id !== a.game_id),
        projected: p?.stats ?? null, actual: a?.stats ?? null, participated: a ? participating(a) : false,
        projectionModifiedAt: p?.last_modified ?? null,
        projectionModifiedAfterGameDate: p?.last_modified && p.date
          ? p.last_modified >= Date.parse(p.date + "T00:00:00Z") + 86_400_000 : null });
    }
  }
  weekly.sort((a, b) => a.season - b.season || a.week - b.week || a.playerId.localeCompare(b.playerId));
  requireSource("raw/espn-clay-2025.pdf");
  const text = execFileSync("pdftotext", ["-layout", DATA_ROOT + "raw/espn-clay-2025.pdf", "-"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const preseason: PreseasonRecord[] = parseClay(text).map(p => {
    const alias = ALIASES[p.name];
    const ids = [...(names.get(`${p.position}:${nameKey(alias ?? p.name)}`) ?? [])];
    if (ids.length > 1) throw new Error(`Ambiguous preseason match: ${p.name}: ${ids}`);
    const id = ids[0];
    const outcomes = id ? weekly.filter(w => w.season === 2025 && w.playerId === id && w.actual) : [];
    const active = outcomes.filter(w => w.participated);
    return { ...p, playerId: id ?? null, match: id ? alias ? "reviewed-alias" : "unique-name-position" : "unmatched",
      // No endpoint outcome is NOT proof of zero season points. Leave it unobserved.
      actual: outcomes.length ? sumStats(outcomes.map(w => w.actual!)) : null,
      activeActual: outcomes.length ? sumStats(active.map(w => w.actual!)) : null,
      activeGames: outcomes.length ? active.length : null };
  });
  const audit = {
    sourceFiles: sources.length, seasons: [2023, 2024, 2025], weeksPerSeason: 18,
    weeklyRows: weekly.length, rawFeedExclusions: excluded,
    missingWeeklyProjection: weekly.filter(w => !w.projected).length,
    missingWeeklyActual: weekly.filter(w => !w.actual).length,
    gameMismatches: weekly.filter(w => w.gameMismatch).map(w => ({ season: w.season, week: w.week,
      playerId: w.playerId, name: w.name, gameId: w.gameId, projectionGameId: w.projectionGameId })),
    nonParticipatingWithActual: weekly.filter(w => w.actual && !w.participated).length,
    projectionModifiedAfterGameDate: weekly.filter(w => w.projectionModifiedAfterGameDate).length,
    preseasonPlayers: preseason.length,
    preseasonGameCountExceptions: preseason.filter(p => p.projectedGames !== 17)
      .map(p => ({ name: p.name, projectedGames: p.projectedGames })),
    reviewedAliases: ALIASES, reviewed2025PositionOverrides: POSITION_2025,
    unmatchedPreseason: preseason.filter(p => !p.playerId).map(p => ({ name: p.name, position: p.position })),
    unobservedSeasonOutcome: preseason.filter(p => !p.actual).map(p => ({ name: p.name, playerId: p.playerId })),
  };
  await writeFile(DATA_ROOT + "espn-clay-2025.txt", text);
  await writeFile(DATA_ROOT + "weekly.jsonl", weekly.map(w => JSON.stringify(w)).join("\n") + "\n");
  await writeFile(DATA_ROOT + "preseason-2025.json", JSON.stringify({
    season: 2025, forecastDate: "2025-09-04", forecastSource: "raw/espn-clay-2025.pdf",
    outcomeSource: "Sleeper 2025 regular-season weekly stats, weeks 1–18", players: preseason,
  }, null, 2) + "\n");
  return { weekly, preseason, audit };
}
