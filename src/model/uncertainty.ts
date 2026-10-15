/** Browser-safe empirical player uncertainty; no league state, network, or filesystem. */
export type UncertaintyPosition = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";
export type ScoringFormat = "standard" | "half" | "ppr";
export interface EmpiricalDistribution {
  n: number;
  mean: number;
  variance: number;
  sd: number;
  p05: number;
  p10: number;
  p50: number;
  p90: number;
  p95: number;
  /** Sorted equally weighted outcomes, not percentile interpolation knots. */
  samples: number[];
}
export interface WeeklyCell {
  minProjection: number;
  maxProjection: number | null;
  rawRatioMean: number;
  rawBiasPoints: number;
  multiplier: EmpiricalDistribution;
}
export interface WeeklyPosition {
  pooled: WeeklyCell;
  /** Only sufficiently populated cells. Sparse tails use the nearest populated bin. */
  bins: WeeklyCell[];
}
export interface PersistentPosition {
  available: boolean;
  cohortN: number;
  minimumProjectedPpg: number;
  minimumActiveGames: number;
  rawRateRatioMean: number | null;
  observedRelativeVariance: number | null;
  weeklyMeanRelativeVariance: number | null;
  latentRelativeVariance: number;
  /** Moment-matched, mean-one approximation, not an identified latent distribution. */
  multiplier: EmpiricalDistribution;
}
export interface UncertaintyFormat {
  weekly: Record<UncertaintyPosition, WeeklyPosition>;
  persistent: Record<UncertaintyPosition, PersistentPosition>;
}
export interface UncertaintyModel {
  version: 1;
  weeklySeasons: number[];
  preseasonSeason: number;
  fullSeasonGames: number;
  seasonWeeks: number;
  defaultLearningExponent: number;
  formats: Record<ScoringFormat, UncertaintyFormat>;
}
export type RandomSource = () => number;

export function weeklyCell(model: UncertaintyFormat, position: UncertaintyPosition, mean: number): WeeklyCell {
  const p = model.weekly[position];
  if (!p) throw new Error(`Unsupported uncertainty position: ${position}`);
  const exact = p.bins.find(b => mean >= b.minProjection && (b.maxProjection === null || mean < b.maxProjection));
  if (exact) return exact;
  // Borrow locally, rather than applying low-projection backup variance to an elite starter.
  const distance = (b: WeeklyCell) => Math.max(b.minProjection - mean, mean - (b.maxProjection ?? Infinity), 0);
  return p.bins.reduce<WeeklyCell | undefined>((best, b) =>
    !best || distance(b) < distance(best) ? b : best, undefined) ?? p.pooled;
}
function draw(d: EmpiricalDistribution, random: RandomSource): number {
  const u = random();
  if (!(u >= 0 && u < 1)) throw new Error("Random source must return a number in [0, 1)");
  if (!d.samples.length) throw new Error("Empty empirical distribution");
  return d.samples[Math.floor(u * d.samples.length)]!;
}
export interface PlayerUncertainty {
  position: UncertaintyPosition;
  /** Draw once per player per simulated ROS. Reuse for every future game. */
  performanceMultiplier: number;
}

export function samplePlayerUncertainty(model: UncertaintyModel, format: ScoringFormat,
  position: UncertaintyPosition, remainingGames: number, random: RandomSource,
  learningExponent = model.defaultLearningExponent): PlayerUncertainty {
  if (!Number.isFinite(remainingGames) || remainingGames < 0 || remainingGames > model.seasonWeeks) {
    throw new Error(`remainingGames must be in [0, ${model.seasonWeeks}]`);
  }
  if (!Number.isFinite(learningExponent) || learningExponent < 0) throw new Error("Invalid learning exponent");
  const p = model.formats[format].persistent[position];
  if (!p) throw new Error(`Unsupported uncertainty position: ${position}`);
  const scale = remainingGames === 0 ? 0 : Math.min(1, remainingGames / model.fullSeasonGames) ** learningExponent;
  const factor = scale && p.available ? draw(p.multiplier, random) : 1;
  return { position, performanceMultiplier: 1 + scale * (factor - 1) };
}

/**
 * Current projection is the unconditional mean over simulations, conditional on playing.
 * Availability/role decisions belong upstream. Do not redraw the persistent state each week.
 * Negative empirical fantasy outcomes are retained (including D/ST); no biased clipping.
 */
export function samplePlayerWeek(model: UncertaintyModel, format: ScoringFormat,
  state: PlayerUncertainty, projectedPoints: number, random: RandomSource, available = true): number {
  if (!Number.isFinite(projectedPoints) || projectedPoints < 0) throw new Error("Expected a nonnegative projection");
  if (!Number.isFinite(state.performanceMultiplier) || state.performanceMultiplier < 0) throw new Error("Invalid player state");
  if (!available || projectedPoints === 0) return 0;
  const cell = weeklyCell(model.formats[format], state.position, projectedPoints);
  // Bin on the original projection: changing the noise law with the latent draw would
  // invalidate the fitted product-variance decomposition.
  return projectedPoints * state.performanceMultiplier * draw(cell.multiplier, random);
}

/** Small deterministic PRNG, useful for repeatable simulations and common random numbers. */
export function uncertaintyRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
