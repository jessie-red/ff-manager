/**
 * Auction grading: what each manager paid versus what the player is worth in
 * dollars, judged with today's information (the same hindsight values as
 * draft.ts).
 *
 * Why dollars and not a ratio. A points-per-dollar ratio is dominated by the
 * cheap end of the board: a $1 flier with a sliver of positive value scores a
 * huge return while a $60 stud who delivered can't, and a manager who bought
 * twelve $1 bodies "wins". So every player is first priced at what his value
 * *should* have cost given the league's budget, and the pick is scored on the
 * difference (surplus = fair - paid). Surplus is additive, so a team's total
 * is meaningful, and the marginal $1 player lands at fair = ~$1, surplus ~ $0:
 * he neither helps nor hurts, which is the truth of it.
 *
 * Fair price (classic VBD auction pricing): every roster spot costs at least
 * $1, so the league's discretionary money is
 *   D = teams x (budget - rosterSize)
 * and it is shared out in proportion to positive value over replacement,
 * discounted for players the league can't start:
 *   fair(p) = 1 + w(p) max(value(p), 0) / sum over drafted of w max(value, 0) x D
 * Players at or below replacement are worth the $1 minimum. Replacement is
 * draft.ts's anchor (the best player still on the board after ANCHOR_ROUNDS
 * roster spots per team), so K1 and D/ST1 price at $1 here too.
 *
 * The slot weight w is by league-wide positional rank on the yardstick
 * (value.ts replacementRanks, flex split evenly): the ranks the league
 * starts weigh 1, and each band of one-per-team below them weighs
 * BENCH_WEIGHTS in turn (0.5, 0.3, 0.2) then BENCH_TAIL (0.1). In a 12-team
 * 3-WR league WR37..48 count half, WR49..60 0.3 and so on. Linear VBD
 * pricing pays a dollar per point wherever the point sits, which
 * systematically underprices the studs: the market pays a premium for
 * value that fits in a lineup, and it's right to, since a WR56's points
 * mostly stay on the bench. Discounting bench-calibre value shrinks the pool
 * and moves that money up the board. Since fair prices still sum to the
 * league's total budget, surplus stays zero-sum before unspent money.
 *
 * The pricing is done twice, once per yardstick (tier value, ppg over
 * replacement), and a pick's fair price is their average.
 *
 * Pick grade: the surplus as a z-score across every pick in the league
 * (zToGrade, as the ratings do). The $1 bodies sit at surplus ~0, i.e. the
 * middle of the pack, a B: paying a dollar for a dollar is neither a steal nor
 * a blunder. draft.ts's best-available yardsticks are left on the pick but
 * carry no weight in an auction, where "who was still on the board" is only
 * a matter of nomination order.
 *
 * Team grade: the roster's fair price, weighted by how much of it can reach
 * the lineup, less the whole budget, z-scored across the league. The team's
 * hindsight-optimal lineup (lineup.ts, filled by fair price) counts in full;
 * the bench, best first, counts on the BENCH_WEIGHTS curve (0.5, 0.3, 0.2,
 * then 0.1 each), since a bench player only turns into points when someone
 * ahead of him doesn't. Paying is always in full: $20 on a bench RB costs $20
 * whether or not he plays. Measuring from the budget rather than from what
 * was spent means money left on the table counts against you: it bought
 * nothing, so it's a $0 return on those dollars. `efficiency` (fair / spent)
 * is the ratio view for the whole roster, where the denominator is big enough
 * for a ratio to mean something. Fair prices themselves stay roster-free, so
 * a pick's grade doesn't depend on who else the team bought.
 */
import type { EspnLeague } from "../espn/types.js";
import type { DraftAnalysis, DraftInput, DraftPick, DraftTeam } from "./draft.js";
import { optimalLineup } from "./lineup.js";
import type { Player } from "./player.js";
import { zToGrade } from "./rate.js";
import { replacementRanks } from "./value.js";

/** Share of a bench player's fair price that counts toward the team grade, best bench player first; BENCH_TAIL beyond the list. */
export const BENCH_WEIGHTS = [0.5, 0.3, 0.2];
export const BENCH_TAIL = 0.1;
export const benchWeight = (i: number) => BENCH_WEIGHTS[i] ?? BENCH_TAIL;

export interface AuctionPick extends DraftPick {
  /** Fair price by each yardstick and their average, in league dollars (>= 1). */
  fair: { value: number; ppg: number; overall: number };
  /** League-wide positional rank on each yardstick and the slot weight it earns (1 for a starter, BENCH_WEIGHTS below). */
  slot: { value: { rank: number; weight: number }; ppg: { rank: number; weight: number } };
  /** fair.overall - bid. */
  surplus: number;
  /** The surplus as a z-score across the league's picks; `grade` is its letter. */
  z: number;
}

export interface AuctionTeam extends DraftTeam {
  spent: number;
  unspent: number;
  /** Sum of the roster's fair prices (fair.overall). */
  fair: number;
  /** Fair price of the hindsight-optimal lineup (by fair), in full, plus the bench on the BENCH_WEIGHTS curve. */
  starterFair: number;
  benchFair: number;
  weightedFair: number;
  /** weightedFair - budget: unspent money counts as spent on nothing. */
  surplus: number;
  /** fair / spent; null when nothing was spent. */
  efficiency: number | null;
}

export interface AuctionAnalysis extends Omit<DraftAnalysis, "picks" | "teams"> {
  budget: number;
  /** Discretionary dollars D above the $1-per-spot floor, and the slot-weighted positive value pool it was priced against. */
  pool: { dollars: number; value: number; ppg: number };
  picks: AuctionPick[];
  teams: AuctionTeam[];
}

