/**
 * Trade finder: every package of up to `maxSide` players from one team for a
 * package from another, scored for both sides by the projected points per
 * game of their optimal lineup after the swap. The bench is worth nothing, so
 * a trade only registers when it changes who starts. Plain data + pure
 * functions; the web client runs this on the rosters it already has.
 */
import { SLOT_FILL_ORDER } from "../espn/constants.js";
import type { Player } from "./player.js";
import { playerValue, type Valuation } from "./value.js";

/** Kickers and defenses are streamed, not traded, and would flood the list with 0.3-point swaps. */
const UNTRADEABLE = new Set(["K", "D/ST"]);

export interface TradeTeam {
  teamId: number;
  /** Every rostered player (IR included; they're skipped as trade pieces and never start). */
  players: Player[];
}

export interface Trade {
  partnerId: number;
  /** Players leaving the focal team. */
  give: Player[];
  /** Players arriving from the partner. */
  get: Player[];
  /** Focal team's optimal-lineup ppg change; at least `minGain` in findTrades' output. */
  myGain: number;
  /** Partner's optimal-lineup ppg change; at least `minTheirGain`, so negative when that floor is. */
  theirGain: number;
  myAfter: number;
  theirAfter: number;
  /** Value (see tradeValue) the focal team takes in minus what it sends out; the partner's net is the negation. 0 when no `value` option was given. */
  netValue: number;
}

export interface TradeOptions {
  /** Most players either side sends (1 or 2 is sane; 3 is 20x slower). Default 2. */
  maxSide?: number;
  /** Points per game a player is worth as a starter. Default: `seasonPpg`-style ESPN/Sleeper blend. */
  ppg?: (p: Player) => number;
  /** Smallest lineup gain the focal team must see for the trade to count. Default 0.05. */
  minGain?: number;
  /**
   * Smallest lineup gain the partner must see. Defaults to `minGain`. Negative
   * lets through trades that cost the partner a little, which is the shape of
   * every offer you actually have to talk someone into.
   */
  minTheirGain?: number;
  /** What a player is worth as an asset (tradeValue), summed per side into Trade.netValue. */
  value?: (p: Player) => number;
}

/**
 * What a player is worth as a trade asset: the same rest-of-season value over
 * replacement the ratings score teams on (`Player.ros.vorp` from model/ros.ts,
 * floored at zero, exactly as rateLeague floors a starter's). A below-replacement
 * body is worth nothing in a trade rather than something negative -- nobody pays
 * you to take him, you just drop him -- which is why the floor is here and not
 * only in the ratings.
 *
 * `hasRos` false means the ratings themselves fell back to the preseason tier
 * table (no per-week projections from either source), so trades fall back with
 * them and stay on the same currency as the grades beside them.
 */
export function tradeValue(valuation: Valuation, hasRos: boolean): (p: Player) => number {
  return hasRos ? (p: Player) => Math.max(0, p.ros?.vorp ?? 0) : (p: Player) => playerValue(valuation, p);
}

/** ESPN's rest-of-season ppg averaged with Sleeper's when the player matched, else whichever exists. */
export function tradePpg(p: Player): number {
  const espn = p.rosPpg;
  const sleeper = p.sleeper?.rosPpg;
  if (sleeper === undefined || sleeper === null) return espn;
  if (!espn) return sleeper;
  return (espn + sleeper) / 2;
}

interface Scored {
  p: Player;
  ppg: number;
}

/** Scoring slots expanded to one entry per starter, most restrictive first (see lineup.ts). */
export function slotOrder(slots: Map<number, number>): number[] {
  const ids = [...SLOT_FILL_ORDER, ...[...slots.keys()].filter((s) => !SLOT_FILL_ORDER.includes(s))];
  return ids.flatMap((id) => Array<number>(slots.get(id) ?? 0).fill(id));
}

/** Points per game of the greedy optimal lineup; `order` from slotOrder(). Same fill as optimalLineup, minus the bookkeeping. */
function fillPoints(roster: Scored[], order: number[]): number {
  const sorted = roster.slice().sort((a, b) => b.ppg - a.ppg);
  const used = new Uint8Array(sorted.length);
  let total = 0;
  for (const slot of order) {
    for (let i = 0; i < sorted.length; i++) {
      if (used[i]) continue;
      const s = sorted[i]!;
      if (s.p.eligibleSlots.includes(slot)) {
        used[i] = 1;
        total += s.ppg;
        break;
      }
    }
  }
  return total;
}

/** Optimal-lineup points per game for a roster, the number every trade is judged on. */
export function lineupPpg(players: Player[], slots: Map<number, number>, ppg: (p: Player) => number = tradePpg): number {
  return fillPoints(
    players.filter((p) => !p.onIR).map((p) => ({ p, ppg: ppg(p) })),
    slotOrder(slots),
  );
}

