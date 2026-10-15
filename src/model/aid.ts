/**
 * Draft aid: the player pool ranked by value so the next pick is the top
 * name still on the board. Modelled on Jay Zheng's draft aid (jayzheng.com/ff),
 * which lists Boris Chen's overall ranks; here the overall order is by
 * season value instead (see value.ts), so a tier-4 RB and a tier-2 TE are
 * compared in the same currency rather than by where Boris's overall list
 * happens to put them.
 *
 * Value is over the WAIVER WIRE, the same replacement the ratings use: the
 * tier's season VORP from the sheet's `waiver_vorp` column (tiers/vorp.ts)
 * with a bench body per team in the rank-value fallback likewise. Unlike the
 * ratings it's not floored, so the order stays meaningful below replacement
 * (a late-round pick between a -5 and a -20 player is still a choice).
 * Players Boris hasn't tiered have no value; they sort after everyone valued,
 * by ESPN's draft rank.
 *
 * The board is ordered by one of two client-side scores, both computed from
 * the server's value-sorted pool because both depend on the draft so far:
 *
 *   * rollout.ts's `edge` (the default): simulate the rest of the draft from
 *     your own pick schedule and score each player by the roster he leads to.
 *     No horizon constant, and it still discriminates at a turn.
 *   * VONA below, kept as the cheap reading and the fallback.
 *
 * VONA, value over next available: the player's value minus the best value
 * among the undrafted players (himself included, at any position or at his own
 * as the client's toggle asks) expected to still be on the board two rounds
 * from the pick on the clock, where "expected" reads ESPN's ADP (a player whose
 * ADP falls before that pick is assumed gone). Two rounds all but guarantees the
 * survivor really will be there, whatever the snake gives you. That's the cost
 * of passing on him now. Both halves are hand-picked, though -- the horizon is
 * stretched to two rounds precisely because ADP-as-a-cutoff is overconfident --
 * and at a turn every VONA correctly collapses to zero, which is why
 * rollout.ts exists.
 *
 * Who's drafted comes from ESPN's draft detail when the league is drafting
 * (or has drafted) and from the user's own clicks otherwise; the client
 * merges the two.
 */
import { BENCH_SLOT } from "../espn/constants.js";
import type { EspnLeague, EspnPoolEntry } from "../espn/types.js";
import type { SleeperProjections } from "../sleeper/client.js";
import type { Tiers } from "../tiers/lookup.js";
import type { VorpTable } from "../tiers/vorp.js";
import { seasonPpg } from "./draft.js";
import { startingSlots, toPlayer } from "./player.js";
import { memberNames } from "./rate.js";
import { playerValue, replacementRanks, tierValues, type Curves, type Valuation } from "./value.js";

export interface AidPlayer {
  id: number;
  name: string;
  pos: string;
  team: string;
  bye: number | null;
  injuryStatus: string;
  /** ESPN rest-of-season consensus positional rank. */
  rank: number | undefined;
  /** ESPN's pre-draft overall rank and ADP across ESPN leagues. */
  draftRank: number | undefined;
  adp: number | undefined;
  /** Boris Chen tier and positional rank; undefined when untiered. */
  tier: number | undefined;
  tierRank: number | undefined;
  /** Season value (unfloored tier value; rank value without tiers); null for untiered players at tiered positions. */
  value: number | null;
  /** Season points per game, ESPN and Sleeper blended (draft.ts seasonPpg). */
  ppg: number;
  /** Fantasy team rostering the player right now (0 = nobody). */
  onTeamId: number;
}

export interface AidTeam {
  teamId: number;
  abbrev: string;
  name: string;
  owner: string;
  isMe: boolean;
}

/** One ESPN draft selection, the light version of draft.ts's DraftPick. */
export interface AidPick {
  overall: number;
  round: number;
  pickInRound: number;
  teamId: number;
  playerId: number;
}

export interface DraftStatus {
  /** "SNAKE" | "AUCTION" | ... */
  type: string;
  drafted: boolean;
  inProgress: boolean;
  picks: AidPick[];
}

