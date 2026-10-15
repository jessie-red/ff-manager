import type { PlayerGame } from "../../src/espn/games.js";

export function gameLabel(game: PlayerGame | null | undefined): string {
  if (!game) return "Game time unavailable";
  if (game.bye) return "Bye";
  const opponent = game.opponent ? `${game.away ? "@" : "vs"} ${game.opponent} ` : "";
  return opponent + (game.kickoff === null ? "Time TBD" : new Intl.DateTimeFormat(undefined, {
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(game.kickoff).replaceAll(",", ""));
}
