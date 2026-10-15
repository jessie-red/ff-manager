/**
 * Season value over replacement by preseason positional rank, from
 * data/monotonic_vorp.csv (built in the sibling `ff` project's historical
 * analysis: six seasons of actual points scored by the player who held each
 * preseason rank, minus the points at a replacement rank, smoothed so that
 * value never rises with rank). Units are season points, not per game.
 *
 * The sheet carries two replacement levels. `waiver_vorp` measures against
 * the waiver wire (the best player typically left unrostered, e.g. RB46 in a
 * 10-team league) and is the value used; `vorp` measures against the last
 * starter and is the fallback for rows where waiver_vorp is blank (K and
 * D/ST, which nobody benches, so the last starter is the waiver level anyway).
 *
 * The sheet carries one table per scoring format (standard / half_ppr / ppr)
 * and league size (8 to 14 teams); loadVorp picks the slice matching the
 * league's reception points and team count, clamping sizes outside that range
 * to the nearest edge.
 *
 * QB, RB, WR, TE, K and D/ST are covered (the sheet spells D/ST as DST); any
 * position missing from it falls back to the nflverse curves (see value.ts).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { EspnLeague } from "../espn/types.js";
import { parseCsv } from "../nflverse/csv.js";
import { leagueScoring, type Scoring } from "../sleeper/client.js";

/** Season VORP at each preseason rank (index 0 = rank 1), by position. */
export type VorpTable = Record<string, number[]>;

/**
 * Which replacement level a table measures against: "waiver" (waiver_vorp,
 * vorp where blank; everything uses this) or "starter" (vorp, the last
 * starter league-wide; kept as an option, nothing reads it at present).
 */
export type VorpBaseline = "waiver" | "starter";

const FILE = fileURLToPath(new URL("../../data/monotonic_vorp.csv", import.meta.url));

/** Sheet's scoring labels for the Sleeper-style presets leagueScoring() returns. */
const SHEET_SCORING: Record<Scoring, string> = { ppr: "ppr", half: "half_ppr", std: "standard" };

/** Every slice of the sheet, keyed "baseline/scoring/size". */
let memo: Promise<Map<string, VorpTable>> | undefined;

function loadSheet(): Promise<Map<string, VorpTable>> {
  memo ??= readFile(FILE, "utf8").then((text) => {
    const slices = new Map<string, VorpTable>();
    const put = (key: string, pos: string, rank: number, vorp: number) => {
      if (!Number.isFinite(vorp)) return;
      let table = slices.get(key);
      if (!table) slices.set(key, (table = {}));
      (table[pos] ??= [])[rank - 1] = vorp;
    };
    for (const row of parseCsv(text)) {
      const pos = row.position === "DST" ? "D/ST" : row.position!;
      const rank = Number(row.preseason_rank);
      if (!Number.isFinite(rank)) continue;
      const key = `${row.scoring}/${row.league_size}`;
      put(`waiver/${key}`, pos, rank, Number(row.waiver_vorp?.trim() ? row.waiver_vorp : row.vorp));
      put(`starter/${key}`, pos, rank, Number(row.vorp));
    }
    if (slices.size === 0) throw new Error("monotonic_vorp.csv has no usable rows");
    return slices;
  });
  memo.catch(() => (memo = undefined));
  return memo;
}

/** The VORP table for a league's scoring format and team count, against the waiver wire unless `baseline` says the last starter. */
export async function loadVorp(league: EspnLeague, baseline: VorpBaseline = "waiver"): Promise<VorpTable> {
  const all = await loadSheet();
  const slices = new Map([...all].filter(([k]) => k.startsWith(`${baseline}/`)).map(([k, v]) => [k.slice(baseline.length + 1), v]));
  const scoring = SHEET_SCORING[leagueScoring(league)];
  const sizes = [...slices.keys()]
    .filter((k) => k.startsWith(`${scoring}/`))
    .map((k) => Number(k.slice(scoring.length + 1)));
  if (sizes.length === 0) throw new Error(`monotonic_vorp.csv has no ${scoring} tables`);
  const teams = league.teams.length;
  const size = sizes.reduce((best, s) => (Math.abs(s - teams) < Math.abs(best - teams) ? s : best));
  return slices.get(`${scoring}/${size}`)!;
}
