/**
 * Writes to ESPN's fantasy API (lineup changes, trade proposals and player acquisitions). Internal use only: this is the undocumented endpoint the ESPN web
 * client POSTs to, authenticated with the same SWID / espn_s2 cookies the
 * read client uses. A bad payload can really move or drop players, so every
 * submit defaults to a dry run that returns the body without sending it.
 *
 * Captured 2026-09-07 from the web client (a bench <-> starter swap):
 *   POST https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}/transactions/
 *   headers: Content-Type: application/json, X-Fantasy-Source: kona, X-Fantasy-Platform: espn-fantasy-web
 *   body: {"isLeagueManager":false,"teamId":9,"type":"ROSTER","memberId":"{SWID}","scoringPeriodId":1,
 *          "executionType":"EXECUTE","items":[{"playerId":..,"type":"LINEUP","fromLineupSlotId":20,"toLineupSlotId":23}, ...]}
 *
 * Captured 2026-09-08 from the web client (a 2-for-2 trade offer): same URL and
 * headers, and the same envelope with type TRADE_PROPOSAL, one TRADE item per
 * player naming which team it leaves and which it joins, plus two fields the
 * ROSTER payload doesn't carry:
 *   body: {..., "type":"TRADE_PROPOSAL", "teamId":9,
 *          "items":[{"playerId":4432665,"type":"TRADE","fromTeamId":14,"toTeamId":9},
 *                   {"playerId":3043078,"type":"TRADE","fromTeamId":9,"toTeamId":14}, ...],
 *          "expirationDate":"2026-09-10T03:15:12.892Z","comment":"I would offer MHJ or Tate"}
 *
 * Captured 2026-10-13 in trade_drop_curl.txt (a 2-for-1 with a drop): ESPN 409s
 * "Too many players on roster" when an offer would overfill the proposer's
 * roster, counting its other pending trades, so the offer names who to release.
 * Each drop is the same DROP item a FREEAGENT pickup uses, after the TRADE items:
 *   "items":[...TRADE items..., {"playerId":4362619,"type":"DROP","fromTeamId":6}]
 * The web client also sends "comment":"" for an empty note; omitting it works too.
 *
 * Read 2026-10-14 from ESPN's public kona client (acceptTrade in the commons
 * main bundle): accepting is its own TRADE_ACCEPT transaction from the
 * accepting team naming the offer as relatedTransactionId, executionType
 * EXECUTE, and no items unless it releases players to make room, as DROP items:
 *   body: {..., "type":"TRADE_ACCEPT", "teamId":6, "executionType":"EXECUTE",
 *          "relatedTransactionId":"{offer id}", "items":[{"playerId":..,"type":"DROP","fromTeamId":6}]}
 * Its client asks for drops when ESPN answers TRAN_ROSTER_LIMIT_EXCEEDED_*
 * (including the _TRADE_RESERVED_* variants, which count other pending trades).
 */
import type { EspnAuth } from "./client.js";
import type { EspnRosterEntry } from "./types.js";
import { BENCH_SLOT } from "./constants.js";

const WRITE_BASE = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl";

export interface LineupItem {
  playerId: number;
  type: "LINEUP";
  fromLineupSlotId: number;
  toLineupSlotId: number;
}

/** Captured FREEAGENT / WAIVER items: ADD names only the destination; DROP only the source. */
export type RosterMoveItem =
  | { playerId: number; type: "ADD"; toTeamId: number }
  | { playerId: number; type: "DROP"; fromTeamId: number };

/** One player changing hands in a TRADE_PROPOSAL: the ESPN ids of both fantasy teams. */
export interface TradeItem {
  playerId: number;
  type: "TRADE";
  fromTeamId: number;
  toTeamId: number;
}

export interface Transaction {
  isLeagueManager: boolean;
  teamId: number;
  type: "ROSTER" | "FREEAGENT" | "WAIVER" | "TRADE_PROPOSAL";
  /** The submitting member's SWID, braces included. */
  memberId: string;
  scoringPeriodId: number;
  executionType: "EXECUTE" | "CANCEL";
  /** Original offer/claim being acted upon. */
  relatedTransactionId?: string;
  items: (LineupItem | RosterMoveItem | TradeItem)[];
  bidAmount?: number;
  /** TRADE_PROPOSAL only: ISO-8601 UTC instant the offer lapses. */
  expirationDate?: string;
  /** TRADE_PROPOSAL only: the note shown to the other manager. */
  comment?: string;
}

