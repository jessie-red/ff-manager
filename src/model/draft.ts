/**
 * Draft grading: for every pick, what the manager took versus the best thing
 * they could have taken, judged with today's information.
 *
 * Two yardsticks per player, both "over replacement" so a QB and an RB are
 * comparable and a pick's roster context doesn't matter:
 *
 *   value  tier value (value.ts): the season VORP averaged over the ranks the
 *          player's Boris Chen tier spans; rank value when tiers aren't loaded
 *   ppg    season points per game (ESPN's and Sleeper's averaged) minus the
 *          replacement player's ppg at the position
 *
 * Replacement here is anchored on the draft itself rather than on the lineup:
 * at each position it's the best player still on the board once the first
 * ANCHOR_ROUNDS rounds are gone, i.e. one past however many the league had
 * drafted at the position by then (anchorRanks). That's the classic VBD
 * "baseline at pick ~100" rule: a player is worth what he gives you over what
 * you'd have got for nothing at the point where the draft stops being about
 * starters. It's what stops a K1 or D/ST1 looking like a round-5 pick: nobody
 * drafts them before the anchor, so the top kicker *is* the replacement and
 * is worth zero. The VORP table is re-based on that rank (value.ts
 * tierValues) and the ppg level is read off the drafted pool ranked by ppg.
 * Neither yardstick is floored at zero: the sign says whether a pick beat
 * what was there for free.
 *
 * "Could have taken" means every player drafted later by anyone, plus the
 * pick itself; undrafted players are not considered. The best available by
 * each yardstick is recorded, and the pick is scored by how much of the
 * board's headroom it captured: the pick's lead over the mean of the
 * remaining pool (what a blind pick from it would have returned) as a share
 * of the best available's lead over that same mean. Measuring from the pool
 * rather than from zero is what keeps the last rounds gradeable, where
 * everything left is below replacement but a handcuff who panned out still
 * beats a dead kicker. Early on the pool is deep and its mean sits near
 * zero, so the score is essentially the share of the best figure captured.
 * Ties for best value (a whole Boris tier shares one value) go to the player
 * Boris ranks highest, then to ppg. The headroom is taken to be at least
 * GAIN_SCALE, so taking a 1-point player when 2 was the best on the board is
 * a rounding error, not an F. The letter grade is from the average of the
 * two scores.
 */
import type { EspnLeague } from "../espn/types.js";
import { memberNames, zToGrade } from "./rate.js";
import type { Player } from "./player.js";
import type { Tiers } from "../tiers/lookup.js";
import type { VorpTable } from "../tiers/vorp.js";
import { playerValue, replacementRanks, tierValues, type Curves, type Valuation } from "./value.js";

/** The board's headroom (best available over the mean remaining) counts as at least this many points, so tiny misses stay tiny. */
export const GAIN_SCALE = 4;

/** Replacement is the best player left at each position after this many rounds (league size x this picks). */
export const ANCHOR_ROUNDS = 10;

/**
 * Replacement rank per position the league starts, anchored on the draft:
 * one past the number drafted at the position in the first ANCHOR_ROUNDS
 * rounds, so the anchor is the best player of the position still on the board
 * afterwards (1 at a position nobody has touched by then).
 */
export function anchorRanks(league: EspnLeague, slots: Map<number, number>, picks: DraftInput[]): Record<string, number> {
  const horizon = league.teams.length * ANCHOR_ROUNDS;
  const out: Record<string, number> = {};
  for (const pos of Object.keys(replacementRanks(league, slots, false))) out[pos] = 1;
  for (const p of picks) {
    if (p.overall > horizon || !p.player) continue;
    if (p.player.pos in out) out[p.player.pos]!++;
  }
  return out;
}

/**
 * The draft's valuation: the ratings' curves and tier sizes, re-based on the
 * draft-anchored replacement ranks and left unfloored. `replacement` is the
 * rank whose value is zero less one, matching value.ts's convention that
 * value hits zero at replacement + 1.
 */
