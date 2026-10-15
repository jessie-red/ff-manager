import { championshipFormat, championshipSchedule, runChampionship } from "./championship.js";
import { prepareSimulationLineups } from "../model/simulation-lineups.js";
import type { SeasonSimulationInput, SimulationResult } from "../model/simulation.js";
import { fetchLiveMatchup } from "./dashboard.js";
import { fetchLiveScores } from "./scores.js";
/**
 * HTTP-agnostic handlers for the web GUI. Wired into the Vite dev server by
 * vite.config.ts; small enough to drop into any Node server later.
 */
import {
  authFromEnv,
  fetchByeWeeks,
  fetchLeague,
  fetchMyTeams,
  fetchPlayerPool,
  fetchPlayers,
  fetchWeeklyProjections,
  type MyTeam,
} from "../espn/client.js";
import type { EspnLeague } from "../espn/types.js";
import {
  acceptTradeTransaction, cancelTradeTransaction, EspnWriteError, lineupTransaction, submitTransaction, tradeTransaction,
  type TradeAcceptTransaction, type Transaction,
} from "../espn/transactions.js";
import { rosterAssignments, sameLineup, validateLineup, type LineupAssignment } from "../model/management.js";
import { canAcceptTrade, canCancelTrade, describePending, pendingForTeam, type PendingTransaction } from "../model/pending.js";
import { unplayedWeeks } from "../model/schedule.js";
import { buildValuation, rateLeague, type TeamRating } from "../model/rate.js";
import { analyzeAuction, type AuctionAnalysis } from "../model/auction.js";
import { analyzeDraft, type DraftAnalysis, type DraftInput } from "../model/draft.js";
import { buildAid, draftStatus, type AidData, type DraftStatus } from "../model/aid.js";
import { startingSlots, toPlayer, type Player } from "../model/player.js";
import { fetchTiers, type Tiers } from "../tiers/fftiers.js";
import { fetchDraftTiers } from "../tiers/draft.js";
import { loadVorp, type VorpBaseline, type VorpTable } from "../tiers/vorp.js";
import { fetchSleeperProjections, type ScoringSource } from "../sleeper/client.js";
import { fetchFantasyCalc } from "../fantasycalc/client.js";
import type { FcValues } from "../fantasycalc/values.js";
import { leagueCurves, type CurveSource } from "../nflverse/index.js";
import type { Valuation } from "../model/value.js";
import type { RosValuation } from "../model/ros.js";

export interface RateResponse {
  league: { id: number; name: string; season: number; currentWeek: number };
  week: number;
  /** How Sleeper stat lines were scored, or null if Sleeper failed / was disabled. */
  sleeper: { scoring: ScoringSource } | null;
  sleeperError: string | null;
  /** Why projected records are missing, when ESPN's per-week projections couldn't be fetched. */
  projectedError: string | null;
  /** Tier values, replacement ranks and historical curves behind every value (see model/value.ts). */
  valuation: Valuation;
  /**
   * The rest-of-season replacement levels every value is measured against
   * (see model/ros.ts), or null when no per-week projections loaded and the
   * ratings fell back to `valuation`. Per-player projections ride along on each
   * player as `Player.ros`, so `byPlayer` isn't repeated here.
   */
  ros: Omit<RosValuation, "byPlayer"> | null;
  /** How history was scored, or null when nflverse data couldn't be loaded (values fall back to linear). */
  curves: { source: CurveSource } | null;
  curvesError: string | null;
  /** Which Boris Chen tier lists were used, or null (with `tiersError`) when they couldn't be loaded and values fall back to rank. */
  tiers: TierInfo | null;
  tiersError: string | null;
  /**
   * FantasyCalc's market trade values for this league's shape (see
   * src/fantasycalc/values.ts), or null with `fantasycalcError`. A second
   * opinion for the trade views only: it prices what managers will actually
   * give up, in its own unit, and never feeds the ratings.
   */
  fantasycalc: FcValues | null;
  fantasycalcError: string | null;
  /**
   * Everything the trade calculator needs to re-run the same championship
   * simulation against a hypothetical roster: standings, remaining matchups,
   * playoff rules, the scoring weeks that were forecast and the league's
   * starting slots. Null whenever the rating's own run didn't happen, in which
   * case each rating's `championshipError` says why. Also null when the caller
   * explicitly skips championship work with championship=0 (trade suggestions).
   */
  championship: ChampionshipSetup | null;
  ratings: TeamRating[];
}

/**
 * The league half of a simulation input: the parts that read ESPN's settings
 * and results, and so stay on the server. The client pairs it with rosters it
 * already holds (see POST /api/trade-odds).
 */
export interface ChampionshipSetup {
  teams: SeasonSimulationInput["teams"];
  regularSeason: SeasonSimulationInput["regularSeason"];
  playoffs: SeasonSimulationInput["playoffs"];
  /** Every scoring week the ratings carry per-week projections for. */
  weeks: number[];
  /** ESPN lineup slot id -> starters required. */
  slots: Record<number, number>;
  format: SeasonSimulationInput["format"];
}

export interface TierInfo {
  scoring: Tiers["scoring"];
  /** When Boris last published the lists (ISO time). */
  updated: string;
  /**
   * Which tiers these are: "weekly" is Boris's live per-position lists, which
   * are the matchup-driven ranks for the current week; "draft" is the
   * draft-time consensus rebuilt in tiers/draft.ts. The draft views want the
   * latter — grading a pick against this week's start/sit ranks would be a
   * different question than the one they ask.
   */
  source: "weekly" | "draft";
}