/** Waiver cancellation omits items and bidAmount, as captured from ESPN. */
export type WaiverCancellationTransaction = Omit<Transaction,
  "type" | "executionType" | "relatedTransactionId" | "items" | "bidAmount"
> & {
  type: "WAIVER";
  executionType: "CANCEL";
  relatedTransactionId: string;
};

/** Trade acceptance carries items only for drops, as ESPN's acceptTrade builds it. */
export type TradeAcceptTransaction = Omit<Transaction, "type" | "executionType" | "relatedTransactionId" | "items" | "bidAmount" | "expirationDate" | "comment"> & {
  type: "TRADE_ACCEPT";
  executionType: "EXECUTE";
  relatedTransactionId: string;
  items?: RosterMoveItem[];
};

type TransactionBody = Transaction | WaiverCancellationTransaction | TradeAcceptTransaction;

export interface SubmitOptions {
  /** Default true: return the payload without sending it. Pass false to actually POST. */
  dryRun?: boolean;
}

export interface SubmitResult<T extends TransactionBody = Transaction> {
  sent: boolean;
  url: string;
  body: T;
  /** Parsed JSON response when sent; ESPN echoes the transaction with an id and status. */
  response?: unknown;
}

/** ESPN refused a write. `body` is the whole response (usually JSON {messages, details:[{type, resolution}]}). */
export class EspnWriteError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, type: string, teamId: number) {
    super(`ESPN ${status} submitting ${type} for team ${teamId}: ${body.slice(0, 300)}`);
    this.name = "EspnWriteError";
    this.status = status;
    this.body = body;
  }
}

export interface TransactionContext {
  leagueId: number;
  season: number;
  teamId: number;
  scoringPeriodId: number;
}

/** A single player move: where they are now and where they should go. */
export interface LineupMove {
  playerId: number;
  from: number;
  to: number;
}

export function lineupTransaction(ctx: TransactionContext, auth: EspnAuth, moves: LineupMove[]): Transaction {
  return {
    isLeagueManager: false,
    teamId: ctx.teamId,
    type: "ROSTER",
    memberId: auth.swid,
    scoringPeriodId: ctx.scoringPeriodId,
    executionType: "EXECUTE",
    items: moves.map((m) => ({ playerId: m.playerId, type: "LINEUP", fromLineupSlotId: m.from, toLineupSlotId: m.to })),
  };
}

/** Verified in ESPN's public kona client cancelTrade implementation (2026-09-10).
 * Cancellation POSTs a TRADE_PROPOSAL with CANCEL and the original offer id;
 * it does not resend the trade items or delete a transaction resource.
 */
export function cancelTradeTransaction(ctx: TransactionContext, auth: EspnAuth, transactionId: string): Transaction {
  return {
    isLeagueManager: false, teamId: ctx.teamId, memberId: auth.swid,
    scoringPeriodId: ctx.scoringPeriodId, type: "TRADE_PROPOSAL",
    executionType: "CANCEL", relatedTransactionId: transactionId, items: [],
  };
}

/** Accept another manager's offer `transactionId`, releasing `drop` from my roster if it goes through. */
export function acceptTradeTransaction(
  ctx: TransactionContext, auth: EspnAuth, transactionId: string, drop: number[] = [],
): TradeAcceptTransaction {
  if (typeof transactionId !== "string" || !transactionId.trim()) throw new Error("trade acceptance requires a transaction id");
  for (const id of drop) if (!Number.isSafeInteger(id) || id === 0) throw new Error("player id must be a nonzero safe integer");
  if (new Set(drop).size !== drop.length) throw new Error("a player appears twice in the drops");
  const body: TradeAcceptTransaction = {
    isLeagueManager: false, teamId: ctx.teamId, type: "TRADE_ACCEPT", memberId: auth.swid,
    scoringPeriodId: ctx.scoringPeriodId, executionType: "EXECUTE", relatedTransactionId: transactionId,
  };
  if (drop.length) body.items = drop.map((playerId) => ({ playerId, type: "DROP", fromTeamId: ctx.teamId }));
  return body;
}

/**
 * Moves needed to turn the current roster into a target lineup. `target` maps
 * player id -> lineup slot id for every player whose slot should change;
 * players not mentioned stay put. Throws if a target slot is over-filled or a
 * player isn't on the roster. Slot eligibility is not checked here; ESPN will
 * reject an ineligible move and the response says why.
 */
