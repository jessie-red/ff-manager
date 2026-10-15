# ff-analyzer

Team rater for ESPN fantasy football leagues. Pulls rosters, ESPN's analyst
consensus ranks and ESPN's projections through the (undocumented) v3 fantasy
API, adds Sleeper's projections as a second opinion, and grades every team on
its optimal lineup and bench depth by rest-of-season value over replacement.

## Setup

```fish
pnpm install
cp .env.example .env   # then fill in ESPN_SWID / ESPN_S2 / LEAGUE_ID
```

`SWID` and `espn_s2` are cookies set by espn.com once you're logged in. In
Firefox they live in `cookies.sqlite` under your profile; in the devtools
Storage tab they're under Cookies -> https://fantasy.espn.com. They last a few
months. Public leagues work without them.

## Usage

```fish
pnpm rate                       # league from .env, your team's detail below the table
pnpm rate -l 974145155          # another league
pnpm rate -t GBG -t 4           # detail for teams by abbrev or id
pnpm rate --all                 # every roster
pnpm rate --json > ratings.json # dump as JSON
pnpm rate --no-sleeper          # ESPN projections only (and no free agents in the replacement ladder)
pnpm rate --no-tiers            # value by ESPN consensus rank instead of Boris Chen tiers
pnpm rate --no-history          # linear rank value instead of historical curves
pnpm curves                     # print the points-by-rank curves behind the values
```

## Projected record

The `Proj` column (and "proj" in the team header) is each team's regular-season
record if every matchup still to be played goes to the team with the higher
optimal lineup that week. Each player's score for a week is the average of
ESPN's and Sleeper's projections for that scoring period (or whichever source
has him), and the lineup is the best legal one for that week, so bye weeks and
players out that week bench themselves. Matchups already decided keep their
real result. ESPN only serves one week's projection per request, so this
makes one player-info request per unplayed week (in parallel; they take well
under a second together). Hover the record in the web UI for the week-by-week
scores and opponents.

## Draft analysis

The "Draft Analysis" view in the web UI is the classic board: teams across the
top in round-1 order, rounds down the side, one square per pick colored by
position with the player, position, NFL team and bye week. Hover a square for
its grade and the two players who would have been the best pick instead.

Every pick is graded in hindsight with today's consensus ranks and season
projections, on two over-replacement yardsticks so positions compare. The
replacement is anchored on the draft rather than the lineup: at each position
it's the best player still on the board after round `ANCHOR_ROUNDS` (10),
i.e. one past however many the league had drafted at the position by then
(the classic VBD "baseline at pick ~100" rule). Nobody drafts a K or D/ST
that early, so the top kicker is the replacement and worth zero; that's what
keeps the analyzer from calling a round-5 kicker the best available.