/** Boris tiers plus the VORP table they're valued with; the caller records the error and goes without. */
async function loadTiers(league: EspnLeague, baseline: VorpBaseline = "waiver"): Promise<Loaded> {
  const [tiers, vorp] = await Promise.all([fetchTiers(league), loadVorp(league, baseline)]);
  return { tiers, vorp, source: "weekly" };
}

/** The same, from the draft-time consensus instead: what the draft analysis and the aid are asking about. */
async function loadDraftTiers(league: EspnLeague, baseline: VorpBaseline = "waiver"): Promise<Loaded> {
  const [draft, vorp] = await Promise.all([fetchDraftTiers(league), loadVorp(league, baseline)]);
  return { tiers: draft.tiers, vorp, source: "draft" };
}

interface Loaded {
  tiers: Tiers;
  vorp: VorpTable;
  source: TierInfo["source"];
}

/**
 * ESPN's stock logo packs are public, but custom uploads on mystique-api need
 * the login cookies, so those are rewritten to go through our /api/logo proxy.
 */
const CUSTOM_LOGO = /^https:\/\/mystique-api\.fantasy\.espn\.com\/apis\/v1\/domains\/lm\/images\/([0-9a-f-]+)$/;
const LOGO_ID = /^[0-9a-f-]{1,64}$/;

function publicLogoUrl(raw: string | undefined): string | undefined {
  const m = raw?.match(CUSTOM_LOGO);
  return m ? `/api/logo/${m[1]}` : raw;
}

export async function fetchLogo(id: string): Promise<{ type: string; body: ArrayBuffer }> {
  if (!LOGO_ID.test(id)) throw new Error("bad logo id");
  const auth = authFromEnv();
  const res = await fetch(`https://mystique-api.fantasy.espn.com/apis/v1/domains/lm/images/${id}`, {
    headers: { Cookie: `SWID=${auth.swid}; espn_s2=${auth.espnS2}` },
  });
  if (!res.ok) throw new Error(`logo ${id}: ESPN ${res.status}`);
  return { type: res.headers.get("content-type") ?? "application/octet-stream", body: await res.arrayBuffer() };
}

export type LeaguesResponse = MyTeam[];

export async function leagues(): Promise<LeaguesResponse> {
  const mine = await fetchMyTeams(authFromEnv());
  return mine.map((m) => ({ ...m, logo: publicLogoUrl(m.logo) }));
}

export interface DefaultsResponse {
  leagueId: number | null;
  season: number;
}

export function defaults(): DefaultsResponse {
  return {
    leagueId: process.env.LEAGUE_ID ? Number(process.env.LEAGUE_ID) : null,
    season: Number(process.env.SEASON ?? new Date().getFullYear()),
  };
}

function leagueParams(params: URLSearchParams): { leagueId: number; season: number } {
  const leagueId = Number(params.get("league"));
  const season = Number(params.get("season") ?? defaults().season);
  if (!Number.isInteger(leagueId) || leagueId <= 0) throw new Error("league must be a positive integer");
  if (!Number.isInteger(season)) throw new Error("season must be a year");
  return { leagueId, season };
}

export async function rate(params: URLSearchParams): Promise<RateResponse> {
  const { leagueId, season } = leagueParams(params);
  const auth = authFromEnv();
  const league = await fetchLeague(leagueId, season, auth);
  const currentWeek = Math.max(1, league.scoringPeriodId);
  const week = params.get("week") ? Number(params.get("week")) : currentWeek;
  // Trade suggestions need player values, but never consume championship odds.
  const includeChampionship = params.get("championship") !== "0";

  // Sleeper is a bonus source: a failure there degrades to ESPN-only rather than a 500.
  let championshipError: string | null = null;
  let schedule: ReturnType<typeof championshipSchedule> | undefined;
  if (includeChampionship) {
    try { schedule = championshipSchedule(league); } catch (e) { championshipError = String(e instanceof Error ? e.message : e); }
  }
  const weeks = [...new Set([...unplayedWeeks(league), ...(schedule?.weeks ?? [])])];
  const playerIds = league.teams.flatMap((t) => (t.roster?.entries ?? []).map((e) => e.playerId));
  let sleeperError: string | null = null;
  let projectedError: string | null = null;
  let curvesError: string | null = null;
  let tiersError: string | null = null;
  let fantasycalcError: string | null = null;
  const [sleeper, weekly, hist, tiers, fantasycalc] = await Promise.all([
    params.get("sleeper") === "0"
      ? undefined
      : fetchSleeperProjections(league, week, Math.min(week, ...weeks)).catch((e: unknown) => {
          sleeperError = e instanceof Error ? e.message : String(e);
          return undefined;
        }),
    fetchWeeklyProjections(league, playerIds, weeks, auth).catch((e: unknown) => {
      projectedError = e instanceof Error ? e.message : String(e);
      return undefined;
    }),
    leagueCurves(league).catch((e: unknown) => {
      curvesError = e instanceof Error ? e.message : String(e);
      return null;
    }),
    loadTiers(league).catch((e: unknown) => {
      tiersError = e instanceof Error ? e.message : String(e);
      return undefined;
    }),
    fetchFantasyCalc(league).catch((e: unknown) => {
      fantasycalcError = e instanceof Error ? e.message : String(e);
      return null;
    }),
  ]);

  const rated = rateLeague(league, week, auth.swid, sleeper, hist?.curves ?? null, weekly, tiers);
  let setup: ChampionshipSetup | null = null;
  try {
    if (schedule) {
      const rosters = new Map(rated.ratings.map(t => [t.teamId, [...t.ros.starters.flatMap(s => s.player ? [s.player] : []), ...t.ros.bench]]));
      const prepared = prepareSimulationLineups('current', rosters, startingSlots(league), schedule.weeks);
      setup = { ...schedule, slots: Object.fromEntries(startingSlots(league)), format: championshipFormat(league) };
      const result = await runChampionship({ ...schedule, players: prepared.players, scenarios: [prepared.scenario], format: setup.format });
      for (const t of rated.ratings) {
        const sim = result.scenarios[0]!.teams.find(s => s.id === t.teamId)!;
        t.championshipOdds = sim.championshipOdds;
        t.simulatedRecord = { wins: sim.wins, losses: sim.losses, ties: sim.ties };
      }
    }
  } catch (e) { championshipError = e instanceof Error ? e.message : String(e); setup = null; }
  for (const t of rated.ratings) if (championshipError) t.championshipError = championshipError;
  return {
    league: { id: league.id, name: league.settings.name, season: league.seasonId, currentWeek },
    week,
    sleeper: sleeper ? { scoring: sleeper.scoring } : null,
    sleeperError,
    projectedError,
    valuation: rated.valuation,
    ros: rated.ros ? { weeks: rated.ros.weeks, replacement: rated.ros.replacement, replacementRank: rated.ros.replacementRank } : null,
    curves: hist ? { source: hist.source } : null,
    curvesError,
    tiers: tiers ? { scoring: tiers.tiers.scoring, updated: tiers.tiers.updated, source: tiers.source } : null,
    tiersError,
    fantasycalc,
    fantasycalcError,
    championship: setup,
    ratings: rated.ratings.map((t) => ({ ...t, logo: publicLogoUrl(t.logo) })),
  };
}

