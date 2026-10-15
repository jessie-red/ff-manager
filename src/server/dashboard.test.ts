import { playerGame } from "../espn/games.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchLiveMatchup, matchupSnapshot } from "./dashboard.js";
import type { EspnLeague } from "../espn/types.js";

function fixture(): EspnLeague {
  return {
    id: 123, seasonId: 2026, scoringPeriodId: 16,
    settings: { name: "League", rosterSettings: { lineupSlotCounts: {} },
      scheduleSettings: { matchupPeriods: { 14: [15, 16], 15: [17, 18] } } },
    teams: [{ id: 1, name: "Mine", abbrev: "M" }, { id: 2, name: "Rival", abbrev: "R" }],
    schedule: [
      { id: 1, matchupPeriodId: 13, home: { teamId: 1, totalPoints: 200 }, away: { teamId: 2, totalPoints: 190 }, winner: "HOME" },
      { id: 2, matchupPeriodId: 14, home: { teamId: 2, totalPoints: 123.45 }, away: { teamId: 1, totalPoints: 130.12 }, winner: "UNDECIDED" },
    ],
  };
}
test("selects active multi-week matchup and puts owned away team first", () => {
  const data = matchupSnapshot(fixture(), 1);
  assert.equal(data.matchupPeriod, 14);
  assert.equal(data.matchups.length, 1);
  assert.equal(data.matchups[0]!.mine.points, 130.12);
  assert.equal(data.matchups[0]!.opponent!.name, "Rival");
  assert.equal(data.matchups[0]!.status, "active");
});
test("explicit current period wins; completed matches are final", () => {
  const league = fixture();
  league.status = { currentMatchupPeriod: 13 };
  assert.equal(matchupSnapshot(league, 1).matchups[0]!.status, "final");
});
test("byes and unscheduled periods are distinct", () => {
  const league = fixture();
  delete league.schedule![1]!.away;
  const data = matchupSnapshot(league, 2);
  assert.equal(data.matchups[0]!.status, "bye");
  assert.equal(data.matchups[0]!.opponent, null);
  assert.equal(matchupSnapshot(league, 1).matchups.length, 0);
});
test("zero and negative scores are preserved; absent scores are unknown", () => {
  const league = fixture();
  league.schedule![1]!.home.totalPoints = 0;
  league.schedule![1]!.away!.totalPoints = -2;
  let data = matchupSnapshot(league, 1);
  assert.equal(data.matchups[0]!.mine.points, -2);
  assert.equal(data.matchups[0]!.opponent!.points, 0);
  league.schedule![1]!.away!.totalPoints = undefined as unknown as number;
  data = matchupSnapshot(league, 1);
  assert.equal(data.matchups[0]!.mine.points, null);
});
test("live totals override delayed scores and invalid live totals fall back", () => {
  const league = fixture();
  const side = league.schedule![1]!.away!;
  side.totalPoints = 0;
  for (const live of [79.1, 0, -2]) {
    side.totalPointsLive = live;
    assert.equal(matchupSnapshot(league, 1).matchups[0]!.mine.points, live);
  }
  side.totalPoints = 130.12;
  side.totalPointsLive = NaN;
  assert.equal(matchupSnapshot(league, 1).matchups[0]!.mine.points, 130.12);
});
test("missing schedule and unknown teams raise errors", () => {
  const league = fixture();
  assert.throws(() => matchupSnapshot(league, 999), /not in this league/);
  delete league.schedule;
  assert.throws(() => matchupSnapshot(league, 1), /schedule/);
});
test("fetches fresh matchup totals with auth and timeout and propagates errors", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).searchParams.get("view") === "proTeamSchedules_wl") return Response.json({ settings: { proTeams: [] } });
    calls++;
    assert.deepEqual(new URL(String(input)).searchParams.getAll("view"), ["mTeam", "mMatchup", "mSettings", "mRoster", "mMatchupScore"]);
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("Cookie"), "SWID=test; espn_s2=cookie");
    return calls === 3 ? new Response("Unavailable", { status: 503 }) : Response.json(fixture());
  };
  try {
    const auth = { swid: "test", espnS2: "cookie" };
    await fetchLiveMatchup(123, 2026, 1, auth);
    await fetchLiveMatchup(123, 2026, 1, auth);
    assert.equal(calls, 2);
    await assert.rejects(fetchLiveMatchup(123, 2026, 1, auth), /503/);
  } finally { globalThis.fetch = original; }
});

test("both sides include full current-week rosters including bench and IR", () => {
  const league = fixture();
  for (const team of league.teams) team.roster = { entries: [2, 20, 21].map((slot, i) => ({
    playerId: team.id * 10 + i, lineupSlotId: slot,
    playerPoolEntry: { player: {
      id: team.id * 10 + i, fullName: `Player ${team.id}-${i}`, defaultPositionId: 2,
      proTeamId: 1, eligibleSlots: [2], stats: [
        { id: "projection", seasonId: 2026, scoringPeriodId: 16, statSourceId: 1, statSplitTypeId: 1, appliedTotal: 99 },
        { id: "last-week", seasonId: 2026, scoringPeriodId: 15, statSourceId: 0, statSplitTypeId: 1, appliedTotal: 50 },
        ...(i === 2 ? [] : [{ id: "actual", seasonId: 2026, scoringPeriodId: 16, statSourceId: 0, statSplitTypeId: 1, appliedTotal: i === 0 ? 0 : -i }]),
      ],
    } },
  })) };
  const match = matchupSnapshot(league, 1).matchups[0]!;
  assert.deepEqual(match.mine.players!.map((p) => p.actual), [0, -1, null]);
  assert.deepEqual(match.opponent!.players!.map((p) => p.slotId), [2, 20, 21]);
  assert.equal(match.mine.players![0]!.name, "Player 1-0");
  assert.equal(match.opponent!.players![0]!.name, "Player 2-0");
  assert.equal(match.mine.points, 130.12);
  delete league.teams[0]!.roster;
  assert.equal(matchupSnapshot(league, 1).matchups[0]!.mine.players, null);
});

test("injury status and game times accompany roster players", () => {
  const league = fixture();
  league.teams[0]!.roster = { entries: [{ playerId: 1, lineupSlotId: 2, injuryStatus: "OUT",
    playerPoolEntry: { player: { id: 1, fullName: "Player", defaultPositionId: 2, eligibleSlots: [2], proTeamId: 1, injuryStatus: "QUESTIONABLE" } } }] };
  const schedules = [{ id: 1, abbrev: "ATL", proGamesByScoringPeriod: { 16: [{ date: 1798358400000, homeProTeamId: 2, awayProTeamId: 1 }] } }, { id: 2, abbrev: "BUF" }];
  const player = matchupSnapshot(league, 1, schedules).matchups[0]!.mine.players![0]!;
  assert.equal(player.injuryStatus, "QUESTIONABLE");
  assert.deepEqual(player.game, { kickoff: 1798358400000, away: true, opponent: "BUF", bye: false });
});

test("schedule distinguishes byes, TBD kickoffs and unavailable games", () => {
  assert.equal(playerGame([], 1, 1), null);
  assert.equal(playerGame([{ id: 1, abbrev: "ATL", byeWeek: 1 }], 1, 1)?.bye, true);
  assert.equal(playerGame([{ id: 1, abbrev: "ATL", proGamesByScoringPeriod: { 1: [{ date: 123, homeProTeamId: 1, awayProTeamId: 2, startTimeTBD: true }] } }], 1, 1)?.kickoff, null);
});
