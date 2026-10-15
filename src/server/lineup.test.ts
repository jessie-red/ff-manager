import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { acceptTrade, acquire, acquisition, cancelTrade, pending, propose, roster, saveLineup, type SaveLineupRequest } from "./api.js";
import type { EspnLeague, EspnRosterEntry } from "../espn/types.js";

const originalFetch = globalThis.fetch;
const originalSwid = process.env.ESPN_SWID;
const originalS2 = process.env.ESPN_S2;
process.env.ESPN_SWID = "{test-owner}";
process.env.ESPN_S2 = "test-cookie";
let writes: { url: string; body: unknown }[];
let failWrite = false;
let league: EspnLeague;
const entry = (id: number, slot: number): EspnRosterEntry => ({
  playerId: id, lineupSlotId: slot,
  playerPoolEntry: { player: { id, fullName: `Player ${id}`, defaultPositionId: 2, proTeamId: 1, eligibleSlots: [2, 23, 20] } },
});
const request = (): SaveLineupRequest => ({
  league: 123, season: 2026, teamId: 1, week: 1,
  previous: [{ playerId: 1, slotId: 2 }, { playerId: 2, slotId: 20 }],
  assignments: [{ playerId: 1, slotId: 20 }, { playerId: 2, slotId: 2 }],
});

beforeEach(() => {
  writes = [];
  failWrite = false;
  league = {
    id: 123, seasonId: 2026, scoringPeriodId: 1,
    teams: [{ id: 1, name: "My Team", abbrev: "ME", owners: ["{TEST-OWNER}"], roster: { entries: [entry(1, 2), entry(2, 20)] } }],
    settings: { name: "Test League", rosterSettings: { lineupSlotCounts: { 2: 1, 23: 1, 20: 1 } } },
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (new URL(url).searchParams.get("view") === "kona_player_info") {
      return Response.json({ players: [1, 2, -16001].map((id) => ({ player: entry(id, 20).playerPoolEntry.player })) });
    }
    if (url.startsWith("https://lm-api-reads.fantasy.espn.com/")) return Response.json(league);
    if (url.startsWith("https://lm-api-writes.fantasy.espn.com/") && init?.method === "POST") {
      writes.push({ url, body: JSON.parse(String(init.body)) });
      return failWrite ? new Response("Player is locked", { status: 400 }) : Response.json({ id: "test-transaction" });
    }
    throw new Error(`Unexpected fetch in lineup test: ${url}`);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalSwid === undefined) delete process.env.ESPN_SWID; else process.env.ESPN_SWID = originalSwid;
  if (originalS2 === undefined) delete process.env.ESPN_S2; else process.env.ESPN_S2 = originalS2;
});

test("roster returns actual assignments, capacities, current week, and ownership", async () => {
  const data = await roster(new URLSearchParams({ league: "123", season: "2026", teamId: "1" }));
  assert.equal(data.team.isMe, true);
  assert.equal(data.week, 1);
  assert.equal(data.slots[23], 1);
  assert.deepEqual(data.players.map((p) => p.lineupSlotId), [2, 20]);
  assert.equal(writes.length, 0);
});

test("save is a dry run unless send is exactly true", async () => {
  for (const send of [undefined, false, "true" as unknown as boolean]) {
    const result = await saveLineup({ ...request(), send });
    assert.equal(result.sent, false);
    assert.equal(result.body?.items.length, 2);
  }
  assert.equal(writes.length, 0);
});

