import { test } from 'node:test';
import assert from 'node:assert/strict';
import { championshipFormat, championshipSchedule, runChampionship } from './championship.js';
import { rate, tradeOdds } from './api.js';
import { fixtureTrade, simulationFixture } from '../simulation/fixture.js';
import type { EspnLeague } from '../espn/types.js';
function league(): EspnLeague {
  return { id: 1, seasonId: 2026, scoringPeriodId: 2, teams: [1,2].map(id => ({ id, name: String(id), abbrev: String(id) })),
    settings: { name: 'test', rosterSettings: { lineupSlotCounts: {} }, scheduleSettings: {
      matchupPeriodCount: 2, playoffTeamCount: 2, matchupPeriods: { 1: [1], 2: [2], 3: [3,4] },
      playoffSeedingRule: 'TOTAL_POINTS_SCORED', playoffReseed: false } },
    schedule: [1,2].map(w => ({ id: w, matchupPeriodId: w, home: { teamId: 1, totalPoints: 100 }, away: { teamId: 2, totalPoints: 80 }, winner: w === 1 ? 'HOME' : 'UNDECIDED', playoffTierType: 'NONE' })) };
}
test('maps completed records once and fetches all playoff weeks', () => {
  const s = championshipSchedule(league());
  assert.deepEqual(s.teams[0], { id: 1, wins: 1, losses: 0, ties: 0, pointsFor: 100 });
  assert.deepEqual(s.weeks, [2,3,4]);
  assert.equal(s.regularSeason.length, 1);
  assert.deepEqual(s.playoffs.rounds, [[3,4]]);
});
test('rejects unsupported rules and partial matchups', () => {
  const l = league(); l.settings.scheduleSettings!.playoffSeedingRule = 'HEAD_TO_HEAD';
  assert.throws(() => championshipSchedule(l), /seeding/);
  l.settings.scheduleSettings!.playoffSeedingRule = 'TOTAL_POINTS_SCORED';
  l.settings.scheduleSettings!.matchupPeriods![2] = [1,2];
  assert.throws(() => championshipSchedule(l), /Partially/);
});
test('server worker runs real engine and conserves championship probability', async () => {
  const result = await runChampionship(simulationFixture());
  assert.equal(result.simulations, 100000);
  assert.ok(Math.abs(result.scenarios[0]!.teams.reduce((s,t) => s+t.championshipOdds.mean, 0)-1) < 1e-10);
});

test('ESPN omitted tie rule uses higher-seed default and preserves reseeding', () => {
  const l = league();
  assert.equal(championshipSchedule(l).playoffs.reseed, false);
  l.settings.scheduleSettings!.playoffReseed = true;
  assert.equal(championshipSchedule(l).playoffs.reseed, true);
  l.settings.scheduleSettings!.playoffMatchupTieRule = 'HIGHER_SEED';
  assert.doesNotThrow(() => championshipSchedule(l));
  l.settings.scheduleSettings!.playoffMatchupTieRule = 'BENCH_POINTS';
  assert.throws(() => championshipSchedule(l), /Unsupported playoff matchup tie rule/);
  delete l.settings.scheduleSettings!.playoffMatchupTieRule;
  delete l.settings.scheduleSettings!.playoffReseed;
  assert.throws(() => championshipSchedule(l), /reseeding setting/);
});

test('trade odds run both rosters in one paired comparison at a caller-chosen budget', async () => {
  const input = simulationFixture();
  input.scenarios.push(fixtureTrade(input));
  const { result } = await tradeOdds({ input, simulations: 2000 });
  assert.equal(result.simulations, 2000);
  assert.equal(result.scenarios.length, 2);
  assert.equal(result.comparisons.length, 1);
  // One title is still awarded every path, so the trade only moves odds between teams.
  assert.ok(Math.abs(result.comparisons[0]!.teams.reduce((s, t) => s + t.championshipOdds.mean, 0)) < 1e-12);
  const traded = result.comparisons[0]!.teams.find(t => t.id === 0)!;
  assert.ok(traded.championshipOdds.interval95[0] <= traded.championshipOdds.mean);
});

