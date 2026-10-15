import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { loadUncertainty } from '../uncertainty/load.js';
import { simulateSeason, type SeasonSimulationInput } from '../model/simulation.js';
import { simulationFixture, fixtureTrade } from './fixture.js';

const [file, count, seedArg] = process.argv.slice(2);
const input: SeasonSimulationInput = file && file !== '--benchmark' ? JSON.parse(await readFile(file, 'utf8')) : simulationFixture();
if (file === '--benchmark') input.scenarios.push(fixtureTrade(input));
const model = await loadUncertainty();
const start = performance.now();
const result = simulateSeason(model, input, { simulations: count ? Number(count) : 100_000, seed: seedArg ? Number(seedArg) : 42 });
const seconds = (performance.now() - start) / 1000;
console.error(JSON.stringify({ seconds: +seconds.toFixed(3), simulationsPerSecond: Math.round(result.simulations / seconds), players: input.players.length, scenarios: input.scenarios.length }));
console.log(JSON.stringify(result, null, 2));