/**
 * A championship simulation over rosters the caller composed. The calculator
 * builds both scenarios from the ratings it already has, so a trade re-runs the
 * Monte Carlo without refetching ESPN; the paired run is what makes the
 * before/after difference meaningful (see src/simulation/README.md).
 */
export interface TradeOddsRequest {
  input: SeasonSimulationInput;
  /** Fixed path count. Omitted, the engine sizes for its default 0.5pp worst case. */
  simulations?: number;
  seed?: number;
}
export interface TradeOddsResponse {
  result: SimulationResult;
}

export async function tradeOdds(req: TradeOddsRequest, signal?: AbortSignal): Promise<TradeOddsResponse> {
  if (!req?.input?.scenarios?.length) throw new Error("a simulation input with at least one scenario is required");
  if (req.simulations !== undefined && (!Number.isInteger(req.simulations) || req.simulations < 1000 || req.simulations > 1_000_000))
    throw new Error("simulations must be between 1,000 and 1,000,000");
  return {
    result: await runChampionship(req.input, {
      seed: req.seed ?? 42,
      ...(req.simulations === undefined ? {} : { simulations: req.simulations }),
    }, signal),
  };
}

export interface DraftResponse {
  league: { id: number; name: string; season: number };
  /** Null (with `draftError`) when the league hasn't drafted yet. */
  draft: DraftAnalysis | AuctionAnalysis | null;
  draftError: string | null;
  sleeper: { scoring: ScoringSource } | null;
  sleeperError: string | null;
  curves: { source: CurveSource } | null;
  curvesError: string | null;
  tiers: TierInfo | null;
  tiersError: string | null;
  /** Bye weeks couldn't be loaded; cells show no BYE. */
  byeError: string | null;
  valuation: Valuation;
}

/**
 * Grade every pick of the league's draft against what was still available
 * (see model/draft.ts). Rankings and projections are today's, so this is a
 * hindsight grade, not a judgement of what was knowable on draft day.
 */
