/**
 * Draft rollouts: what the board is worth to YOU, by simulating the rest of
 * the draft instead of guessing a horizon.
 *
 * VONA (aid.ts) asks "what does waiting cost", measured at a pick two rounds
 * out. Both halves of that are fudges: the horizon is arbitrary (your real
 * next pick is in pickOrder, and at the turn it's one pick away, not a round
 * and a half), and availability is a step function on ADP (a player is
 * certainly there or certainly gone, and a faller whose ADP has passed is
 * treated as gone even while he's sitting on the board). The two errors were
 * cancelling: the horizon was stretched to two rounds precisely because the
 * step function is overconfident.
 *
 * Worse, VONA answers the wrong question at a turn. If you pick back-to-back
 * the cost of passing really is zero -- you get him one pick later -- so every
 * VONA collapses and the board stops discriminating. That is a true statement
 * about a question that has stopped mattering: at the turn you aren't deciding
 * whether to wait, you're deciding on a PAIR.
 *
 * So this scores the decision directly. For each candidate, roll the draft
 * forward many times and average the roster you finish with:
 *
 *     U(i) = E[ value of my starting lineup | I take i now, then draft greedily ]
 *
 * and report `edge` = U(i) - max over the other candidates, so the best pick
 * is the one positive number and everyone else's figure is what choosing him
 * instead would give up. Mid-round this ranks the board the same way VONA
 * does (it is VONA plus a constant); at a turn it keeps discriminating,
 * because the second pick's continuation differs; and it needs no horizon
 * constant at all -- the horizon is your own pick schedule, which the snake
 * order already tells us.
 *
 * The three pieces VONA lacked:
 *   * availability is sampled, not thresholded. Opponents pick from a
 *     Plackett-Luce (softmax-on-ADP) policy, so a player with ADP 40 taken at
 *     pick 46 is an ordinary outcome rather than an impossibility, and a
 *     player still on the board past his ADP is simply still on the board.
 *   * the count constraint holds by construction. Independent per-player
 *     survival probabilities don't add up to the number of picks that actually
 *     happen; a simulated draft makes exactly one selection per pick.
 *   * positional runs are correlated. Opponents won't take a fourth QB, so
 *     supply at a position drains together across sims -- the thing the
 *     by-position VONA toggle was hand-approximating.
 *
 * And because the rollout carries YOUR roster, the continuation term is
 * marginal lineup value, not raw board value: at a turn, RB-then-WR versus
 * WR-then-RB is decided by which position's cliff arrives before your third
 * pick, which is exactly what a max-over-the-board baseline cannot see.
 *
 * Browser-safe and pure: the aid runs it client-side on every pick.
 */
import { SLOT_FILL_ORDER, SLOT_POSITIONS } from "../espn/constants.js";
import type { AidPlayer } from "./aid.js";

/** Simulations per call. 400 puts the standard error of a candidate's utility well under a point. */
export const SIMS = 400;
/** How many of my future picks to roll forward. Beyond this the continuation is flat and the cost isn't worth it. */
export const MAX_LOOKAHEAD = 8;
/** How many players deep the opponents' policy looks (by ADP). Nobody reaches past this. */
const POLICY_DEPTH = 40;
/** Plackett-Luce temperature, in picks: the ADP gap at which a player is e times less likely to go next. */
const TEMPERATURE = 5;
/** How many players per position each snapshot keeps for my own greedy. */
const NEED_DEPTH = 4;
/** How many available players get a full rollout; the rest take their position's continuation. */
const CANDIDATES = 60;
/** How many top players per position are force-added to the candidate set, so a position's best is always scored. */
const CANDIDATES_PER_POS = 3;
/** What a bench body is worth against a starter. Value is already over the waiver wire, so depth is real but small. */
const BENCH_WEIGHT = 0.2;
/** Weight multiplier for a position a team has already filled to the brim: they'll take one anyway, but rarely. */
const SATED = 0.05;
/** Effective ADP for a player with neither an ADP nor a draft rank: past anywhere the policy looks. */
const NO_ADP = 9999;

export interface RolloutContext {
  /** Team ids in round-1 order; empty falls back to a linear draft of `teamCount` teams. */
  pickOrder: number[];
  teamCount: number;
  /** My fantasy team id; undefined outside a real league draft, when the pick on the clock is taken to be mine. */
  myTeamId: number | undefined;
  /** The overall pick on the clock (1-based). */
  currentPick: number;
  /** Players already on my roster, so the continuation knows what I still need. */
  myRoster: AidPlayer[];
  /** Starting lineup slot counts, ESPN slot id -> count (player.ts startingSlots). */
  slots: Record<number, number>;
  /** Bench spots per team, which is what caps how many picks there are to roll forward. */
  benchSize: number;
}

