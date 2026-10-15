/**
 * Fetcher for FantasyCalc's public value endpoint
 * (api.fantasycalc.com/values/current), the market prices described in
 * values.ts.
 *
 * The endpoint is priced per league shape, so the query carries the league's
 * own team count, QB count (2 for superflex) and reception points; the answer
 * is the top ~200 players, every one of them tagged with the ESPN id we key
 * rosters by. There is no K or D/ST in it, and nothing past the top 200:
 * players it doesn't list are simply unpriced.
 *
 * Fetched at most once every few hours per league shape, with the last good
 * copy kept under .cache/fantasycalc so an outage doesn't drop the column.
 * Node-only (fs); the browser-safe lookup lives in values.ts.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SLOT_POSITIONS } from "../espn/constants.js";
import type { EspnLeague } from "../espn/types.js";
import { startingSlots } from "../model/player.js";
import { fcKey, type FcValue, type FcValues } from "./values.js";

const BASE = "https://api.fantasycalc.com/values/current";
const CACHE = fileURLToPath(new URL("../../.cache/fantasycalc/", import.meta.url));
const TTL_MS = 6 * 60 * 60 * 1000;

/** The endpoint's shape, trimmed to the fields we read. */
interface FcRow {
  player: { name: string; position: string; espnId?: string | null };
  value: number;
  overallRank: number;
  positionRank: number;
  trend30Day?: number;
}

/** FantasyCalc's position labels are ESPN's for everything it lists (QB/RB/WR/TE); UNK rows are dropped. */
const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

/** FantasyCalc prices three reception settings; a league's points per catch rounds to the nearest of them. */
function pprOf(league: EspnLeague): number {
  const rec = league.settings.scoringSettings?.scoringItems?.find((i) => i.statId === 53)?.points ?? 0;
  return rec >= 0.75 ? 1 : rec >= 0.25 ? 0.5 : 0;
}

/** 2 when the league starts a second QB anywhere (a superflex slot counts), else 1: the only two prices FantasyCalc quotes. */
function qbsOf(league: EspnLeague): number {
  let qbs = 0;
  for (const [slot, count] of startingSlots(league)) {
    if (SLOT_POSITIONS[slot]?.includes("QB")) qbs += count;
  }
  return qbs >= 2 ? 2 : 1;
}

/** The league shape the values are priced for. */
export function fcParams(league: EspnLeague): FcValues["params"] {
  return { numTeams: league.teams.length, numQbs: qbsOf(league), ppr: pprOf(league) };
}

function url(p: FcValues["params"]): string {
  const u = new URL(BASE);
  u.searchParams.set("isDynasty", "false");
  u.searchParams.set("numQbs", String(p.numQbs));
  u.searchParams.set("numTeams", String(p.numTeams));
  u.searchParams.set("ppr", String(p.ppr));
  return u.toString();
}

function build(params: FcValues["params"], rows: FcRow[], fetched: string): FcValues {
  const byEspnId: Record<number, FcValue> = {};
  const byName: Record<string, FcValue> = {};
  for (const r of rows) {
    if (!POSITIONS.has(r.player.position)) continue;
    const v: FcValue = {
      value: r.value,
      overallRank: r.overallRank,
      positionRank: r.positionRank,
      trend30Day: r.trend30Day ?? 0,
    };
    const espnId = Number(r.player.espnId);
    if (r.player.espnId && Number.isInteger(espnId)) byEspnId[espnId] = v;
    byName[fcKey(r.player.position, r.player.name)] = v;
  }
  return { params, fetched, byEspnId, byName };
}

const memo = new Map<string, { at: number; p: Promise<FcValues> }>();

/**
 * Market values for the league's shape, memoized for a few hours and cached
 * on disk. A failed fetch falls back to the cached copy; only when there
 * isn't one does this reject, and the caller records the error and goes
 * without the column.
 */
export function fetchFantasyCalc(league: EspnLeague): Promise<FcValues> {
  const params = fcParams(league);
  const key = `${params.numTeams}-${params.numQbs}-${params.ppr}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const path = `${CACHE}${key}.json`;
  const p = (async (): Promise<FcValues> => {
    try {
      const res = await fetch(url(params), { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`FantasyCalc ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      const rows = (await res.json()) as FcRow[];
      if (!Array.isArray(rows) || !rows.length) throw new Error("FantasyCalc: empty value list");
      const values = build(params, rows, new Date().toISOString());
      await mkdir(CACHE, { recursive: true });
      await writeFile(path, JSON.stringify(values));
      return values;
    } catch (e) {
      try {
        return JSON.parse(await readFile(path, "utf8")) as FcValues;
      } catch {
        throw e;
      }
    }
  })();
  p.catch(() => memo.delete(key));
  memo.set(key, { at: Date.now(), p });
  return p;
}
