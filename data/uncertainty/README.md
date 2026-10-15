# Player uncertainty data and first-pass distributions

This is an offline, reproducible input layer used by the [season Monte Carlo simulator](../../src/simulation/README.md).
It does **not** change the current VORP ratings or team-rating page. All data is public;
no league credentials, rosters, or private ESPN responses are saved here.

## Saved inputs

| File | Contents |
| --- | --- |
| `sources.json` | Original URLs, retrieval times, stored-byte SHA-256 checksums and sizes for 109 source files |
| `raw/espn-clay-2025.pdf` | Mike Clay's ESPN projection guide, internally dated September 4, 2025 |
| `raw/sleeper-{projections,stats}-{year}-{week}.json.gz` | Lossless public endpoint responses for 2023–2025, regular-season weeks 1–18 |
| `espn-clay-2025.txt` | PDF text extracted with Poppler, including page boundaries |
| `preseason-2025.json` | 459 preseason player forecasts, stat components, projected games, printed PPR points/rank, PDF page, matched Sleeper ID and observed season totals |
| `weekly.jsonl` | 24,646 player-week records: projections, outcomes, participation, game IDs and modification timestamps; absent records remain `null` |
| `season-comparisons.json` | Per-player projected/actual totals, active-game rates, ratios and persistent-fit exclusion reasons in standard/half/PPR |
| `season-total-distributions.json` | Descriptive full-season point-error and total-ratio distributions, including observed short/injured seasons |
| `distributions.json` | Simulator-ready weekly and persistent multipliers for standard/half/PPR |
| `report.json` | Source/matching/exclusion audits, persistent variance decomposition, and held-out weekly diagnostics |

Original sources:

