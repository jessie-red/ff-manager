import { parseArgs } from "node:util";
import pc from "picocolors";
import { authFromEnv, fetchLeague, fetchWeeklyProjections } from "./espn/client.js";
import { recordLabel, unplayedWeeks } from "./model/schedule.js";
import { rateLeague, type TeamRating } from "./model/rate.js";
import type { Player } from "./model/player.js";
import type { Lineup, LineupSlot } from "./model/lineup.js";
import { fetchSleeperProjections } from "./sleeper/client.js";
import { rankValue } from "./model/value.js";
import { leagueCurves, HISTORY_SEASONS } from "./nflverse/index.js";
import { fetchTiers } from "./tiers/fftiers.js";
import { loadVorp } from "./tiers/vorp.js";

// Exit quietly when piped into `head` etc.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

try {
  process.loadEnvFile();
} catch {
  /* no .env; rely on the environment */
}

const { values: args } = parseArgs({
  options: {
    league: { type: "string", short: "l", default: process.env.LEAGUE_ID },
    season: { type: "string", short: "s", default: process.env.SEASON ?? String(new Date().getFullYear()) },
    week: { type: "string", short: "w" },
    team: { type: "string", short: "t", multiple: true },
    all: { type: "boolean", short: "a", default: false },
    json: { type: "boolean", default: false },
    "no-sleeper": { type: "boolean", default: false },
    "no-history": { type: "boolean", default: false },
    "no-tiers": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help || !args.league) {
  console.log(`usage: pnpm rate [--league ID] [--season YYYY] [--week N] [--team ABBREV]... [--all] [--json]

  --league, -l   ESPN league id (default: LEAGUE_ID from .env)
  --season, -s   season year (default: SEASON from .env or current year)
  --week,   -w   scoring period for the weekly lineup (default: league's current week)
  --team,   -t   show roster detail for this team abbrev or id (repeatable)
  --all,    -a   show roster detail for every team
  --json         dump ratings as JSON
  --no-sleeper   skip Sleeper projections (ESPN only)
  --no-history   value ranks linearly instead of by historical points-by-rank curves
  --no-tiers     value players by ESPN consensus rank instead of Boris Chen tiers`);
  process.exit(args.help ? 0 : 1);
}

const auth = authFromEnv();
const league = await fetchLeague(Number(args.league), Number(args.season), auth);
const week = args.week ? Number(args.week) : Math.max(1, league.scoringPeriodId);
const weeks = unplayedWeeks(league);
const sleeper = args["no-sleeper"]
  ? undefined
  : await fetchSleeperProjections(league, week, Math.min(week, ...weeks)).catch((e: unknown) => {
      console.error(pc.yellow(`warning: Sleeper projections unavailable (${e instanceof Error ? e.message : e})`));
      return undefined;
    });
const weekly = await fetchWeeklyProjections(
  league,
  league.teams.flatMap((t) => (t.roster?.entries ?? []).map((e) => e.playerId)),
  weeks,
  auth,
).catch((e: unknown) => {
  console.error(pc.yellow(`warning: ESPN weekly projections unavailable, no projected records (${e instanceof Error ? e.message : e})`));
  return undefined;
});
const hist = args["no-history"]
  ? null
  : await leagueCurves(league).catch((e: unknown) => {
      console.error(pc.yellow(`warning: nflverse history unavailable, using linear rank value (${e instanceof Error ? e.message : e})`));
      return null;
    });
const tiers = args["no-tiers"]
  ? undefined
  : await Promise.all([fetchTiers(league), loadVorp(league)])
      .then(([tiers, vorp]) => ({ tiers, vorp }))
      .catch((e: unknown) => {
        console.error(pc.yellow(`warning: Boris Chen tiers unavailable, valuing by rank (${e instanceof Error ? e.message : e})`));
        return undefined;
      });
const { valuation, ros, ratings } = rateLeague(league, week, auth.swid, sleeper, hist?.curves ?? null, weekly, tiers);
const { replacement } = valuation;
if (ratings.every((t) => t.ros.starters.every((s) => s.player === null))) {
  console.error(pc.yellow("warning: every roster is empty. Has this league drafted yet?"));
}
const unmatched = [...new Set(ratings.flatMap((t) => t.sleeperUnmatched))];
if (unmatched.length) console.error(pc.dim(`no Sleeper match for: ${unmatched.join(", ")}`));


// ---------- rendering ----------

const gradeColor = (g: string) =>
  g.startsWith("A") ? pc.green(g) : g.startsWith("B") ? pc.cyan(g) : g.startsWith("C") ? pc.yellow(g) : pc.red(g);

const pad = (s: string, n: number, right = false) => {
  const raw = s.replace(/\x1b\[[0-9;]*m/g, "");
  const fill = " ".repeat(Math.max(0, n - raw.length));
  return right ? fill + s : s + fill;
};
const num = (x: number, d = 1) => x.toFixed(d);
const delta = (x: number) => {
  const s = (x > 0 ? "+" : "") + num(x);
  return Math.abs(x) < 3 ? pc.dim(s) : x > 0 ? pc.green(s) : pc.red(s);
};

/** A summary column: header, width, right-aligned?, and an optional group label shared with neighbours. */
type Col = { h: string; w: number; r?: boolean; group?: string };

function summaryTable(rows: TeamRating[]) {
  const slotNames = rows[0]?.positions.map((p) => p.slot) ?? [];
  const showOwner = rows.some((t) => t.owner !== "");
  const paired = (group: string): Col[] =>
    sleeper && !ros ? [{ h: "ESPN", w: 6, r: true, group }, { h: "Slpr", w: 6, r: true, group }] : [{ h: group, w: 7, r: true }];
  const cols: Col[] = [
    { h: "#", w: 3, r: true }, { h: "Team", w: 26 }, ...(showOwner ? [{ h: "Owner", w: 18 }] : []), { h: "Rec", w: 5 },
    { h: "Proj", w: 5 },
    { h: "Grade", w: 5 }, ...paired(ros ? "ROS ppg" : "ROS pts/wk"), { h: "ESPN", w: 4, r: true },
    ...slotNames.map((s): Col => ({ h: s, w: Math.max(4, s.length) })),
    { h: "Bench", w: 5 },
  ];

  // Group labels sit on a line above, centred over the columns they span.
  if (cols.some((c) => c.group)) {
    let line = "";
    for (let i = 0; i < cols.length; ) {
      const g = cols[i]!.group;
      let span = 1;
      while (g && cols[i + span]?.group === g) span++;
      const width = cols.slice(i, i + span).reduce((a, c) => a + c.w, 0) + 2 * (span - 1);
      const label = g ?? "";
      const left = Math.floor((width - label.length) / 2);
      line += pad(pad("", left) + pc.dim(label), width) + "  ";
      i += span;
    }
    console.log(line.trimEnd());
  }
  const line = cols.map((c) => pad(pc.bold(c.h), c.w, c.r)).join("  ");
  console.log(line);
  console.log(pc.dim("-".repeat(line.replace(/\x1b\[[0-9;]*m/g, "").length)));

  for (const t of rows) {
    const short = t.name.trim().slice(0, 26);
    const cells = [
      pad(String(t.rank), 3, true),
      pad(t.isMe ? pc.bold(pc.magenta(short)) : short, 26),
      ...(showOwner ? [pad(t.owner.slice(0, 18), 18)] : []),
      pad(t.record, 5),
      pad(t.projected ? recordLabel(t.projected) : pc.dim("-"), 5),
      pad(gradeColor(t.grade), 5),
      ...(sleeper && !ros
        ? [pad(num(t.ros.points), 6, true), pad(num(t.sleeperRos!.total), 6, true)]
        : [pad(num(t.ros.points), 7, true)]),
      pad(t.espnProjectedRank ? String(t.espnProjectedRank) : "-", 4, true),
      ...t.positions.map((p) => pad(gradeColor(p.grade), Math.max(4, p.slot.length))),
      pad(gradeColor(t.benchGrade), 5),
    ];
    console.log(cells.join("  "));
  }
}

/** "RB5" for a consensus rank of 5.4; "--" when unranked. */
const rankLabel = (pos: string, rank: number | undefined) => (rank === undefined ? pc.dim("--") : `${pos}${Math.round(rank)}`);
/** "T3" for Boris tier 3; "--" when untiered (blank when tiers aren't loaded). */
const tierLabel = (p: Player | null) => (!tiers ? "" : !p || p.tier === undefined ? pc.dim("--") : `T${p.tier}`);

/** toFixed(0) renders a small negative as "-0"; a bench body one point under replacement reads better as 0. */
const rosNum = (x: number) => (num(x, 0) === "-0" ? "0" : num(x, 0));
/**
 * ROS value, shown only for the rest-of-season lineup and only when ros.ts ran.
 * Starters pass the floored value the lineup was built on, so the column adds
 * up to the total; the bench passes its unfloored value, which is what it's
 * graded on.
 */
const rosCol = (p: Player | null, value: number | undefined) =>
  !ros ? "" : ` ${pad(p?.ros ? rosNum(value ?? p.ros.vorp) : pc.dim("--"), 6, true)}`;

function lineupBlock(
  title: string,
  lu: Lineup,
  ptsLabel: string,
  alt: ((p: Player) => number | undefined) | undefined,
  showTier = true,
  showRos = false,
) {
  const cols = [ "rank", ...(showTier && tiers ? ["tier"] : []), ...(showRos && ros ? ["ROS value"] : []), ptsLabel ].join(", ");
  const label = sleeper && alt !== undefined ? `${cols} | Sleeper` : cols;
  console.log(pc.bold(`  ${title}`) + pc.dim(`  (${label})`));
  const altCol = (s: LineupSlot) => {
    if (!sleeper || alt === undefined) return "";
    const v = s.player ? alt?.(s.player) : undefined;
    return " " + pad(v === undefined ? pc.dim("   --") : delta(v - s.points), 6, true);
  };
  let altTotal = 0;
  for (const s of lu.starters) {
    const p = s.player;
    const inj = p && p.injuryStatus !== "ACTIVE" && p.injuryStatus !== "NORMAL" ? pc.red(` ${p.injuryStatus}`) : "";
    if (p) altTotal += alt?.(p) ?? 0;
    console.log(
      `    ${pad(s.slotName, 5)} ${pad(p ? `${p.name} (${p.team})` : pc.dim("-- empty --"), 30)} ${pad(p ? rankLabel(p.pos, s.rank) : "", 6, true)}${showTier && tiers ? " " + pad(tierLabel(p), 4, true) : ""}${showRos ? rosCol(p, s.value) : ""} ${pad(num(s.points), 6, true)}${altCol(s)}${inj}`,
    );
  }
  const altTot = sleeper && alt !== undefined ? " " + pad(delta(altTotal - lu.points), 6, true) : "";
  console.log(
    `    ${pad("", 5)} ${pad(pc.dim("total"), 30)} ${pad("", 6)}${showTier && tiers ? " " + pad("", 4) : ""}${showRos && ros ? " " + pad(pc.bold(num(lu.total, 0)), 6, true) : ""} ${pad(pc.bold(num(lu.points)), 6, true)}${altTot}`,
  );
}

function teamDetail(t: TeamRating) {
  console.log();
  console.log(
    pc.bold(pc.underline(`${t.rank}. ${t.name}`)) +
      `  ${t.owner ? t.owner + "  " : ""}${t.record}${t.projected ? pc.dim(` (proj ${recordLabel(t.projected)})`) : ""}  grade ${gradeColor(t.grade)}`,
  );
  console.log("  " + [...t.positions.map((p) => `${p.slot} ${gradeColor(p.grade)}`), `Bench ${gradeColor(t.benchGrade)}`].join("   "));
  lineupBlock(
    "Rest-of-season lineup",
    t.ros,
    ros ? "ESPN/Sleeper averaged ppg" : "ESPN proj pts/game",
    ros ? undefined : (p) => p.sleeper?.rosPpg,
    true,
    true,
  );
  lineupBlock(`Week ${week} lineup`, t.week, "ESPN weekly proj", (p) => p.sleeper?.weekProj, false);
  // Sorted the way it's graded: ROS value where that ran, rank value otherwise.
  const value = ros ? (p: Player) => p.ros?.vorp ?? 0 : (p: Player) => rankValue(valuation, p.pos, p.rosRank);
  const bench = t.ros.bench.sort((a, b) => value(b) - value(a) || b.rosPpg - a.rosPpg);
  console.log(
    pc.bold("  Bench") + pc.dim(`  (ROS rank, ${tiers ? "tier, " : ""}${ros ? "ROS value, ROS ppg)" : "ESPN pts/game)"}`),
  );
  for (const p of bench) {
    const flag = p.onIR ? pc.dim(" IR") : p.injuryStatus !== "ACTIVE" && p.injuryStatus !== "NORMAL" ? pc.red(` ${p.injuryStatus}`) : "";
    console.log(
      `    ${pad(p.pos, 5)} ${pad(`${p.name} (${p.team})`, 30)} ${pad(rankLabel(p.pos, p.rosRank), 6, true)}${tiers ? " " + pad(tierLabel(p), 4, true) : ""}${rosCol(p, undefined)} ${pad(num(p.ros?.ppg ?? p.rosPpg), 6, true)}${flag}`,
    );
  }
}

function render() {
  const src = sleeper ? `, Sleeper ${sleeper.scoring === "league" ? "rescored with league rules" : `${sleeper.scoring} preset`}` : "";
  console.log(pc.bold(league.settings.name) + pc.dim(`  season ${league.seasonId}, week ${week}, ${ratings.length} teams${src}`));
  const repl = Object.entries(replacement)
    .map(([pos, r]) => (ros ? `${pos}${ros.replacementRank[pos] ?? r} ${num(ros.replacement[pos] ?? 0)}/wk` : `${pos}${r}`))
    .join(", ");
  const how = hist
    ? `historical pts/game at consensus rank - pts/game at replacement (${HISTORY_SEASONS} seasons, ${hist.source === "league" ? "league scoring" : "ESPN stock scoring"})`
    : "replacement rank + 1 - consensus rank";
  const value = ros
    ? `value = projected points over weeks ${ros.weeks[0]}-${ros.weeks.at(-1)} (${sleeper ? "ESPN/Sleeper average" : "ESPN"}) minus replacement pts/game x games projected`
    : tiers
      ? `value = season VORP averaged over the player's Boris Chen tier (${tiers.tiers.scoring} tiers of ${tiers.tiers.updated.slice(0, 10)})`
      : `value = ${how}`;
  const benchNote = ros ? "bench graded separately by the same value, unfloored" : "bench graded separately by rank value";
  console.log(pc.dim(`rating = starters' value incl. K/D/ST (no grade of their own; ${benchNote}), graded by z-score; ${value}, replacement at ${repl}`));
  if (weekly) console.log(pc.dim(`Proj = record if every unplayed matchup goes to the better optimal lineup by the ${sleeper ? "ESPN/Sleeper average" : "ESPN"} weekly projection`));
  console.log();
  summaryTable(ratings);

  const wanted = new Set((args.team ?? []).map((s) => s.toLowerCase()));
  const detail = args.all
    ? ratings
    : ratings.filter((t) => t.isMe || wanted.has(t.abbrev.toLowerCase()) || wanted.has(String(t.teamId)));
  for (const t of detail) teamDetail(t);
}

if (args.json) {
  // Don't process.exit() here: a large write to a pipe would be truncated.
  process.stdout.write(JSON.stringify(
      { league: league.settings.name, week, valuation, ros: ros && { ...ros, byPlayer: undefined }, ratings },
      null,
      2,
    ) + "\n");
} else {
  render();
}