export interface AidData {
  valuation: Valuation;
  /** Every pool player in draft order: by value, ties to Boris's order then ESPN's rank, untiered last by draft rank. */
  players: AidPlayer[];
  teams: AidTeam[];
  /** Team ids in round-1 order (ESPN's draft settings), empty when the league hasn't set one. */
  pickOrder: number[];
  /** Starting lineup slot counts (ESPN slot id -> count), what the rollout fills a roster against. */
  slots: Record<number, number>;
  /** Bench spots per team, which with the starting slots says how many picks a draft has. */
  benchSize: number;
  draft: DraftStatus;
}

/** Who picks at overall pick `n` (1-based) in a snake draft with this round-1 order; undefined without an order. */
export function snakePicker(order: number[], n: number): number | undefined {
  if (!order.length || n < 1) return undefined;
  const round = Math.floor((n - 1) / order.length);
  const i = (n - 1) % order.length;
  return round % 2 === 0 ? order[i] : order[order.length - 1 - i];
}

/**
 * The ratings' valuation (over the waiver wire: replacementRanks with the
 * bench allowance, the sheet's waiver table from loadVorp(league)) but
 * unfloored, so below-replacement players keep their order.
 */
export function aidValuation(league: EspnLeague, curves: Curves | null, tiers?: { tiers: Tiers; vorp: VorpTable }): Valuation {
  const base: Valuation = { replacement: replacementRanks(league, startingSlots(league)), curves, tiers: null, floor: false };
  if (!tiers) return base;
  const sizes = Object.fromEntries(Object.entries(tiers.tiers.tiers).map(([pos, ts]) => [pos, ts.map((t) => t.length)]));
  return { ...base, tiers: tierValues(sizes, tiers.vorp, { floor: false }) };
}

/** ESPN's draft detail as the aid wants it; empty picks before the draft (ESPN lists -1 placeholders then). */
export function draftStatus(league: EspnLeague): DraftStatus {
  const d = league.draftDetail;
  const picks = d?.drafted || d?.inProgress ? (d.picks ?? []).filter((p) => p.playerId !== -1) : [];
  return {
    type: league.settings.draftSettings?.type ?? "SNAKE",
    drafted: d?.drafted ?? false,
    inProgress: d?.inProgress ?? false,
    picks: picks
      .map((p) => ({ overall: p.overallPickNumber, round: p.roundId, pickInRound: p.roundPickNumber, teamId: p.teamId, playerId: p.playerId }))
      .sort((a, b) => a.overall - b.overall),
  };
}

export function buildAid(
  league: EspnLeague,
  pool: EspnPoolEntry[],
  byes: Map<number, number>,
  sources: { sleeper?: SleeperProjections; curves: Curves | null; tiers?: { tiers: Tiers; vorp: VorpTable } },
  mySwid?: string,
): AidData {
  const valuation = aidValuation(league, sources.curves, sources.tiers);
  const week = Math.max(1, league.scoringPeriodId);
  const rankType = league.settings.scoringSettings?.playerRankType ?? "PPR";

  const players: AidPlayer[] = pool.map((entry) => {
    const espn = entry.player;
    const p = toPlayer({ playerId: espn.id, lineupSlotId: 20, playerPoolEntry: { player: espn } }, league, week, sources.sleeper, undefined, sources.tiers?.tiers);
    // At a position with tier values an untiered player has no value (rather than 0, which would outrank every negative tier).
    const tiered = valuation.tiers?.[p.pos] === undefined || p.tier !== undefined;
    return {
      id: p.id,
      name: p.name,
      pos: p.pos,
      team: p.team,
      bye: byes.get(espn.proTeamId) ?? null,
      injuryStatus: p.injuryStatus,
      rank: p.rosRank,
      draftRank: espn.draftRanksByRankType?.[rankType]?.rank,
      adp: espn.ownership?.averageDraftPosition,
      tier: p.tier,
      tierRank: p.tierRank,
      value: tiered ? playerValue(valuation, p) : null,
      ppg: seasonPpg(p),
      onTeamId: entry.onTeamId,
    };
  });
  players.sort(compareAid);

  const names = memberNames(league);
  const me = mySwid?.toLowerCase();
  const teams: AidTeam[] = league.teams.map((t) => {
    const owners = (t.owners ?? []).map((o) => o.toLowerCase());
    return { teamId: t.id, abbrev: t.abbrev, name: t.name, owner: names.get(owners[0] ?? "") ?? "", isMe: me !== undefined && owners.includes(me) };
  });

  const slots = Object.fromEntries(startingSlots(league));
  const benchSize = league.settings.rosterSettings.lineupSlotCounts[String(BENCH_SLOT)] ?? 0;
  return { valuation, players, teams, pickOrder: league.settings.draftSettings?.pickOrder ?? [], slots, benchSize, draft: draftStatus(league) };
}