test('scoring format comes from ESPN reception scoring and rejects anything else', () => {
  const l = league();
  assert.equal(championshipFormat(l), 'standard');
  l.settings.scoringSettings = { scoringItems: [{ statId: 53, points: .5 }] };
  assert.equal(championshipFormat(l), 'half');
  l.settings.scoringSettings.scoringItems![0]!.points = 1;
  assert.equal(championshipFormat(l), 'ppr');
  l.settings.scoringSettings.scoringItems![0]!.points = .25;
  assert.throws(() => championshipFormat(l), /reception scoring/);
});

test('trade odds reject an empty input or an out-of-range budget', async () => {
  await assert.rejects(tradeOdds({ input: { ...simulationFixture(), scenarios: [] } }), /scenario/);
  await assert.rejects(tradeOdds({ input: simulationFixture(), simulations: 10 }), /between/);
});

test('an abandoned run stops its worker instead of finishing', async () => {
  const abandoned = new AbortController();
  const run = tradeOdds({ input: simulationFixture(), simulations: 1_000_000 }, abandoned.signal);
  abandoned.abort();
  await assert.rejects(run, /abandoned/);
  await assert.rejects(tradeOdds({ input: simulationFixture() }, AbortSignal.abort()), /abandoned/);
});

test('trade data skips playoff forecasts and simulations while retaining player values', async (t) => {
  const savedSwid = process.env.ESPN_SWID;
  const savedS2 = process.env.ESPN_S2;
  process.env.ESPN_SWID = '{test}';
  process.env.ESPN_S2 = 'test';
  t.after(() => {
    if (savedSwid === undefined) delete process.env.ESPN_SWID; else process.env.ESPN_SWID = savedSwid;
    if (savedS2 === undefined) delete process.env.ESPN_S2; else process.env.ESPN_S2 = savedS2;
  });
  const l = league();
  l.settings.rosterSettings.lineupSlotCounts = { 0: 1 };
  for (const team of l.teams) team.roster = { entries: [{ playerId: team.id, lineupSlotId: 0,
    playerPoolEntry: { player: { id: team.id, fullName: `Test QB ${team.id}`,
      defaultPositionId: 1, proTeamId: 1, eligibleSlots: [0] } } }] };
  const fetchedWeeks: number[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname !== 'lm-api-reads.fantasy.espn.com') throw new Error('Optional source unavailable in test');
    if (url.searchParams.get('view') !== 'kona_player_info') return Response.json(l);
    const week = Number(url.searchParams.get('scoringPeriodId'));
    fetchedWeeks.push(week);
    return Response.json({ players: l.teams.map(team => ({ player: {
      ...team.roster!.entries[0]!.playerPoolEntry.player,
      stats: [{ statSourceId: 1, statSplitTypeId: 1, seasonId: 2026, scoringPeriodId: week, appliedTotal: 20 }],
    } })) });
  });
  const params = new URLSearchParams({ league: '1', season: '2026', sleeper: '0', championship: '0' });
  const trade = await rate(params);
  assert.deepEqual(fetchedWeeks, [2]);
  assert.equal(trade.championship, null);
  assert.ok(trade.ros);
  assert.equal(trade.ratings.length, 2);
  for (const team of trade.ratings) {
    assert.equal(team.championshipOdds, undefined);
    assert.equal(team.championshipError, undefined);
    assert.equal(team.simulatedRecord, undefined);
  }
  fetchedWeeks.length = 0;
  params.delete('championship');
  const full = await rate(params);
  assert.deepEqual(fetchedWeeks.sort(), [2, 3, 4]);
  assert.ok(full.championship, full.ratings[0]?.championshipError ?? 'Expected championship setup');
  assert.ok(full.ratings.every(team => team.championshipOdds && team.simulatedRecord));
  assert.deepEqual(trade.ros, full.ros);
  assert.deepEqual(trade.ratings.map(team => team.ros.starters.map(s => s.player?.ros)),
    full.ratings.map(team => team.ros.starters.map(s => s.player?.ros)));
});
