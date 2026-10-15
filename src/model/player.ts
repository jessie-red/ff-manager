import { POSITION_NAMES, POSITION_SLOT, PRO_TEAMS, IR_SLOT } from "../espn/constants.js";
import type { EspnLeague, EspnRanking, EspnRosterEntry } from "../espn/types.js";
import type { WeeklyProjections } from "../espn/client.js";
import { lookupSleeper, type SleeperProj, type SleeperProjections } from "../sleeper/client.js";
import { lookupTierRank, type Tiers } from "../tiers/lookup.js";
import type { RosProjection } from "./ros.js";

/** A roster player with the projections we care about already extracted. */
export interface Player {
  id: number;
  name: string;
  pos: string;
  team: string;
  eligibleSlots: number[];
  /** Slot the manager currently has them in. */
  lineupSlotId: number;
  /** ESPN’s current lineup lock, including games already started or finished. */
  lineupLocked?: boolean;
  onIR: boolean;
  injuryStatus: string;
  /** ESPN rest-of-season projection, per game, in league scoring. */
  rosPpg: number;
  /** ESPN projection for the given scoring period, in league scoring. */
  weekProj: number;
  /** ESPN projections by scoring period, for whichever weeks were fetched (always includes `weekProj`'s). */
  espnByWeek: Record<number, number>;
  /** ESPN analysts' consensus rest-of-season rank within the position, or undefined if unranked. */
  rosRank: number | undefined;
  /** Same, for the given scoring period. */
  weekRank: number | undefined;
  /** Boris Chen tier at the position (1 = best), or undefined if untiered / tiers not loaded. */
  tier: number | undefined;
  /** Boris Chen's positional rank (the order names appear across his tier lists), or undefined with `tier`. */
  tierRank: number | undefined;
  /** Sleeper's projections for the same player, or null if unmatched / not loaded. */
  sleeper: SleeperProj | null;
  /**
   * Rest-of-season points, games and value over replacement, from the blended
   * per-week projections; filled in by model/ros.ts annotateRos() once the
   * whole league is known, and undefined when per-week projections weren't
   * loaded (values fall back to the tier table, see value.ts).
   */
  ros?: RosProjection;
}

/**
 * ESPN's consensus row (rankSourceId 0) carries the average of its analysts;
 * when it's missing, average whichever analysts did rank the player.
 * Only rows for the player's own position slot count: a two-way player like
 * Travis Hunter is also ranked among DBs (where he's #1), which must not read
 * as WR1.
 */
function consensusRank(rankings: EspnRanking[] | undefined, rankType: string, slot: number | undefined): number | undefined {
  const ofType = (rankings ?? []).filter((r) => r.rankType === rankType && r.slotId === slot);
  const consensus = ofType.find((r) => r.rankSourceId === 0 && (r.averageRank ?? 0) > 0);
  if (consensus) return consensus.averageRank;
  const ranks = ofType.filter((r) => r.rankSourceId !== 0 && r.rank > 0).map((r) => r.rank);
  return ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : undefined;
}

export function toPlayer(
  entry: EspnRosterEntry,
  league: EspnLeague,
  week: number,
  sleeper?: SleeperProjections,
  weekly?: WeeklyProjections,
  tiers?: Tiers,
): Player {
  const p = entry.playerPoolEntry.player;
  const stats = p.stats ?? [];
  const season = league.seasonId;
  const rankType = league.settings.scoringSettings?.playerRankType ?? "PPR";
  const pos = POSITION_NAMES[p.defaultPositionId] ?? `POS${p.defaultPositionId}`;
  const slot = POSITION_SLOT[pos];

  const seasonProj = stats.find(
    (s) => s.statSourceId === 1 && s.statSplitTypeId === 0 && s.seasonId === season,
  );
  const weekProj = stats.find(
    (s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.seasonId === season && s.scoringPeriodId === week,
  );

  const espnByWeek: Record<number, number> = Object.fromEntries(weekly?.get(p.id) ?? []);
  const boris = tiers ? lookupTierRank(tiers, p) : undefined;
  if (weekProj && espnByWeek[week] === undefined) espnByWeek[week] = weekProj.appliedTotal ?? 0;

  return {
    id: p.id,
    name: p.fullName,
    pos,
    team: PRO_TEAMS[p.proTeamId] ?? `T${p.proTeamId}`,
    eligibleSlots: p.eligibleSlots,
    lineupSlotId: entry.lineupSlotId,
    lineupLocked: entry.playerPoolEntry.lineupLocked ?? false,
    onIR: entry.lineupSlotId === IR_SLOT,
    injuryStatus: p.injuryStatus ?? entry.injuryStatus ?? "ACTIVE",
    rosPpg: seasonProj?.appliedAverage ?? 0,
    weekProj: weekProj?.appliedTotal ?? 0,
    espnByWeek,
    rosRank: consensusRank(p.rankings?.["0"], rankType, slot),
    weekRank: consensusRank(p.rankings?.[String(week)], rankType, slot),
    tier: boris?.tier,
    tierRank: boris?.rank,
    sleeper: (sleeper && lookupSleeper(sleeper, p)) ?? null,
  };
}

/** ESPN injury statuses as the abbreviated tags the injury report uses; anything unexpected keeps its first letter. */
const STATUS_TAGS: Record<string, string> = {
  QUESTIONABLE: "Q",
  DOUBTFUL: "D",
  OUT: "O",
  INJURY_RESERVE: "IR",
  SUSPENSION: "S",
  PROBABLE: "P",
  DAY_TO_DAY: "DTD",
};
export function statusTag(status: string): string {
  return STATUS_TAGS[status] ?? status.charAt(0);
}

/** Scoring slots and how many of each the league starts (bench/IR excluded). */
export function startingSlots(league: EspnLeague): Map<number, number> {
  const out = new Map<number, number>();
  for (const [slot, count] of Object.entries(league.settings.rosterSettings.lineupSlotCounts)) {
    const id = Number(slot);
    if (count > 0 && id !== 20 && id !== IR_SLOT) out.set(id, count);
  }
  return out;
}
