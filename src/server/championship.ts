import { Worker } from 'node:worker_threads';
import type { EspnLeague } from '../espn/types.js';
import type { SeasonSimulationInput, SimulationOptions, SimulationResult } from '../model/simulation.js';
import type { ScoringFormat } from '../model/uncertainty.js';

/** The engine's scoring format, from ESPN's own reception scoring. */
export function championshipFormat(league: EspnLeague): ScoringFormat {
  const receptions = league.settings.scoringSettings?.scoringItems?.find(i => i.statId === 53)?.points ?? 0;
  if (receptions === 1) return 'ppr';
  if (receptions === .5) return 'half';
  if (receptions === 0) return 'standard';
  throw new Error('Unsupported reception scoring for championship simulation.');
}

/** Require ESPN's explicit schedule and supported seeding rules. */
export function championshipSchedule(league: EspnLeague) {
  const s = league.settings.scheduleSettings;
  const count = s?.matchupPeriodCount;
  const field = s?.playoffTeamCount;
  if (!count || !field || field < 2 || field > league.teams.length || !s?.matchupPeriods)
    throw new Error('Playoff field or scoring-period schedule is missing.');
  if (s.playoffSeedingRule !== 'TOTAL_POINTS_SCORED' || (s.divisions?.length ?? 0) > 1)
    throw new Error('Championship simulation requires overall standings with points-for seeding and no divisions.');
  // ESPN football omits this field in live mSettings responses. Its documented
  // default advances the higher seed: https://support.espn.com/hc/en-us/articles/360000067252
  if (s.playoffMatchupTieRule !== undefined && s.playoffMatchupTieRule !== 'HIGHER_SEED')
    throw new Error(`Unsupported playoff matchup tie rule: ${s.playoffMatchupTieRule}.`);
  if (typeof s.playoffReseed !== 'boolean')
    throw new Error('Playoff reseeding setting is missing or unsupported.');
  const rounds = Array.from({ length: Math.ceil(Math.log2(field)) }, (_, i) => s.matchupPeriods![count + i + 1]);
  if (rounds.some(r => !r?.length)) throw new Error('Playoff scoring weeks are missing.');
  const current = Math.max(1, league.scoringPeriodId);
  if (rounds[0]![0]! < current) throw new Error('An already-started playoff bracket is not supported.');
  if (!league.schedule?.length) throw new Error('Regular-season schedule is missing.');
  const teams = league.teams.map(t => ({ id: t.id, wins: 0, losses: 0, ties: 0, pointsFor: 0 }));
  const byId = new Map(teams.map(t => [t.id, t]));
  const regularSeason: SeasonSimulationInput['regularSeason'] = [];
  for (const m of league.schedule.filter(m => m.matchupPeriodId <= count && (!m.playoffTierType || m.playoffTierType === 'NONE') && m.away)) {
    const home = byId.get(m.home.teamId), away = byId.get(m.away!.teamId);
    if (!home || !away) throw new Error('Unknown team in schedule.');
    if (m.winner === 'UNDECIDED') {
      const weeks = s.matchupPeriods[m.matchupPeriodId];
      if (!weeks?.length || weeks.some(w => w < current)) throw new Error('Partially completed or missing matchup weeks are not supported.');
      regularSeason.push({ home: home.id, away: away.id, weeks });
    } else {
      home.pointsFor += m.home.totalPoints; away.pointsFor += m.away!.totalPoints;
      if (m.winner === 'HOME') { home.wins++; away.losses++; }
      else if (m.winner === 'AWAY') { away.wins++; home.losses++; }
      else { home.ties++; away.ties++; }
    }
  }
  return { teams, regularSeason, playoffs: { teams: field, rounds: rounds as number[][], reseed: s.playoffReseed },
    weeks: [...new Set([...regularSeason.flatMap(g => g.weeks), ...rounds.flat() as number[]])].sort((a,b) => a-b) };
}

/** Isolate synchronous Monte Carlo work from the HTTP event loop. A signal
 * stops the worker: an abandoned run is minutes of CPU nobody is waiting for. */
export function runChampionship(input: SeasonSimulationInput,
  options: SimulationOptions = { seed: 42, simulations: 100000 }, signal?: AbortSignal): Promise<SimulationResult> {
  if (signal?.aborted) return Promise.reject(new Error('Championship simulation was abandoned.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { tsImport } = await import('tsx/esm/api');
        const { simulateSeason } = await tsImport(workerData.engine, workerData.base);
        const { loadUncertainty } = await tsImport(workerData.loader, workerData.base);
        parentPort.postMessage(simulateSeason(await loadUncertainty(), workerData.input, workerData.options));
      })().catch(e => { throw e; });
    `, { eval: true, workerData: { input, options, engine: new URL('../model/simulation.ts', import.meta.url).href,
      loader: new URL('../uncertainty/load.ts', import.meta.url).href, base: import.meta.url } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Championship simulation timed out.')); }, 60000);
    const abandon = () => { void worker.terminate(); clearTimeout(timer); reject(new Error('Championship simulation was abandoned.')); };
    signal?.addEventListener('abort', abandon, { once: true });
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abandon); };
    worker.once('message', result => { done(); resolve(result); });
    worker.once('error', error => { done(); reject(error); });
    worker.once('exit', code => { done(); if (code !== 0) reject(new Error(`Simulation worker exited (${code}).`)); });
  });
}
