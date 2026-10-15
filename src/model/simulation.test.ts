import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadUncertainty } from '../uncertainty/load.js';
import { simulateSeason, type SeasonSimulationInput } from './simulation.js';
import { simulationFixture } from '../simulation/fixture.js';
import { prepareSimulationLineups } from './simulation-lineups.js';
import type { Player } from './player.js';

const model = await loadUncertainty();
function deterministicModel() {
  const copy = structuredClone(model);
  for (const format of Object.values(copy.formats)) {
    for (const p of Object.values(format.persistent)) p.multiplier.samples = [1];
    for (const p of Object.values(format.weekly)) for (const b of [p.pooled, ...p.bins]) b.multiplier.samples = [1];
  }
  return copy;
}
function tiny(): SeasonSimulationInput {
  return { format: 'ppr', teams: [0, 1].map(id => ({ id, wins: 2, losses: 1, ties: 1, pointsFor: 100 })),
    players: [0, 1].map(id => ({ id, position: 'QB', projections: { 5: 10 + id, 6: 10 + id, 7: 10 + id, 8: 10 + id } })),
    regularSeason: [{ home: 0, away: 1, weeks: [5, 6] }], playoffs: { teams: 2, rounds: [[7, 8]] },
    scenarios: [{ name: 'base', lineups: Object.fromEntries([0, 1].map(id => [id, Object.fromEntries([5, 6, 7, 8].map(w => [w, [id]]))])) }] };
}

test('known winners, multiweek games, current records and histogram conservation', () => {
  const r = simulateSeason(deterministicModel(), tiny(), { simulations: 100 });
  const [a, b] = r.scenarios[0]!.teams;
  assert.equal(a!.wins.mean, 2); assert.equal(a!.losses.mean, 2); assert.equal(a!.ties.mean, 1);
  assert.equal(b!.wins.mean, 3); assert.equal(b!.championshipOdds.mean, 1);
  assert.deepEqual(a!.records, { '2-2-1': 1 });
  assert.ok(a!.championshipOdds.interval95[1] > 0);
});

test('ties are half wins for seeding; playoff score ties go to higher seed', () => {
  const input = tiny();
  input.players[1]!.projections = { ...input.players[0]!.projections };
  input.teams[1]!.pointsFor = 101;
  const r = simulateSeason(deterministicModel(), input, { simulations: 100 });
  assert.equal(r.scenarios[0]!.teams[0]!.ties.mean, 2);
  assert.equal(r.scenarios[0]!.teams[1]!.championshipOdds.mean, 1);
});

test('paired identical/reordered scenarios have exactly zero noise; adding an unused player does not shift draws', () => {
  const input = tiny();
  const a = simulateSeason(model, input, { simulations: 2000 });
  input.players.reverse(); input.teams.reverse();
  input.players.push({ id: 999, position: 'WR', projections: { 5: 15, 6: 15, 7: 15, 8: 15 } });
  input.scenarios.push({ ...structuredClone(input.scenarios[0]!), name: 'same' });
  const b = simulateSeason(model, input, { simulations: 2000 });
  assert.deepEqual(a.scenarios[0], b.scenarios[0]);
  for (const t of b.comparisons[0]!.teams) for (const e of [t.wins, t.playoffOdds, t.championshipOdds]) {
    assert.equal(e.mean, 0); assert.equal(e.standardError, 0); assert.deepEqual(e.interval95, [0, 0]);
  }
});

test('symmetric 12-team league is fair, records conserve games, six teams qualify and one wins', () => {
  const input = simulationFixture();
  const r = simulateSeason(model, input, { simulations: 20_000 });
  const teams = r.scenarios[0]!.teams;
  assert.ok(Math.abs(teams.reduce((s, t) => s + t.championshipOdds.mean, 0) - 1) < 1e-12);
  assert.ok(Math.abs(teams.reduce((s, t) => s + t.playoffOdds.mean, 0) - 6) < 1e-12);
  for (const t of teams) {
    assert.ok(Math.abs(t.championshipOdds.mean - 1 / 12) < .015, `${t.id}: ${t.championshipOdds.mean}`);
    assert.ok(Math.abs(t.playoffOdds.mean - .5) < .025);
    assert.ok(Math.abs(t.wins.mean + t.losses.mean + t.ties.mean - 14) < 1e-10);
    assert.ok(Math.abs(Object.values(t.records).reduce((a, b) => a + b, 0) - 1) < 1e-10);
  }
});

test('dominant team wins; 3/4/5/6/8-team brackets, byes and reseeding preserve a single champion', () => {
  for (const count of [3, 4, 5, 6, 8]) for (const reseed of [false, true]) {
    const input = simulationFixture(100);
    input.playoffs = { teams: count, rounds: Array.from({ length: Math.ceil(Math.log2(count)) }, (_, i) => [15 + i]), reseed };
    const r = simulateSeason(deterministicModel(), input, { simulations: 20 });
    assert.equal(r.scenarios[0]!.teams[0]!.championshipOdds.mean, 1);
    assert.ok(Math.abs(r.scenarios[0]!.teams.reduce((a, t) => a + t.playoffOdds.mean, 0) - count) < 1e-12);
  }
});

