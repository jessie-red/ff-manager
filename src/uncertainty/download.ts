/** Download public research inputs. Existing snapshots are immutable unless explicitly removed. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../data/uncertainty/", import.meta.url));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
interface Source { path: string; url: string; retrievedAt: string; sha256: string; bytes: number }
await mkdir(root + "raw", { recursive: true });
const manifestPath = root + "sources.json";
let sources: Source[] = [];
try { sources = JSON.parse(await readFile(manifestPath, "utf8")); } catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const jobs = [{
  path: "raw/espn-clay-2025.pdf",
  url: "https://g.espncdn.com/s/ffldraftkit/25/NFLDK2025_CS_ClayProjections2025.pdf",
}];
for (const season of [2023, 2024, 2025]) for (let week = 1; week <= 18; week++) {
  for (const kind of ["projections", "stats"]) jobs.push({
    path: `raw/sleeper-${kind}-${season}-${week}.json.gz`,
    url: `https://api.sleeper.app/${kind}/nfl/${season}/${week}?season_type=regular`,
  });
}
// Small batches keep requests well below Sleeper's rate limit; persist after each batch.
for (let i = 0; i < jobs.length; i += 4) {
  await Promise.all(jobs.slice(i, i + 4).map(async ({ path, url }) => {
    const saved = sources.find((s) => s.path === path);
    if (saved) {
      const bytes = await readFile(root + path);
      if (sha256(bytes) !== saved.sha256) throw new Error(`Checksum mismatch: ${path}`);
      return;
    }
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) break;
      if (response.status !== 429 && response.status < 500) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!response?.ok) throw new Error(`${response?.status}: ${url}`);
    const input = Buffer.from(await response.arrayBuffer());
    if (path.endsWith(".gz")) {
      const json = JSON.parse(input.toString());
      if (!Array.isArray(json) || !json.length) throw new Error(`Empty/non-array feed: ${url}`);
    } else if (!input.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Not a PDF");
    const bytes = path.endsWith(".gz") ? gzipSync(input) : input;
    await writeFile(root + path, bytes);
    sources.push({ path, url, retrievedAt: new Date().toISOString(), sha256: sha256(bytes), bytes: bytes.length });
  }));
  sources.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(manifestPath, JSON.stringify(sources, null, 2) + "\n");
  console.log(`Saved/verified ${Math.min(i + 4, jobs.length)}/${jobs.length} source files`);
}
