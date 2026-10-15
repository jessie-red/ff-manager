/**
 * FantasyCalc trade values (fantasycalc.com): a market price per player,
 * derived from the trades people actually make in real leagues rather than
 * from projections. Browser-safe half: the shape of a value table and how to
 * read a player out of it. The fetcher lives in client.ts (node only).
 *
 * These are a different currency from everything else here. The ratings and
 * the tier values are points over replacement; a FantasyCalc value is an
 * arbitrary market scale (~10,000 for the consensus #1) with no unit. They're
 * shown side by side, never added: the projection says who helps your lineup,
 * the market says what a manager will actually part with.
 */
import { nameKey } from "../sleeper/client.js";

/** One player's market price. */
export interface FcValue {
  /** Market value, ~0-10000. Redraft (isDynasty=false), so it's a rest-of-this-season price. */
  value: number;
  overallRank: number;
  positionRank: number;
  /** Change in value over the last 30 days; the trend arrows read this. */
  trend30Day: number;
}

/** A fetched table plus what it was fetched for; `byEspnId` is keyed by the same ids Player.id carries. */
export interface FcValues {
  /** League shape the values were priced for, echoed back for the footnote. */
  params: { numTeams: number; numQbs: number; ppr: number };
  /** When we fetched it (ISO); FantasyCalc republishes continuously. */
  fetched: string;
  /** ESPN player id -> value. Every player FantasyCalc lists carries an espnId, so this is the primary index. */
  byEspnId: Record<number, FcValue>;
  /** `${pos}:${normalized name}` -> value, the fallback when an id doesn't line up. */
  byName: Record<string, FcValue>;
}

/** Same normalization the other name-matched sources use (see sleeper/client.ts). */
export function fcKey(pos: string, name: string): string {
  return `${pos}:${nameKey(name)}`;
}

/** A player's market value, by ESPN id then by name; undefined when FantasyCalc doesn't list them (it stops around 200 deep, and carries no K or D/ST). */
export function lookupFc(values: FcValues | null | undefined, p: { id: number; name: string; pos: string }): FcValue | undefined {
  if (!values) return undefined;
  return values.byEspnId[p.id] ?? values.byName[fcKey(p.pos, p.name)];
}

/** Market value as a plain number, 0 when unlisted: what the trade totals sum. */
export function fcPoints(values: FcValues | null | undefined, p: { id: number; name: string; pos: string }): number {
  return lookupFc(values, p)?.value ?? 0;
}