test("explicit save submits one atomic swap with both original slot ids", async () => {
  const result = await saveLineup({ ...request(), send: true });
  assert.equal(result.sent, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(result.body?.items, [
    { playerId: 1, type: "LINEUP", fromLineupSlotId: 2, toLineupSlotId: 20 },
    { playerId: 2, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 2 },
  ]);
  assert.equal(result.body?.scoringPeriodId, 1);
});

test("can submit a move into an unoccupied configured starter slot", async () => {
  const req = request();
  req.assignments = [{ playerId: 1, slotId: 2 }, { playerId: 2, slotId: 23 }];
  const result = await saveLineup({ ...req, send: true });
  assert.equal(result.body?.items.length, 1);
});

test("rejects another owner's team without posting", async () => {
  league.teams[0]!.owners = ["{someone-else}"];
  await assert.rejects(saveLineup({ ...request(), send: true }), /team you manage/);
  assert.equal(writes.length, 0);
});

test("rejects stale week and changed rosters without posting", async () => {
  await assert.rejects(saveLineup({ ...request(), week: 2, send: true }), /week has changed/);
  league.teams[0]!.roster!.entries[0]!.lineupSlotId = 23;
  await assert.rejects(saveLineup({ ...request(), send: true }), /roster changed/);
  assert.equal(writes.length, 0);
});

test("invalid assignments and unchanged lineups never produce a write", async () => {
  await assert.rejects(saveLineup({ ...request(), assignments: [], send: true }), /every roster player/);
  const req = request();
  const result = await saveLineup({ ...req, assignments: req.previous, send: true });
  assert.deepEqual(result, { sent: false, body: null });
  assert.equal(writes.length, 0);
});

test("ESPN lock errors propagate instead of reporting success", async () => {
  failWrite = true;
  await assert.rejects(saveLineup({ ...request(), send: true }), /Player is locked/);
});

const pendingQuery = () => new URLSearchParams({ league: "123", season: "2026", teamId: "1" });

test("missing pendingTransactions is an empty inbox, not an error", async () => {
  const result = await pending(pendingQuery());
  assert.deepEqual(result.transactions, []);
  assert.equal(writes.length, 0);
});

test("pending inbox includes incoming offers, accepted trades and waiver adds/drops", async () => {
  league.teams.push({ id: 2, name: "Partner", abbrev: "THEM" });
  const items = [
    { playerId: 1, type: "TRADE", fromTeamId: 1, toTeamId: 2 },
    { playerId: 2, type: "TRADE", fromTeamId: 2, toTeamId: 1 },
  ];
  league.pendingTransactions = [
    { id: "offer", type: "TRADE_PROPOSAL", teamId: 2, isPending: true, status: "PENDING", items, expirationDate: 1789255764475 },
    { id: "accepted", type: "TRADE_ACCEPT", teamId: 1, isPending: true, status: "PENDING", items, processDate: 1789071280504 },
    { id: "waiver", type: "WAIVER", teamId: 1, isPending: true, bidAmount: 0, subOrder: 1, items: [
      { playerId: -16001, type: "ADD", fromTeamId: 0, toTeamId: 1 },
      { playerId: 1, type: "DROP", fromTeamId: 1, toTeamId: 0 },
    ] },
  ];
  const result = await pending(pendingQuery());
  assert.equal(result.transactions.length, 3);
  const offer = result.transactions.find((t) => t.id === "offer")!;
  assert.equal(offer.direction, "incoming");
  assert.deepEqual(offer.partners, ["Partner"]);
  assert.equal(offer.incoming[0]?.name, "Player 2");
  assert.equal(offer.outgoing[0]?.name, "Player 1");
  assert.equal(offer.expiresAt, 1789255764475);
  assert.equal(result.transactions.find((t) => t.id === "accepted")?.accepted, true);
  const waiver = result.transactions.find((t) => t.id === "waiver")!;
  assert.equal(waiver.bid, 0);
  assert.equal(waiver.incoming[0]?.id, -16001);
  assert.equal(waiver.outgoing[0]?.id, 1);
  assert.equal(writes.length, 0);
});

test("pending inbox excludes closed requests, unrelated trades and other teams' claims", async () => {
  league.pendingTransactions = [
    { id: "closed", type: "TRADE_PROPOSAL", teamId: 1, status: "CANCELED" },
    { id: "done", type: "WAIVER", teamId: 1, isPending: false },
    { id: "other-claim", type: "WAIVER", teamId: 2, isPending: true },
    { id: "other-trade", type: "TRADE_PROPOSAL", teamId: 2, isPending: true, items: [{ playerId: 2, type: "TRADE", fromTeamId: 2, toTeamId: 3 }] },
    { id: "roster", type: "ROSTER", teamId: 1, isPending: true },
  ];
  assert.deepEqual((await pending(pendingQuery())).transactions, []);
});

test("pending requests cannot be queried for an unowned team", async () => {
  league.teams[0]!.owners = ["{someone-else}"];
  await assert.rejects(pending(pendingQuery()), /team you manage/);
});

const cancelRequest = () => ({ league: 123, season: 2026, teamId: 1, transactionId: "offer", send: true });
const openOffer = () => ({ id: "offer", type: "TRADE_PROPOSAL", teamId: 1, isPending: true, status: "PENDING" });

test("trade cancellation uses ESPN's CANCEL envelope and defaults to a dry run", async () => {
  league.pendingTransactions = [openOffer()];
  for (const send of [undefined, false, "true" as unknown as boolean]) {
    assert.equal((await cancelTrade({ ...cancelRequest(), send })).sent, false);
  }
  assert.equal(writes.length, 0);
  assert.equal((await pending(pendingQuery())).transactions[0]?.canCancel, true);
  league.status = { latestScoringPeriod: 2 };
  assert.deepEqual(await cancelTrade(cancelRequest()), { sent: true, transactionId: "offer" });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.body, {
    isLeagueManager: false, teamId: 1, memberId: "{test-owner}", scoringPeriodId: 2,
    type: "TRADE_PROPOSAL", executionType: "CANCEL", relatedTransactionId: "offer", items: [],
  });
});