export interface RolloutOptions {
  sims?: number;
  seed?: number;
  maxLookahead?: number;
}

export interface Rollout {
  /** id -> expected final lineup value if he goes here; only the scored candidates. */
  utility: Map<number, number>;
  /**
   * id -> utility minus the best OTHER candidate's utility. Exactly one player
   * is positive (the pick, and the figure is its edge); everyone else's is what
   * taking them instead would cost. Null for players with no value at all.
   */
  edge: Map<number, number | null>;
  /** My remaining picks that were rolled forward, as overall pick numbers. */
  myPicks: number[];
  /**
   * Whether those picks came from ESPN's draft order and my team id, or were
   * assumed by taking the pick on the clock to be mine. The two schedules look
   * alike in the output and are very different if the guess is wrong, so the
   * aid says which it used.
   */
  slotKnown: boolean;
  sims: number;
  /** How many candidates got a full rollout; the rest were scored by their position's continuation. */
  scored: number;
}

/** Deterministic PRNG, so the board doesn't reshuffle under the cursor between renders. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Who owns overall pick `n` in a snake with this round-1 order; the order's index when there is no order. */
function picker(order: number[], teamCount: number, n: number): number {
  const t = order.length || Math.max(1, teamCount);
  const round = Math.floor((n - 1) / t);
  const i = (n - 1) % t;
  const slot = round % 2 === 0 ? i : t - 1 - i;
  return order.length ? (order[slot] ?? slot) : slot;
}

