import type { EspnLeague } from "../espn/types.js";
import { leagueScorer } from "../sleeper/scoring.js";
import { presetScorer } from "../sleeper/scoring.js";
import { buildCurves, historySeasons, type Curves } from "./curve.js";

export { curvePoints, historySeasons, type Curves } from "./curve.js";

/** Seasons of history the value curves average over. */
export const HISTORY_SEASONS = 10;

/** How historical stat lines were scored: the league's own rules or ESPN's stock scoring at N ppr. */
export type CurveSource = "league" | "preset";

const memo = new Map<string, Promise<{ curves: Curves; source: CurveSource }>>();

/** Value curves for a league, scored with its rules over the ten seasons before its own; memoized per league season. */
export function leagueCurves(league: EspnLeague): Promise<{ curves: Curves; source: CurveSource }> {
  const key = `${league.id}:${league.seasonId}`;
  let p = memo.get(key);
  if (!p) {
    const own = leagueScorer(league);
    const rec = league.settings.scoringSettings?.scoringItems?.find((i) => i.statId === 53)?.points ?? 1;
    const scorer = own ?? presetScorer(rec);
    p = buildCurves(scorer, historySeasons(league.seasonId, HISTORY_SEASONS)).then((curves) => ({
      curves,
      source: own ? "league" : "preset",
    }));
    p.catch(() => memo.delete(key));
    memo.set(key, p);
  }
  return p;
}
