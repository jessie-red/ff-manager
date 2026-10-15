import assert from "node:assert/strict";
import { test } from "node:test";
import { lineupOptions, rosterAssignments, sameLineup, validateLineup, type RosterPlayer } from "./management.js";

const players: RosterPlayer[] = [
  { id: 1, name: "Starting RB", eligibleSlots: [2, 23, 20], lineupSlotId: 2 },
  { id: 2, name: "Flex WR", eligibleSlots: [4, 23, 20], lineupSlotId: 23 },
  { id: 3, name: "Bench RB", eligibleSlots: [2, 23, 20], lineupSlotId: 20 },
  { id: 4, name: "IR WR", eligibleSlots: [4, 23, 20, 21], lineupSlotId: 21 },
  { id: -16001, name: "Defense", eligibleSlots: [16, 20], lineupSlotId: 20 },
];
const slots = { 2: 1, 4: 1, 16: 1, 23: 1, 20: 2, 21: 1 };
const current = rosterAssignments(players);
const move = (id: number, to: number) => current.map((p) => p.playerId === id ? { ...p, slotId: to } : p);

test("moves can fill vacant starter slots, including negative defense ids", () => {
  assert.doesNotThrow(() => validateLineup(players, slots, move(-16001, 16)));
  assert.ok(lineupOptions(-16001, players, slots, current).some((o) => o.key === "move:16"));
});

test("bench/start swaps preserve roster capacity and move both players", () => {
  const option = lineupOptions(3, players, slots, current).find((o) => o.key === "swap:1")!;
  assert.ok(option);
  assert.equal(option.assignments.find((p) => p.playerId === 3)?.slotId, 2);
  assert.equal(option.assignments.find((p) => p.playerId === 1)?.slotId, 20);
  assert.doesNotThrow(() => validateLineup(players, slots, option.assignments));
});

test("swaps require eligibility in both directions, including IR", () => {
  assert.equal(lineupOptions(1, players, slots, current).some((o) => o.key === "swap:2"), false);
  assert.equal(lineupOptions(3, players, slots, current).some((o) => o.key === "swap:4"), false);
  assert.ok(lineupOptions(4, players, slots, current).some((o) => o.key === "move:4"));
});

test("rejects full slots, ineligible moves, and slots absent from the league", () => {
  assert.throws(() => validateLineup(players, slots, move(3, 2)), /only 1 spots/);
  assert.throws(() => validateLineup(players, slots, move(1, 4)), /not eligible/);
  assert.throws(() => validateLineup(players, slots, move(1, 0)), /not a roster slot/);
  assert.doesNotThrow(() => validateLineup(players, slots, move(1, 20)));
});

test("rejects incomplete, duplicate, foreign, and malformed assignments", () => {
  assert.throws(() => validateLineup(players, slots, current.slice(1)), /every roster player/);
  assert.throws(() => validateLineup(players, slots, [current[1]!, ...current.slice(1)]), /duplicate/);
  assert.throws(() => validateLineup(players, slots, [{ playerId: 99, slotId: 2 }, ...current.slice(1)]), /unknown/);
  assert.throws(() => validateLineup(players, slots, move(1, 2.5)), /Invalid/);
});

test("stale snapshot comparison is order-independent but detects duplicates and moves", () => {
  assert.equal(sameLineup([...current].reverse(), current), true);
  assert.equal(sameLineup(move(1, 20), current), false);
  assert.equal(sameLineup([current[1]!, ...current.slice(1)], current), false);
  assert.equal(sameLineup(current.slice(1), current), false);
  assert.equal(sameLineup(undefined as never, current), false);
});


test("kicker and defense can both be benched without replacements on a full bench", () => {
  const roster: RosterPlayer[] = [
    { id: 1, name: "Kicker", eligibleSlots: [17, 20], lineupSlotId: 17 },
    { id: -1, name: "Defense", eligibleSlots: [16, 20], lineupSlotId: 16 },
    { id: 2, name: "Bench RB", eligibleSlots: [2, 20], lineupSlotId: 20 },
    { id: 3, name: "IR RB", eligibleSlots: [2, 20, 21], lineupSlotId: 21 },
  ];
  const capacity = { 17: 1, 16: 1, 20: 1, 21: 1 };
  let lineup = rosterAssignments(roster);
  for (const id of [1, -1]) {
    const option = lineupOptions(id, roster, capacity, lineup).find((o) => o.key === "move:20");
    assert.ok(option);
    lineup = option.assignments;
    assert.doesNotThrow(() => validateLineup(roster, capacity, lineup));
  }
  assert.equal(lineup.filter((p) => p.slotId === 20).length, 3);
  assert.equal(lineupOptions(3, roster, capacity, lineup).some((o) => o.key === "move:20"), false);
  assert.throws(() => validateLineup(roster, capacity, lineup.map((p) => ({ ...p, slotId: 20 }))), /active roster/);
});


test("locked players cannot move or be displaced by a swap", () => {
  const locked = players.map((p) => ({ ...p, lineupLocked: p.id === 1 }));
  assert.doesNotThrow(() => validateLineup(locked, slots, current));
  assert.deepEqual(lineupOptions(1, locked, slots, current), []);
  assert.equal(lineupOptions(3, locked, slots, current).some((o) => o.key === "swap:1"), false);
  assert.throws(() => validateLineup(locked, slots, move(1, 20)), /locked/);
  assert.ok(lineupOptions(-16001, locked, slots, current).some((o) => o.key === "move:16"));
});