export function draftValuation(
  league: EspnLeague,
  slots: Map<number, number>,
  picks: DraftInput[],
  curves: Curves | null,
  tiers?: { tiers: Tiers; vorp: VorpTable },
): Valuation {
  const anchor = anchorRanks(league, slots, picks);
  const replacement = Object.fromEntries(Object.entries(anchor).map(([pos, r]) => [pos, r - 1]));
  const base: Valuation = { replacement, curves, tiers: null, floor: false };
  if (!tiers) return base;
  const sizes = Object.fromEntries(Object.entries(tiers.tiers.tiers).map(([pos, ts]) => [pos, ts.map((t) => t.length)]));
  return { ...base, tiers: tierValues(sizes, tiers.vorp, { anchor, floor: false }) };
}

export interface DraftPlayer {
  id: number;
  name: string;
  pos: string;
  team: string;
  bye: number | null;
  injuryStatus: string;
  /** ESPN rest-of-season consensus positional rank. */
  rank: number | undefined;
  /** Boris Chen tier and positional rank (undefined when untiered or tiers aren't loaded). */
  tier: number | undefined;
  tierRank: number | undefined;
  /** Tier value (rank value without tiers), see value.ts. */
  value: number;
  /** Season points per game: ESPN and Sleeper averaged, or whichever exists. */
  ppg: number;
  espnPpg: number;
  sleeperPpg: number | null;
  /** `ppg` minus the position's replacement ppg (ppgReplacement); negative below it. */
  ppgOver: number;
  /** ESPN's pre-draft overall rank, i.e. roughly where ESPN expected the player to go. */
  draftRank: number | undefined;
}

/** A player's worth by each yardstick: rank value and ppg over replacement. */
export interface PickGain {
  value: number;
  ppg: number;
}

/** A player who was still on the board and what they're worth. */
export interface Alternative {
  player: DraftPlayer;
  gain: PickGain;
  /** Overall pick number the player actually went at (equals the pick's own when it was the best choice). */
  overall: number;
  teamId: number;
}

export interface DraftPick {
  overall: number;
  round: number;
  pickInRound: number;
  teamId: number;
  /** Winning bid in an auction; 0 in snake drafts. */
  bid: number;
  keeper: boolean;
  /** ESPN's autodraft made the selection. */
  auto: boolean;
  /** The drafted player, or null when ESPN returned no record for the id. */
  player: DraftPlayer | null;
  /** The drafted player's rank value and ppg over replacement (zeros without a record). */
  gain: PickGain;
  /** Best available by rank value / by ppg over replacement; null when no player record was available. */
  bestValue: Alternative | null;
  bestPpg: Alternative | null;
  /** Mean gain of every player still on the board (this pick included): what a blind pick would have returned. */
  remaining: PickGain;
  /** Share of the board's headroom over `remaining` captured, 0..1, per yardstick and averaged. */
  score: { value: number; ppg: number; overall: number };
  grade: string;
}

export interface DraftTeam {
  teamId: number;
  abbrev: string;
  name: string;
  owner: string;
  isMe: boolean;
  logo: string | undefined;
  /** Mean of the team's pick scores (null with no graded picks). */
  score: number | null;
  /** That mean as a z-score across the league's teams, and its letter (zToGrade), so the grades spread like the ratings'. */
  z: number | null;
  grade: string | null;
}

export interface DraftAnalysis {
  /** "SNAKE", "AUCTION", ... from the league's settings. */
  type: string;
  /** Teams in round-1 pick order; the board's columns. */
  teams: DraftTeam[];
  /** Draft-anchored replacement rank (see anchorRanks) and its season ppg per position, the ppg replacement level. */
  ppgReplacement: Record<string, { rank: number; ppg: number }>;
  /** The draft's valuation (anchored replacement ranks, unfloored tier values), behind every `value`. */
  valuation: Valuation;
  /** Number of rows on the board: the most picks any one team made. */
  rounds: number;
  picks: DraftPick[];
}

export function scoreToGrade(s: number): string {
  if (s >= 0.97) return "A+";
  if (s >= 0.9) return "A";
  if (s >= 0.8) return "A-";
  if (s >= 0.7) return "B+";
  if (s >= 0.6) return "B";
  if (s >= 0.5) return "B-";
  if (s >= 0.4) return "C+";
  if (s >= 0.3) return "C";
  if (s >= 0.2) return "C-";
  return "D";
}

