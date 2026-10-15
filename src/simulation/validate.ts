/** Reproducible offline convergence/performance experiment; --full includes 1M paths. */
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { loadUncertainty } from '../uncertainty/load.js';
import { simulateSeason } from '../model/simulation.js';
import { simulationFixture, fixtureTrade } from './fixture.js';

const model = await loadUncertainty();
const input = simulationFixture();
input.scenarios.push(fixtureTrade(input));
const runs = [];
for (const simulations of process.argv.includes('--full') ? [10_000, 100_000, 1_000_000] : [10_000, 100_000]) {
  for (const seed of [42, 7, 2026]) {
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    const r = simulateSeason(model, input, { simulations, seed });
    const before = r.scenarios[0]!.teams[0]!.championshipOdds;
    const after = r.scenarios[1]!.teams[0]!.championshipOdds;
    const delta = r.comparisons[0]!.teams[0]!.championshipOdds;
    const independentSE = Math.hypot(before.standardError, after.standardError);
    const cpu = process.cpuUsage(cpuStart);
    const run = { cpuSeconds: +((cpu.user + cpu.system) / 1e6).toFixed(3), simulations, seed, seconds: +( (performance.now() - start) / 1000).toFixed(3),
      baselineTitle: before.mean, tradeTitle: after.mean, titleDelta: delta.mean, deltaInterval95: delta.interval95,
      pairedSE: delta.standardError, independentSE, varianceReduction: 1 - (delta.standardError / independentSE) ** 2,
      symmetricTitleRange: [Math.min(...r.scenarios[0]!.teams.map(t => t.championshipOdds.mean)), Math.max(...r.scenarios[0]!.teams.map(t => t.championshipOdds.mean))] };
    runs.push(run); console.log(JSON.stringify(run));
    await writeFile(new URL('../../data/uncertainty/simulation-validation.json', import.meta.url), JSON.stringify({
      description: 'Synthetic 12-team PPR league; 180 players, nine weekly starters, 14 regular weeks, six-team fixed playoffs in weeks 15–17. Two paired scenarios. Numerical validation, not historical championship calibration.',
      node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, runs,
    }, null, 2) + '\n');
  }
}
