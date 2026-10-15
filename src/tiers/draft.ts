/**
 * Draft-time tiers, for the draft analysis and the draft aid.
 *
 * fftiers.ts fetches Boris Chen's WEEKLY tiers, which is the wrong yardstick
 * for a draft: by the time you look at the board, text_RB-PPR.txt has been
 * overwritten with this week's matchup-driven ranks. His cron wipes
 * out/current/txt every run and push-to-s3.py flattens whatever survives into
 * one prefix, so the per-position draft tiers he publishes at week 0 are gone
 * within days and there is no per-week archive to recover them from.
 *
 * FantasyPros' draft cheatsheets replace them: still served all season, still
 * the expert consensus Boris himself downloads (his fp_api.py hits the same
 * numbers through their API). Clustered here by gmm.ts, using his k per
 * position, which reconstructs the per-position draft tiers he stopped
 * publishing — and goes deeper than his top-60, which the aid needs since it
 * ranks 500 players.
 *
 * (His frozen pre-draft ALL board is another survivor, but it's
 * cross-position, so it can't value a player on its own; the aid values
 * everyone in one currency itself and doesn't need it.)
 *
 * Node-only (fs); the value side of tiers stays in lookup.ts.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { EspnLeague } from "../espn/types.js";
import { leagueScoring, type Scoring } from "../sleeper/client.js";
import { tierGroups } from "./gmm.js";
import { tierKey, type Tiers } from "./lookup.js";

const FP = "https://www.fantasypros.com/nfl/rankings/";
const CACHE = fileURLToPath(new URL("../../.cache/fpdraft/", import.meta.url));
const TTL_MS = 6 * 60 * 60 * 1000;

/** FantasyPros 404s an unadorned bot; any real UA string is enough. */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Page-name prefix per scoring format; RB/WR/TE come in all three. */
const PREFIX: Record<Scoring, string> = { std: "", ppr: "ppr-", half: "half-point-ppr-" };

/**
 * How Boris tiers each position, from the draw.tiers() calls in his main.R:
 * `head` players deep into `k` tiers. QB, K and D/ST have one set of ranks;
 * the others differ by scoring format.
 */
const SPEC: Record<string, { page: string; head: number; k: number | Record<Scoring, number> }> = {
  QB: { page: "qb", head: 26, k: 8 },
  RB: { page: "rb", head: 40, k: { std: 9, ppr: 10, half: 9 } },
  WR: { page: "wr", head: 60, k: { std: 12, ppr: 12, half: 10 } },
  TE: { page: "te", head: 25, k: { std: 8, ppr: 8, half: 7 } },
  K: { page: "k", head: 20, k: 5 },
  "D/ST": { page: "dst", head: 20, k: 6 },
};
/** Positions whose cheatsheet comes in PPR / half-PPR flavours; QB, K and D/ST don't. */
const SCORED = new Set(["RB", "WR", "TE"]);

/** How much coarser than Boris's own tiers the undrafted tail is cut, and the ceiling on how many tiers it gets. */
const TAIL_COARSENESS = 2;
const MAX_TAIL_TIERS = 12;

/** One row of FantasyPros' expert consensus. */
export interface EcrPlayer {
  name: string;
  pos: string;
  team: string;
  /** Consensus rank: the position it holds on the page. */
  rank: number;
  /** Mean and standard deviation of the experts' ranks. Only the mean is clustered on (see gmm.ts). */
  avg: number;
  sd: number;
}

function pageName(pos: string, scoring: Scoring): string {
  const { page } = SPEC[pos]!;
  return `${SCORED.has(pos) ? PREFIX[scoring] : ""}${page}-cheatsheets`;
}

/**
 * FantasyPros embeds the whole ranking as a JSON literal in a `var ecrData =`
 * assignment; that's what their own table renders from, and what ffpros and
 * fftiers ultimately read.
 */