test('paired upgrade improves odds reproducibly across seeds', () => {
  const input = tiny();
  input.players.push({ id: 2, position: 'QB', projections: { 5: 25, 6: 25, 7: 25, 8: 25 } });
  const upgraded = structuredClone(input.scenarios[0]!); upgraded.name = 'upgrade';
  for (const week of [5, 6, 7, 8]) upgraded.lineups[0]![week] = [2];
  input.scenarios.push(upgraded);
  for (const seed of [1, 42, 98765]) {
    const r = simulateSeason(model, input, { simulations: 10_000, seed });
    const delta = r.comparisons[0]!.teams[0]!.championshipOdds;
    assert.ok(delta.interval95[0] > .1);
    assert.ok(delta.standardError < Math.hypot(r.scenarios[0]!.teams[0]!.championshipOdds.standardError,
      r.scenarios[1]!.teams[0]!.championshipOdds.standardError));
  }
});

test('precision sizing is fixed in advance, capped and honestly reported', () => {
  const r = simulateSeason(model, tiny(), { targetHalfWidth: .01 });
  assert.equal(r.simulations, 9604); assert.equal(r.precisionReached, true);
  const capped = simulateSeason(model, tiny(), { targetHalfWidth: .001, maxSimulations: 100 });
  assert.equal(capped.precisionReached, false);
});

test('rejects malformed inputs rather than silently inventing schedules or forecasts', () => {
  const cases: ((i: SeasonSimulationInput) => void)[] = [
    i => { delete i.players[0]!.projections[8]; },
    i => { i.players[0]!.projections[8] = -1; },
    i => { i.regularSeason.push(i.regularSeason[0]!); },
    i => { i.scenarios[0]!.lineups[1]![5] = [0]; },
    i => { i.playoffs.rounds = [[6, 8]]; },
    i => { i.playoffs.teams = 3; },
    i => { i.teams[1]!.id = 0; },
  ];
  for (const change of cases) { const input = tiny(); change(input); assert.throws(() => simulateSeason(model, input, { simulations: 10 })); }
});

test('lineup adapter uses forecasts, benches bye players, and requires playoff coverage', () => {
  const player = (id: number, pts: Record<number, number>): Player => ({ id, name: String(id), pos: 'QB', eligibleSlots: [0], onIR: false, espnByWeek: pts, sleeper: null } as Player);
  const roster = new Map([[1, [player(10, { 1: 20, 2: 0 }), player(11, { 1: 10, 2: 10 })]]]);
  const prepared = prepareSimulationLineups('base', roster, new Map([[0, 1]]), [1, 2]);
  assert.deepEqual(prepared.scenario.lineups[1], { 1: [10], 2: [11] });
  assert.throws(() => prepareSimulationLineups('base', roster, new Map([[0, 1]]), [1, 2, 3]), /Missing projection/);
});


test('negative ESPN defense identities retain their weekly negative score tail', () => {
  const input = tiny();
  input.players[0]!.id = -16001;
  input.players[0]!.position = 'DEF';
  for (const w of [5, 6, 7, 8]) input.scenarios[0]!.lineups[0]![w] = [-16001];
  const copy = deterministicModel();
  for (const b of [copy.formats.ppr.weekly.DEF.pooled, ...copy.formats.ppr.weekly.DEF.bins]) b.multiplier.samples = [-1];
  const r = simulateSeason(copy, input, { simulations: 10 });
  assert.equal(r.scenarios[0]!.teams[0]!.losses.mean, 2);
});

test('paired precision sizes for the larger possible variance of differences', () => {
  const input = tiny();
  input.scenarios.push({ ...structuredClone(input.scenarios[0]!), name: 'same' });
  const r = simulateSeason(model, input, { targetHalfWidth: .02 });
  assert.equal(r.simulations, 9604);
  assert.equal(r.precisionReached, true);
  assert.equal(r.worstCaseComparisonHalfWidth, .02);
});

test('reseeded and fixed brackets produce the correct different opponents after an upset', () => {
  const teams = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, wins: 8 - i, losses: i, ties: 0, pointsFor: 0 }));
  const input: SeasonSimulationInput = {
    format: 'ppr', teams, regularSeason: [], playoffs: { teams: 8, rounds: [[15], [16], [17]] },
    players: teams.map(t => ({ id: t.id, position: 'QB', projections: {
      15: t.id === 8 ? 200 : 100 - t.id,
      16: ({ 8: 80, 4: 70, 2: 100, 3: 60 } as Record<number, number>)[t.id] ?? 0,
      17: ({ 8: 90, 4: 100, 2: 80 } as Record<number, number>)[t.id] ?? 0,
    } })),
    scenarios: [{ name: 'base', lineups: Object.fromEntries(teams.map(t => [t.id, { 15: [t.id], 16: [t.id], 17: [t.id] }])) }],
  };
  const fixed = simulateSeason(deterministicModel(), input, { simulations: 10 });
  assert.equal(fixed.scenarios[0]!.teams.find(t => t.id === 8)!.championshipOdds.mean, 1);
  input.playoffs.reseed = true;
  const reseeded = simulateSeason(deterministicModel(), input, { simulations: 10 });
  assert.equal(reseeded.scenarios[0]!.teams.find(t => t.id === 4)!.championshipOdds.mean, 1);
});
