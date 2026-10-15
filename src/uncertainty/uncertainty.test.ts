import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { commonPoints, nameKey, parseClay, POSITIONS, type PreseasonRecord, type WeeklyRecord } from "./data.js";
import { empirical, fitWeekly, latentVariance, seasonTotalDistributions } from "./fit.js";
import { loadUncertainty } from "./load.js";
import { samplePlayerUncertainty, samplePlayerWeek, uncertaintyRandom, weeklyCell,
  type UncertaintyFormat, type UncertaintyModel } from "../model/uncertainty.js";

const root = new URL("../../data/uncertainty/", import.meta.url);
const model = await loadUncertainty();
const preseason = JSON.parse(await readFile(new URL("preseason-2025.json", root), "utf8")).players as PreseasonRecord[];
const weekly = (await readFile(new URL("weekly.jsonl", root), "utf8")).trim().split("\n").map(l => JSON.parse(l)) as WeeklyRecord[];
const close = (a: number, b: number, tolerance = 1e-10) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test("Clay parser reads all team pages once and preserves reduced projected game counts", async () => {
  const text = await readFile(new URL("espn-clay-2025.txt", root), "utf8");
  const rows = parseClay(text);
  assert.equal(rows.length, 459);
  assert.equal(new Set(rows.map(p => `${p.position}:${nameKey(p.name)}`)).size, rows.length);
  assert.equal(new Set(rows.map(p => p.page)).size, 32);
  const murray = rows.find(p => p.name === "Kyler Murray")!;
  assert.deepEqual(murray.projected, { gp: 17, pass_att: 552, pass_cmp: 374, pass_yd: 3862,
    pass_td: 23, pass_int: 12, pass_sack: 36, rush_att: 90, rush_yd: 597, rush_td: 5,
    rec_tgt: 0, rec: 0, rec_yd: 0, rec_td: 0 });
  assert.equal(murray.printedPpr, 307);
  assert.equal(rows.find(p => p.name === "Isaiah Likely")!.projectedGames, 15);
  assert.throws(() => parseClay(text.replace("9/4/2025", "9/4/2024")), /edition/);
  assert.throws(() => parseClay(text.replace("2025 Arizona Cardinals Projections", "bad heading")), /heading/);
});

test("every preseason identity matched; absent outcomes remain null, not fabricated zeroes", () => {
  assert.equal(preseason.filter(p => !p.playerId).length, 0);
  assert.equal(preseason.filter(p => p.actual === null).length, 6);
  assert.equal(preseason.find(p => p.name === "Joe Mixon")!.actual, null);
  assert.equal(preseason.find(p => p.name === "Cameron Ward")!.playerId, "12522");
  assert.equal(preseason.find(p => p.name === "Travis Hunter")!.playerId, "12530");
  assert.equal(preseason.find(p => p.name === "Bijan Robinson")!.activeGames, 17);
  for (const p of preseason) {
    // Trades can bypass a bye: Shaheed's records show NO weeks 1–9 and SEA weeks 10–18.
    assert.ok(p.activeGames === null || p.activeGames >= 0 && p.activeGames <= 18);
    assert.equal(p.actual?.pos_rank_ppr, undefined);
  }
});

test("weekly joining excludes wrong games and nonparticipants but retains actual zeroes", () => {
  const fit = fitWeekly(weekly, "ppr");
  assert.equal(fit.exclusions.differentGame, 1);
  assert.ok(fit.exclusions.missingActual! > 0);
  assert.ok(fit.model.TE.pooled.multiplier.samples.includes(0));
  assert.ok(weekly.some(w => w.participated && w.actual && w.actual.pts_ppr === undefined));
  assert.equal(weekly.filter(w => w.gameMismatch).length, 1);
  assert.ok(weekly.filter(w => w.projectionModifiedAfterGameDate).length > 20_000);
  for (const position of POSITIONS) assert.deepEqual(fit.model[position], model.formats.ppr.weekly[position]);
});

test("shared preseason scoring deliberately excludes unprojected fumbles and conversion stats", () => {
  close(commonPoints({ pass_yd: 100, pass_td: 1, pass_int: 1, rec: 2, rec_yd: 10,
    fum_lost: 5, rush_2pt: 2 }, 1), 9);
});

test("empirical draws use exact equally weighted finite outcomes and all fitted means are one", () => {
  assert.equal(empirical([0, 1, 2, 3]).p50, 1);
  assert.throws(() => empirical([]));
  assert.throws(() => empirical([NaN]));
  for (const format of Object.values(model.formats)) for (const position of POSITIONS) {
    const p = format.persistent[position];
    close(p.multiplier.mean, 1);
    close(p.multiplier.variance, p.latentRelativeVariance);
    assert.ok(p.multiplier.samples.every(x => x >= 0));
    if (p.available) {
      close(p.latentRelativeVariance + (1 + p.latentRelativeVariance) * p.weeklyMeanRelativeVariance!,
        p.observedRelativeVariance!);
    }
    for (const c of [format.weekly[position].pooled, ...format.weekly[position].bins]) {
      close(c.multiplier.mean, 1);
      assert.ok(c.multiplier.n >= 100);
      assert.deepEqual(c.multiplier, empirical(c.multiplier.samples));
    }
  }
});