* **value**: season VORP averaged over the ranks the player's Boris Chen
  tier spans (rank value when tiers aren't loaded), as in the ratings but
  re-based so the anchor rank is zero.
* **ppg+**: season points per game (the average of ESPN's season projection
  and Sleeper's week-by-week projections averaged over the season) minus the
  anchor player's, read off the drafted pool ranked by ppg.

Neither yardstick is floored at zero: a negative figure means the pick was
worse than what was there for free.

The best available by each yardstick is the player drafted later (by anyone)
with the largest figure; undrafted players aren't considered. Since every
player in a Boris tier shares one value, ties for best value go to the player
Boris ranks highest within the tier (then to ppg+). A pick scores the share of
the board's headroom it captured: its lead over the mean of everything still
on the board (what a blind pick from the pool would have returned) as a share
of the best available's lead over that mean, with the headroom counted as at
least `GAIN_SCALE` (4) points so a late-round miss of half a point isn't a
failure. Measuring from the pool rather than from zero is what keeps the last
rounds gradeable: everything left is below replacement by then, but a
handcuff who panned out still beats a dead kicker. Early on the pool is deep
and its mean sits near zero, so the score is essentially the share of the
best figure captured. The letter grade comes from the average of the two
scores. Team grades in the column headers take the team's average pick score as a
z-score across the league and letter it on the same scale as the ratings;
on the absolute scale every team's average lands within a few points of 50%,
so a league of B-minuses said nothing.
Auction drafts aren't analyzed yet.

## Draft aid

The "Draft Aid" view is a draft-day board in the style of
[Jay Zheng's draft aid](https://jayzheng.com/ff/): available players on the
left, the top of each position in the middle, the draft so far on the right,
and one click marks a player drafted. The difference is the left list, which
is sorted by what the pick is actually worth to you rather than by Boris
Chen's overall rank. Value underneath is the same currency the ratings use:
season points over the waiver wire at the position, averaged over the player's
Boris Chen tier, but not floored, so late in the draft a player at -8 still
sorts above one at -20.

### Edge, by rolling the draft forward

The default score is `edge`, and it comes from simulating the rest of the
draft rather than from a horizon picked by hand. Four hundred times, from the
pick on the clock: the other managers pick from a softmax on ADP (so a player
with ADP 40 going at 46 is ordinary rather than impossible), damped at
positions they have already filled; you pick at the slots the snake order
actually gives you; and each candidate is scored by the starting lineup you
finish with if you take him now and then draft greedily through your remaining
picks. `edge` is that expectation minus the best alternative's, so the pick is
the single positive number on the board and everyone else's figure is what
taking them instead would give up.

Three things fall out that a horizon-and-cutoff rule can't give you. A player
who has slid past his ADP is simply still on the board, rather than assumed
gone. Exactly one player leaves per pick, so the arithmetic of who's left
adds up. And positional runs are correlated across simulations, because
nobody drafts a fourth quarterback.

The continuation is marginal *lineup* value against the roster you already
hold, not the best thing on the board, which is what makes the score know that
an empty required slot is worth its whole value while a sixth running back is
worth a bench body. It's why the score stays useful at a turn: with
back-to-back picks you aren't choosing whether to wait, you're choosing a
pair, and which pair is decided by whose cliff arrives before your third pick.

The whole thing runs in the browser in about a quarter of a second per pick.

### VONA

The two "VONA" buttons keep the older reading, value over next available: the
player's value minus the best value among the players expected to still be on
the board two rounds from the pick on the clock, where ESPN's ADP decides who's
gone by then, measured against the whole board or against the player's own
position. The best survivor sits at 0 (nothing lost by waiting) and a positive
figure is what passing would cost. It's cheap and legible, but both halves are
hand-picked — the horizon is stretched to two rounds precisely because
ADP-as-a-yes/no-cutoff is overconfident — and at a turn every VONA correctly
collapses to zero, since waiting costs nothing when you pick again
immediately. That's a true answer to a question that has stopped mattering,
which is what the rollout replaces.

Either way the list is recomputed in the browser at every pick. Ties go to
value, then Boris's own order; players Boris hasn't tiered sit at the bottom in
ESPN draft-rank order. Each row also shows ESPN's rest-of-season rank, blended
ESPN/Sleeper season points per game and ESPN's ADP.

Clicks are remembered per league in the browser (undo / reset). With "ESPN
picks" on, the league's real draft picks are counted as drafted as well, the
draft is re-read every 15 seconds while it's live, and the status shows who is
on the clock and how many picks away yours is (snake drafts with a set order).

## Trade suggestions

The "Trade Suggestions" view lists every trade between the selected team and
each other roster that raises *both* teams' projected points per game, best
for the selected team first. A team is scored by its optimal lineup's ppg
(ESPN's rest-of-season projection averaged with Sleeper's when the player
matched); the bench is worth nothing, so a trade only registers when it
changes who starts on both sides. Packages run from 1-for-1 up to 2-for-2
(switchable), K and D/ST aren't offered, and trades padded with a throw-in
that a smaller trade already matches are hidden. A 2-for-1 leaves the side
taking two a roster spot short; under this metric the drop is free. Each row
also shows the net value: the value you take in minus what you send out, so a
positive figure is a trade that wins you season-long value even though both
lineups improve. That value is the same **rest-of-season VORP the team ratings
are built on** (floored at zero, since a below-replacement body is free on
waivers rather than a negative asset), so a trade's net and a team's grade are
one currency; it falls back to the preseason tier value only in a league where
no per-week projections loaded and the ratings fell back too. When FantasyCalc's values load there's a second
sortable column, **net market**: the same in-minus-out sum in FantasyCalc's
market prices (see below). It runs in
the browser on the rosters the rating already fetched.

## Trade calculator

The "Trade Calculator" view builds any trade by hand: pick two teams, check
players on either roster, and each side shows its optimal lineup's ppg before
and after (same scoring as the suggestions), the value out and in (the ratings'
rest-of-season VORP, as in the suggestions), the **market** value out and in (FantasyCalc's
trade values, below), and who would start or sit as a result. Every player
lists ESPN and Sleeper rest-of-season ppg, value and market price. A line under
the heading names whoever wins the trade at market prices and by what share of
the larger package -- anything under 5% reads as even. Clicking a row in Trade
Suggestions opens it here with the trade already checked, so you can tweak it.

### FantasyCalc trade values

The two value columns answer different questions, which is why they're shown
side by side rather than merged. *Value* is this project's own number: points
over replacement, derived from projections and expert ranks -- what a player is
worth to your lineup. *Market* is [FantasyCalc](https://fantasycalc.com)'s
redraft trade value, computed from the trades people actually make in real
leagues -- what a manager will part with, name value and all. A trade can be a
clear lineup win and a clear market loss; that gap is usually the whole
negotiation.

Values are pulled from `api.fantasycalc.com/values/current` for your league's
own shape: team count, one QB or two (any superflex slot counts), and
receptions rounded to standard / half / full PPR. They're refreshed every six
hours and cached under `.cache/fantasycalc/`, so an outage leaves the last good
copy in place rather than dropping the column.

Caveats:

- The list stops around 200 players deep and carries no K or D/ST. Anyone
  outside it is unpriced and counts as **zero**, which in a deep league can make
  a package look emptier than it is -- check the column before reading the
  verdict.
- The scale is arbitrary (the consensus #1 sits near 10,000) and is not points.
  Don't add it to anything else here.
- Players are matched on the ESPN id FantasyCalc publishes for every row, with
  normalized name + position as a fallback.
- Like every other outside source here, a failure degrades to no column rather
  than an error.

## How teams are rated

Teams are rated on **rest-of-season value over replacement**: how much each
player is projected to win you between now and the end of the fantasy regular
season, over what you'd get by streaming his roster spot. Not raw projected
points, and not a preseason ranking.

Both sources project every remaining week, so both are used. A player's
projection for a week is ESPN's and Sleeper's averaged (whichever of the two
has him), the same blend the projected record uses. Summed over the weeks left,
that's his projected points `P`. Counting the weeks he's projected to play --
Sleeper zeroes a week it has no game for, ESPN zeroes byes, and a week the two
disagree about counts as half a game with the halved projection it already
carries -- gives his games `g`. Write `r` for replacement points per game at
his position and `W` for the weeks left:

    holding him   = P + r * (W - g)     (someone else starts on his byes and
                                         the weeks he misses)
    streaming it  =     r * W
    value         = P - r * g

Two things fall out of that rather than being bolted on. Byes and missed games
cost value in exact proportion to the games missed and no more, because those
weeks aren't empty -- you start a replacement. And value shrinks as the season
runs down, which is right: two remaining games of RB5-over-RB40 really are
worth less than twelve.

`P` and `g` are kept apart because they're the two things a manager actually
trades off. `P / g` is the scoring *rate* while he's on the field -- an injured
starter and a rookie whose season totals lag both keep a high rate while their
points collapse -- and `g` is availability. Lineups show the rate beside the
value as **ROS ppg**; games left aren't a column (the page is column-heavy
enough and the value already prices them), but they're in the JSON on every
player as `ros.games`.

The replacement level is read off the league rather than a table: rank the
position by rest-of-season *points*, take the player at the replacement rank,
and use his ppg -- with the median over the ranks either side, so one odd
projection can't reprice a whole position. The replacement rank per position is the number of starters the
league fields there (flex slots split evenly between eligible positions) plus
one bench body per team, except at K and D/ST where nobody carries a backup; in
a 14-team league starting QB/2RB/2WR/TE/FLEX/K/D/ST that's QB28, RB47, WR47,
TE33, K14, D/ST14. The header line of every run shows both the ranks and the
points per game they came out at.

That ladder has to include free agents, not just rostered players. Rosters
don't reach the replacement rank at the thin positions -- a 14-team league
rosters about 25 QBs against a replacement rank of 28 -- and the tail that does
reach it at the deep ones is handcuffs and stashes projected for nothing, which
isn't who you'd actually stream. Both mistakes read replacement too low and
inflate every value at the position. Sleeper is the only source here that
covers unrostered players, so its projections complete the ladder.

Ranking that ladder by points and then reading a *rate* off it is deliberate.
`r` is a rate, but "who is the marginal rosterable body here" is a question
about total worth. A backup QB projected to start twice scores at a starter's
rate for those two weeks and is nobody's replacement, yet on a ppg ladder he
sits among the QB2s and drags the position's replacement level up with him --
which then shows up as a perfectly good WR4 or RB4 priced below replacement.
Ranked by points he falls where he belongs, and the median over the band keeps
a neighbour on a short season from doing the same thing. This ordering is
internal to the valuation: the rank shown next to a player is still ESPN's
consensus rank, and the replacement rank quoted in the header is unchanged.

A team's rating is the value of its optimal starters, K and D/ST included.
They get no position grade of their own, though: a kicker ranking is noise
nobody needs to see. Starters' values are floored at zero, since a
below-replacement starter is worth no less than an empty slot. The bench is
graded separately and doesn't count toward the rating; it sums the same value
*unfloored*, so a bench of near-replacement bodies still orders. The letter
grade is the rating's z-score across the league, and each position gets a grade
the same way from its starters' value. The weekly lineup is still picked by
ESPN's weekly consensus ranks, since these values are rest-of-season, and it
keeps its ESPN-vs-Sleeper delta column, where a disagreement is a start/sit
call; the rest-of-season lineup shows one averaged ROS ppg instead.

Why over replacement rather than points: a QB2 on the bench projects for as
many points as a starting RB but is worth nothing to the team, and value over
replacement zeroes him out.

### Fallbacks

Without per-week projections from either source, values fall back to
[Boris Chen's tiers](https://www.borischen.co/) (expert consensus ranks
clustered so that players whose rankings can't be told apart share a tier),
fetched from the fftiers S3 bucket for the league's scoring and cached for an
hour under `.cache/fftiers`. A tier is worth the season value over replacement
averaged over the positional ranks it spans:

    tier value = mean of data/monotonic_vorp.csv over the tier's ranks   (floored at 0)

`data/monotonic_vorp.csv` (from the sibling `ff` analysis) holds, for each
preseason rank at QB/RB/WR/TE/K/D/ST, the season points the player holding that
rank actually scored over the last six seasons minus the points at a
replacement rank, smoothed so value never rises with rank, with one table per
scoring format and league size (8 to 14 teams). It's still what the draft
analysis and the draft aid use, where a preseason-rank table is the right
instrument; for in-season ratings it answered the wrong question twice over,
pricing a player by where he was drafted and pricing him for a whole season
that's more than half gone.

Tiers are also what the lineup tables' `tier` column shows, and ties in the
draft views break on Boris's own order within a tier.

If the tier lists can't be fetched either (and nothing is cached), or with
`--no-tiers`, players are valued by ESPN's consensus positional rank instead,
in historical points:

    value = hist pts/game at consensus rank - hist pts/game at (replacement rank + 1)   (floored at 0)

The historical curve per position comes from nflverse (see below): over the
ten seasons before the league's, the average points per game scored by the
player who finished the season as RB1, RB2, ..., in the league's own scoring.
`pnpm curves` prints the tables. If nflverse can't be reached either, or with
`--no-history`, value falls back to linear in rank:
`replacement rank + 1 - consensus rank`.

## Historical curves (nflverse)

`src/nflverse/` pulls the regular-season player-week and team-week stat
files from the nflverse-data GitHub releases plus `games.csv` from nfldata
(final scores, for D/ST points allowed), no auth. Each season is reduced to
Sleeper-style stat lines (the same names `sleeper/scoring.ts` scores with
the league's ESPN rules): players summed to one line per season with
ESPN's per-game yardage bonuses (100/200 rush, 100/200 rec, 300/400 pass)
counted week by week, and D/ST kept per game so points- and yards-allowed
brackets score correctly. Raw CSVs (~9 MB/season) and the reduced lines
(~1 MB/season) live in `.cache/nflverse/`; the first run takes a few
seconds per season, after that curves build in well under a second.

For each season players are ranked within position by total points, totals
are divided by the season's regular-season weeks (17 or 18) so seasons
compare, and the ten curves are averaged rank by rank.

Caveats:

- nflverse has no TD-distance breakdown in the stat files, so 40+/50+ yard
  TD bonuses score zero historically (same gap as the Sleeper side).
- Position is nflverse's roster position (FB counts as RB). Players who
  moved between positions are ranked where nflverse lists them that season.
- Yards allowed are the opponent's gross passing minus sack yards plus
  rushing yards; points allowed are the final score, so a pick-six thrown
  by the team's own offense counts against its D/ST, as on ESPN.
- Without the league's `scoringItems` (rare), history is scored with ESPN's
  stock rules at the league's reception value.

## Sleeper projections

Alongside ESPN's numbers, each run pulls Sleeper's projections from the
endpoint the Sleeper app uses (`api.sleeper.app/projections/nfl/{season}/{week}`,
no auth). The league table shows ESPN and Sleeper side by side for
rest-of-season and bench value, and the lineup detail shows the per-player
delta. A big disagreement between the two is usually more interesting than
either number alone.

Sleeper's full projected stat line (passing yards, receptions, field goals
by distance, points allowed, ...) is rescored with the league's own ESPN
scoring rules, so custom settings like -2 per interception or distance-based
kicker points are reflected. `src/sleeper/scoring.ts` holds the ESPN statId
to Sleeper stat-name mapping; the ids were verified by recomputing ESPN's
`appliedTotal` from its `appliedStats` breakdown (exact match), and the
mapping by scoring Sleeper lines under plain PPR and comparing to Sleeper's
own `pts_ppr` (RB/WR/TE agree within a fraction of a point).

Caveats:

- Sleeper doesn't project ESPN's per-play bonuses (40+/50+ yard TDs,
  100/300-yard games, blocked-kick TDs), so those score zero on the Sleeper
  side. Points/yards-allowed brackets use Sleeper's expected value.
- Players are matched by normalized name + position (Sleeper's `espn_id` is
  missing for most recent draftees). Unmatched players are listed on stderr.
- Rest-of-season per game averages the remaining weeks' projections, which
  means fetching every remaining week (~2 MB each, in parallel, memoized
  for 10 minutes in the dev server).
- The endpoint is undocumented and could change; a Sleeper failure degrades to
  ESPN-only with a warning rather than failing the run.
