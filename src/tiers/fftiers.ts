/**
 * Boris Chen's tiers (borischen.co, github.com/borisachen/fftiers): expert
 * consensus ranks clustered by Gaussian mixture into tiers, so that players
 * whose rankings are statistically indistinguishable sit in the same tier.
 *
 * The site publishes plain-text files to S3, one per position, as
 *   Tier 1: Name, Name, ...
 * with a -PPR or -HALF suffix for the reception-scoring positions (QB, K and
 * D/ST have one file each). Fetched once an hour per scoring format; the last
 * good copy is kept under .cache/fftiers so an S3 hiccup doesn't drop tiers.
 * Node-only (fs); the browser-safe lookup lives in lookup.ts.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { EspnLeague } from "../espn/types.js";
import { leagueScoring, type Scoring } from "../sleeper/client.js";
import { tierKey, type Tiers } from "./lookup.js";

export { lookupTier, tierKey, type Tiers } from "./lookup.js";

const BASE = "https://s3-us-west-1.amazonaws.com/fftiers/out/";
const CACHE = fileURLToPath(new URL("../../.cache/fftiers/", import.meta.url));
const TTL_MS = 60 * 60 * 1000;

/** Positions with tier files, and the file stem each uses. */
const FILES: Record<string, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", "D/ST": "DST" };
/** Positions whose files come in PPR / half-PPR flavours. */
const SCORED = new Set(["RB", "WR", "TE"]);

function fileName(pos: string, scoring: Scoring): string {
  const stem = FILES[pos]!;
  const suffix = SCORED.has(pos) && scoring !== "std" ? `-${scoring.toUpperCase()}` : "";
  return `text_${stem}${suffix}.txt`;
}

function parse(pos: string, text: string): string[][] {
  const tiers: string[][] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^Tier (\d+):\s*(.*)$/);
    if (!m) continue;
    tiers[Number(m[1]) - 1] = m[2]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => tierKey(pos, n));
  }
  return tiers.map((t) => t ?? []);
}

async function fetchFile(name: string): Promise<{ text: string; modified: string }> {
  const path = CACHE + name;
  try {
    const res = await fetch(BASE + name);
    if (!res.ok) throw new Error(`fftiers ${name}: HTTP ${res.status}`);
    const text = await res.text();
    if (!/^Tier 1:/m.test(text)) throw new Error(`fftiers ${name}: unexpected content`);
    const modified = new Date(res.headers.get("last-modified") ?? Date.now()).toISOString();
    await mkdir(CACHE, { recursive: true });
    await writeFile(path, JSON.stringify({ modified, text }));
    return { text, modified };
  } catch (e) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as { text: string; modified: string };
    } catch {
      throw e;
    }
  }
}

const memo = new Map<Scoring, { at: number; p: Promise<Tiers> }>();

/** Tiers for the league's scoring format (ppr / half / std by its reception points), memoized for an hour. */
export function fetchTiers(league: EspnLeague): Promise<Tiers> {
  const scoring = leagueScoring(league);
  const hit = memo.get(scoring);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = (async (): Promise<Tiers> => {
    const tiers: Tiers["tiers"] = {};
    let updated = "";
    await Promise.all(
      Object.keys(FILES).map(async (pos) => {
        const { text, modified } = await fetchFile(fileName(pos, scoring));
        tiers[pos] = parse(pos, text);
        if (modified > updated) updated = modified;
      }),
    );
    return { scoring, updated, tiers };
  })();
  p.catch(() => memo.delete(scoring));
  memo.set(scoring, { at: Date.now(), p });
  return p;
}
