import type { EmpiricalDistribution, PersistentPosition, ScoringFormat, UncertaintyFormat,
  UncertaintyModel, WeeklyCell, WeeklyPosition } from "../model/uncertainty.js";
import { weeklyCell } from "../model/uncertainty.js";
import { presetScorer } from "../sleeper/scoring.js";
import { commonPoints, POSITIONS, type Position, type PreseasonRecord, type StatLine, type WeeklyRecord } from "./data.js";

export const FORMATS: Record<ScoringFormat, number> = { standard: 0, half: .5, ppr: 1 };
const SCORERS = { standard: presetScorer(0), half: presetScorer(.5), ppr: presetScorer(1) };
const BOUNDS = [1, 5, 10, 15, 20, 25];
const MIN_CELL = 100;
const MIN_SEASON_GAMES = 6;
// Fixed before inspecting outcomes; very small denominators make backup rate ratios unstable.
const MIN_SEASON_PPG: Record<Position, number> = { QB: 8, RB: 3, WR: 3, TE: 3, K: Infinity, DEF: Infinity };

export const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
export function empirical(values: number[]): EmpiricalDistribution {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error("Expected finite nonempty sample");
  const samples = values.slice().sort((a, b) => a - b);
  const m = mean(samples), variance = mean(samples.map(v => (v - m) ** 2));
  // Inverse empirical CDF, consistent with the discrete bootstrap sampler.
  const q = (p: number) => samples[Math.max(0, Math.ceil(p * samples.length) - 1)]!;
  return { n: samples.length, mean: m, variance, sd: Math.sqrt(variance),
    p05: q(.05), p10: q(.1), p50: q(.5), p90: q(.9), p95: q(.95), samples };
}
interface Pair { row: WeeklyRecord; projected: number; actual: number }
function pair(row: WeeklyRecord, format: ScoringFormat, common: boolean): Pair | string {
  if (!row.projected) return "missingProjection";
  if (!row.actual) return "missingActual";
  if (row.gameMismatch) return "differentGame";
  if (!row.participated) return "didNotParticipate";
  const score = (s: StatLine) => common && row.position !== "K" && row.position !== "DEF"
    ? commonPoints(s, FORMATS[format]) : SCORERS[format](s, row.position);
  const projected = score(row.projected), actual = score(row.actual);
  if (!Number.isFinite(projected) || !Number.isFinite(actual)) throw new Error("Nonfinite score");
  if (projected < 1) return "projectionBelowOnePoint";
  return { row, projected, actual };
}
function cell(pairs: Pair[], minProjection: number, maxProjection: number | null): WeeklyCell {
  if (pairs.length < MIN_CELL) throw new Error(`Not enough weekly observations: ${pairs.length}`);
  const ratios = pairs.map(p => p.actual / p.projected), ratioMean = mean(ratios);
  if (!(ratioMean > 0)) throw new Error("Cannot normalize nonpositive mean ratio");
  return { minProjection, maxProjection, rawRatioMean: ratioMean,
    rawBiasPoints: mean(pairs.map(p => p.actual - p.projected)),
    multiplier: empirical(ratios.map(r => r / ratioMean)) };
}
export function fitWeekly(rows: WeeklyRecord[], format: ScoringFormat, common = false): {
  model: Record<Position, WeeklyPosition>; exclusions: Record<string, number>;
} {
  const pairs: Pair[] = [], exclusions: Record<string, number> = {};
  for (const row of rows) {
    const p = pair(row, format, common);
    if (typeof p === "string") exclusions[p] = (exclusions[p] ?? 0) + 1;
    else pairs.push(p);
  }
  const model = Object.fromEntries(POSITIONS.map(position => {
    const group = pairs.filter(p => p.row.position === position);
    return [position, { pooled: cell(group, 1, null), bins: BOUNDS.flatMap((lo, i) => {
      const hi = BOUNDS[i + 1] ?? null;
      const bin = group.filter(p => p.projected >= lo && (hi === null || p.projected < hi));
      return bin.length >= MIN_CELL ? [cell(bin, lo, hi)] : [];
    }) }];
  })) as Record<Position, WeeklyPosition>;
  return { model, exclusions };
}