export async function draft(params: URLSearchParams): Promise<DraftResponse> {
  const { leagueId, season } = leagueParams(params);
  const auth = authFromEnv();
  const league = await fetchLeague(leagueId, season, auth, ["mTeam", "mSettings", "mDraftDetail"]);
  const info = { id: league.id, name: league.settings.name, season: league.seasonId };
  // Before the draft ESPN lists placeholder picks with playerId -1 (D/ST ids are negative too, so match exactly).
  const picks = league.draftDetail?.drafted ? (league.draftDetail.picks ?? []).filter((p) => p.playerId !== -1) : [];
  const type = league.settings.draftSettings?.type ?? "SNAKE";
  if (!picks.length) {
    return {
      league: info,
      draft: null,
      draftError: league.draftDetail?.inProgress ? "draft in progress" : "this league hasn't drafted yet",
      sleeper: null,
      sleeperError: null,
      curves: null,
      curvesError: null,
      tiers: null,
      tiersError: null,
      byeError: null,
      valuation: { replacement: {}, curves: null, tiers: null },
    };
  }

  const week = Math.max(1, league.scoringPeriodId);
  let sleeperError: string | null = null;
  let curvesError: string | null = null;
  let byeError: string | null = null;
  let tiersError: string | null = null;
  const [players, byes, sleeper, hist, tiers] = await Promise.all([
    fetchPlayers(league, picks.map((p) => p.playerId), auth),
    fetchByeWeeks(league.seasonId, auth).catch((e: unknown) => {
      byeError = e instanceof Error ? e.message : String(e);
      return new Map<number, number>();
    }),
    params.get("sleeper") === "0"
      ? undefined
      : fetchSleeperProjections(league, week, 1).catch((e: unknown) => {
          sleeperError = e instanceof Error ? e.message : String(e);
          return undefined;
        }),
    leagueCurves(league).catch((e: unknown) => {
      curvesError = e instanceof Error ? e.message : String(e);
      return null;
    }),
    loadDraftTiers(league).catch((e: unknown) => {
      tiersError = e instanceof Error ? e.message : String(e);
      return undefined;
    }),
  ]);

  const slots = startingSlots(league);
  const rankType = league.settings.scoringSettings?.playerRankType ?? "PPR";
  const inputs: DraftInput[] = picks.map((pick) => {
    const espn = players.get(pick.playerId);
    const player = espn
      ? toPlayer({ playerId: pick.playerId, lineupSlotId: pick.lineupSlotId, playerPoolEntry: { player: espn } }, league, week, sleeper, undefined, tiers?.tiers)
      : null;
    if (player) player.onIR = false;
    return {
      overall: pick.overallPickNumber,
      round: pick.roundId,
      pickInRound: pick.roundPickNumber,
      teamId: pick.teamId,
      bid: pick.bidAmount,
      keeper: pick.keeper,
      auto: pick.autoDraftTypeId !== 0,
      player,
      bye: espn ? (byes.get(espn.proTeamId) ?? null) : null,
      draftRank: espn?.draftRanksByRankType?.[rankType]?.rank,
    };
  });
  const graded = analyzeDraft(league, inputs, slots, { curves: hist?.curves ?? null, tiers }, auth.swid);
  const analysis = type === "AUCTION" ? analyzeAuction(league, graded, inputs, slots) : graded;
  return {
    league: info,
    draft: { ...analysis, teams: analysis.teams.map((t) => ({ ...t, logo: publicLogoUrl(t.logo) })) },
    draftError: null,
    sleeper: sleeper ? { scoring: sleeper.scoring } : null,
    sleeperError,
    curves: hist ? { source: hist.source } : null,
    curvesError,
    tiers: tiers ? { scoring: tiers.tiers.scoring, updated: tiers.tiers.updated, source: tiers.source } : null,
    tiersError,
    byeError,
    valuation: analysis.valuation,
  };
}

export interface AidResponse extends AidData {
  league: { id: number; name: string; season: number };
  sleeper: { scoring: ScoringSource } | null;
  sleeperError: string | null;
  curves: { source: CurveSource } | null;
  curvesError: string | null;
  tiers: TierInfo | null;
  tiersError: string | null;
  byeError: string | null;
}

/** How many players the aid lists: deep enough for a 14-team, 16-round draft with room to spare. */
export const POOL_SIZE = 500;

/**
 * The draft aid's pool: the top POOL_SIZE players by ESPN draft rank, valued
 * over the waiver wire unfloored (model/aid.ts) and sorted by value, plus the
 * league's teams and its draft so far. The client orders the board by VONA.
 */
export async function aid(params: URLSearchParams): Promise<AidResponse> {
  const { leagueId, season } = leagueParams(params);
  const auth = authFromEnv();
  const league = await fetchLeague(leagueId, season, auth, ["mTeam", "mSettings", "mDraftDetail"]);
  const week = Math.max(1, league.scoringPeriodId);
  let sleeperError: string | null = null;
  let curvesError: string | null = null;
  let byeError: string | null = null;
  let tiersError: string | null = null;
  const [pool, byes, sleeper, hist, tiers] = await Promise.all([
    fetchPlayerPool(league, auth, POOL_SIZE),
    fetchByeWeeks(league.seasonId, auth).catch((e: unknown) => {
      byeError = e instanceof Error ? e.message : String(e);
      return new Map<number, number>();
    }),
    params.get("sleeper") === "0"
      ? undefined
      : fetchSleeperProjections(league, week, 1).catch((e: unknown) => {
          sleeperError = e instanceof Error ? e.message : String(e);
          return undefined;
        }),
    leagueCurves(league).catch((e: unknown) => {
      curvesError = e instanceof Error ? e.message : String(e);
      return null;
    }),
    loadDraftTiers(league).catch((e: unknown) => {
      tiersError = e instanceof Error ? e.message : String(e);
      return undefined;
    }),
  ]);
  const data = buildAid(league, pool, byes, { sleeper, curves: hist?.curves ?? null, tiers }, auth.swid);
  return {
    ...data,
    league: { id: league.id, name: league.settings.name, season: league.seasonId },
    sleeper: sleeper ? { scoring: sleeper.scoring } : null,
    sleeperError,
    curves: hist ? { source: hist.source } : null,
    curvesError,
    tiers: tiers ? { scoring: tiers.tiers.scoring, updated: tiers.tiers.updated, source: tiers.source } : null,
    tiersError,
    byeError,
  };
}

export type PicksResponse = DraftStatus;

export interface RosterResponse {
  league: { id: number; season: number };
  team: { id: number; name: string; logo?: string; isMe: boolean };
  teams?: { id: number; name: string; isMe: boolean }[];
  week: number;
  slots: Record<number, number>;
  players: Player[];
}