test("rejects cancellation of missing, incoming, accepted, closed and waiver requests", async () => {
  const invalid = [
    [], [{ ...openOffer(), teamId: 2 }], [{ ...openOffer(), type: "TRADE_ACCEPT" }],
    [{ ...openOffer(), acceptedDate: 1789071280504 }], [{ ...openOffer(), status: "CANCELED" }],
    [{ ...openOffer(), isPending: false }], [{ ...openOffer(), type: "WAIVER" }],
  ];
  for (const transactions of invalid) {
    league.pendingTransactions = transactions;
    await assert.rejects(cancelTrade(cancelRequest()), /no longer cancellable/);
    assert.ok((await pending(pendingQuery())).transactions.every((t) => !t.canCancel));
  }
  assert.equal(writes.length, 0);
});

test("cancellation checks team ownership and malformed input before writing", async () => {
  league.pendingTransactions = [openOffer()];
  await assert.rejects(cancelTrade({ ...cancelRequest(), transactionId: "" }), /transaction id/);
  await assert.rejects(cancelTrade({ ...cancelRequest(), teamId: -1 }), /team id/);
  league.teams[0]!.owners = ["{someone-else}"];
  await assert.rejects(cancelTrade(cancelRequest()), /team you manage/);
  assert.equal(writes.length, 0);
});

test("ESPN cancellation rejection propagates without reporting success", async () => {
  league.pendingTransactions = [openOffer()];
  failWrite = true;
  await assert.rejects(cancelTrade(cancelRequest()), /ESPN 400/);
});


const acceptRequest = () => ({ league: 123, season: 2026, teamId: 1, transactionId: "offer", send: true });
const incomingOffer = () => ({
  id: "offer", type: "TRADE_PROPOSAL", teamId: 2, isPending: true, status: "PENDING", items: [
    { playerId: 3, type: "TRADE", fromTeamId: 2, toTeamId: 1 },
    { playerId: 1, type: "TRADE", fromTeamId: 1, toTeamId: 2 },
  ],
});

test("trade acceptance uses ESPN's TRADE_ACCEPT envelope, defaults to a dry run and appends drops", async () => {
  league.teams.push({ id: 2, name: "Partner", abbrev: "THEM" });
  league.pendingTransactions = [incomingOffer()];
  for (const send of [undefined, false, "true" as unknown as boolean]) {
    assert.equal((await acceptTrade({ ...acceptRequest(), send })).sent, false);
  }
  assert.equal(writes.length, 0);
  const offer = (await pending(pendingQuery())).transactions[0]!;
  assert.equal(offer.canAccept, true);
  assert.equal(offer.canCancel, false);
  assert.deepEqual(offer.partnerIds, [2]);
  league.status = { latestScoringPeriod: 4 };
  const result = await acceptTrade(acceptRequest());
  assert.equal(result.sent, true);
  assert.deepEqual(writes[0]!.body, {
    isLeagueManager: false, teamId: 1, type: "TRADE_ACCEPT", memberId: "{test-owner}", scoringPeriodId: 4,
    executionType: "EXECUTE", relatedTransactionId: "offer",
  });
  await acceptTrade({ ...acceptRequest(), drop: [2] });
  assert.deepEqual((writes[1]!.body as { items: unknown }).items, [{ playerId: 2, type: "DROP", fromTeamId: 1 }]);
});