/** For R = F * average(W), independent E[F]=E[W]=1: Var(R)=tau²+(1+tau²)v. */
export function latentVariance(observedVariance: number, weeklyMeanVariance: number): number {
  if (observedVariance < 0 || weeklyMeanVariance < 0 || !Number.isFinite(observedVariance + weeklyMeanVariance)) {
    throw new Error("Invalid variance");
  }
  return Math.max(0, (observedVariance - weeklyMeanVariance) / (1 + weeklyMeanVariance));
}
export function fitPersistent(players: PreseasonRecord[], format: ScoringFormat,
  weeklyCommon: Record<Position, WeeklyPosition>): {
    model: Record<Position, PersistentPosition>; comparisons: object[];
  } {
  const comparisons: object[] = [];
  const model = Object.fromEntries(POSITIONS.map(position => {
    const ratios: number[] = [], noises: number[] = [];
    for (const p of players.filter(p => p.position === position)) {
      const projectedTotal = commonPoints(p.projected, FORMATS[format]);
      const projectedPpg = projectedTotal / p.projectedGames;
      const actualTotal = p.actual ? commonPoints(p.actual, FORMATS[format]) : null;
      const actualActiveTotal = p.activeActual ? commonPoints(p.activeActual, FORMATS[format]) : null;
      const actualPpg = p.activeGames && actualActiveTotal !== null ? actualActiveTotal / p.activeGames : null;
      const excluded = !p.playerId ? "unmatched" : actualTotal === null ? "unobservedOutcome"
        : projectedPpg < MIN_SEASON_PPG[position] ? "lowPreseasonProjection"
        : (p.activeGames ?? 0) < MIN_SEASON_GAMES ? "fewerThanSixActiveGames"
        : actualPpg === null || actualPpg < 0 ? "invalidActiveRate" : null;
      comparisons.push({ name: p.name, playerId: p.playerId, position, projectedTotal, actualTotal,
        totalDelta: actualTotal === null ? null : actualTotal - projectedTotal,
        projectedPpg, activeGames: p.activeGames, actualActivePpg: actualPpg,
        activeRateRatio: actualPpg !== null && projectedPpg > 0 ? actualPpg / projectedPpg : null,
        persistentFitExclusion: excluded });
      if (excluded) continue;
      ratios.push(actualPpg! / projectedPpg);
      const c = weeklyCell({ weekly: weeklyCommon } as UncertaintyFormat, position, projectedPpg);
      noises.push(c.multiplier.variance / p.activeGames!);
    }
    if (ratios.length < 12) return [position, { available: false, cohortN: ratios.length,
      minimumProjectedPpg: Number.isFinite(MIN_SEASON_PPG[position]) ? MIN_SEASON_PPG[position] : 0,
      minimumActiveGames: MIN_SEASON_GAMES, rawRateRatioMean: null, observedRelativeVariance: null,
      weeklyMeanRelativeVariance: null, latentRelativeVariance: 0, multiplier: empirical([1]) }];
    const rawMean = mean(ratios);
    const normalized = empirical(ratios.map(r => r / rawMean));
    const v = mean(noises), tau2 = latentVariance(normalized.variance, v);
    const shrink = normalized.variance ? Math.sqrt(tau2 / normalized.variance) : 0;
    return [position, { available: true, cohortN: ratios.length, minimumProjectedPpg: MIN_SEASON_PPG[position],
      minimumActiveGames: MIN_SEASON_GAMES, rawRateRatioMean: rawMean,
      observedRelativeVariance: normalized.variance, weeklyMeanRelativeVariance: v,
      latentRelativeVariance: tau2,
      multiplier: empirical(normalized.samples.map(r => 1 + shrink * (r - 1))) }];
  })) as Record<Position, PersistentPosition>;
  return { model, comparisons };
}

