import assert from "node:assert/strict";
import { test } from "node:test";
import { acquirePlayer, waiverTransaction, cancelWaiverTransaction, cancelWaiver, tradeTransaction } from "./transactions.js";

const ctx = { leagueId: 123, season: 2026, teamId: 10, scoringPeriodId: 1 };
const auth = { swid: "{test-owner}", espnS2: "test-cookie" };
const pickup = { addPlayerId: 5081397, dropPlayerId: 4241457 };

test("free-agent add/drop matches the captured payload with synthetic credentials", () => {
  assert.deepEqual(waiverTransaction(ctx, auth, pickup), {
    isLeagueManager: false, teamId: 10, type: "FREEAGENT", memberId: auth.swid,
    scoringPeriodId: 1, executionType: "EXECUTE",
    items: [
      { playerId: 5081397, type: "ADD", toTeamId: 10 },
      { playerId: 4241457, type: "DROP", fromTeamId: 10 },
    ],
  });
});

test("add-only supports D/ST ids and rejects invalid or conflicting ids", () => {
  assert.deepEqual(waiverTransaction(ctx, auth, { addPlayerId: -16001 }).items,
    [{ playerId: -16001, type: "ADD", toTeamId: 10 }]);
  assert.throws(() => waiverTransaction(ctx, auth, { addPlayerId: 1, dropPlayerId: 1 }), /same player/);
  for (const id of [0, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => waiverTransaction(ctx, auth, { addPlayerId: id }), /player id/);
    assert.throws(() => waiverTransaction(ctx, auth, { addPlayerId: 1, dropPlayerId: id }), /player id/);
  }
});

test("acquisitions dry run by default; explicit submission uses authenticated POST and reports errors", async (t) => {
  const calls: RequestInit[] = [];
  let fail = false;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123/transactions/");
    calls.push(init);
    return fail ? new Response("Player is locked", { status: 400 }) : Response.json({ id: "test-acquisition" });
  });
  assert.equal((await acquirePlayer(ctx, pickup, auth)).sent, false);
  assert.equal((await acquirePlayer(ctx, pickup, auth, { dryRun: true })).sent, false);
  assert.equal(calls.length, 0);
  const result = await acquirePlayer(ctx, pickup, auth, { dryRun: false });
  assert.equal(result.sent, true);
  assert.deepEqual(result.response, { id: "test-acquisition" });
  assert.ok(calls[0]);
  assert.equal(calls[0].method, "POST");
  assert.equal(new Headers(calls[0].headers).get("Cookie"), "SWID={test-owner}; espn_s2=test-cookie");
  assert.deepEqual(JSON.parse(String(calls[0].body)), waiverTransaction(ctx, auth, pickup));
  fail = true;
  await assert.rejects(acquirePlayer(ctx, pickup, auth, { dryRun: false }), /ESPN 400.*Player is locked/);
});

test("FAAB claim matches the capture and preserves a zero-dollar bid", () => {
  assert.deepEqual(waiverTransaction(ctx, auth, {
    type: "WAIVER", addPlayerId: 4241457, dropPlayerId: 5081397, bidAmount: 0,
  }), {
    isLeagueManager: false, teamId: 10, type: "WAIVER", memberId: auth.swid,
    scoringPeriodId: 1, executionType: "EXECUTE",
    items: [
      { playerId: 4241457, type: "ADD", toTeamId: 10 },
      { playerId: 5081397, type: "DROP", fromTeamId: 10 },
    ],
    bidAmount: 0,
  });
});

test("FAAB claims support add-only and reject malformed bids or acquisition types", () => {
  const claim = waiverTransaction(ctx, auth, { type: "WAIVER", addPlayerId: -16001, bidAmount: 12 });
  assert.equal(claim.bidAmount, 12);
  assert.deepEqual(claim.items, [{ playerId: -16001, type: "ADD", toTeamId: 10 }]);
  for (const bidAmount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, "5", null]) {
    assert.throws(() => waiverTransaction(ctx, auth, {
      type: "WAIVER", addPlayerId: 1, bidAmount: bidAmount as number,
    }), /waiver bid/);
  }
  assert.throws(() => waiverTransaction(ctx, auth, {
    ...pickup, bidAmount: 1,
  } as unknown as Parameters<typeof waiverTransaction>[2]), /FAAB bids require/);
  assert.throws(() => waiverTransaction(ctx, auth, {
    ...pickup, type: "WAIVERS",
  } as unknown as Parameters<typeof waiverTransaction>[2]), /unsupported acquisition type/);
});

