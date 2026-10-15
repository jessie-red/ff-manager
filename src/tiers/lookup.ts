/**
 * Browser-safe half of the tiers module: the `Tiers` shape and how a player
 * is matched to it. fftiers.ts (the fetcher, Node-only) builds these.
 */
import type { EspnPlayer } from "../espn/types.js";
import { POSITION_NAMES } from "../espn/constants.js";
import { nameKey, type Scoring } from "../sleeper/client.js";

export interface Tiers {
  scoring: Scoring;
  /** ISO time of the newest file, from S3's Last-Modified. */
  updated: string;
  /** Tier membership per position: `tiers[pos][t]` is the name keys in tier t+1, in Boris's rank order. */
  tiers: Record<string, string[][]>;
}

/** Boris lists D/STs by full team name ("Houston Texans"); ESPN calls them "Texans D/ST". Key on the nickname. */
export function tierKey(pos: string, name: string): string {
  if (pos === "D/ST") return nameKey(name.replace(/\s*D\/ST$/i, "").split(/\s+/).pop() ?? "");
  return nameKey(name);
}

/** The player's Boris tier (1-based) at their own position, or undefined when untiered. */
export function lookupTier(tiers: Tiers, p: EspnPlayer): number | undefined {
  return lookupTierRank(tiers, p)?.tier;
}

/**
 * The player's Boris tier and overall Boris rank at their own position: rank 1
 * is the first name of tier 1, and tier 2's first name comes right after tier
 * 1's last. Undefined when untiered.
 */
export function lookupTierRank(tiers: Tiers, p: EspnPlayer): { tier: number; rank: number } | undefined {
  const pos = POSITION_NAMES[p.defaultPositionId] ?? "";
  const key = tierKey(pos, p.fullName);
  let before = 0;
  for (const [i, names] of (tiers.tiers[pos] ?? []).entries()) {
    const j = names.indexOf(key);
    if (j >= 0) return { tier: i + 1, rank: before + j + 1 };
    before += names.length;
  }
  return undefined;
}