/**
 * Share of the board's headroom captured: the pick's lead over the mean of
 * the remaining pool as a share of the best available's, with the headroom
 * counted as at least GAIN_SCALE. 1 for the best available (or better), 0 at
 * or below the mean.
 */
function captured(actual: number, best: number, mean: number): number {
  const headroom = Math.max(best - mean, GAIN_SCALE);
  return Math.min(1, Math.max(0, (actual - mean) / headroom));
}

/** Season points per game blended across sources, or whichever one exists. */
export function seasonPpg(p: Player): number {
  const espn = p.rosPpg;
  const sleeper = p.sleeper?.seasonPpg;
  if (sleeper === undefined || sleeper === null) return espn;
  if (!espn) return sleeper;
  return (espn + sleeper) / 2;
}

export interface DraftInput {
  overall: number;
  round: number;
  pickInRound: number;
  teamId: number;
  bid: number;
  keeper: boolean;
  auto: boolean;
  /** Full player record, or null when ESPN didn't return one. */
  player: Player | null;
  bye: number | null;
  draftRank: number | undefined;
}

export function analyzeDraft(
  league: EspnLeague,
  picks: DraftInput[],
  slots: Map<number, number>,
  sources: { curves: Curves | null; tiers?: { tiers: Tiers; vorp: VorpTable } },
  mySwid?: string,
): DraftAnalysis {
  const ordered = [...picks].sort((a, b) => a.overall - b.overall);
  const valuation = draftValuation(league, slots, ordered, sources.curves, sources.tiers);
  const valueOf = (p: Player) => playerValue(valuation, p);

  // ppg replacement level: the anchor rank at each position, read off the drafted pool ranked by
  // season ppg (the pool holds every starter-calibre player).
  const ppgReplacement: DraftAnalysis["ppgReplacement"] = {};
  for (const [pos, rank] of Object.entries(anchorRanks(league, slots, ordered))) {
    const sorted = ordered
      .map((p) => p.player)
      .filter((p): p is Player => p !== null && p.pos === pos)
      .map(seasonPpg)
      .sort((a, b) => b - a);
    ppgReplacement[pos] = { rank, ppg: sorted[Math.min(rank, sorted.length) - 1] ?? 0 };
  }
  const ppgOverOf = (p: Player) => {
    const level = ppgReplacement[p.pos];
    return level ? seasonPpg(p) - level.ppg : 0;
  };

  const describe = (input: DraftInput): DraftPlayer | null => {
    const p = input.player;
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      pos: p.pos,
      team: p.team,
      bye: input.bye,
      injuryStatus: p.injuryStatus,
      rank: p.rosRank,
      tier: p.tier,
      tierRank: p.tierRank,
      value: valueOf(p),
      ppg: seasonPpg(p),
      espnPpg: p.rosPpg,
      sleeperPpg: p.sleeper?.seasonPpg ?? null,
      ppgOver: ppgOverOf(p),
      draftRank: input.draftRank,
    };
  };
  const described = ordered.map(describe);
  const gains: PickGain[] = described.map((d) => (d ? { value: d.value, ppg: d.ppgOver } : { value: 0, ppg: 0 }));

  // Value ties (a whole Boris tier shares one value) go to Boris's own order when both
  // players are in his lists at the same position, else to ppg over replacement.
  const betterValue = (a: Alternative, b: Alternative): boolean => {
    if (a.gain.value !== b.gain.value) return a.gain.value > b.gain.value;
    const ra = a.player.tierRank;
    const rb = b.player.tierRank;
    if (a.player.pos === b.player.pos && ra !== undefined && rb !== undefined && ra !== rb) return ra < rb;
    return a.gain.ppg > b.gain.ppg;
  };

  // Best on the board at each pick, scanning from the last pick back so it's one pass.
  const bestValueAt: (Alternative | null)[] = new Array(ordered.length).fill(null);
  const bestPpgAt: (Alternative | null)[] = new Array(ordered.length).fill(null);
  const remainingAt: PickGain[] = new Array(ordered.length);
  let bestValue: Alternative | null = null;
  let bestPpg: Alternative | null = null;
  const sum: PickGain = { value: 0, ppg: 0 };
  let n = 0;
  for (let j = ordered.length - 1; j >= 0; j--) {
    const player = described[j];
    if (player) {
      const g = gains[j]!;
      const alt: Alternative = { player, gain: g, overall: ordered[j]!.overall, teamId: ordered[j]!.teamId };
      if (!bestValue || betterValue(alt, bestValue)) bestValue = alt;
      if (!bestPpg || g.ppg > bestPpg.gain.ppg || (g.ppg === bestPpg.gain.ppg && g.value > bestPpg.gain.value)) bestPpg = alt;
      sum.value += g.value;
      sum.ppg += g.ppg;
      n++;
    }
    bestValueAt[j] = bestValue;
    bestPpgAt[j] = bestPpg;
    remainingAt[j] = n ? { value: sum.value / n, ppg: sum.ppg / n } : { value: 0, ppg: 0 };
  }

  const out: DraftPick[] = ordered.map((pick, i) => {
    const gain = gains[i]!;
    const remaining = remainingAt[i]!;
    const score = {
      value: captured(gain.value, bestValueAt[i]?.gain.value ?? 0, remaining.value),
      ppg: captured(gain.ppg, bestPpgAt[i]?.gain.ppg ?? 0, remaining.ppg),
      overall: 0,
    };
    score.overall = (score.value + score.ppg) / 2;
    return {
      overall: pick.overall,
      round: pick.round,
      pickInRound: pick.pickInRound,
      teamId: pick.teamId,
      bid: pick.bid,
      keeper: pick.keeper,
      auto: pick.auto,
      player: described[i]!,
      gain,
      bestValue: bestValueAt[i]!,
      bestPpg: bestPpgAt[i]!,
      remaining,
      score,
      grade: scoreToGrade(score.overall),
    };
  });

  // Columns: the league's round-1 order when ESPN provides it, else the order teams first picked in.
  const firstPick = new Map<number, number>();
  for (const p of ordered) if (!firstPick.has(p.teamId)) firstPick.set(p.teamId, p.overall);
  const configured = league.settings.draftSettings?.pickOrder ?? [];
  const teamIds = [...new Set([...configured, ...league.teams.map((t) => t.id)])].filter((id) => league.teams.some((t) => t.id === id));
  teamIds.sort((a, b) => {
    const ia = configured.indexOf(a);
    const ib = configured.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
    return (firstPick.get(a) ?? Infinity) - (firstPick.get(b) ?? Infinity);
  });
  // Team grade: mean pick score, graded as a z-score across the league (as the ratings are)
  // since every team's mean lands within a few points of 0.5 on the absolute scale.
  const scores = new Map<number, number[]>();
  for (const p of out) if (p.player) (scores.get(p.teamId) ?? scores.set(p.teamId, []).get(p.teamId)!).push(p.score.overall);
  const teamScore = new Map([...scores].map(([id, ss]) => [id, ss.reduce((a, b) => a + b, 0) / ss.length]));
  const all = [...teamScore.values()];
  const m = all.reduce((a, b) => a + b, 0) / (all.length || 1);
  const sd = Math.sqrt(all.reduce((a, s) => a + (s - m) ** 2, 0) / (all.length || 1)) || 1;

  const names = memberNames(league);
  const me = mySwid?.toLowerCase();
  const teams: DraftTeam[] = teamIds.map((id) => {
    const t = league.teams.find((x) => x.id === id)!;
    const owners = (t.owners ?? []).map((o) => o.toLowerCase());
    const score = teamScore.get(id) ?? null;
    const z = score === null ? null : (score - m) / sd;
    return {
      teamId: t.id,
      abbrev: t.abbrev,
      name: t.name,
      owner: names.get(owners[0] ?? "") ?? "",
      isMe: me !== undefined && owners.includes(me),
      logo: t.logo,
      score,
      z,
      grade: z === null ? null : zToGrade(z),
    };
  });
  const counts = new Map<number, number>();
  for (const p of out) counts.set(p.teamId, (counts.get(p.teamId) ?? 0) + 1);

  return {
    type: league.settings.draftSettings?.type ?? "SNAKE",
    teams,
    ppgReplacement,
    valuation,
    rounds: Math.max(0, ...counts.values()),
    picks: out,
  };
}
