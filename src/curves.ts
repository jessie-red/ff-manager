/**
 * Print the historical points-by-rank curves a league's values are built on:
 * average points per team-game at each finishing rank over the last ten
 * seasons, scored with the league's rules, plus each rank's share of rank 1.
 */
import { parseArgs } from "node:util";
import pc from "picocolors";
import { authFromEnv, fetchLeague } from "./espn/client.js";
import { startingSlots } from "./model/player.js";
import { replacementRanks } from "./model/value.js";
import { leagueCurves, HISTORY_SEASONS, historySeasons } from "./nflverse/index.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});
try {
  process.loadEnvFile();
} catch {
  /* rely on the environment */
}

const { values: args } = parseArgs({
  options: {
    league: { type: "string", short: "l", default: process.env.LEAGUE_ID },
    season: { type: "string", short: "s", default: process.env.SEASON ?? String(new Date().getFullYear()) },
    depth: { type: "string", short: "d", default: "60" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (args.help || !args.league) {
  console.log(`usage: pnpm curves [--league ID] [--season YYYY] [--depth N] [--json]

  --league, -l   ESPN league id (default: LEAGUE_ID from .env); its scoring rules score the history
  --season, -s   season year; the curves average the ${HISTORY_SEASONS} seasons before it
  --depth,  -d   ranks to print per position (default 60)
  --json         dump the curves as JSON`);
  process.exit(args.help ? 0 : 1);
}

const league = await fetchLeague(Number(args.league), Number(args.season), authFromEnv());
const { curves, source } = await leagueCurves(league);
const replacement = replacementRanks(league, startingSlots(league));

if (args.json) {
  process.stdout.write(JSON.stringify({ seasons: historySeasons(league.seasonId, HISTORY_SEASONS), source, replacement, curves }, null, 2) + "\n");
} else {
  const seasons = historySeasons(league.seasonId, HISTORY_SEASONS);
  console.log(
    pc.bold(league.settings.name) +
      pc.dim(`  ${seasons[0]}-${seasons.at(-1)}, ${source === "league" ? "league scoring" : "ESPN stock scoring"}; pts/team-game at finishing rank, and share of rank 1`),
  );
  const positions = ["QB", "RB", "WR", "TE", "K", "D/ST"].filter((p) => curves[p]);
  const depth = Number(args.depth);
  const cell = (s: string, w: number) => s.padStart(w);
  console.log(cell("rank", 4) + positions.map((p) => cell(replacement[p] ? `${p} repl${replacement[p]}` : p, 14)).join(""));
  for (let r = 1; r <= depth; r++) {
    const cols = positions.map((p) => {
      const c = curves[p]!;
      const v = c[r - 1];
      if (v === undefined) return cell("", 14);
      const share = `${Math.round((100 * v) / c[0]!)}%`;
      const past = replacement[p] !== undefined && r > replacement[p];
      const txt = cell(`${v.toFixed(1)} ${share.padStart(4)}`, 14);
      return past ? pc.dim(txt) : txt;
    });
    console.log(cell(String(r), 4) + cols.join(""));
  }
}