/** Every non-empty subset of `xs` with at most `k` members, as index arrays. */
function packages(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, cur: number[]) => {
    if (cur.length) out.push(cur.slice());
    if (cur.length === k) return;
    for (let i = start; i < n; i++) {
      cur.push(i);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return out;
}

class Side {
  readonly active: Scored[];
  readonly pieces: Scored[];
  readonly before: number;
  /** Lineup ppg after adding a package (by index into a Set of piece ids), the upper bound on any trade bringing it in. */
  private readonly addCache = new Map<string, number>();

  constructor(
    team: TradeTeam,
    private readonly order: number[],
    ppg: (p: Player) => number,
  ) {
    this.active = team.players.filter((p) => !p.onIR).map((p) => ({ p, ppg: ppg(p) }));
    this.pieces = this.active.filter((s) => !UNTRADEABLE.has(s.p.pos) && s.ppg > 0);
    this.before = fillPoints(this.active, order);
  }

  /** Lineup ppg with `out` removed and `incoming` added. */
  after(out: Scored[], incoming: Scored[]): number {
    const outIds = new Set(out.map((s) => s.p.id));
    return fillPoints(this.active.filter((s) => !outIds.has(s.p.id)).concat(incoming), this.order);
  }

  /** Lineup ppg if `incoming` arrived for free: no trade giving anything up can beat it. */
  addOnly(incoming: Scored[]): number {
    const key = incoming.map((s) => s.p.id).join(",");
    let v = this.addCache.get(key);
    if (v === undefined) {
      v = fillPoints(this.active.concat(incoming), this.order);
      this.addCache.set(key, v);
    }
    return v;
  }
}

const EPS = 1e-6;

/**
 * Trades between `me` and each of `others` that raise the focal team's optimal
 * lineup ppg and move the partner's by at least `minTheirGain` (which may be
 * negative), best for `me` first. Packages are 1..maxSide players a side.
 * A trade with a throw-in, one a smaller sub-trade already matches for both
 * sides, is dropped so the list isn't a 2-for-2 restatement of every 1-for-1.
 */
export function findTrades(me: TradeTeam, others: TradeTeam[], slots: Map<number, number>, opts: TradeOptions = {}): Trade[] {
  const maxSide = opts.maxSide ?? 2;
  const ppg = opts.ppg ?? tradePpg;
  const minGain = opts.minGain ?? 0.05;
  const minTheirGain = opts.minTheirGain ?? minGain;
  const value = opts.value ?? (() => 0);
  const sum = (ps: Scored[]) => ps.reduce((a, s) => a + value(s.p), 0);
  const order = slotOrder(slots);
  const mine = new Side(me, order, ppg);
  const out: Trade[] = [];

  for (const other of others) {
    if (other.teamId === me.teamId) continue;
    const theirs = new Side(other, order, ppg);
    const myPackages = packages(mine.pieces.length, maxSide).map((ix) => ix.map((i) => mine.pieces[i]!));
    const theirPackages = packages(theirs.pieces.length, maxSide).map((ix) => ix.map((i) => theirs.pieces[i]!));

    // Evaluate one swap for both sides; memoized so the throw-in check below is cheap.
    const cache = new Map<string, { my: number; their: number }>();
    const evaluate = (give: Scored[], get: Scored[]) => {
      const key = give.map((s) => s.p.id).join(",") + "|" + get.map((s) => s.p.id).join(",");
      let v = cache.get(key);
      if (!v) {
        v = { my: mine.after(give, get) - mine.before, their: theirs.after(get, give) - theirs.before };
        cache.set(key, v);
      }
      return v;
    };

    // Drop one player from either side: if some smaller trade is at least as good for both, this one is padding.
    const dominated = (give: Scored[], get: Scored[], my: number, their: number): boolean => {
      const subs: [Scored[], Scored[]][] = [];
      if (give.length > 1) for (let i = 0; i < give.length; i++) subs.push([give.filter((_, j) => j !== i), get]);
      if (get.length > 1) for (let i = 0; i < get.length; i++) subs.push([give, get.filter((_, j) => j !== i)]);
      return subs.some(([g, r]) => {
        const v = evaluate(g, r);
        return v.my >= my - EPS && v.their >= their - EPS;
      });
    };

    const candidates: { give: Scored[]; get: Scored[]; my: number; their: number }[] = [];
    for (const get of theirPackages) {
      if (mine.addOnly(get) - mine.before < minGain) continue;
      for (const give of myPackages) {
        // Free-add upper bound; a no-op prune once the partner's floor is negative, since a gift never loses them points.
        if (theirs.addOnly(give) - theirs.before < minTheirGain) continue;
        const v = evaluate(give, get);
        if (v.my < minGain || v.their < minTheirGain) continue;
        candidates.push({ give, get, my: v.my, their: v.their });
      }
    }
    for (const c of candidates) {
      if (dominated(c.give, c.get, c.my, c.their)) continue;
      out.push({
        partnerId: other.teamId,
        give: c.give.map((s) => s.p),
        get: c.get.map((s) => s.p),
        myGain: c.my,
        theirGain: c.their,
        myAfter: mine.before + c.my,
        theirAfter: theirs.before + c.their,
        netValue: sum(c.get) - sum(c.give),
      });
    }
  }

  return out.sort((a, b) => b.myGain - a.myGain || b.theirGain - a.theirGain);
}
