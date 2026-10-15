import type { AidResponse, DefaultsResponse, DraftResponse, LeaguesResponse, PicksResponse, ProposeRequest, ProposeResponse, RateResponse } from "../../src/server/api.js";
import type { RosterResponse, SaveLineupRequest, SaveLineupResponse } from "../../src/server/api.js";
import type { PendingResponse } from "../../src/server/api.js";
import type { AcceptTradeRequest, AcceptTradeResponse, CancelTradeRequest, CancelTradeResponse } from "../../src/server/api.js";
export type { PendingResponse };
export type { PendingTransaction, PendingPlayer } from "../../src/model/pending.js";
export type { RosterResponse, SaveLineupRequest, SaveLineupResponse };

export type { AidResponse, DefaultsResponse, DraftResponse, LeaguesResponse, PicksResponse, ProposeRequest, ProposeResponse, RateResponse };
export type { AidPick, AidPlayer, AidTeam, DraftStatus } from "../../src/model/aid.js";
export type { DraftAnalysis, DraftPick, DraftPlayer, DraftTeam, Alternative } from "../../src/model/draft.js";
export type { AuctionAnalysis, AuctionPick, AuctionTeam } from "../../src/model/auction.js";
export type { MyTeam } from "../../src/espn/client.js";
export type { TeamRating, PositionScore } from "../../src/model/rate.js";
export type { Lineup, LineupSlot } from "../../src/model/lineup.js";
export type { Player } from "../../src/model/player.js";
export type { ProjectedRecord, ProjectedGame } from "../../src/model/schedule.js";
export type { Valuation } from "../../src/model/value.js";
export type { FcValue, FcValues } from "../../src/fantasycalc/values.js";
export type { RosProjection, RosValuation } from "../../src/model/ros.js";
export type { ChampionshipSetup, TradeOddsRequest, TradeOddsResponse } from "../../src/server/api.js";
export type { Estimate, SimulationResult } from "../../src/model/simulation.js";

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const fetchDefaults = () => get<DefaultsResponse>("/api/defaults");
export const fetchLeagues = () => get<LeaguesResponse>("/api/leagues");

export interface RateQuery {
  league: number;
  season: number;
  week?: number;
  /** Skip championship preparation and simulation for trade suggestions. */
  championship?: 0 | 1;
}
export const fetchRatings = (q: RateQuery) => get<RateResponse>("/api/rate", { ...q });

export interface DraftQuery {
  league: number;
  season: number;
}
export const fetchDraft = (q: DraftQuery) => get<DraftResponse>("/api/draft", { ...q });

export const fetchAid = (q: DraftQuery) => get<AidResponse>("/api/aid", { ...q });
export const fetchPicks = (q: DraftQuery) => get<PicksResponse>("/api/picks", { ...q });

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(new URL(path, location.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Build (and with `send`, submit) a trade offer to ESPN. See src/server/api.ts propose(). */
export const proposeTrade = (req: ProposeRequest) => post<ProposeResponse>("/api/propose", req);

/**
 * Re-run the championship Monte Carlo over rosters composed in the browser.
 * Tens of seconds of CPU on the server worker, so pass a signal: an edited
 * trade should abandon the run in flight rather than race it.
 */
export const tradeOdds = (req: import("../../src/server/api.js").TradeOddsRequest, signal?: AbortSignal) =>
  post<import("../../src/server/api.js").TradeOddsResponse>("/api/trade-odds", req, signal);

export const fetchRoster = (q: DraftQuery & { teamId: number }) => get<RosterResponse>("/api/roster", { ...q });
export const fetchPending = (q: DraftQuery & { teamId: number }) => get<PendingResponse>("/api/pending", { ...q });
export const cancelTrade = (req: CancelTradeRequest) => post<CancelTradeResponse>("/api/cancel-trade", req);
/** Accept another manager's offer (with `send`, for real). See src/server/api.ts acceptTrade(). */
export const acceptTrade = (req: AcceptTradeRequest) => post<AcceptTradeResponse>("/api/accept-trade", req);
export const saveLineup = (req: SaveLineupRequest) => post<SaveLineupResponse>("/api/lineup", req);

export type { ScoresResponse } from "../../src/server/scores.js";
export const fetchScores = (q: DraftQuery & { teamId: number }) =>
  get<import("../../src/server/scores.js").ScoresResponse>("/api/scores", { ...q });

export type { MatchupResponse } from "../../src/server/dashboard.js";
export const fetchMatchup = (q: DraftQuery & { teamId: number }) =>
  get<import("../../src/server/dashboard.js").MatchupResponse>("/api/matchup", { ...q });

export type { AcquisitionResponse } from "../../src/server/api.js";
export const acquirePlayer = (req: import("../../src/server/api.js").AcquireRequest) =>
  post<{ sent: boolean }>("/api/acquire", req);
export const fetchAcquisition = (q: DraftQuery & { teamId: number; week?: number; stats?: number }) =>
  get<import("../../src/server/api.js").AcquisitionResponse>("/api/acquisition", { ...q });