test("rejects acceptance of own, accepted, answered, closed, unrelated and waiver requests", async () => {
  const invalid = [
    [], [{ ...incomingOffer(), teamId: 1 }], [{ ...incomingOffer(), acceptedDate: 1789071280504 }],
    [incomingOffer(), { id: "accept", type: "TRADE_ACCEPT", teamId: 1, isPending: true, status: "PENDING", relatedTransactionId: "offer" }],
    [{ ...incomingOffer(), status: "CANCELED" }], [{ ...incomingOffer(), isPending: false }],
    [{ ...incomingOffer(), items: [{ playerId: 3, type: "TRADE", fromTeamId: 2, toTeamId: 3 }] }],
    [{ ...incomingOffer(), type: "WAIVER" }],
  ];
  for (const transactions of invalid) {
    league.pendingTransactions = transactions;
    await assert.rejects(acceptTrade(acceptRequest()), /can no longer be accepted/);
    assert.ok((await pending(pendingQuery())).transactions.every((t) => !t.canAccept));
  }
  assert.equal(writes.length, 0);
});

test("acceptance checks ownership, input and drops before writing", async () => {
  league.pendingTransactions = [incomingOffer()];
  await assert.rejects(acceptTrade({ ...acceptRequest(), transactionId: "" }), /transaction id/);
  await assert.rejects(acceptTrade({ ...acceptRequest(), teamId: 0 }), /team id/);
  await assert.rejects(acceptTrade({ ...acceptRequest(), drop: [99] }), /not on My Team's roster/);
  await assert.rejects(acceptTrade({ ...acceptRequest(), drop: [1] }), /already being traded away/);
  await assert.rejects(acceptTrade({ ...acceptRequest(), drop: [2, 2] }), /twice/);
  league.teams[0]!.owners = ["{someone-else}"];
  await assert.rejects(acceptTrade(acceptRequest()), /team you manage/);
  assert.equal(writes.length, 0);
});

test("a roster-limit refusal comes back as rosterLimit so drops can be picked; other refusals throw", async () => {
  league.pendingTransactions = [incomingOffer()];
  const base = globalThis.fetch;
  globalThis.fetch = async (input, init) => init?.method === "POST"
    ? Response.json({ details: [{ type: "TRAN_ROSTER_LIMIT_EXCEEDED_ONE", message: "Too many players on roster.", resolution: "Drop 1 player." }] }, { status: 409 })
    : base(input, init);
  const result = await acceptTrade(acceptRequest());
  assert.equal(result.sent, false);
  assert.deepEqual(result.rosterLimit, { message: "Too many players on roster.", resolution: "Drop 1 player." });
  globalThis.fetch = base;
  failWrite = true;
  await assert.rejects(acceptTrade(acceptRequest()), /Player is locked/);
});

test("ESPN lineup locks are exposed in the roster and reject writes", async () => {
  league.teams[0]!.roster!.entries[0]!.playerPoolEntry.lineupLocked = true;
  const data = await roster(new URLSearchParams({ league: "123", season: "2026", teamId: "1" }));
  assert.equal(data.players[0]!.lineupLocked, true);
  await assert.rejects(saveLineup({ ...request(), send: true }), /locked/);
  assert.equal(writes.length, 0);
});


test("acquisition preserves waiver status and negative ids, and live rosters override pool ownership", async () => {
  globalThis.fetch = async input => new URL(String(input)).searchParams.get("view") === "kona_player_info"
    ? Response.json({ players: [1, 3, -16001].map(id => ({ id, onTeamId: 0, status: "WAIVERS", player: entry(id, 20).playerPoolEntry.player })) })
    : Response.json(league);
  const data = await acquisition(new URLSearchParams({ league: "123", season: "2026", teamId: "1" }));
  assert.equal(data.players.find(p => p.id === 1)?.ownerId, 1);
  assert.equal(data.players.find(p => p.id === 2)?.status, "ONTEAM");
  assert.equal(data.players.find(p => p.id === -16001)?.status, "WAIVERS");
  assert.equal(data.players.find(p => p.id === 3)?.ownerId, 0);
});

test("acquisition rejects teams the account does not manage", async () => {
  league.teams[0]!.owners = ["someone-else"];
  await assert.rejects(acquisition(new URLSearchParams({ league: "123", season: "2026", teamId: "1" })), /team you manage/);
});


const pickup = () => ({ league: 123, season: 2026, teamId: 1, addPlayerId: -16001, dropPlayerId: 2, type: "WAIVER" as const, bidAmount: 0 });
function mockPickupPool(status = "WAIVERS") {
  const base = globalThis.fetch;
  globalThis.fetch = async (input, init) => new URL(String(input)).searchParams.get("view") === "kona_player_info"
    ? Response.json({ players: [{ id: -16001, onTeamId: 0, status, player: entry(-16001, 20).playerPoolEntry.player }] })
    : base(input, init);
}

test("pickup defaults to dry run and submits a zero-bid waiver with optional drop", async () => {
  mockPickupPool();
  for (const send of [undefined, false, "true" as unknown as boolean]) {
    assert.equal((await acquire({ ...pickup(), send })).sent, false);
  }
  assert.equal(writes.length, 0);
  league.status = { latestScoringPeriod: 3 };
  assert.equal((await acquire({ ...pickup(), send: true })).sent, true);
  assert.deepEqual(writes[0]!.body, {
    isLeagueManager: false, teamId: 1, memberId: "{test-owner}", scoringPeriodId: 3,
    type: "WAIVER", executionType: "EXECUTE", bidAmount: 0,
    items: [{ playerId: -16001, type: "ADD", toTeamId: 1 }, { playerId: 2, type: "DROP", fromTeamId: 1 }],
  });
});

test("free-agent pickup submits immediately without a bid or drop", async () => {
  mockPickupPool("FREEAGENT");
  assert.equal((await acquire({ league: 123, season: 2026, teamId: 1, addPlayerId: -16001, type: "FREEAGENT", send: true })).sent, true);
  const body = writes[0]!.body as { type: string; items: unknown[]; bidAmount?: number };
  assert.equal(body.type, "FREEAGENT");
  assert.equal(body.items.length, 1);
  assert.equal(body.bidAmount, undefined);
});

test("pickup rejects stale availability, invalid drops, rostered targets and bad bids without writing", async () => {
  mockPickupPool("FREEAGENT");
  await assert.rejects(acquire({ ...pickup(), send: true }), /availability changed/);
  await assert.rejects(acquire({ ...pickup(), dropPlayerId: 99, send: true }), /no longer on your roster/);
  await assert.rejects(acquire({ ...pickup(), addPlayerId: 1, send: true }), /already rostered/);
  await assert.rejects(acquire({ ...pickup(), bidAmount: -1, send: true }), /bid/);
  league.teams[0]!.owners = ["someone-else"];
  await assert.rejects(acquire({ ...pickup(), send: true }), /team you manage/);
  assert.equal(writes.length, 0);
});

test("pickup surfaces ESPN rejection", async () => {
  mockPickupPool();
  failWrite = true;
  await assert.rejects(acquire({ ...pickup(), send: true }), /Player is locked/);
});


test("FA stats preserve zero, use selected-week positional consensus and match Sleeper projections", async () => {
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === "api.sleeper.app") return Response.json([{
      player_id: "3", player: { first_name: "Player", last_name: "3", position: "RB", fantasy_positions: ["RB"], team: "ATL" },
      stats: { gp: 1, pts_std: 7.5 },
    }]);
    if (url.searchParams.get("view") === "kona_player_info") {
      assert.equal(url.searchParams.get("scoringPeriodId"), "2");
      return Response.json({ players: [3, 4].map(id => ({ id, onTeamId: 0, status: "FREEAGENT", player: {
        ...entry(id, 20).playerPoolEntry.player,
        ...(id === 3 ? { ownership: { percentOwned: 0 }, stats: [
          { seasonId: 2026, statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: 99 },
          { seasonId: 2026, statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 2, appliedTotal: 0 },
        ], rankings: {
          "0": [{ rankType: "PPR", slotId: 2, rankSourceId: 0, averageRank: 20, rank: 0 }],
          "2": [{ rankType: "PPR", slotId: 2, rankSourceId: 0, averageRank: 12.5, rank: 0 },
            { rankType: "PPR", slotId: 10, rankSourceId: 0, averageRank: 1, rank: 0 }],
        } } : {}),
      } })) });
    }
    return Response.json(league);
  };
  const data = await acquisition(new URLSearchParams({ league: "123", season: "2026", teamId: "1", week: "2", stats: "1" }));
  const player = data.players.find(p => p.id === 3)!;
  assert.equal(data.week, 2);
  assert.equal(player.percentOwned, 0);
  assert.equal(player.espnProjection, 0);
  assert.equal(player.sleeperProjection, 7.5);
  assert.equal(player.weekRank, 12.5);
  assert.equal(player.rosRank, 20);
  const missing = data.players.find(p => p.id === 4)!;
  assert.equal(missing.espnProjection, null);
  assert.equal(missing.sleeperProjection, null);
  assert.equal(missing.weekRank, null);
});