test("latent variance subtracts weekly aggregate variation, including the product interaction", () => {
  close(latentVariance(.25 + 1.25 * .1, .1), .25);
  assert.equal(latentVariance(.01, .1), 0);
  assert.throws(() => latentVariance(-1, 0));
});

test("sparse high-projection bins borrow from the nearest populated band", () => {
  const f = model.formats.ppr;
  assert.equal(weeklyCell(f, "WR", 30), f.weekly.WR.bins.at(-1));
  assert.equal(weeklyCell(f, "WR", .5), f.weekly.WR.bins[0]);
});

test("state is shared across weeks; optional ROS learning shrinks deviations, not means", () => {
  const first = () => 0;
  const full = samplePlayerUncertainty(model, "ppr", "RB", 17, first);
  const short = samplePlayerUncertainty(model, "ppr", "RB", 4, first);
  assert.equal(short.performanceMultiplier, full.performanceMultiplier); // no invented learning by default
  const learning = samplePlayerUncertainty(model, "ppr", "RB", 4, first, .5);
  close(learning.performanceMultiplier - 1, (full.performanceMultiplier - 1) * Math.sqrt(4 / 17));
  assert.equal(samplePlayerUncertainty(model, "ppr", "RB", 0, first).performanceMultiplier, 1);
  assert.equal(samplePlayerUncertainty(model, "ppr", "K", 17, first).performanceMultiplier, 1);
  const before = JSON.stringify(full);
  samplePlayerWeek(model, "ppr", full, 12, uncertaintyRandom(12));
  samplePlayerWeek(model, "ppr", full, 14, uncertaintyRandom(13));
  assert.equal(JSON.stringify(full), before);
});

test("byes and unavailability score zero without consuming randomness; invalid inputs reject", () => {
  const state = { position: "RB" as const, performanceMultiplier: 1 };
  const noDraw = () => { throw new Error("Should not draw"); };
  assert.equal(samplePlayerWeek(model, "ppr", state, 0, noDraw), 0);
  assert.equal(samplePlayerWeek(model, "ppr", state, 12, noDraw, false), 0);
  assert.throws(() => samplePlayerWeek(model, "ppr", state, NaN, noDraw));
  assert.throws(() => samplePlayerWeek(model, "ppr", state, 12, () => 1));
  assert.throws(() => samplePlayerUncertainty(model, "ppr", "RB", 19, noDraw));
  assert.throws(() => samplePlayerUncertainty(model, "ppr", "RB", 10, noDraw, -1));
});

test("Monte Carlo preserves mean and the analytical ROS variance with a persistent player draw", () => {
  const fixture = structuredClone(model);
  const f = fixture.formats.ppr;
  const d = empirical([0, 2]);
  f.weekly.RB = { pooled: { minProjection: 1, maxProjection: null, rawRatioMean: 1, rawBiasPoints: 0, multiplier: d }, bins: [] };
  f.persistent.RB.multiplier = empirical([.5, 1.5]);
  const rng = uncertaintyRandom(12345), totals: number[] = [], n = 4, mu = 10;
  for (let sim = 0; sim < 100_000; sim++) {
    const state = samplePlayerUncertainty(fixture, "ppr", "RB", n, rng);
    let total = 0;
    for (let week = 0; week < n; week++) total += samplePlayerWeek(fixture, "ppr", state, mu, rng);
    totals.push(total);
  }
  const result = empirical(totals);
  close(result.mean, n * mu, .3);
  close(result.variance, mu ** 2 * (n ** 2 * .25 + n * (1 + .25) * 1), 15);
});

test("negative fantasy outcomes survive and seeded simulations reproduce", () => {
  const fixture: UncertaintyModel = structuredClone(model);
  const f: UncertaintyFormat = fixture.formats.ppr;
  f.weekly.DEF.bins = [];
  f.weekly.DEF.pooled.multiplier = empirical([-1, 3]);
  assert.equal(samplePlayerWeek(fixture, "ppr", { position: "DEF", performanceMultiplier: 1 }, 5, () => 0), -5);
  const run = () => {
    const rng = uncertaintyRandom(42);
    const state = samplePlayerUncertainty(model, "ppr", "WR", 10, rng);
    return Array.from({ length: 10 }, () => samplePlayerWeek(model, "ppr", state, 12, rng));
  };
  assert.deepEqual(run(), run());
});

test("descriptive season-total errors include short injured seasons, independently of active-rate exclusions", () => {
  const value = seasonTotalDistributions(preseason) as Record<string, Record<string, { observedOutcomeN: number }>>;
  assert.ok(value.ppr!.RB!.observedOutcomeN > model.formats.ppr.persistent.RB.cohortN);
});
