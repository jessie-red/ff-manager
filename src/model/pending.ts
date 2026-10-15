import type { EspnLeague, EspnPendingTransaction, EspnPlayer } from "../espn/types.js";
import { POSITION_NAMES, PRO_TEAMS } from "../espn/constants.js";

export interface PendingPlayer {
  id: number;
  name: string;
  pos: string;
  team: string;
}

export interface PendingTransaction {
  id: string;
  kind: "trade" | "waiver";
  /** Trade proposals keep their original direction even once accepted. */
  direction: "incoming" | "outgoing";
  accepted: boolean;
  canCancel: boolean;
  canAccept: boolean;
  partners: string[];
  /** ESPN team ids matching `partners`, in the same order. */
  partnerIds: number[];
  incoming: PendingPlayer[];
  outgoing: PendingPlayer[];
  proposedAt?: number;
  expiresAt?: number;
  processesAt?: number;
  bid?: number;
  order?: number;
  note?: string;
}

const TRADE_TYPES = new Set(["TRADE_PROPOSAL", "TRADE_ACCEPT", "TRADE_ACCEPTED", "TRADE"]);
const CLOSED_STATUSES = new Set(["EXECUTED", "CANCELED", "CANCELLED", "REJECTED", "DECLINED", "EXPIRED", "VETOED", "FAILED"]);

export function canCancelTrade(t: EspnPendingTransaction, teamId: number): boolean {
  return t.type === "TRADE_PROPOSAL" && t.teamId === teamId
    && t.isPending !== false && t.status === "PENDING" && t.acceptedDate === undefined;
}

/**
 * Another manager's open offer that moves players to or from `teamId`. `pending`
 * is the rest of the inbox: an offer this team already answered with a
 * TRADE_ACCEPT is not offered again, in case ESPN still lists it as pending.
 */
export function canAcceptTrade(t: EspnPendingTransaction, teamId: number, pending: EspnPendingTransaction[] = []): boolean {
  return t.type === "TRADE_PROPOSAL" && t.teamId !== teamId
    && t.isPending !== false && t.status === "PENDING" && t.acceptedDate === undefined
    && (t.items ?? []).some((i) => i.type === "TRADE" && (i.fromTeamId === teamId || i.toTeamId === teamId))
    && !pending.some((a) => a.type === "TRADE_ACCEPT" && a.relatedTransactionId === t.id);
}

/** Include offers from other managers and accepted trades still awaiting processing. */
export function pendingForTeam(league: EspnLeague, teamId: number): EspnPendingTransaction[] {
  return (league.pendingTransactions ?? []).filter((t) => {
    if (t.isPending === false || CLOSED_STATUSES.has(t.status ?? "")) return false;
    if (t.type === "WAIVER") return t.teamId === teamId;
    return TRADE_TYPES.has(t.type) && (t.teamId === teamId || (t.items ?? []).some((i) => i.fromTeamId === teamId || i.toTeamId === teamId));
  });
}

export function describePending(
  transactions: EspnPendingTransaction[], league: EspnLeague, teamId: number, players: Map<number, EspnPlayer>,
): PendingTransaction[] {
  const player = (id: number): PendingPlayer => {
    const p = players.get(id);
    return { id, name: p?.fullName ?? `Player ${id}`, pos: p ? POSITION_NAMES[p.defaultPositionId] ?? "" : "", team: p ? PRO_TEAMS[p.proTeamId] ?? "" : "" };
  };
  return transactions.map((t): PendingTransaction => {
    const items = t.items ?? [];
    const trade = TRADE_TYPES.has(t.type);
    const partners = [...new Set(items.flatMap((i) => [i.fromTeamId, i.toTeamId]))].filter((id) => id > 0 && id !== teamId);
    return {
      id: t.id, kind: trade ? "trade" : "waiver", direction: t.teamId === teamId ? "outgoing" : "incoming",
      accepted: trade && (t.type === "TRADE_ACCEPT" || t.type === "TRADE_ACCEPTED" || t.acceptedDate !== undefined),
      canCancel: canCancelTrade(t, teamId), canAccept: canAcceptTrade(t, teamId, transactions),
      partners: partners.map((id) => league.teams.find((team) => team.id === id)?.name.trim() ?? `Team ${id}`), partnerIds: partners,
      incoming: items.filter((i) => trade ? i.toTeamId === teamId : i.type === "ADD").map((i) => player(i.playerId)),
      outgoing: items.filter((i) => trade ? i.fromTeamId === teamId : i.type === "DROP").map((i) => player(i.playerId)),
      proposedAt: t.proposedDate, expiresAt: t.expirationDate, processesAt: t.processDate,
      bid: trade ? undefined : t.bidAmount, order: trade ? undefined : t.subOrder, note: t.comment,
    };
  }).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "trade" ? -1 : 1;
    if (a.kind === "waiver") return (a.order ?? Infinity) - (b.order ?? Infinity) || (a.proposedAt ?? 0) - (b.proposedAt ?? 0);
    return (b.proposedAt ?? 0) - (a.proposedAt ?? 0);
  });
}
