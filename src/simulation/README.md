# Season Monte Carlo

`src/model/simulation.ts` is a pure, browser-safe engine using the empirical weekly
and persistent distributions in `data/uncertainty/distributions.json`. It returns
expected final regular-season W/L/T, a full record probability histogram, playoff
odds, championship odds, and paired differences between roster scenarios. The
rating page uses the server worker in `src/server/championship.ts` for 100,000
fixed-seed seasons, showing championship odds and Monte Carlo intervals instead
of deterministic projected records. The trade calculator composes both roster
states in the browser and posts them to `POST /api/trade-odds`, which runs the
same worker as one paired comparison and shows each team's title odds before and
after with the difference's own interval.
The adapter requires supported ESPN playoff rules and complete weekly
forecasts through the final round; unsupported or missing inputs show an unavailable
reason. ESPN football omits the default playoff matchup tiebreaker field; the
adapter uses ESPN’s documented higher-seed rule when absent and still requires
an explicit reseeding setting. Current-week scores are simulated in full, without live-score conditioning.

## Run offline

```sh
pnpm simulate                         # synthetic 12-team league, 100,000 seasons
pnpm simulate league.json 100000 42   # normalized input JSON, count, seed
pnpm simulate:benchmark 100000        # baseline + WR trade, time printed to stderr
pnpm simulate:validate               # 10k and 100k paths, three seeds each
pnpm simulate:validate --full        # also 1M paths per seed; takes longer
```

The CLI prints result JSON to stdout (use `pnpm --silent` when redirecting it).
The validation command writes `data/uncertainty/simulation-validation.json`. Inputs
are synthetic, and the experiment needs no account, network, or historical-data
rebuild. Node 20+ with project dependencies installed is sufficient.

## Integrating rosters

```ts
import { loadUncertainty } from '../uncertainty/load.js'; // Node only
import { prepareSimulationLineups } from '../model/simulation-lineups.js';
import { simulateSeason } from '../model/simulation.js';

const before = prepareSimulationLineups('before', rosters, slots, futureWeeks);
const after = prepareSimulationLineups('after', tradedRosters, slots, futureWeeks);
const players = [...new Map([...before.players, ...after.players].map(p => [p.id, p])).values()];
const result = simulateSeason(await loadUncertainty(), {
  players,
  teams: currentStandings, // {id, wins, losses, ties, pointsFor} for completed games
  regularSeason: remainingGames, // {home: teamId, away: teamId, weeks: [week, ...]}
  playoffs: { teams: 6, rounds: [[15], [16], [17]], reseed: false },
  scenarios: [before.scenario, after.scenario],
  format: 'ppr',
}, { seed: 42, targetHalfWidth: .002, maxSimulations: 1_000_000 });
```

All scenarios share one projection per player/week. The comparison varies roster
ownership/starting lineups, not player forecasts. Use stable ESPN IDs (including
negative D/ST IDs). The helper chooses starters from blended ESPN/Sleeper weekly
means using the existing lineup optimizer; IR players are excluded according to
that optimizer. It returns the entire roster pool, including bench players. To
model future availability differently, supply a projection callback and adjusted
roster state. The caller must union players across all scenarios without conflicting
positions or forecasts for the same ID.

Every team needs an explicit starting lineup for every requested scoring week,
including playoffs even if qualification is uncertain. Empty lineups/slots score
zero. Missing forecasts raise an error; encode known byes/absences as explicit
zeroes. The normalized engine checks duplicate starters across teams but trusts
the caller to supply legal roster/slot assignments. Use the lineup helper when
constructing them from application rosters.

Regular-season games must be **remaining full matchups**, with disjoint scoring
weeks for each team, before the playoffs. Completed games belong in starting
standings/PF and must not also appear as simulated games. The initial version
does not condition on live scores, partially completed multiweek matchups, or an
already-started playoff bracket. It deliberately requires explicit playoff rules
rather than guessing ESPN's missing settings. Playoff projections must be fetched
through the final scoring week; the rating pipeline's regular-season ROS horizon
alone is insufficient.

## Rules and model

- Draw one persistent player factor per path; reuse it every week and in every
  scenario. Draw independent weekly factors, selecting bands on the original
  projection. Preserve negative empirical scores. K/DST have no persistent factor.
- Freeze weekly lineups before sampling. No hindsight lineup optimization, learned
  role changes, waiver acquisitions, or future manager reactions to performance.
