import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchLiveScores, scoreSnapshot } from "./scores.js";
import type { EspnLeague, EspnStat } from "../espn/types.js";

const stat = (value: number, overrides: Partial<EspnStat> = {}): EspnStat => ({
  id: "actual", seasonId: 2026, scoringPeriodId: 1, statSourceId: 0,
  statSplitTypeId: 1, appliedTotal: value, ...overrides,
});
function fixture(): EspnLeague {
  return {
    id: 123, seasonId: 2026, scoringPeriodId: 1,
    settings: { name: "Test", rosterSettings: { lineupSlotCounts: {} } },
    teams: [{ id: 1, name: "Team", abbrev: "T", roster: { entries:
      [[1, 2, 0], [2, 4, -2], [3, 20, 20], [4, 21, 30]].map(([id, slot, points]) => ({
        playerId: id!, lineupSlotId: slot!, playerPoolEntry: { player: {
          id: id!, fullName: "Player", defaultPositionId: 2, eligibleSlots: [2], proTeamId: 1,
          stats: [stat(100, { statSourceId: 1 }), stat(90, { seasonId: 2025 }),
            stat(80, { scoringPeriodId: 2 }), stat(70, { statSplitTypeId: 0 }), stat(points!)],
        } },
      })),
    } }],
  };
}
test("actuals select current weekly actual stats, preserve zero/negative and exclude bench/IR from total", () => {
  const result = scoreSnapshot(fixture(), 1);
  assert.deepEqual(result.players.map((p) => p.actual), [0, -2, 20, 30]);
  assert.equal(result.starterTotal, -2);
  assert.equal(result.week, 1);
});
test("missing or invalid actual totals stay unknown", () => {
  for (const value of [undefined, NaN, Infinity]) {
    const league = fixture();
    league.teams[0]!.roster!.entries[0]!.playerPoolEntry.player.stats = [stat(0, { appliedTotal: value })];
    assert.equal(scoreSnapshot(league, 1).players[0]!.actual, null);
    assert.equal(scoreSnapshot(league, 1).starterTotal, null);
  }
});
test("missing team and roster fail instead of reporting zero", () => {
  const league = fixture();
  assert.throws(() => scoreSnapshot(league, 2), /not in this league/);
  delete league.teams[0]!.roster;
  assert.throws(() => scoreSnapshot(league, 1), /did not return/);
});
test("live updates fetch fresh league-scored rosters and surface upstream failure", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.searchParams.get("view") === "proTeamSchedules_wl") return new Response("Unavailable", { status: 503 });
    calls++;
    assert.deepEqual(url.searchParams.getAll("view"), ["mTeam", "mRoster"]);
    assert.equal(new Headers(init?.headers).get("Cookie"), "SWID=test; espn_s2=cookie");
    assert.ok(init?.signal);
    return calls === 3 ? new Response("Unavailable", { status: 503 }) : Response.json(fixture());
  };
  try {
    const auth = { swid: "test", espnS2: "cookie" };
    const result = await fetchLiveScores(123, 2026, 1, auth);
    assert.equal(result.scheduleError, "Game times unavailable");
    assert.equal(result.players[0]!.game, null);
    await fetchLiveScores(123, 2026, 1, auth);
    assert.equal(calls, 2);
    await assert.rejects(fetchLiveScores(123, 2026, 1, auth), /503/);
  } finally { globalThis.fetch = original; }
});

test("scores attach current-week games to starters, bench and IR", () => {
  const result = scoreSnapshot(fixture(), 1, [
    { id: 1, abbrev: "ATL", proGamesByScoringPeriod: { 1: [{ date: 1798358400000, homeProTeamId: 2, awayProTeamId: 1 }] } },
    { id: 2, abbrev: "BUF" },
  ]);
  for (const player of result.players) {
    assert.deepEqual(player.game, { kickoff: 1798358400000, opponent: "BUF", away: true, bye: false });
  }
});
