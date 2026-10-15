/**
 * Sleeper projections, via the undocumented projections endpoint that the
 * Sleeper app itself uses. No auth. Each entry carries the player's name,
 * position and team plus a full projected stat line (pass_yd, rec_td, ...)
 * and Sleeper's own pts_ppr / pts_half_ppr / pts_std presets.
 *
 * Stat lines are rescored with the ESPN league's rules (see scoring.ts) when
 * those are available, falling back to the closest Sleeper preset otherwise.
 * Rest-of-season is the per-game average of the remaining weeks' projections.
 *
 * Players are joined to ESPN by normalized name + position (with team as a
 * tiebreaker): Sleeper's espn_id field is missing for most players drafted
 * since ~2023, so it's not usable as the primary key.
 */
import type { EspnLeague, EspnPlayer } from "../espn/types.js";
import { POSITION_NAMES, PRO_TEAMS } from "../espn/constants.js";
import { leagueScorer, type Scorer, type Stats } from "./scoring.js";

const BASE = "https://api.sleeper.app";
/** ESPN and Sleeper disagree on one position name. */
const ESPN_TO_SLEEPER_POS: Record<string, string> = { "D/ST": "DEF" };
const SLEEPER_TO_ESPN_POS: Record<string, string> = { DEF: "D/ST" };
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const LAST_WEEK = 18;

export type Scoring = "ppr" | "half" | "std";
/** "league" = rescored from stat lines with the ESPN league's rules; otherwise a Sleeper preset. */
export type ScoringSource = "league" | Scoring;

interface SleeperEntry {
  player_id: string;
  player: {
    first_name: string;
    last_name: string;
    position: string;
    /** e.g. ["DB", "WR"] for Travis Hunter; ESPN lists him at WR. */
    fantasy_positions: string[] | null;
    team: string | null;
  };
  stats: Stats;
}

export interface SleeperProj {
  /** Projected points for the requested week. */
  weekProj: number;
  /** Average of the remaining weeks' projections, over weeks the player is projected to play. */
  rosPpg: number;
  /**
   * Same average over every fetched week, i.e. from `fromWeek` on. Callers
   * that pass `fromWeek = 1` get a full-season points-per-game figure.
   */
  seasonPpg: number;
  /** Projected points by scoring period, for every week fetched; 0 on byes. */
  byWeek: Record<number, number>;
}

/**
 * One projected player, listed once at the position they're scored at.
 * `key` is the same `${ESPN position}:${normalized name}` the ratings build for
 * a rostered player, so the two sets can be merged (see model/ros.ts).
 */
export interface SleeperPlayer {
  key: string;
  /** ESPN's spelling of the position: D/ST, not DEF. */
  pos: string;
  name: string;
  team: string | null;
  proj: SleeperProj;
}

export interface SleeperProjections {
  season: number;
  week: number;
  scoring: ScoringSource;
  /** Keyed by `${pos}:${normalized name}`; value may hold several players if names collide. */
  byKey: Map<string, { team: string | null; proj: SleeperProj }[]>;
  /**
   * Every projected player exactly once, unlike `byKey` (which lists two-way
   * players under each of their positions). This is the only source that
   * covers UNROSTERED players, so it's what a waiver-wire replacement level is
   * read off.
   */
  all: SleeperPlayer[];
}

/** Strip suffixes, punctuation, diacritics and case so "A.J. Brown Jr." === "ajbrown". */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** ESPN and Sleeper mostly agree on team abbreviations; these are the exceptions. */
const TEAM_ALIAS: Record<string, string> = { WSH: "WAS", JAC: "JAX", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };
const teamKey = (t: string | null | undefined) => (t ? (TEAM_ALIAS[t] ?? t) : null);

const ptsField = (s: Scoring) => (s === "ppr" ? "pts_ppr" : s === "half" ? "pts_half_ppr" : "pts_std");

/** Closest Sleeper preset to the league's reception scoring; used only when the full rules are unavailable. */
export function leagueScoring(league: EspnLeague): Scoring {
  const rec = league.settings.scoringSettings?.scoringItems?.find((i) => i.statId === 53)?.points ?? 0;
  return rec >= 1 ? "ppr" : rec > 0 ? "half" : "std";
}

async function fetchEntries(season: number, week: number): Promise<SleeperEntry[]> {
  const url = new URL(`${BASE}/projections/nfl/${season}/${week}`);
  url.searchParams.set("season_type", "regular");
  for (const p of POSITIONS) url.searchParams.append("position[]", p);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Sleeper ${res.status} for ${season}/${week}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as SleeperEntry[];
}

const cache = new Map<string, { at: number; value: Promise<SleeperEntry[]> }>();
const TTL_MS = 10 * 60 * 1000;