function teamRoster(league: EspnLeague, teamId: number, swid: string): RosterResponse {
  const team = league.teams.find((t) => t.id === teamId);
  if (!team) throw new Error(`Team ${teamId} is not in this league.`);
  if (!team.roster) throw new Error("ESPN did not return this team's roster. Try refreshing.");
  const week = Math.max(1, league.scoringPeriodId);
  return {
    league: { id: league.id, season: league.seasonId },
    teams: league.teams.map((t) => ({ id: t.id, name: t.name.trim(),
      isMe: (t.owners ?? []).some((o) => o.toLowerCase() === swid.toLowerCase()) })),
    team: {
      id: team.id, name: team.name.trim(), logo: publicLogoUrl(team.logo),
      isMe: (team.owners ?? []).some((o) => o.toLowerCase() === swid.toLowerCase()),
    },
    week,
    slots: league.settings.rosterSettings.lineupSlotCounts,
    players: team.roster.entries.map((e) => toPlayer(e, league, week)),
  };
}

/** Current ESPN assignments, independent of the ratings' optimized lineups/week. */
export async function roster(params: URLSearchParams): Promise<RosterResponse> {
  const { leagueId, season } = leagueParams(params);
  const teamId = Number(params.get("teamId"));
  if (!Number.isInteger(teamId) || teamId <= 0) throw new Error("teamId must be a team id");
  const auth = authFromEnv();
  return teamRoster(await fetchLeague(leagueId, season, auth, ["mTeam", "mRoster", "mSettings"]), teamId, auth.swid);
}

export interface SaveLineupRequest {
  league: number;
  season: number;
  teamId: number;
  week: number;
  /** Assignments originally loaded, used to reject changes made against stale data. */
  previous: LineupAssignment[];
  assignments: LineupAssignment[];
  /** Only an explicit true submits the transaction. */
  send?: boolean;
}

export interface PendingResponse {
  league: { id: number; season: number };
  team: { id: number; name: string };
  transactions: PendingTransaction[];
  playersError: string | null;
}

/** Open trades and waiver claims for an owned team, as visible to the ESPN login. */
export async function pending(params: URLSearchParams): Promise<PendingResponse> {
  const { leagueId, season } = leagueParams(params);
  const teamId = Number(params.get("teamId"));
  if (!Number.isInteger(teamId) || teamId <= 0) throw new Error("teamId must be a team id");
  const auth = authFromEnv();
  const league = await fetchLeague(leagueId, season, auth, ["mTeam", "mPendingTransactions"]);
  const team = league.teams.find((t) => t.id === teamId);
  if (!team || !(team.owners ?? []).some((o) => o.toLowerCase() === auth.swid.toLowerCase())) {
    throw new Error("Pending transactions are only available for a team you manage.");
  }
  const transactions = pendingForTeam(league, teamId);
  const playerIds = [...new Set(transactions.flatMap((t) => (t.items ?? []).map((i) => i.playerId)))];
  let playersError: string | null = null;
  const players = await fetchPlayers(league, playerIds, auth).catch(() => {
    playersError = "Player details could not be loaded. Requests are shown with player IDs; refresh to try again.";
    return new Map();
  });
  return {
    league: { id: league.id, season: league.seasonId },
    team: { id: team.id, name: team.name.trim() },
    transactions: describePending(transactions, league, teamId, players), playersError,
  };
}

export interface SaveLineupResponse {
  sent: boolean;
  body: Transaction | null;
}

export interface CancelTradeRequest {
  league: number;
  season: number;
  teamId: number;
  transactionId: string;
  send?: boolean;
}

export interface CancelTradeResponse {
  sent: boolean;
  transactionId: string;
}

export async function cancelTrade(req: CancelTradeRequest): Promise<CancelTradeResponse> {
  if (!req || typeof req !== "object") throw new Error("A cancellation request is required.");
  const { leagueId, season } = leagueParams(new URLSearchParams({ league: String(req.league), season: String(req.season) }));
  if (!Number.isInteger(req.teamId) || req.teamId <= 0) throw new Error("teamId must be a team id");
  if (typeof req.transactionId !== "string" || !req.transactionId.trim() || req.transactionId.length > 128) {
    throw new Error("A valid transaction id is required.");
  }
  const auth = authFromEnv();
  const league = await fetchLeague(leagueId, season, auth, ["mTeam", "mPendingTransactions"]);
  const team = league.teams.find((t) => t.id === req.teamId);
  if (!team || !(team.owners ?? []).some((o) => o.toLowerCase() === auth.swid.toLowerCase())) {
    throw new Error("You can only cancel offers from a team you manage.");
  }
  const offer = league.pendingTransactions?.find((t) => t.id === req.transactionId);
  if (!offer || !canCancelTrade(offer, team.id)) {
    throw new Error("This offer is no longer cancellable. Only your unaccepted outgoing offers can be cancelled; refresh the requests.");
  }
  const ctx = { leagueId, season, teamId: team.id, scoringPeriodId: Math.max(1, league.status?.latestScoringPeriod ?? league.scoringPeriodId) };
  const result = await submitTransaction(ctx, cancelTradeTransaction(ctx, auth, offer.id), auth, { dryRun: req.send !== true });
  return { sent: result.sent, transactionId: offer.id };
}

export interface AcceptTradeRequest {
  league: number;
  season: number;
  teamId: number;
  transactionId: string;
  /** My players released if the trade goes through, when taking on more than I send overfills the roster. */
  drop?: number[];
  send?: boolean;
}

export interface AcceptTradeResponse {
  sent: boolean;
  transactionId: string;
  body: TradeAcceptTransaction;
  /** ESPN refused for overfilling my roster (sent is false): pick drops and accept again. */
  rosterLimit?: ProposeResponse["rosterLimit"];
}