/** Lineup slots in fill order (restrictive first, flex last), each as the positions that can fill it. */
function slotRequirements(slots: Record<number, number>): { positions: string[]; count: number }[] {
  const ids = Object.keys(slots)
    .map(Number)
    .filter((id) => (slots[id] ?? 0) > 0);
  ids.sort((a, b) => {
    const ia = SLOT_FILL_ORDER.indexOf(a);
    const ib = SLOT_FILL_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const out: { positions: string[]; count: number }[] = [];
  for (const id of ids) {
    const positions = SLOT_POSITIONS[id];
    const count = slots[id];
    if (positions && count) out.push({ positions, count });
  }
  return out;
}

/** The most of a position a team will take: its dedicated starters, every flex it can fill, and one bench body. */
function positionCaps(slots: Record<number, number>): Map<string, number> {
  const caps = new Map<string, number>();
  for (const [id, count] of Object.entries(slots)) {
    const positions = SLOT_POSITIONS[Number(id)];
    if (!positions || count <= 0) continue;
    for (const pos of positions) caps.set(pos, (caps.get(pos) ?? 0) + count);
  }
  // K and D/ST are streamed, never stashed; everyone else gets one spare.
  for (const [pos, n] of caps) caps.set(pos, pos === "K" || pos === "D/ST" ? n : n + 1);
  return caps;
}

/** Most players a roster will hold at one position; the flat roster arrays are strided by this. */
const STRIDE = 12;

/** A lineup slot group with its positions resolved to indices into the position table. */
interface Req {
  positions: number[];
  count: number;
}

/**
 * A roster's optimal starting lineup value plus its bench at BENCH_WEIGHT.
 *
 * `vals` holds each position's values sorted descending in its own stride,
 * `counts` how many; `cursor` is scratch. Dedicated slots fill before flex
 * slots, which is optimal whenever every flex's eligibility is a superset of
 * the dedicated slots it overlaps (lineup.ts makes the same argument).
 * `extraPos` >= 0 adds one hypothetical player without touching the roster,
 * which is the greedy's whole inner loop -- hence the flat arrays and the
 * absence of any allocation in here.
 */
function lineupValue(vals: Float64Array, counts: Int32Array, req: Req[], cursor: Int32Array, extraPos: number, extraValue: number): number {
  cursor.fill(0);
  let pending = extraPos >= 0;
  let total = 0;
  for (const r of req) {
    for (let i = 0; i < r.count; i++) {
      let bestPos = -1;
      let best = -Infinity;
      let bestExtra = false;
      for (const pi of r.positions) {
        const k = cursor[pi] as number;
        const mine = k < (counts[pi] as number) ? (vals[pi * STRIDE + k] as number) : -Infinity;
        const isExtra = pending && pi === extraPos && extraValue >= mine;
        const v = isExtra ? extraValue : mine;
        if (v > best) {
          best = v;
          bestPos = pi;
          bestExtra = isExtra;
        }
      }
      if (bestPos < 0 || best === -Infinity) continue;
      if (bestExtra) pending = false;
      else cursor[bestPos] = (cursor[bestPos] as number) + 1;
      total += best;
    }
  }
  for (let pi = 0; pi < counts.length; pi++) {
    for (let k = cursor[pi] as number; k < (counts[pi] as number); k++) total += BENCH_WEIGHT * Math.max(0, vals[pi * STRIDE + k] as number);
  }
  if (pending) total += BENCH_WEIGHT * Math.max(0, extraValue);
  return total;
}

/** One available player as the simulation sees him. */
interface Row {
  id: number;
  pos: string;
  /** Index into the position table, so the hot loops never touch a string. */
  pi: number;
  value: number;
  /** ADP, or the draft rank standing in for one, or NO_ADP. */
  adp: number;
}

/** The board at one of my future picks: the best NEED_DEPTH per position, in value order. */
type Snapshot = Row[];

/**
 * Roll the rest of the draft forward `sims` times and score the board by the
 * roster each choice leads to. See the file header for the why.
 */
export function rollout(players: AidPlayer[], drafted: Set<number>, ctx: RolloutContext, opts: RolloutOptions = {}): Rollout {
  const sims = opts.sims ?? SIMS;
  const caps = positionCaps(ctx.slots);
  const slotReq = slotRequirements(ctx.slots);
  const teamCount = ctx.pickOrder.length || Math.max(1, ctx.teamCount);

  // The position table: every position the lineup or the pool knows about, as an index.
  const posList: string[] = [];
  const posIndex = new Map<string, number>();
  const indexOf = (pos: string): number => {
    let i = posIndex.get(pos);
    if (i === undefined) {
      i = posList.length;
      posList.push(pos);
      posIndex.set(pos, i);
    }
    return i;
  };
  for (const r of slotReq) for (const pos of r.positions) indexOf(pos);
  for (const p of players) indexOf(p.pos);
  const req: Req[] = slotReq.map((r) => ({ positions: r.positions.map(indexOf), count: r.count }));
  const P = posList.length;
  const rosterSize = slotReq.reduce((s, r) => s + r.count, 0) + ctx.benchSize;

  /**
   * Which picks are mine. With ESPN's draft order it's my team's slot in the
   * snake. Without one -- a league that hasn't set an order yet, or a SWID
   * that matches no owner -- the pick on the clock is taken to be mine, which
   * is enough to place me: the slot that lands on `currentPick` mirrors round
   * by round like anyone else's, so a synthetic order gives me the same
   * schedule ESPN's would. Spacing my picks evenly instead would quietly lose
   * the turn, the one case this file exists for.
   */
  const known = ctx.pickOrder.length > 0 && ctx.myTeamId !== undefined;
  const order = known ? ctx.pickOrder : Array.from({ length: teamCount }, (_, i) => i);
  const round0 = Math.floor((ctx.currentPick - 1) / teamCount);
  const slot0 = (ctx.currentPick - 1) % teamCount;
  const myTeam = known ? (ctx.myTeamId as number) : round0 % 2 === 0 ? slot0 : teamCount - 1 - slot0;
  const meAt = (n: number): boolean => picker(order, teamCount, n) === myTeam;
  const wanted = Math.min(opts.maxLookahead ?? MAX_LOOKAHEAD, Math.max(1, rosterSize - ctx.myRoster.length));
  const myPicks: number[] = [];
  for (let n = ctx.currentPick; myPicks.length < wanted && n < ctx.currentPick + teamCount * (wanted * 2 + 2); n++) {
    if (meAt(n)) myPicks.push(n);
  }
  const horizon = myPicks[myPicks.length - 1] ?? ctx.currentPick;
  const mineAt = new Set(myPicks);

  // The pool, in value order (the server already sorts it that way) and in ADP order for the opponents' policy.
  const rows: Row[] = [];
  for (const p of players) {
    if (drafted.has(p.id)) continue;
    rows.push({ id: p.id, pos: p.pos, pi: indexOf(p.pos), value: p.value ?? 0, adp: p.adp ?? p.draftRank ?? NO_ADP });
  }
  const byAdp = [...rows.keys()].sort((a, b) => (rows[a]?.adp ?? 0) - (rows[b]?.adp ?? 0));
  const capAt = new Int32Array(P);
  for (let i = 0; i < P; i++) capAt[i] = caps.get(posList[i] as string) ?? 1;

  // My roster so far, as the flat arrays lineupValue reads.
  const baseVals = new Float64Array(P * STRIDE);
  const baseCounts = new Int32Array(P);
  for (const p of ctx.myRoster) {
    const pi = indexOf(p.pos);
    const n = baseCounts[pi] as number;
    if (n >= STRIDE) continue;
    baseVals[pi * STRIDE + n] = p.value ?? 0;
    baseCounts[pi] = n + 1;
  }
  for (let pi = 0; pi < P; pi++) {
    const n = baseCounts[pi] as number;
    const slice = Array.from(baseVals.subarray(pi * STRIDE, pi * STRIDE + n)).sort((a, b) => b - a);
    baseVals.set(slice, pi * STRIDE);
  }

  /**
   * Candidates, deduplicated by (position, value). The rollout reads nothing
   * else off a candidate, and tier values are heavily quantised -- five backs
   * in one tier share a value -- so scoring the distinct pairs is exact and
   * cuts the work several-fold. Ties then break on the board's own order
   * (Boris's) instead of on simulation noise.
   */
  const candidates: Row[] = [];
  const byKey = new Map<string, number>();
  const perPos = new Map<number, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Row;
    const near = i < CANDIDATES;
    const n = perPos.get(row.pi) ?? 0;
    if (!near && n >= CANDIDATES_PER_POS) continue;
    perPos.set(row.pi, n + 1);
    const key = `${row.pi}|${row.value}`;
    if (byKey.has(key)) continue;
    byKey.set(key, candidates.length);
    candidates.push(row);
  }
  const totals = new Float64Array(candidates.length);

  const rand = mulberry32(opts.seed ?? 0x5eed);
  const taken = new Uint8Array(rows.length);
  const snapshots: Snapshot[] = [];
  const counts: Map<number, Int32Array> = new Map();
  const weights = new Float64Array(POLICY_DEPTH);
  const pickIdx = new Int32Array(POLICY_DEPTH);
  // Scratch reused by every lineupValue call, so the hot loop allocates nothing.
  const cursor = new Int32Array(P);
  const vals = new Float64Array(P * STRIDE);
  const cnt = new Int32Array(P);

  for (let s = 0; s < sims; s++) {
    taken.fill(0);
    counts.clear();
    snapshots.length = 0;
    let adpCursor = 0;

    for (let n = ctx.currentPick; n <= horizon; n++) {
      // My picks are recorded, not decided: the candidates are scored against this same board afterwards.
      if (mineAt.has(n) && n > ctx.currentPick) snapshots.push(snapshot(rows, taken));

      // Softmax over the shallowest POLICY_DEPTH available players by ADP, damped at positions the team has filled.
      while (adpCursor < byAdp.length && taken[byAdp[adpCursor] ?? 0]) adpCursor++;
      const team = picker(order, teamCount, n);
      let roster = counts.get(team);
      if (!roster) counts.set(team, (roster = new Int32Array(P)));
      let k = 0;
      let sum = 0;
      const first = rows[byAdp[adpCursor] ?? -1]?.adp ?? 0;
      for (let j = adpCursor; j < byAdp.length && k < POLICY_DEPTH; j++) {
        const idx = byAdp[j] ?? 0;
        if (taken[idx]) continue;
        const row = rows[idx];
        if (!row) continue;
        const sated = (roster[row.pi] as number) >= (capAt[row.pi] as number);
        sum += Math.exp(-(row.adp - first) / TEMPERATURE) * (sated ? SATED : 1);
        weights[k] = sum;
        pickIdx[k] = idx;
        k++;
      }
      if (k === 0) break;
      const target = rand() * sum;
      let lo = 0;
      while (lo < k - 1 && (weights[lo] as number) < target) lo++;
      const chosen = pickIdx[lo] ?? 0;
      const row = rows[chosen];
      if (!row) break;
      taken[chosen] = 1;
      roster[row.pi] = (roster[row.pi] as number) + 1;
    }

    // Score every candidate against this one simulated draft (common random numbers: the same
    // board for all of them, so the differences are the choice and not the sampling).
    for (let c = 0; c < candidates.length; c++) {
      const cand = candidates[c] as Row;
      totals[c] = (totals[c] as number) + finish(baseVals, baseCounts, vals, cnt, cursor, req, cand, snapshots);
    }
  }

  const utility = new Map<number, number>();
  for (let c = 0; c < candidates.length; c++) utility.set((candidates[c] as Row).id, (totals[c] as number) / sims);

  // Everyone else takes his (position, value) twin's figure when he has one, and otherwise his
  // position's mean continuation (utility minus own value) -- below the candidate set the order
  // is value order anyway, so all a tail player needs is the right offset.
  const contTotal = new Map<number, { sum: number; n: number }>();
  let allSum = 0;
  for (const c of candidates) {
    const u = utility.get(c.id) ?? 0;
    const acc = contTotal.get(c.pi) ?? { sum: 0, n: 0 };
    acc.sum += u - c.value;
    acc.n++;
    contTotal.set(c.pi, acc);
    allSum += u - c.value;
  }
  const allMean = candidates.length ? allSum / candidates.length : 0;
  const continuation = (pi: number): number => {
    const acc = contTotal.get(pi);
    return acc && acc.n ? acc.sum / acc.n : allMean;
  };

  const full = new Map<number, number>();
  for (const row of rows) {
    const twin = byKey.get(`${row.pi}|${row.value}`);
    const u = twin === undefined ? undefined : (totals[twin] as number) / sims;
    full.set(row.id, u ?? row.value + continuation(row.pi));
  }

  // edge = utility over the best OTHER candidate, so the pick is the one positive figure.
  let best = -Infinity;
  let second = -Infinity;
  for (const row of rows) {
    const u = full.get(row.id) ?? -Infinity;
    if (u > best) {
      second = best;
      best = u;
    } else if (u > second) second = u;
  }
  const edge = new Map<number, number | null>();
  for (const p of players) {
    const u = full.get(p.id);
    edge.set(p.id, u === undefined ? null : u - (u >= best ? second : best));
  }

  return { utility: full, edge, myPicks, slotKnown: known, sims, scored: candidates.length };
}

/**
 * The best NEED_DEPTH available players per position, in the pool's value
 * order. One per position would do -- marginal lineup value is monotone in a
 * player's value, so the best at a position is always the highest-valued one
 * there -- but the greedy needs spares for the players it has already taken.
 */
function snapshot(rows: Row[], taken: Uint8Array): Snapshot {
  const out: Snapshot = [];
  const seen = new Map<number, number>();
  for (let i = 0; i < rows.length; i++) {
    if (taken[i]) continue;
    const row = rows[i];
    if (!row) continue;
    const n = seen.get(row.pi) ?? 0;
    if (n >= NEED_DEPTH) continue;
    seen.set(row.pi, n + 1);
    out.push(row);
  }
  return out;
}

/**
 * Take `first` now, then fill the rest of the schedule greedily by marginal
 * lineup value, and return what the roster is worth. Greedy rather than
 * optimal on purpose: it's what a drafter does with the board in front of
 * them, and the alternative is a search over every future board.
 */
function finish(
  baseVals: Float64Array,
  baseCounts: Int32Array,
  vals: Float64Array,
  counts: Int32Array,
  cursor: Int32Array,
  req: Req[],
  first: Row,
  snapshots: Snapshot[],
): number {
  vals.set(baseVals);
  counts.set(baseCounts);
  const add = (pi: number, value: number): void => {
    let n = counts[pi] as number;
    if (n >= STRIDE) return;
    let i = n;
    while (i > 0 && (vals[pi * STRIDE + i - 1] as number) < value) {
      vals[pi * STRIDE + i] = vals[pi * STRIDE + i - 1] as number;
      i--;
    }
    vals[pi * STRIDE + i] = value;
    counts[pi] = ++n;
  };
  add(first.pi, first.value);

  // `first` was deduplicated by (position, value), so drop one twin rather than one id.
  let dropTwin = true;
  const gone = new Set<number>();
  for (const snap of snapshots) {
    let bestPi = -1;
    let bestValue = 0;
    let bestId = -1;
    let bestGain = -Infinity;
    let twinId = -1;
    const have = lineupValue(vals, counts, req, cursor, -1, 0);
    for (const row of snap) {
      if (gone.has(row.id)) continue;
      if (dropTwin && twinId < 0 && row.pi === first.pi && row.value === first.value) {
        twinId = row.id;
        continue;
      }
      const gain = lineupValue(vals, counts, req, cursor, row.pi, row.value) - have;
      if (gain > bestGain) {
        bestGain = gain;
        bestPi = row.pi;
        bestValue = row.value;
        bestId = row.id;
      }
    }
    if (twinId >= 0) {
      gone.add(twinId);
      dropTwin = false;
    }
    if (bestPi < 0) continue;
    gone.add(bestId);
    add(bestPi, bestValue);
  }
  return lineupValue(vals, counts, req, cursor, -1, 0);
}
