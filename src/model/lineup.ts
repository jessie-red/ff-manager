import { SLOT_FILL_ORDER, SLOT_NAMES } from "../espn/constants.js";
import type { Player } from "./player.js";

export interface LineupSlot {
  slotId: number;
  slotName: string;
  player: Player | null;
  /** What the lineup was optimized on: rank value for ESPN lineups, projected points for Sleeper's. */
  value: number;
  /** Projected points for the same player and period. */
  points: number;
  /** Positional rank the value came from, when the lineup is rank-based. */
  rank: number | undefined;
}

export interface Lineup {
  starters: LineupSlot[];
  bench: Player[];
  /** Sum of starters' values. */
  total: number;
  /** Sum of starters' projected points. */
  points: number;
}

/** How to read a player for one lineup: the number to maximize, plus what to show alongside it. */
export interface LineupMetric {
  value: (p: Player) => number;
  points: (p: Player) => number;
  rank?: (p: Player) => number | undefined;
}

/**
 * Fill scoring slots with the highest-valued eligible players.
 * Restrictive slots (QB, RB, WR, ...) are filled before flex-type slots, which
 * is optimal whenever every flex slot's eligibility is a superset of the
 * dedicated slots it overlaps with, i.e. every normal ESPN league.
 */
export function optimalLineup(players: Player[], slots: Map<number, number>, metric: LineupMetric): Lineup {
  const { value, points, rank } = metric;
  const pool = players.filter((p) => !p.onIR).sort((a, b) => value(b) - value(a) || points(b) - points(a));
  const used = new Set<number>();
  const starters: LineupSlot[] = [];

  const order = [...SLOT_FILL_ORDER, ...[...slots.keys()].filter((s) => !SLOT_FILL_ORDER.includes(s))];
  for (const slotId of order) {
    const count = slots.get(slotId) ?? 0;
    for (let i = 0; i < count; i++) {
      const pick = pool.find((p) => !used.has(p.id) && p.eligibleSlots.includes(slotId));
      if (pick) used.add(pick.id);
      starters.push({
        slotId,
        slotName: SLOT_NAMES[slotId] ?? `S${slotId}`,
        player: pick ?? null,
        value: pick ? value(pick) : 0,
        points: pick ? points(pick) : 0,
        rank: pick && rank ? rank(pick) : undefined,
      });
    }
  }

  const bench = pool.filter((p) => !used.has(p.id));
  return {
    starters,
    bench,
    total: starters.reduce((s, x) => s + x.value, 0),
    points: starters.reduce((s, x) => s + x.points, 0),
  };
}