/**
 * Accepts another manager's offer to a team I manage. A fresh read rechecks
 * that the offer is still open, unaccepted, proposed by someone else and moves
 * players to or from my team, and that every drop is on my roster and not
 * one I'm sending. Locks, roster limits and the trade deadline are ESPN's to
 * enforce. Dry run unless send === true.
 */
export async function acceptTrade(req: AcceptTradeRequest): Promise<AcceptTradeResponse> {
  if (!req || typeof req !== "object") throw new Error("An accept request is required.");
  const { leagueId, season } = leagueParams(new URLSearchParams({ league: String(req.league), season: String(req.season) }));
  if (!Number.isInteger(req.teamId) || req.teamId <= 0) throw new Error("teamId must be a team id");
  if (typeof req.transactionId !== "string" || !req.transactionId.trim() || req.transactionId.length > 128) {
    throw new Error("A valid transaction id is required.");
  }
  const drop = ids(req.drop ?? [], "drop");
  const auth = authFromEnv();
  const league = await fetchLeague(leagueId, season, auth, ["mTeam", "mRoster", "mPendingTransactions"]);
  const team = league.teams.find((t) => t.id === req.teamId);
  if (!team || !(team.owners ?? []).some((o) => o.toLowerCase() === auth.swid.toLowerCase())) {
    throw new Error("You can only accept offers to a team you manage.");
  }
  const offer = league.pendingTransactions?.find((t) => t.id === req.transactionId);
  if (!offer || !canAcceptTrade(offer, team.id, league.pendingTransactions)) {
    throw new Error("This offer can no longer be accepted. Only open offers from other managers to your team can be accepted; refresh the requests.");
  }
  const roster = new Set((team.roster?.entries ?? []).map((e) => e.playerId));
  const sending = new Set((offer.items ?? []).filter((i) => i.fromTeamId === team.id).map((i) => i.playerId));
  for (const id of drop) {
    if (!roster.has(id)) throw new Error(`player ${id} is not on ${team.name.trim()}'s roster to drop`);
    if (sending.has(id)) throw new Error(`player ${id} is already being traded away; pick someone else to drop`);
  }
  const ctx = { leagueId, season, teamId: team.id, scoringPeriodId: Math.max(1, league.status?.latestScoringPeriod ?? league.scoringPeriodId) };
  const body = acceptTradeTransaction(ctx, auth, offer.id, drop);
  try {
    const result = await submitTransaction(ctx, body, auth, { dryRun: req.send !== true });
    return { sent: result.sent, transactionId: offer.id, body };
  } catch (e) {
    const rosterLimit = rosterLimitOf(e);
    if (!rosterLimit) throw e;
    return { sent: false, transactionId: offer.id, body, rosterLimit };
  }
}

export async function saveLineup(req: SaveLineupRequest): Promise<SaveLineupResponse> {
  if (!req || typeof req !== "object") throw new Error("A lineup request is required.");
  const params = new URLSearchParams({ league: String(req.league), season: String(req.season), teamId: String(req.teamId) });
  const live = await roster(params);
  if (!live.team.isMe) throw new Error("You can only change the lineup of a team you manage.");
  if (req.week !== live.week) throw new Error("The current week has changed. Refresh the roster before saving.");
  if (!sameLineup(req.previous, rosterAssignments(live.players))) {
    throw new Error("Your roster changed on ESPN. Refresh the roster before saving.");
  }
  validateLineup(live.players, live.slots, req.assignments);
  const current = new Map(live.players.map((p) => [p.id, p.lineupSlotId]));
  const moves = req.assignments.filter((p) => current.get(p.playerId) !== p.slotId)
    .map((p) => ({ playerId: p.playerId, from: current.get(p.playerId)!, to: p.slotId }));
  if (!moves.length) return { sent: false, body: null };
  const ctx = { leagueId: live.league.id, season: live.league.season, teamId: live.team.id, scoringPeriodId: live.week };
  const auth = authFromEnv();
  const result = await submitTransaction(ctx, lineupTransaction(ctx, auth, moves), auth, { dryRun: req.send !== true });
  return { sent: result.sent, body: result.body };
}

/** Just the draft so far (one light ESPN call), for the aid to poll during a live draft. */
export async function picks(params: URLSearchParams): Promise<PicksResponse> {
  const { leagueId, season } = leagueParams(params);
  const league = await fetchLeague(leagueId, season, authFromEnv(), ["mDraftDetail"]);
  return draftStatus(league);
}


/**
 * A trade offer from the calculator. `send` is the safety catch: without it
 * this builds and validates the payload but never POSTs, which is what the
 * GUI's preview does before you confirm.
 */
export interface ProposeRequest {
  league: number;
  season?: number;
  /** My team; must be one the configured SWID owns. */
  teamId: number;
  partnerId: number;
  /** Player ids leaving my team, and coming back from the partner. */
  give: number[];
  get: number[];
  /** Player ids from my roster to release if the trade goes through, for an offer that would overfill it. */
  drop?: number[];
  /** How long the offer stands, in days. Default 1, ESPN's own default. */
  days?: number;
  /** The note shown to the other manager. */
  note?: string;
  /** False (default) builds and validates only. */
  send?: boolean;
}