test("FA keeps ESPN data available when Sleeper fails", async () => {
  const base = globalThis.fetch;
  globalThis.fetch = async (input, init) => new URL(String(input)).hostname === "api.sleeper.app"
    ? new Response("Unavailable", { status: 503 }) : base(input, init);
  const data = await acquisition(new URLSearchParams({ league: "123", season: "2025", teamId: "1", stats: "1" }));
  assert.match(data.sleeperError!, /Sleeper 503/);
  assert.ok(data.players.length);
});

test("trade offers carry validated drops, including D/ST ids, and stay dry unless sent", async () => {
  league.teams[0]!.roster!.entries.push(entry(-16001, 20));
  league.teams.push({ id: 2, name: "Partner", abbrev: "PT", owners: ["{someone-else}"], roster: { entries: [entry(7, 20), entry(8, 20)] } });
  const offer = { league: 123, season: 2026, teamId: 1, partnerId: 2, give: [1], get: [7, 8], drop: [-16001] };
  const preview = await propose(offer);
  assert.equal(preview.sent, false);
  assert.equal(writes.length, 0);
  assert.deepEqual(preview.body.items.at(-1), { playerId: -16001, type: "DROP", fromTeamId: 1 });
  assert.equal(preview.names[-16001], "Player -16001");
  const result = await propose({ ...offer, send: true });
  assert.equal(result.sent, true);
  assert.deepEqual(writes[0]?.body, result.body);
  await assert.rejects(propose({ ...offer, drop: [7] }), /not on My Team's roster to drop/);
  await assert.rejects(propose({ ...offer, drop: [1] }), /already being traded away/);
  await assert.rejects(propose({ ...offer, drop: [0] }), /bad player id/);
  assert.equal(writes.length, 1);
});

test("ESPN's roster-limit 409 comes back as rosterLimit for the drops prompt; other refusals still throw", async () => {
  league.teams.push({ id: 2, name: "Partner", abbrev: "PT", owners: ["{someone-else}"], roster: { entries: [entry(7, 20), entry(8, 20)] } });
  const offer = { league: 123, season: 2026, teamId: 1, partnerId: 2, give: [1], get: [7, 8], send: true };
  const limit = {
    messages: ["Too many players on roster (maximum 16)."],
    details: [{
      message: "Too many players on roster (maximum 16).", shortMessage: "Too many players on roster (maximum 16).",
      resolution: "You must drop at least 1 player to clear your roster for the incoming player.", type: "TRAN_ROSTER_LIMIT_E",
    }],
  };
  let reply = () => Response.json(limit, { status: 409 });
  const mocked = globalThis.fetch;
  globalThis.fetch = async (input, init) =>
    String(input).startsWith("https://lm-api-writes.fantasy.espn.com/") ? reply() : mocked(input, init);

  const refused = await propose(offer);
  assert.equal(refused.sent, false);
  assert.deepEqual(refused.rosterLimit, {
    message: "Too many players on roster (maximum 16).",
    resolution: "You must drop at least 1 player to clear your roster for the incoming player.",
  });
  reply = () => Response.json({ details: [{ message: "Trade deadline has passed.", type: "TRAN_DEADLINE_E" }] }, { status: 409 });
  await assert.rejects(propose(offer), /ESPN 409.*Trade deadline/);
  reply = () => new Response("Player is locked", { status: 400 });
  await assert.rejects(propose(offer), /ESPN 400.*Player is locked/);
});