test("FAAB submission stays dry by default and sends the bid only on explicit execution", async (t) => {
  let writes = 0;
  const claim = { ...pickup, type: "WAIVER" as const, bidAmount: 0 };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    writes++;
    assert.deepEqual(JSON.parse(String(init.body)), waiverTransaction(ctx, auth, claim));
    return Response.json({ id: "queued-claim" });
  });
  const preview = await acquirePlayer(ctx, claim, auth);
  assert.equal(preview.sent, false);
  assert.equal(preview.body.bidAmount, 0);
  assert.equal(writes, 0);
  assert.equal((await acquirePlayer(ctx, claim, auth, { dryRun: false })).sent, true);
  assert.equal(writes, 1);
  await assert.rejects(acquirePlayer(ctx, { ...claim, bidAmount: -1 }, auth, { dryRun: false }), /waiver bid/);
  assert.equal(writes, 1);
});

test("waiver cancellation matches captured envelope without items or bid", () => {
  assert.deepEqual(cancelWaiverTransaction(ctx, auth, "test-claim-id"), {
    isLeagueManager: false, teamId: 10, type: "WAIVER", memberId: auth.swid,
    scoringPeriodId: 1, executionType: "CANCEL", relatedTransactionId: "test-claim-id",
  });
  for (const id of ["", "   "]) {
    assert.throws(() => cancelWaiverTransaction(ctx, auth, id), /transaction id/);
  }
});

test("waiver cancellation defaults to dry run and propagates ESPN rejection", async (t) => {
  let writes = 0;
  let fail = false;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    writes++;
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), cancelWaiverTransaction(ctx, auth, "test-claim-id"));
    return fail ? new Response("Claim already processed", { status: 400 }) : Response.json({ id: "test-claim-id" });
  });
  assert.equal((await cancelWaiver(ctx, "test-claim-id", auth)).sent, false);
  assert.equal(writes, 0);
  assert.equal((await cancelWaiver(ctx, "test-claim-id", auth, { dryRun: false })).sent, true);
  assert.equal(writes, 1);
  fail = true;
  await assert.rejects(cancelWaiver(ctx, "test-claim-id", auth, { dryRun: false }), /ESPN 400.*Claim already processed/);
  await assert.rejects(cancelWaiver(ctx, "", auth, { dryRun: false }), /transaction id/);
  assert.equal(writes, 2);
});

test("trade offers append optional drops after the trade items, as captured in trade_drop_curl.txt", () => {
  const offer = { partnerTeamId: 14, give: [3043078], get: [4432665, 4241457], drop: [-16001], expiresAt: new Date("2026-10-14T00:00:00Z") };
  const body = tradeTransaction(ctx, auth, offer);
  assert.equal(body.type, "TRADE_PROPOSAL");
  assert.deepEqual(body.items, [
    { playerId: 4432665, type: "TRADE", fromTeamId: 14, toTeamId: 10 },
    { playerId: 4241457, type: "TRADE", fromTeamId: 14, toTeamId: 10 },
    { playerId: 3043078, type: "TRADE", fromTeamId: 10, toTeamId: 14 },
    { playerId: -16001, type: "DROP", fromTeamId: 10 },
  ]);
  assert.deepEqual(tradeTransaction(ctx, auth, { ...offer, drop: undefined }).items, body.items.slice(0, 3));
  assert.throws(() => tradeTransaction(ctx, auth, { ...offer, drop: [3043078] }), /appears twice/);
  assert.throws(() => tradeTransaction(ctx, auth, { ...offer, drop: [4432665] }), /appears twice/);
});