export function analyzeAuction(league: EspnLeague, analysis: DraftAnalysis, inputs: DraftInput[], slots: Map<number, number>): AuctionAnalysis {
  const budget = league.settings.draftSettings?.auctionBudget ?? 200;
  const nTeams = analysis.teams.length;
  const rosterSize = analysis.rounds;
  const dollars = Math.max(0, nTeams * (budget - rosterSize));
  const pos = (x: number) => Math.max(0, x);

  // Slot weights: rank the drafted players at each position on each yardstick; the league's
  // starters weigh 1 and every band of one-per-team below them steps down BENCH_WEIGHTS.
  const starters = replacementRanks(league, slots, false);
  const slotOf = (yard: "value" | "ppg", other: "value" | "ppg") => {
    const out = new Map<DraftPick, { rank: number; weight: number }>();
    const byPos = new Map<string, DraftPick[]>();
    for (const p of analysis.picks) if (p.player) (byPos.get(p.player.pos) ?? byPos.set(p.player.pos, []).get(p.player.pos)!).push(p);
    for (const [position, ps] of byPos) {
      ps.sort((a, b) => b.gain[yard] - a.gain[yard] || b.gain[other] - a.gain[other]);
      const last = starters[position] ?? 0;
      ps.forEach((p, i) => {
        const rank = i + 1;
        out.set(p, { rank, weight: rank <= last ? 1 : benchWeight(Math.floor((rank - last - 1) / nTeams)) });
      });
    }
    return (p: DraftPick) => out.get(p) ?? { rank: 0, weight: BENCH_TAIL };
  };
  const slotValue = slotOf("value", "ppg");
  const slotPpg = slotOf("ppg", "value");
  const pool = {
    dollars,
    value: analysis.picks.reduce((s, p) => s + slotValue(p).weight * pos(p.gain.value), 0),
    ppg: analysis.picks.reduce((s, p) => s + slotPpg(p).weight * pos(p.gain.ppg), 0),
  };
  const price = (gain: number, weight: number, total: number) => 1 + (total > 0 ? (weight * pos(gain) / total) * dollars : 0);

  const priced = analysis.picks.map((p) => {
    const slot = { value: slotValue(p), ppg: slotPpg(p) };
    const value = price(p.gain.value, slot.value.weight, pool.value);
    const ppg = price(p.gain.ppg, slot.ppg.weight, pool.ppg);
    const overall = (value + ppg) / 2;
    return { ...p, fair: { value, ppg, overall }, slot, surplus: overall - p.bid };
  });
  const pm = mean(priced.map((p) => p.surplus));
  const psd = stdev(priced.map((p) => p.surplus), pm);
  const picks: AuctionPick[] = priced.map((p) => {
    const z = (p.surplus - pm) / psd;
    return { ...p, z, grade: zToGrade(z) };
  });

  // Per team: spend, fair, and fair weighted by lineup slot (the lineup filler needs the full Player records).
  const fairOf = new Map<number, number>();
  for (const p of picks) if (p.player) fairOf.set(p.player.id, p.fair.overall);
  const fairMetric = { value: (p: Player) => fairOf.get(p.id) ?? 0, points: (p: Player) => fairOf.get(p.id) ?? 0 };
  const totals = new Map<number, { spent: number; fair: number; starterFair: number; benchFair: number; weightedFair: number }>();
  for (const t of analysis.teams) {
    const mine = picks.filter((p) => p.teamId === t.teamId);
    const roster = inputs.filter((i) => i.teamId === t.teamId && i.player).map((i) => ({ ...i.player!, onIR: false }));
    const lineup = optimalLineup(roster, slots, fairMetric);
    const starterFair = lineup.total;
    // optimalLineup returns the bench sorted by the metric, best first.
    const benchFair = lineup.bench.reduce((s, p, i) => s + benchWeight(i) * fairMetric.value(p), 0);
    // Picks without a player record are $1 bodies: count them as bench tail.
    const missing = mine.filter((p) => !p.player).length * BENCH_TAIL;
    totals.set(t.teamId, {
      spent: mine.reduce((s, p) => s + p.bid, 0),
      fair: mine.reduce((s, p) => s + p.fair.overall, 0),
      starterFair,
      benchFair,
      weightedFair: starterFair + benchFair + missing,
    });
  }
  const surpluses = analysis.teams.map((t) => (totals.get(t.teamId)?.weightedFair ?? 0) - budget);
  const m = mean(surpluses);
  const sd = stdev(surpluses, m);

  const teams: AuctionTeam[] = analysis.teams.map((t, i) => {
    const { spent, fair, starterFair, benchFair, weightedFair } = totals.get(t.teamId) ?? { spent: 0, fair: 0, starterFair: 0, benchFair: 0, weightedFair: 0 };
    const surplus = surpluses[i]!;
    const z = (surplus - m) / sd;
    return {
      ...t,
      spent,
      unspent: budget - spent,
      fair,
      starterFair,
      benchFair,
      weightedFair,
      surplus,
      efficiency: spent > 0 ? fair / spent : null,
      score: surplus,
      z,
      grade: zToGrade(z),
    };
  });

  return { ...analysis, budget, pool, picks, teams };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
/** Population standard deviation, 1 when it would be 0 so z-scores stay finite. */
const stdev = (xs: number[], m: number) => Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length || 1)) || 1;