export interface ProposeResponse {
  sent: boolean;
  body: Transaction;
  expiresAt: string;
  /** Player id -> name for everyone in the offer, so the GUI can confirm what it's about to send. */
  names: Record<number, string>;
  response?: unknown;
  /** ESPN refused the offer for overfilling my roster (sent is false): pick drops and send again. */
  rosterLimit?: { message: string; resolution: string };
}

const MAX_TRADE_DAYS = 14;

/** ESPN's 409 TRAN_ROSTER_LIMIT_E, the one refusal drops can fix; undefined for anything else. */
function rosterLimitOf(e: unknown): ProposeResponse["rosterLimit"] {
  if (!(e instanceof EspnWriteError) || e.status !== 409) return undefined;
  try {
    const { details } = JSON.parse(e.body) as { details?: { type?: string; message?: string; resolution?: string }[] };
    // TRAN_ROSTER_LIMIT_E answered offers; ESPN's own client asks for drops on every TRAN_ROSTER_LIMIT_EXCEEDED_* too.
    const d = details?.find((x) => x.type?.startsWith("TRAN_ROSTER_LIMIT_E"));
    return d && { message: d.message ?? "Too many players on roster.", resolution: d.resolution ?? "" };
  } catch {
    return undefined;
  }
}

function ids(v: unknown, field: string): number[] {
  if (!Array.isArray(v)) throw new Error(`${field} must be an array of player ids`);
  return v.map((x) => {
    const n = Number(x);
    // ESPN D/ST player ids are negative.
    if (!Number.isSafeInteger(n) || n === 0) throw new Error(`${field} contains a bad player id: ${String(x)}`);
    return n;
  });
}

/**
 * Validates a trade against the live rosters and (only with `send`) POSTs it to
 * ESPN. The checks here are the ones a typo would trip: that the proposing team
 * is really mine, that the partner is someone else, and that every player is on
 * the roster it's claimed to be leaving, and that drops are mine and not in the
 * trade. Roster limits (which ESPN counts across my other pending trades too),
 * locked players and the trade deadline are ESPN's to enforce, and its
 * rejection says which one bit.
 */
export async function propose(req: ProposeRequest): Promise<ProposeResponse> {
  const leagueId = Number(req.league);
  const season = Number(req.season ?? defaults().season);
  if (!Number.isInteger(leagueId) || leagueId <= 0) throw new Error("league must be a positive integer");
  const teamId = Number(req.teamId);
  const partnerId = Number(req.partnerId);
  if (!Number.isInteger(teamId) || !Number.isInteger(partnerId)) throw new Error("teamId and partnerId must be team ids");
  if (teamId === partnerId) throw new Error("cannot trade with yourself");
  const give = ids(req.give, "give");
  const get = ids(req.get, "get");
  const drop = ids(req.drop ?? [], "drop");
  if (!give.length && !get.length) throw new Error("pick at least one player to trade");
  const days = req.days === undefined ? 1 : Number(req.days);
  if (!(days > 0) || days > MAX_TRADE_DAYS) throw new Error(`days must be between 0 and ${MAX_TRADE_DAYS}`);

  const auth = authFromEnv();
  const league = await fetchLeague(leagueId, season, auth, ["mTeam", "mRoster"]);
  const me = auth.swid.toLowerCase();
  const mine = league.teams.find((t) => t.id === teamId);
  const partner = league.teams.find((t) => t.id === partnerId);
  if (!mine) throw new Error(`team ${teamId} is not in league ${leagueId}`);
  if (!partner) throw new Error(`team ${partnerId} is not in league ${leagueId}`);
  if (!(mine.owners ?? []).some((o) => o.toLowerCase() === me)) {
    throw new Error(`${mine.name.trim()} isn't your team; a trade can only be offered from a team you manage`);
  }

  const rosterOf = (t: typeof mine) => new Map((t.roster?.entries ?? []).map((e) => [e.playerId, e]));
  const mineRoster = rosterOf(mine);
  const partnerRoster = rosterOf(partner);
  for (const id of give) if (!mineRoster.has(id)) throw new Error(`player ${id} is not on ${mine.name.trim()}'s roster`);
  for (const id of get) if (!partnerRoster.has(id)) throw new Error(`player ${id} is not on ${partner.name.trim()}'s roster`);
  for (const id of drop) {
    if (!mineRoster.has(id)) throw new Error(`player ${id} is not on ${mine.name.trim()}'s roster to drop`);
    if (give.includes(id)) throw new Error(`player ${id} is already being traded away; pick someone else to drop`);
  }

  const names: Record<number, string> = {};
  for (const [id, e] of [...mineRoster, ...partnerRoster]) {
    if (give.includes(id) || get.includes(id) || drop.includes(id)) names[id] = e.playerPoolEntry?.player?.fullName ?? `player ${id}`;
  }

  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const ctx = { leagueId, season, teamId, scoringPeriodId: Math.max(1, league.scoringPeriodId) };
  const body = tradeTransaction(ctx, auth, { partnerTeamId: partnerId, give, get, drop, expiresAt, comment: req.note?.trim() || undefined });
  try {
    const result = await submitTransaction(ctx, body, auth, { dryRun: !req.send });
    return { sent: result.sent, body, expiresAt: expiresAt.toISOString(), names, response: result.response };
  } catch (e) {
    const rosterLimit = rosterLimitOf(e);
    if (!rosterLimit) throw e;
    return { sent: false, body, expiresAt: expiresAt.toISOString(), names, rosterLimit };
  }
}