const INF = Number.POSITIVE_INFINITY;

/** How many rounds past the pick on the clock VONA looks: far enough that a surviving player really will be there. */
export const VONA_ROUNDS = 2;

/** The pick VONA measures availability at: overall pick `n` (the one on the clock) plus VONA_ROUNDS rounds. */
export const vonaPick = (teams: number, n: number): number => n + VONA_ROUNDS * Math.max(1, teams);

/** Expected to still be on the board at overall pick `pick`: ADP at or after it (no ADP = nobody's drafting him). */
export const survivesTo = (p: AidPlayer, pick: number): boolean => p.adp === undefined || p.adp >= pick;

/**
 * Value over next available for every valued player: his value minus the
 * best value among the undrafted players expected to survive to `nextPick`
 * (survivesTo), himself included, so the best survivor is worth 0 (nothing
 * lost by waiting) and everyone else's figure is what waiting would cost
 * or, below the line, what he trails the safe pick by. His whole value when
 * nobody would survive. Null for unvalued players; drafted players still get
 * a figure, for the struck-through rows.
 *
 * `byPosition` picks the baseline: false (the default) compares against the
 * best survivor at ANY position, which asks "what does this pick cost me
 * against the best thing the board will still offer" and so ranks the whole
 * board in one currency; true is the classic VONA, comparing against the best
 * survivor at the player's OWN position, which asks "how much of this
 * position's supply falls off before I pick again" and surfaces positional
 * runs (the last good TE scores high even when RBs are worth more).
 */
export function vonaValues(players: AidPlayer[], drafted: Set<number>, nextPick: number, byPosition = false): Map<number, number | null> {
  let best: number | null = null;
  const bestAt = new Map<string, number>();
  for (const p of players) {
    if (p.value === null || drafted.has(p.id) || !survivesTo(p, nextPick)) continue;
    if (best === null || p.value > best) best = p.value;
    const at = bestAt.get(p.pos);
    if (at === undefined || p.value > at) bestAt.set(p.pos, p.value);
  }
  const out = new Map<number, number | null>();
  for (const p of players) {
    const base = byPosition ? bestAt.get(p.pos) : best;
    out.set(p.id, p.value === null ? null : p.value - (base ?? 0));
  }
  return out;
}

/** Board order: VONA (from vonaValues), ties and unvalued players as compareAid. */
export function compareVona(vona: Map<number, number | null>): (a: AidPlayer, b: AidPlayer) => number {
  return (a, b) => {
    const va = vona.get(a.id) ?? null;
    const vb = vona.get(b.id) ?? null;
    if (va !== null && vb !== null && va !== vb) return vb - va;
    if ((va === null) !== (vb === null)) return va === null ? 1 : -1;
    return compareAid(a, b);
  };
}

/** Draft order: value, then Boris's own order within a position, then ESPN's rank; unvalued players last by draft rank. */
export function compareAid(a: AidPlayer, b: AidPlayer): number {
  if (a.value === null || b.value === null) {
    if (a.value !== b.value) return a.value === null ? 1 : -1;
    return (a.draftRank ?? INF) - (b.draftRank ?? INF) || (a.adp ?? INF) - (b.adp ?? INF);
  }
  if (a.value !== b.value) return b.value - a.value;
  if (a.pos === b.pos && a.tierRank !== undefined && b.tierRank !== undefined && a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
  return (a.rank ?? INF) - (b.rank ?? INF) || (a.draftRank ?? INF) - (b.draftRank ?? INF);
}
