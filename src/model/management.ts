import { BENCH_SLOT, IR_SLOT, SLOT_NAMES } from "../espn/constants.js";
import type { Player } from "./player.js";

export interface LineupAssignment {
  playerId: number;
  slotId: number;
}

export type RosterPlayer = Pick<Player, "id" | "name" | "eligibleSlots" | "lineupSlotId" | "lineupLocked">;

export const slotLabel = (id: number) => id === BENCH_SLOT ? "Bench" : SLOT_NAMES[id] ?? `Slot ${id}`;
export const isStarter = (slot: number) => slot !== BENCH_SLOT && slot !== IR_SLOT;
export const rosterAssignments = (players: RosterPlayer[]): LineupAssignment[] =>
  players.map((p) => ({ playerId: p.id, slotId: p.lineupSlotId }));

/** Full-roster assignments make missing/duplicate players and stale edits explicit. */
export function validateLineup(players: RosterPlayer[], slots: Record<number, number>, target: LineupAssignment[]): void {
  if (!Array.isArray(target) || target.length !== players.length) throw new Error("The lineup must include every roster player exactly once.");
  const roster = new Map(players.map((p) => [p.id, p]));
  const seen = new Set<number>();
  const counts = new Map<number, number>();
  for (const assignment of target) {
    if (!assignment || !Number.isInteger(assignment.playerId) || !Number.isInteger(assignment.slotId)) {
      throw new Error("Invalid lineup assignment.");
    }
    const { playerId, slotId } = assignment;
    const player = roster.get(playerId);
    if (!player || seen.has(playerId)) throw new Error("The lineup contains an unknown or duplicate player.");
    seen.add(playerId);
    if (player.lineupLocked && slotId !== player.lineupSlotId) throw new Error(`${player.name} is locked and cannot be moved.`);
    if (!((slots[slotId] ?? 0) > 0)) throw new Error(`${slotLabel(slotId)} is not a roster slot in this league.`);
    // An unchanged IR occupant may no longer be eligible; ESPN decides whether
    // that blocks a transaction. Don't silently move them out of IR.
    if (slotId !== player.lineupSlotId && slotId !== BENCH_SLOT && !player.eligibleSlots.includes(slotId)) {
      throw new Error(`${player.name} is not eligible for ${slotLabel(slotId)}.`);
    }
    counts.set(slotId, (counts.get(slotId) ?? 0) + 1);
  }
  for (const [slot, count] of counts) {
    if (slot !== BENCH_SLOT && count > slots[slot]!) throw new Error(`${slotLabel(slot)} has ${count} players but only ${slots[slot]} spots.`);
  }
  // Benching a starter leaves an active roster vacancy; bench size is not
  // an independent cap. IR players still need room in the active roster.
  const activeCapacity = Object.entries(slots).reduce((sum, [slot, count]) =>
    Number(slot) === IR_SLOT ? sum : sum + count, 0);
  const activeCount = target.filter((p) => p.slotId !== IR_SLOT).length;
  if (activeCount > activeCapacity) throw new Error(`The active roster has ${activeCount} players but only ${activeCapacity} spots.`);
}

export function sameLineup(a: LineupAssignment[], b: LineupAssignment[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const slots = new Map(b.map((p) => [p.playerId, p.slotId]));
  const seen = new Set<number>();
  return a.every((p) => {
    if (!p || seen.has(p.playerId) || !slots.has(p.playerId) || slots.get(p.playerId) !== p.slotId) return false;
    seen.add(p.playerId);
    return true;
  });
}

export interface LineupOption {
  key: string;
  label: string;
  assignments: LineupAssignment[];
}

/** Offer explicit swaps (including the displaced player) and moves to vacant slots. */
export function lineupOptions(playerId: number, players: RosterPlayer[], slots: Record<number, number>, current: LineupAssignment[]): LineupOption[] {
  const from = current.find((p) => p.playerId === playerId)?.slotId;
  if (from === undefined) return [];
  const options: LineupOption[] = [];
  const add = (key: string, label: string, to: number, swapId?: number) => {
    const assignments = current.map((p) => ({
      ...p,
      slotId: p.playerId === playerId ? to : p.playerId === swapId ? from : p.slotId,
    }));
    try {
      validateLineup(players, slots, assignments);
      options.push({ key, label, assignments });
    } catch { /* Ineligible or over capacity: not an available move. */ }
  };
  for (const [slot, count] of Object.entries(slots)) {
    const to = Number(slot);
    if (to !== from && (to === BENCH_SLOT || current.filter((p) => p.slotId === to).length < count)) {
      add(`move:${to}`, `Move to ${slotLabel(to)}`, to);
    }
  }
  for (const other of current) {
    if (other.slotId === from) continue;
    const name = players.find((p) => p.id === other.playerId)?.name;
    add(`swap:${other.playerId}`, `Swap with ${name} (${slotLabel(other.slotId)})`, other.slotId, other.playerId);
  }
  return options;
}