export function diffLineup(roster: EspnRosterEntry[], target: Map<number, number>): LineupMove[] {
  const current = new Map(roster.map((e) => [e.playerId, e.lineupSlotId]));
  const moves: LineupMove[] = [];
  for (const [playerId, to] of target) {
    const from = current.get(playerId);
    if (from === undefined) throw new Error(`player ${playerId} is not on this roster`);
    if (from !== to) moves.push({ playerId, from, to });
  }
  // Sanity check that the resulting slot occupancy doesn't exceed what's there now.
  const before = countSlots([...current.values()]);
  const after = new Map(current);
  for (const m of moves) after.set(m.playerId, m.to);
  const afterCounts = countSlots([...after.values()]);
  for (const [slot, n] of afterCounts) {
    if (slot === BENCH_SLOT) continue;
    if (n > (before.get(slot) ?? 0)) throw new Error(`slot ${slot} would hold ${n} players but only has ${before.get(slot) ?? 0} spots filled today`);
  }
  return moves;
}

function countSlots(slots: number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of slots) out.set(s, (out.get(s) ?? 0) + 1);
  return out;
}

export async function submitTransaction<T extends TransactionBody>(
  ctx: Pick<TransactionContext, "leagueId" | "season">,
  body: T,
  auth: EspnAuth,
  { dryRun = true }: SubmitOptions = {},
): Promise<SubmitResult<T>> {
  const url = `${WRITE_BASE}/seasons/${ctx.season}/segments/0/leagues/${ctx.leagueId}/transactions/`;
  if (dryRun) return { sent: false, url, body };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: `SWID=${auth.swid}; espn_s2=${auth.espnS2}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Fantasy-Source": "kona",
      "X-Fantasy-Platform": "espn-fantasy-web",
      Origin: "https://fantasy.espn.com",
      Referer: "https://fantasy.espn.com/",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new EspnWriteError(res.status, text, body.type, body.teamId);
  let response: unknown = text;
  try {
    response = JSON.parse(text);
  } catch {
    /* ESPN sometimes returns an empty body on success */
  }
  return { sent: true, url, body, response };
}

/** Convenience: diff, build, and (optionally) submit a lineup change. */
export async function setLineup(
  ctx: TransactionContext,
  roster: EspnRosterEntry[],
  target: Map<number, number>,
  auth: EspnAuth,
  opts: SubmitOptions = {},
): Promise<SubmitResult | undefined> {
  const moves = diffLineup(roster, target);
  if (!moves.length) return undefined;
  return submitTransaction(ctx, lineupTransaction(ctx, auth, moves), auth, opts);
}

/** An offer from `ctx.teamId` to one other team, in the terms model/trade.ts already speaks. */
export interface TradeOffer {
  /** ESPN team id of the manager being offered the trade. */
  partnerTeamId: number;
  /** Player ids leaving my team for theirs. */
  give: number[];
  /** Player ids coming back from them. */
  get: number[];
  /** Player ids I release if the trade goes through, to make room for an uneven one. */
  drop?: number[];
  /** When the offer lapses. Default 24 hours out, which is what the web client sends. */
  expiresAt?: Date;
  /** The note shown to the other manager. Omitted when empty. */
  comment?: string;
}

/**
 * A TRADE_PROPOSAL for `offer`. Every player becomes one TRADE item saying
 * which team it leaves and which it joins; the web client lists the incoming
 * players first, and that ordering is preserved here in case ESPN cares.
 * Roster legality (position limits, locked players, the league's trade
 * deadline) isn't checked -- ESPN rejects the POST and the response says why.
 */
export function tradeTransaction(ctx: TransactionContext, auth: EspnAuth, offer: TradeOffer): Transaction {
  if (offer.partnerTeamId === ctx.teamId) throw new Error(`cannot trade with yourself (team ${ctx.teamId})`);
  if (!offer.give.length && !offer.get.length) throw new Error("trade offer has no players on either side");
  const drop = offer.drop ?? [];
  const dupes = [...offer.give, ...offer.get, ...drop].filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length) throw new Error(`player ${dupes[0]} appears twice in the same trade`);

  const incoming: TradeItem[] = offer.get.map((playerId) => ({
    playerId,
    type: "TRADE",
    fromTeamId: offer.partnerTeamId,
    toTeamId: ctx.teamId,
  }));
  const outgoing: TradeItem[] = offer.give.map((playerId) => ({
    playerId,
    type: "TRADE",
    fromTeamId: ctx.teamId,
    toTeamId: offer.partnerTeamId,
  }));
  const drops: RosterMoveItem[] = drop.map((playerId) => ({ playerId, type: "DROP", fromTeamId: ctx.teamId }));

  const body: Transaction = {
    isLeagueManager: false,
    teamId: ctx.teamId,
    type: "TRADE_PROPOSAL",
    memberId: auth.swid,
    scoringPeriodId: ctx.scoringPeriodId,
    executionType: "EXECUTE",
    items: [...incoming, ...outgoing, ...drops],
    expirationDate: (offer.expiresAt ?? new Date(Date.now() + DEFAULT_TRADE_TTL_MS)).toISOString(),
  };
  if (offer.comment) body.comment = offer.comment;
  return body;
}

/** The web client's default offer window: 24 hours. */
const DEFAULT_TRADE_TTL_MS = 24 * 60 * 60 * 1000;

/** Convenience: build and (optionally) send a trade offer. Dry run unless `dryRun: false`. */
export async function proposeTrade(
  ctx: TransactionContext,
  offer: TradeOffer,
  auth: EspnAuth,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  return submitTransaction(ctx, tradeTransaction(ctx, auth, offer), auth, opts);
}

/** A pickup with an optional drop. Existing callers default to immediate free agency. */
export type WaiverAcquisition = {
  addPlayerId: number;
  dropPlayerId?: number;
} & (
  | { type?: "FREEAGENT"; bidAmount?: never }
  | { type: "WAIVER"; bidAmount: number }
);

/**
 * Captured 2026-09-12 in waiver_curl.txt and waiver_faab_curl.txt.
 * FREEAGENT executes immediately; WAIVER queues a claim with an explicit FAAB
 * bid (including zero). ESPN validates availability, budget, roster limits,
 * ownership and game locks when submitted.
 */
export function waiverTransaction(
  ctx: TransactionContext,
  auth: EspnAuth,
  acquisition: WaiverAcquisition,
): Transaction {
  const { addPlayerId, dropPlayerId } = acquisition;
  const type = acquisition.type ?? "FREEAGENT";
  if (type !== "FREEAGENT" && type !== "WAIVER") throw new Error("unsupported acquisition type");
  if (type === "WAIVER") {
    if (!Number.isSafeInteger(acquisition.bidAmount) || acquisition.bidAmount! < 0) {
      throw new Error("waiver bid must be a nonnegative safe integer");
    }
  } else if (acquisition.bidAmount !== undefined) {
    throw new Error("FAAB bids require a WAIVER transaction");
  }
  // ESPN D/ST player ids can be negative.
  for (const id of [addPlayerId, ...(dropPlayerId === undefined ? [] : [dropPlayerId])]) {
    if (!Number.isSafeInteger(id) || id === 0) throw new Error("player id must be a nonzero safe integer");
  }
  if (addPlayerId === dropPlayerId) throw new Error("cannot add and drop the same player");
  const items: RosterMoveItem[] = [{ playerId: addPlayerId, type: "ADD", toTeamId: ctx.teamId }];
  if (dropPlayerId !== undefined) items.push({ playerId: dropPlayerId, type: "DROP", fromTeamId: ctx.teamId });
  return {
    isLeagueManager: false,
    teamId: ctx.teamId,
    type,
    memberId: auth.swid,
    scoringPeriodId: ctx.scoringPeriodId,
    executionType: "EXECUTE",
    items,
    ...(type === "WAIVER" ? { bidAmount: acquisition.bidAmount } : {}),
  };
}

/** Build and optionally submit a free-agent pickup or FAAB waiver claim. Dry run by default. */
export async function acquirePlayer(
  ctx: TransactionContext,
  acquisition: WaiverAcquisition,
  auth: EspnAuth,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  return submitTransaction(ctx, waiverTransaction(ctx, auth, acquisition), auth, opts);
}

/** Captured in waiver_cancel_curl.txt: cancel by id, without items or a bid. */
export function cancelWaiverTransaction(
  ctx: TransactionContext,
  auth: EspnAuth,
  transactionId: string,
): WaiverCancellationTransaction {
  if (typeof transactionId !== "string" || !transactionId.trim()) {
    throw new Error("waiver cancellation requires a transaction id");
  }
  return {
    isLeagueManager: false,
    teamId: ctx.teamId,
    type: "WAIVER",
    memberId: auth.swid,
    scoringPeriodId: ctx.scoringPeriodId,
    executionType: "CANCEL",
    relatedTransactionId: transactionId,
  };
}

/** Cancel an existing waiver claim. Dry run unless explicitly disabled. */
export async function cancelWaiver(
  ctx: TransactionContext,
  transactionId: string,
  auth: EspnAuth,
  opts: SubmitOptions = {},
): Promise<SubmitResult<WaiverCancellationTransaction>> {
  return submitTransaction(ctx, cancelWaiverTransaction(ctx, auth, transactionId), auth, opts);
}
