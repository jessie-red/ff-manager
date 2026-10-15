/** Normalized research records. No mutable roster/injury metadata is used as historical evidence. */
export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
export type Position = typeof POSITIONS[number];
export type OffensePosition = "QB" | "RB" | "WR" | "TE";
export type StatLine = Record<string, number>;
export interface WeeklyRecord {
  season: number;
  week: number;
  playerId: string;
  name: string;
  position: Position;
  team: string | null;
  gameId: string | null;
  projectionGameId: string | null;
  gameMismatch: boolean;
  date: string | null;
  projected: StatLine | null;
  actual: StatLine | null;
  participated: boolean;
  projectionModifiedAt: number | null;
  projectionModifiedAfterGameDate: boolean | null;
}
export interface PreseasonRecord {
  name: string;
  position: OffensePosition;
  team: string;
  page: number;
  projectedGames: number;
  projected: StatLine;
  printedPpr: number;
  printedRank: number;
  playerId: string | null;
  match: "unique-name-position" | "reviewed-alias" | "unmatched";
  actual: StatLine | null;
  activeGames: number | null;
  activeActual: StatLine | null;
}

/** Same observable scoring on BOTH sides; Clay doesn't publish fumbles/2PT/bonuses. */
export function commonPoints(s: StatLine, receptions: number): number {
  return .04 * (s.pass_yd ?? 0) + 4 * (s.pass_td ?? 0) - 2 * (s.pass_int ?? 0)
    + .1 * ((s.rush_yd ?? 0) + (s.rec_yd ?? 0))
    + 6 * ((s.rush_td ?? 0) + (s.rec_td ?? 0)) + receptions * (s.rec ?? 0);
}

export function nameKey(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z0-9]/g, "");
}

/** Parse only the 32 team pages, never the repeated positional/ranking tables. */
export function parseClay(text: string): Omit<PreseasonRecord,
  "playerId" | "match" | "actual" | "activeGames" | "activeActual">[] {
  const pages = text.split("\f");
  if (!/Updated:\s+9\/4\/2025/.test(pages[0] ?? "")) throw new Error("Unexpected Clay edition/date");
  const keys = ["gp", "pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int", "pass_sack",
    "rush_att", "rush_yd", "rush_td", "rec_tgt", "rec", "rec_yd", "rec_td", "printedPpr", "rank"];
  const rows: ReturnType<typeof parseClay> = [];
  const seen = new Set<string>();
  for (let page = 2; page <= 33; page++) {
    const content = pages[page - 1] ?? "";
    const team = content.match(/2025 (.+?) Projections/)?.[1];
    if (!team) throw new Error(`Missing team heading on page ${page}`);
    let count = 0;
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*(QB|RB|WR|TE)\s+(.+?)\s+((?:-?\d+(?:\.\d+)?\s+){15}-?\d+(?:\.\d+)?)(?=\s|$)/);
      if (!match || match[2] === "Total") continue;
      const position = match[1] as OffensePosition, name = match[2]!;
      const nums = match[3]!.trim().split(/\s+/).map(Number);
      const values = Object.fromEntries(keys.map((k, i) => [k, nums[i]!])) as StatLine;
      const { printedPpr, rank, ...projected } = values;
      if (nums.length !== 16 || !(projected.gp! > 0 && projected.gp! <= 17) || !rank || !Number.isFinite(printedPpr)) {
        throw new Error(`Invalid row on page ${page}: ${line}`);
      }
      const key = `${position}:${nameKey(name)}`;
      if (seen.has(key)) throw new Error(`Duplicate preseason player: ${key}`);
      seen.add(key);
      rows.push({ name, position, team, page, projectedGames: projected.gp!, projected,
        printedPpr: printedPpr!, printedRank: rank });
      count++;
    }
    if (count < 8 || count > 25) throw new Error(`Suspicious player count ${count} on page ${page}`);
  }
  return rows;
}