/** One week's raw projections, memoized for a few minutes (~2 MB per week). */
function weekEntries(season: number, week: number): Promise<SleeperEntry[]> {
  const key = `${season}/${week}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = fetchEntries(season, week);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/**
 * Projections for `week` plus rest-of-season, scored with the league's rules.
 * Fetches every remaining week of the season (in parallel) to build the ROS
 * average; a player counts as playing a week when Sleeper lists a game (gp)
 * for them, so byes and missed weeks don't drag the average down.
 * `fromWeek` (default `week`) extends the per-week table further back, for
 * callers projecting matchups earlier than the displayed week.
 */
export async function fetchSleeperProjections(league: EspnLeague, week: number, fromWeek = week): Promise<SleeperProjections> {
  const season = league.seasonId;
  const scorer = leagueScorer(league);
  const preset = leagueScoring(league);
  const score: Scorer = scorer ?? ((stats) => stats[ptsField(preset)] ?? 0);

  const first = Math.min(week, fromWeek);
  const weeks = Array.from({ length: LAST_WEEK - first + 1 }, (_, i) => first + i);
  const fetched = await Promise.all(weeks.map((w) => weekEntries(season, w)));
  const perWeek = fetched.slice(week - first);

  // Score at the player's fantasy position: Sleeper files Travis Hunter as DB but projects him as a WR.
  const scoringPos = (e: SleeperEntry) =>
    POSITIONS.includes(e.player.position) ? e.player.position : (e.player.fantasy_positions?.find((p) => POSITIONS.includes(p)) ?? e.player.position);

  const byWeek = new Map<string, Record<number, number>>();
  fetched.forEach((entries, i) => {
    for (const e of entries) {
      const table = byWeek.get(e.player_id) ?? {};
      table[weeks[i]!] = e.stats.gp ? score(e.stats, scoringPos(e)) : 0;
      byWeek.set(e.player_id, table);
    }
  });
  const ppgOver = (weeksEntries: SleeperEntry[][]) => {
    const total = new Map<string, { pts: number; games: number }>();
    for (const entries of weeksEntries) {
      for (const e of entries) {
        if (!e.stats.gp) continue;
        const acc = total.get(e.player_id) ?? { pts: 0, games: 0 };
        acc.pts += score(e.stats, scoringPos(e));
        acc.games += 1;
        total.set(e.player_id, acc);
      }
    }
    return (id: string) => {
      const t = total.get(id);
      return t?.games ? t.pts / t.games : 0;
    };
  };
  const rosPpgOf = ppgOver(perWeek);
  const seasonPpgOf = ppgOver(fetched);

  const byKey: SleeperProjections["byKey"] = new Map();
  const all: SleeperPlayer[] = [];
  for (const e of perWeek[0]!) {
    const weekProj = e.stats.gp ? score(e.stats, scoringPos(e)) : 0;
    const rosPpg = rosPpgOf(e.player_id);
    const seasonPpg = seasonPpgOf(e.player_id);
    if (!weekProj && !rosPpg && !seasonPpg) continue;
    const p = e.player;
    const name = p.position === "DEF" ? (teamKey(e.player_id) ?? "") : nameKey(`${p.first_name} ${p.last_name}`);
    const entry = { team: teamKey(p.team), proj: { weekProj, rosPpg, seasonPpg, byWeek: byWeek.get(e.player_id) ?? {} } };
    for (const pos of new Set([p.position, ...(p.fantasy_positions ?? [])])) {
      const k = `${pos}:${name}`;
      const list = byKey.get(k) ?? [];
      list.push(entry);
      byKey.set(k, list);
    }
    const espnPos = SLEEPER_TO_ESPN_POS[scoringPos(e)] ?? scoringPos(e);
    all.push({ key: `${espnPos}:${name}`, pos: espnPos, name, team: entry.team, proj: entry.proj });
  }
  return { season, week, scoring: scorer ? "league" : preset, byKey, all };
}

/** Find the Sleeper projection for an ESPN player, or undefined if no confident match. */
export function lookupSleeper(proj: SleeperProjections, p: EspnPlayer): SleeperProj | undefined {
  const espnPos = POSITION_NAMES[p.defaultPositionId] ?? "";
  const pos = ESPN_TO_SLEEPER_POS[espnPos] ?? espnPos;
  const team = teamKey(PRO_TEAMS[p.proTeamId]);
  const name = pos === "DEF" ? (team ?? "") : nameKey(p.fullName);
  const candidates = proj.byKey.get(`${pos}:${name}`);
  if (!candidates?.length) return undefined;
  if (candidates.length === 1) return candidates[0]!.proj;
  return (candidates.find((c) => c.team === team) ?? candidates[0]!).proj;
}
