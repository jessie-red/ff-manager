/**
 * The clustering behind Boris Chen's tiers, ported from fftiers.
 *
 * His whole algorithm (src/ff-functions.R, error.bar.plot) is two lines of R:
 *
 *     df = this.pos[, which(colnames(this.pos)=="Avg.Rank")]
 *     mclust <- Mclust(df, G=k)
 *
 * A one-dimensional Gaussian mixture over the experts' AVERAGE rank, with the
 * component count k fixed by hand per position. Note what isn't in it: the
 * standard deviation of the expert ranks is never clustered on — in his code
 * it only draws the error bars on the chart. So a tier is a run of players
 * whose mean ranks cluster together, nothing more.
 *
 * mclust with G fixed still picks a covariance model: in one dimension that's
 * "E" (one variance shared by every component) against "V" (its own variance
 * per component), scored by BIC. This fits both by EM and keeps the winner,
 * the same choice mclust makes. Components that come out empty are dropped and
 * the ones above them shift down, as his index-shifting loop does.
 *
 * Pure and dependency-free, so the browser can run it too.
 */

/** BIC in mclust's sign convention: 2*loglik - npar*log(n), higher is better. */
interface Fit {
  labels: number[];
  bic: number;
}

const LOG_2PI = Math.log(2 * Math.PI);
/** Keeps a component that collapses onto a single point from dividing by zero. */
const MIN_VAR = 1e-6;

/**
 * One EM run at fixed k. Initialised by cutting the (ascending) data into k
 * equal-count blocks, which for rank data is already close to where the
 * answer lands; mclust seeds itself with model-based hierarchical clustering
 * instead, so tier boundaries can differ from his by a player or two.
 */
function em(x: number[], k: number, equalVar: boolean, iters = 500, tol = 1e-8): Fit {
  const n = x.length;
  const mu = new Array<number>(k);
  const varr = new Array<number>(k);
  const pi = new Array<number>(k).fill(1 / k);

  for (let j = 0; j < k; j++) {
    const lo = Math.floor((j * n) / k);
    const hi = Math.max(lo + 1, Math.floor(((j + 1) * n) / k));
    const block = x.slice(lo, hi);
    const m = block.reduce((a, b) => a + b, 0) / block.length;
    mu[j] = m;
    varr[j] = Math.max(block.reduce((a, b) => a + (b - m) * (b - m), 0) / block.length, MIN_VAR);
  }
  if (equalVar) {
    const shared = varr.reduce((a, b) => a + b, 0) / k;
    varr.fill(Math.max(shared, MIN_VAR));
  }

  const z: number[][] = Array.from({ length: n }, () => new Array<number>(k).fill(0));
  let prev = -Infinity;
  let loglik = -Infinity;

  for (let it = 0; it < iters; it++) {
    // E step, in logs so a far-off component can't underflow to a flat zero row.
    loglik = 0;
    for (let i = 0; i < n; i++) {
      const row = z[i]!;
      let max = -Infinity;
      for (let j = 0; j < k; j++) {
        const d = x[i]! - mu[j]!;
        const lp = -0.5 * (LOG_2PI + Math.log(varr[j]!) + (d * d) / varr[j]!) + Math.log(Math.max(pi[j]!, Number.MIN_VALUE));
        row[j] = lp;
        if (lp > max) max = lp;
      }
      let sum = 0;
      for (let j = 0; j < k; j++) sum += Math.exp(row[j]! - max);
      const lse = max + Math.log(sum);
      loglik += lse;
      for (let j = 0; j < k; j++) row[j] = Math.exp(row[j]! - lse);
    }

    // M step
    let pooled = 0;
    for (let j = 0; j < k; j++) {
      let nk = 0;
      let sx = 0;
      for (let i = 0; i < n; i++) {
        nk += z[i]![j]!;
        sx += z[i]![j]! * x[i]!;
      }
      nk = Math.max(nk, Number.MIN_VALUE);
      pi[j] = nk / n;
      mu[j] = sx / nk;
      let sq = 0;
      for (let i = 0; i < n; i++) {
        const d = x[i]! - mu[j]!;
        sq += z[i]![j]! * d * d;
      }
      pooled += sq;
      if (!equalVar) varr[j] = Math.max(sq / nk, MIN_VAR);
    }
    if (equalVar) varr.fill(Math.max(pooled / n, MIN_VAR));

    if (Math.abs(loglik - prev) < tol * Math.abs(loglik)) break;
    prev = loglik;
  }

  const labels = z.map((row) => {
    let best = 0;
    for (let j = 1; j < row.length; j++) if (row[j]! > row[best]!) best = j;
    return best;
  });
  const npar = k - 1 + k + (equalVar ? 1 : k);
  return { labels, bic: 2 * loglik - npar * Math.log(n) };
}

/**
 * `Mclust(x, G=k)` for one-dimensional x: fits the equal- and unequal-variance
 * models, keeps the better BIC, and returns a 1-based tier per point, numbered
 * in ascending order of component mean (so tier 1 is the best ranks). Empty
 * components are dropped, leaving the tiers contiguous, so the result can hold
 * fewer than k of them.
 *
 * `x` must be sorted ascending — pass the average expert ranks in rank order.
 */
export function mclust(x: number[], k: number): number[] {
  if (x.length === 0) return [];
  const g = Math.max(1, Math.min(k, x.length));
  if (g === 1) return x.map(() => 1);

  const fits = [em(x, g, true), em(x, g, false)];
  const best = fits[0]!.bic >= fits[1]!.bic ? fits[0]! : fits[1]!;

  // Renumber by component mean, then close the gaps left by empty components.
  const sums = new Array<number>(g).fill(0);
  const counts = new Array<number>(g).fill(0);
  for (const [i, c] of best.labels.entries()) {
    sums[c] = sums[c]! + x[i]!;
    counts[c] = counts[c]! + 1;
  }
  const used = [...counts.keys()].filter((c) => counts[c]! > 0).sort((a, b) => sums[a]! / counts[a]! - sums[b]! / counts[b]!);
  const rank = new Map(used.map((c, i) => [c, i + 1]));
  return best.labels.map((c) => rank.get(c)!);
}

/** Cluster `x` into tiers and return them as index groups, tier 1 first. */
export function tierGroups(x: number[], k: number): number[][] {
  const labels = mclust(x, k);
  const groups: number[][] = [];
  for (const [i, t] of labels.entries()) (groups[t - 1] ??= []).push(i);
  return groups.filter((g) => g?.length);
}