- Seed by regular-season win percentage (ties count half), then points for in
  scheduled games plus initial PF, then a seeded fair lottery. No divisions,
  head-to-head tiebreakers, median games, or league-specific seeding overrides.
- Support any playoff field from 2 through league size, with top-seed byes to the
  next power of two. Default bracket is 1–8/4–5/2–7/3–6 for an eight-slot field;
  optional reseeding pairs highest remaining seed with lowest. Aggregate all weeks
  of each round. The higher seed wins an exact playoff score tie.
- No future injury hazard, player role transition, teammate/game correlation, or
  waiver replacement model. The input data's historical timestamp and calibration
  limitations still apply. These are conditional model probabilities, not validated
  real-world championship forecasts. Numerical convergence does not fix model error.

## Precision and trade noise

Random draws are addressed by seed, simulation index, player ID and week, independently
of roster/scenario order and the other players included. A trade moves the same
simulated player outcomes. All teams, including unaffected teams, are re-evaluated
in the shared league. Adding an unused player does not shift the random stream.
Unchanged scenarios have exactly zero paired difference. For a changed scenario,
the error of its difference is computed directly from pathwise differences, not
by incorrectly treating the two odds estimates as independent.

Default `targetHalfWidth` is .005 (0.5 percentage points). Sample size is chosen
**before running**, using the worst-case standard deviation: .5 for an individual
probability, 1 for a paired probability difference. This takes 38,416 paths for a
single scenario or 153,664 for comparisons. `simulations` overrides automatic
sizing. `maxSimulations` defaults to one million; a capped run reports
`precisionReached: false` if it cannot reach the requested worst-case precision.
The output includes both marginal and paired worst-case half-widths. These use
the usual approximate 95% Monte Carlo calculation, not an absolute error guarantee.

Individual odds have Wilson intervals, including nonzero upper bounds when no
championships are observed. Expected records and paired differences have normal
approximation intervals and sample standard errors; rare outcomes/very small
samples can make these approximations unreliable. In particular, no observed
changed outcome alone is not proof that two different rosters are equivalent.
Use the conservative worst-case bound alongside the observed paired interval.
Intervals measure simulation noise, not uncertainty in the fitted model, and are
pointwise, not simultaneous guarantees over a large trade search.

The trade calculator follows this: fixed seed and forecasts while the trade is
edited, the paired interval on screen, and a difference inside that interval
dimmed as unresolved. Pass `simulations` to POST /api/trade-odds for more paths
on a close candidate, then validate a selected trade with fresh seeds; searching
many noisy trades can select a lucky one. The synchronous CPU work runs in the
server worker rather than blocking the page. The engine uses precompiled empirical cells, typed score buffers and
precomputed random keys; it retains aggregate moments/histograms, not every path.

## Validation

`pnpm test` covers exact outcomes and ties, completed-record preservation,
multiweek matchups, bracket sizes/byes/reseeding, symmetry, probability conservation,
negative defense IDs/scores, missing-input rejection, forecast-based lineup
selection, identical-scenario cancellation, roster-order invariance, and a clear
upgrade's positive paired interval across seeds. Existing uncertainty tests verify
mean/variance math and persistent reuse. `pnpm simulate:validate --full` measures
seed stability, paired-vs-independent variance, and runtime at increasing budgets;
its saved report contains actual results and environment information.


### Measured performance and convergence

Saved run on Apple M1 / Node 25.9.0, 12 teams, 180 rostered players, 17 weeks,
and two scenarios (baseline and WR exchange), three seeds at each budget:

| Paths per scenario | Elapsed time | Sample trade title change across seeds | Paired 95% half-width |
| --- | --- | --- | --- |
| 10,000 | 0.39–0.41 s | -2.710 to -2.670 pp | ±0.541–0.553 pp |
| 100,000 | 3.06–4.09 s | -2.570 to -2.394 pp | ±0.171–0.175 pp |
| 1,000,000 | 29.93–30.30 s | -2.473 to -2.442 pp | ±0.054–0.055 pp |

At one million paths, symmetric teams' title odds ranged from 8.280% to 8.395%
across all three runs, close to 1/12 = 8.333%. The trade reduced one team's title
odds by about 2.46 percentage points; its seed-to-seed spread was 0.0314 percentage
points. Pairing reduced the delta estimator's variance by about 41–42% versus
independent before/after simulations. These timings are local measurements, not
browser or server latency guarantees. The 100k budget is a useful initial estimate;
use a larger fixed budget for close decisions, guided by the returned intervals.