function parseEcr(html: string): EcrPlayer[] {
  const m = html.match(/var ecrData\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (!m) throw new Error("no ecrData in page");
  const data = JSON.parse(m[1]!) as {
    players: {
      player_name: string;
      player_position_id: string;
      player_team_id: string;
      rank_ecr: number;
      rank_ave: string;
      rank_std: string;
    }[];
  };
  return data.players
    .map((p) => ({
      name: p.player_name,
      pos: p.player_position_id,
      team: p.player_team_id,
      rank: Number(p.rank_ecr),
      avg: Number(p.rank_ave),
      sd: Number(p.rank_std),
    }))
    .filter((p) => Number.isFinite(p.avg))
    .sort((a, b) => a.avg - b.avg);
}

/**
 * Fetch and reduce a URL, keeping the last good result on disk so an upstream
 * hiccup doesn't drop tiers. Only what `reduce` keeps is cached: a cheatsheet
 * page is half a megabyte of HTML wrapped around the one JSON literal that
 * matters.
 */
async function cached<T>(key: string, url: string, reduce: (text: string) => T): Promise<T> {
  const path = CACHE + key;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const value = reduce(await res.text());
    await mkdir(CACHE, { recursive: true });
    await writeFile(path, JSON.stringify(value));
    return value;
  } catch (e) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      throw e;
    }
  }
}

/** The expert consensus draft board for one position, deepest first. */
export async function fetchDraftEcr(pos: string, scoring: Scoring): Promise<EcrPlayer[]> {
  const page = pageName(pos, scoring);
  return cached(`${page}.json`, `${FP}${page}.php`, parseEcr);
}

/**
 * Cluster one position's consensus into tiers: Boris's own k over the top
 * `head` players, then the tail split into tiers of about the same size so
 * that a pick outside his top 60 still lands somewhere. Numbering runs
 * straight through both halves.
 */
export function buildTiers(ecr: EcrPlayer[], pos: string, scoring: Scoring): string[][] {
  const spec = SPEC[pos];
  if (!spec || ecr.length === 0) return [];
  const k = typeof spec.k === "number" ? spec.k : spec.k[scoring];
  const head = Math.min(spec.head, ecr.length);

  const tiers = tierGroups(
    ecr.slice(0, head).map((p) => p.avg),
    k,
  ).map((g) => g.map((i) => tierKey(pos, ecr[i]!.name)));

  const tail = ecr.slice(head);
  if (tail.length) {
    // Past the depth Boris tiers, the consensus thins out: the experts spread
    // further apart and the players are all close to replacement, so real tier
    // breaks are scarce. Cut it about twice as coarsely as the head rather
    // than reading structure into the noise, and cap k so EM isn't asked to
    // fit more components than the tail can support.
    const size = (head / Math.max(1, tiers.length)) * TAIL_COARSENESS;
    const tailK = Math.min(MAX_TAIL_TIERS, Math.max(1, Math.round(tail.length / size)));
    for (const g of tierGroups(
      tail.map((p) => p.avg),
      tailK,
    )) {
      tiers.push(g.map((i) => tierKey(pos, tail[i]!.name)));
    }
  }
  return tiers;
}

export interface DraftTiers {
  /** Per-position draft tiers, the same shape the weekly tiers use, so everything downstream is unchanged. */
  tiers: Tiers;
}

const memo = new Map<Scoring, { at: number; p: Promise<DraftTiers> }>();

/** Draft tiers for the league's scoring format, memoized for six hours (the cheatsheets move slowly). */
export function fetchDraftTiers(league: EspnLeague): Promise<DraftTiers> {
  const scoring = leagueScoring(league);
  const hit = memo.get(scoring);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;

  const p = (async (): Promise<DraftTiers> => {
    const positions = Object.keys(SPEC);
    const ecrs = await Promise.all(positions.map((pos) => fetchDraftEcr(pos, scoring)));

    const tiers: Tiers["tiers"] = {};
    for (const [i, pos] of positions.entries()) tiers[pos] = buildTiers(ecrs[i]!, pos, scoring);

    return { tiers: { scoring, updated: new Date().toISOString(), tiers } };
  })();

  p.catch(() => memo.delete(scoring));
  memo.set(scoring, { at: Date.now(), p });
  return p;
}