/** Current-week actual points in this league's scoring rules. */
export async function scores(params: URLSearchParams) {
  const { leagueId, season } = leagueParams(params);
  const teamId = Number(params.get("teamId"));
  if (!Number.isInteger(teamId) || teamId <= 0) throw new Error("teamId must be a team id");
  return fetchLiveScores(leagueId, season, teamId, authFromEnv());
}

export async function matchup(params: URLSearchParams) {
  const { leagueId, season } = leagueParams(params);
  const teamId = Number(params.get("teamId"));
  if (!Number.isInteger(teamId) || teamId <= 0) throw new Error("teamId must be a team id");
  return fetchLiveMatchup(leagueId, season, teamId, authFromEnv());
}

/** Fresh ownership and a broad searchable player pool, independent of ratings. */
export async function acquisition(params: URLSearchParams) {
  const { leagueId, season } = leagueParams(params);
  const teamId = Number(params.get("teamId"));
  const auth = authFromEnv();
  const league = await fetchLeague(leagueId, season, auth, ["mTeam", "mRoster", "mSettings"]);
  const mine = league.teams.find(t => t.id === teamId);
  if (!mine || !(mine.owners ?? []).some(o => o.toLowerCase() === auth.swid.toLowerCase())) {
    throw new Error("Select a team you manage.");
  }
  const week = params.has("week") ? Number(params.get("week")) : Math.max(1, league.scoringPeriodId);
  if (!Number.isInteger(week) || week < 1 || week > 18) throw new Error("week must be between 1 and 18");
  let sleeperError: string | null = null;
  const [pool, sleeper] = await Promise.all([
    fetchPlayerPool(league, auth, 10000, week),
    params.get("stats") === "1" ? fetchSleeperProjections(league, week).catch((error: unknown) => {
      sleeperError = error instanceof Error ? error.message : String(error);
      return undefined;
    }) : undefined,
  ]);
  const finite = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const describe = (p: import("../espn/types.js").EspnPlayer, ownerId: number, status: string) => {
    const player = toPlayer({ playerId: p.id, lineupSlotId: 20, playerPoolEntry: { player: p } }, league, week, sleeper);
    const projection = p.stats?.find(s => s.seasonId === season && s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === week);
    return {
      id: p.id, name: p.fullName, positionId: p.defaultPositionId, proTeamId: p.proTeamId,
      ownerId, status, percentOwned: finite(p.ownership?.percentOwned),
      espnProjection: finite(projection?.appliedTotal), sleeperProjection: finite(player.sleeper?.weekProj),
      weekRank: finite(player.weekRank), rosRank: finite(player.rosRank),
    };
  };
  const players = new Map(pool.map(entry => [entry.id, describe(entry.player, entry.onTeamId, entry.status ?? "UNKNOWN")]));
  // Live rosters take precedence, including players outside the ranked pool.
  for (const team of league.teams) for (const entry of team.roster?.entries ?? []) {
    const p = entry.playerPoolEntry.player;
    players.set(p.id, describe(p, team.id, "ONTEAM"));
  }
  return { players: [...players.values()], teams: league.teams.map(t => ({ id: t.id, name: t.name.trim() })),
    week, sleeperError, sleeperScoring: sleeper?.scoring ?? null };
}
export type AcquisitionResponse = Awaited<ReturnType<typeof acquisition>>;

export type AcquireRequest = {
  league: number;
  season: number;
  teamId: number;
  send?: boolean;
} & import("../espn/transactions.js").WaiverAcquisition;

/** Revalidate ownership and availability immediately before submitting a pickup. */
export async function acquire(req: AcquireRequest) {
  if (!req || typeof req !== "object") throw new Error("An acquisition request is required.");
  const { acquirePlayer, waiverTransaction } = await import("../espn/transactions.js");
  const { leagueId, season } = leagueParams(new URLSearchParams({ league: String(req.league), season: String(req.season) }));
  if (!Number.isSafeInteger(req.teamId) || req.teamId <= 0) throw new Error("teamId must be a team id");
  const auth = authFromEnv();
  const league = await fetchLeague(leagueId, season, auth, ["mTeam", "mRoster"]);
  const team = league.teams.find(t => t.id === req.teamId);
  if (!team || !(team.owners ?? []).some(o => o.toLowerCase() === auth.swid.toLowerCase())) {
    throw new Error("You can only add players to a team you manage.");
  }
  const ctx = { leagueId, season, teamId: team.id, scoringPeriodId: Math.max(1, league.status?.latestScoringPeriod ?? league.scoringPeriodId) };
  waiverTransaction(ctx, auth, req);
  if (req.dropPlayerId !== undefined && !team.roster?.entries.some(e => e.playerId === req.dropPlayerId)) {
    throw new Error("The player to drop is no longer on your roster. Refresh availability.");
  }
  if (league.teams.some(t => t.roster?.entries.some(e => e.playerId === req.addPlayerId))) {
    throw new Error("This player is already rostered. Refresh availability.");
  }
  const pool = await fetchPlayerPool(league, auth, 10000);
  const player = pool.find(p => p.id === req.addPlayerId);
  const expectedStatus = req.type === "WAIVER" ? "WAIVERS" : "FREEAGENT";
  if (!player || player.onTeamId !== 0 || player.status !== expectedStatus) {
    throw new Error("This player's availability changed. Refresh availability and try again.");
  }
  const result = await acquirePlayer(ctx, req, auth, { dryRun: req.send !== true });
  return { sent: result.sent };
}