/** Conditional WEEKLY coverage only; not validation of the combined ROS/championship model. */
export function validateWeekly(rows: WeeklyRecord[], format: ScoringFormat, model: UncertaintyFormat): object {
  return Object.fromEntries(POSITIONS.map(position => {
    const pairs = rows.filter(r => r.position === position).map(r => pair(r, format, false))
      .filter((p): p is Pair => typeof p !== "string");
    let inside80 = 0, inside90 = 0, sq = 0, predictedVar = 0, width80 = 0;
    for (const p of pairs) {
      const d = weeklyCell(model, position, p.projected).multiplier;
      inside80 += +(p.actual >= p.projected * d.p10 && p.actual <= p.projected * d.p90);
      inside90 += +(p.actual >= p.projected * d.p05 && p.actual <= p.projected * d.p95);
      sq += (p.actual - p.projected) ** 2;
      predictedVar += p.projected ** 2 * d.variance;
      width80 += p.projected * (d.p90 - d.p10);
    }
    const previous = new Map<string, Pair>();
    const lagPairs: [number, number][] = [];
    for (const p of pairs.slice().sort((a, b) => a.row.season - b.row.season || a.row.week - b.row.week)) {
      const key = `${p.row.season}:${p.row.playerId}`, prev = previous.get(key);
      if (prev && prev.row.week + 1 === p.row.week) {
        lagPairs.push([prev.actual / prev.projected - 1, p.actual / p.projected - 1]);
      }
      previous.set(key, p);
    }
    const x = lagPairs.map(p => p[0]), y = lagPairs.map(p => p[1]);
    const mx = mean(x), my = mean(y);
    const covariance = mean(lagPairs.map(([a, b]) => (a - mx) * (b - my)));
    const denominator = Math.sqrt(mean(x.map(v => (v - mx) ** 2)) * mean(y.map(v => (v - my) ** 2)));
    return [position, { n: pairs.length, biasPoints: mean(pairs.map(p => p.actual - p.projected)),
      mae: mean(pairs.map(p => Math.abs(p.actual - p.projected))), rmse: Math.sqrt(sq / pairs.length),
      predictedRmsSd: Math.sqrt(predictedVar / pairs.length),
      coverage80: inside80 / pairs.length, coverage90: inside90 / pairs.length,
      meanIntervalWidth80: width80 / pairs.length,
      lagOneRatioResidualCorrelation: denominator > 0 ? covariance / denominator : null,
      consecutiveGamePairs: lagPairs.length }];
  }));
}

/** Descriptive total-season errors, including missed games; NEVER add these atop injury simulation. */
export function seasonTotalDistributions(players: PreseasonRecord[]): object {
  return Object.fromEntries(Object.entries(FORMATS).map(([format, receptions]) => [format,
    Object.fromEntries(POSITIONS.filter(p => p !== "K" && p !== "DEF").map(position => {
      const projectedCohort = players.filter(p => p.position === position
        && commonPoints(p.projected, receptions) / p.projectedGames >= MIN_SEASON_PPG[position]);
      const observed = projectedCohort.filter(p => p.actual !== null);
      return [position, {
        projectedCohortN: projectedCohort.length, observedOutcomeN: observed.length,
        unobservedOutcomeN: projectedCohort.length - observed.length,
        pointDelta: empirical(observed.map(p => commonPoints(p.actual!, receptions) - commonPoints(p.projected, receptions))),
        actualToProjectedTotalRatio: empirical(observed.map(p => commonPoints(p.actual!, receptions) / commonPoints(p.projected, receptions))),
      }];
    }))]));
}

/** No holdout data is used to tune thresholds. Production refits weekly noise on all three seasons. */
export function fit(weekly: WeeklyRecord[], preseason: PreseasonRecord[]): {
  model: UncertaintyModel; report: object; comparisons: Record<string, object[]>;
} {
  const model: UncertaintyModel = { version: 1, weeklySeasons: [2023, 2024, 2025], preseasonSeason: 2025,
    fullSeasonGames: 17, seasonWeeks: 18, defaultLearningExponent: 0, formats: {} as UncertaintyModel["formats"] };
  const report: Record<string, object> = {}, comparisons: Record<string, object[]> = {};
  for (const format of Object.keys(FORMATS) as ScoringFormat[]) {
    const training = fitWeekly(weekly.filter(w => w.season < 2025), format);
    const all = fitWeekly(weekly, format);
    const common = fitWeekly(weekly, format, true);
    const persistent = fitPersistent(preseason, format, common.model);
    model.formats[format] = { weekly: all.model, persistent: persistent.model };
    comparisons[format] = persistent.comparisons;
    report[format] = { trainingSeasons: [2023, 2024], holdoutSeason: 2025,
      holdoutWeekly: validateWeekly(weekly.filter(w => w.season === 2025), format,
        { weekly: training.model, persistent: persistent.model }),
      productionWeeklyExclusions: all.exclusions,
      persistent: Object.fromEntries(POSITIONS.map(p => {
        const { multiplier, ...meta } = persistent.model[p];
        const { samples: _samples, ...summary } = multiplier;
        return [p, { ...meta, multiplier: summary }];
      })) };
  }
  return { model, report, comparisons };
}