- [ESPN's 2025 Clay guide](https://g.espncdn.com/s/ffldraftkit/25/NFLDK2025_CS_ClayProjections2025.pdf).
- Sleeper public historical endpoints, for example [2025 week 1 projections](https://api.sleeper.app/projections/nfl/2025/1?season_type=regular)
  and [2025 week 1 outcomes](https://api.sleeper.app/stats/nfl/2025/1?season_type=regular).
  Projection responses identify their provider as `rotowire`; outcome responses identify `sportradar`.

### Important provenance limits

The PDF's printed preseason date is evidence of its forecast edition, not a
cryptographically verified September 2025 capture. The downloader preserves the copy retrieved now.

**Sleeper's historical projection records are not certified pre-kickoff snapshots.**
All 21,660 retained projection records have a modification timestamp later than
their game date. This may reflect batch maintenance, but it cannot establish that
the numbers were frozen before kickoff. One record also has the wrong game:
Xavier Gipson, 2025 week 1 (projection PHI, actual NYJ). It is preserved and excluded
from fitting. Calibration results are provisional historical-endpoint diagnostics,
not proof of live forecasting accuracy or absence of hindsight contamination.

Current player metadata is mutable. We never use its current injury status, news,
experience, or team as historical evidence. Names/eligibility identify players;
game-record teams identify their historical teams. Ten reviewed name aliases and
two reviewed 2025 position overrides are recorded in the audit. No fuzzy matching.
All 459 preseason identities match. Six have no observed season stat line and are
left unobserved, **not silently assigned zero**. This means descriptive total-error
distributions omit some possible entire-season absences and do not estimate the
complete injury-loss tail. Their observed/unobserved counts are explicit.

## What is fitted

### 1. Weekly boom/bust

For each position, scoring preset and projected-points band, collect
`r = actualPoints / projectedPoints`, then use the equally weighted empirical
distribution of `W = r / mean(r)`.

- Positions: QB, RB, WR, TE, K, DEF. Bands: 1–5, 5–10, 10–15, 15–20, 20–25, 25+.
- At least 100 observations per band. A sparse band borrows the nearest populated
  band at the same position; the position pool is the ultimate fallback.
- Require matching game IDs, an observed stat line, participation and at least one
  projected point. Missing actual records are not zeroes. Byes/nonparticipants are
  excluded. Offensive participation means a snap or a passing/rushing/target opportunity;
  merely dressing or playing special teams is insufficient. In-game injury exits
  remain in the weekly data.
- A real participant with no scoring stats **is** a zero. Recompute both projections
  and actuals with `src/sleeper/scoring.ts`'s `presetScorer`; do not depend on optional
  published point fields. Retain negative fantasy scores. No Gaussian symmetry,
  winsorization, normal fit, or score-floor clipping is imposed.
- Centering enforces `E[W] = 1`, so the simulator respects the current projection.
  Raw source bias and mean ratios are reported separately, not learned as corrections
  to another provider's current means.
- The production PPR fit uses 18,864 eligible player-weeks. Values below one projected
  point or above observed bands are extrapolations. A zero mean stays zero; a handcuff
  needs an upstream role change to obtain a starter's projection.

Stat components are saved for later custom scoring. The built artifacts use the
app's three scoring presets, not every possible league rule (e.g. six-point passing
TDs, TE premiums, yardage bonuses). K/DST scoring inherits the existing scorer's
approximations, including applying nonlinear points-allowed bands to projected stats.

### 2. Persistent active-game performance

Most Clay projections assume 17 games, **but 33 rows have explicit game-count
exceptions** for known absences/role splits. The parser preserves each row's actual
projected game count. The guide itself warns that ordinary future injury losses
are not generally deducted.

Use `R = (actualActivePoints / activeGames) / (projectedPoints / projectedGames)`.
Both sides use only their shared observable scoring components: passing yards/TDs/INTs,
rushing yards/TDs, receiving yards/TDs, and receptions. Clay doesn't publish all
fumble/conversion/return components, so neither side uses them for this comparison.
Printed PDF PPR totals are preserved but not substituted for these comparable scores;
printed rounded components need not reconstruct printed totals exactly.

For stable-enough denominators, require at least six active games and projected
PPG of at least 8 for QB or 3 for RB/WR/TE. Negative active season rates are excluded.
Every exclusion is saved. This is an available-player/established-role cohort, not
a calibrated model for zero-usage backups or the probability of losing a job.
PPR cohort sizes are QB 35, RB 58, WR 101, TE 45. K/DST have weekly noise but **no
fitted persistent component**; the sampler explicitly uses a multiplier of one.

Normalize observed `R` by its position mean. Its observed variance already contains
weekly randomness. Estimate the weekly contribution to a season average using a
second weekly fit with exactly the shared scoring above:

```text
v = mean_over_players(weeklyMultiplierVariance(at preseason PPG) / activeGames)
tau² = max(0, (Var(normalized R) - v) / (1 + v))
```

The denominator accounts for multiplicative interaction: under independent
mean-one `F` and `W`, `Var(F × average(W)) = tau² + (1 + tau²) × v`.
Shrink the centered empirical season ratios to variance `tau²`, preserving mean
one and nonnegative support. This removes estimated weekly variation **at the
variance level**, not through an exact statistical deconvolution of distribution
shape. The displayed empirical tail shape is a moment-matched approximation.

Independence, stable role/rate within a simulated ROS, transfer of weekly forecast
errors to preseason-rate errors, and independence of role uncertainty from the
estimated weekly variance are modeling assumptions. Weekly forecast errors need
not be pure independent luck: role errors, changing forecasts and injuries can
leave serial dependence. `report.json` includes lag-one ratio-error correlations;
these are diagnostics, not a correction or a proof of independence.

The descriptive **total-season** distributions retain availability losses and
role changes. They are saved separately for inspection, not stacked on top of
weekly noise plus an explicit injury simulation.

### 3. Sampling and ROS horizon

Draw `F` once for a player at the start of a simulated ROS. Each active week:

```text
points(player, week) = currentProjectedPoints(player, week) × F × W(player, week)
```

Draw a fresh `W` each week, selecting its band with the original weekly projection.
Use the **same `F`** in every week. Both factors have mean one. Fewer games already
reduce the persistent effect on season total points: its variance contribution is
`Var(F) × (sum of remaining projected points)²`.

Optional extra learning shrinkage is
`F_ROS = 1 + min(1, remainingGames / 17)^learningExponent × (F - 1)`.
The default exponent is **0**: no unverified learning curve. An exponent such as
0.5 is an explicit sensitivity assumption, not something learned from historical
ROS snapshots. Freeze this state for the simulated path; don't redraw or repeatedly
shrink it each week. Zero remaining games produces the identity state. Eighteen
games are allowed for the rare traded player who bypasses a bye (present in this data).

Availability and role changes belong upstream. Passing `available=false` returns
zero without drawing noise. This is not yet a model for injury hazards, handcuff
opportunities, correlated QB/receiver outcomes, NFL game environment, lineup
decisions or championship odds. An explicit injury model must also consider that
early in-game exits are already represented in the weekly outcomes.

## Rebuild and use

```sh
pnpm uncertainty:download   # network; resumes and verifies existing immutable source files
pnpm uncertainty:build      # offline; requires Poppler's pdftotext on PATH
pnpm test
pnpm typecheck
```

The build verifies source hashes, rejects ambiguous identities/duplicate rows or
unexpected PDF structure, and deterministically rewrites the derived JSON files.
It does not require the app's `.cache` directory. Raw JSON is gzip-compressed; all
derived research records are ordinary JSON or one JSON object per line.

```ts
import { loadUncertainty } from "./src/uncertainty/load.js"; // Node-only loader
import { samplePlayerUncertainty, samplePlayerWeek, uncertaintyRandom }
  from "./src/model/uncertainty.js"; // browser-safe functions

const model = await loadUncertainty();
const rng = uncertaintyRandom(42);
// Inside each simulation: one state per PLAYER, not per team or per week.
const player = samplePlayerUncertainty(model, "ppr", "RB", 10, rng);
const score1 = samplePlayerWeek(model, "ppr", player, 12.3, rng);
const score2 = samplePlayerWeek(model, "ppr", player, 13.1, rng);
```

## Validation, not a calibration guarantee

Fit weekly distributions on 2023–24, then evaluate on 2025 without using 2025 to
estimate those test distributions. Production weekly distributions are subsequently
fit on all three seasons. PPR coverage from the held-out check:

| Position | Player-weeks | Nominal 80% coverage | Nominal 90% coverage |
| --- | ---: | ---: | ---: |
| QB | 545 | 76.9% | 87.5% |
| RB | 1,335 | 79.6% | 87.3% |
| WR | 2,152 | 87.0% | 92.5% |
| TE | 1,140 | 83.1% | 93.6% |
| K | 534 | 80.9% | 90.1% |
| DEF | 537 | 80.6% | 90.1% |

Coverage differs by position; the WR intervals are conservative in this check,
while QB intervals are somewhat narrow. Discrete mass at zero also means a nominal
central interval cannot always attain its nominal coverage exactly. This validates
neither the combined ROS distribution nor championship percentages. Persistent
uncertainty has only one preseason season and no independent season holdout; sampling
uncertainty in the fitted parameters and provider-transfer error are not modeled.
Tests verify parsing/matching, missing-versus-zero handling, means/variance math,
persistent reuse, horizon behavior, seeded reproducibility and Monte Carlo moments.


## Season simulator

The pure engine in `src/model/simulation.ts` consumes these distributions to
project regular-season records and playoff/championship odds. It supports shared
player draws and paired confidence intervals for roster/trade comparisons.
`pnpm simulate:benchmark 100000` runs a synthetic baseline and trade offline;
`pnpm simulate:validate --full` saves numerical convergence and timing results in
`simulation-validation.json`. See [the simulator guide](../../src/simulation/README.md)
for inputs, supported playoff rules, precision controls, and model limitations.
This does not establish championship calibration or change the current rating UI.
