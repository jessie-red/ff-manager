import type { SeasonSimulationInput } from '../model/simulation.js';
import type { UncertaintyPosition } from '../model/uncertainty.js';

/** Synthetic 12-team league, 14 regular weeks, six-team playoffs in weeks 15–17.
 * Nine starters and six bench players, weekly byes, equal team strength by default.
 */
export function simulationFixture(strength = 0): SeasonSimulationInput {
  const positions: UncertaintyPosition[] = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'WR', 'K', 'DEF', 'RB', 'WR', 'TE', 'QB', 'WR', 'RB'];
  const means = [20, 14, 12, 15, 12, 10, 11, 8, 7, 8, 8, 6, 15, 7, 7];
  const teams = Array.from({ length: 12 }, (_, id) => ({ id, wins: 0, losses: 0, ties: 0, pointsFor: 0 }));
  const players = teams.flatMap(t => positions.map((position, slot) => ({ id: t.id * 100 + slot, position,
    projections: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i + 1, i + 1 === 5 + slot % 8 ? 0 : means[slot]! + (t.id === 0 ? strength : 0)])) })));
  const lineups = Object.fromEntries(teams.map(t => [t.id, Object.fromEntries(Array.from({ length: 17 }, (_, i) => {
    const ids = positions.slice(0, 9).map((_, j) => t.id * 100 + j);
    const used = new Set(ids);
    for (let j = 0; j < ids.length; j++) if (!players.find(p => p.id === ids[j])!.projections[i + 1]) {
      const replacement = players.find(p => Math.floor(p.id / 100) === t.id && p.position === positions[j] && !used.has(p.id) && p.projections[i + 1]! > 0);
      if (replacement) { used.add(replacement.id); ids[j] = replacement.id; }
    }
    return [i + 1, ids];
  }))]));
  let rotation = teams.map(t => t.id);
  const regularSeason = [];
  for (let w = 1; w <= 14; w++) {
    for (let j = 0; j < 6; j++) regularSeason.push({ home: rotation[j]!, away: rotation[11 - j]!, weeks: [w] });
    rotation = [rotation[0]!, rotation[11]!, ...rotation.slice(1, 11)];
  }
  return { players, teams, regularSeason, playoffs: { teams: 6, rounds: [[15], [16], [17]] }, scenarios: [{ name: 'baseline', lineups }], format: 'ppr' };
}

/** Legal WR-for-WR exchange; known bye weeks remain zero in the exchanged projections. */
export function fixtureTrade(input: SeasonSimulationInput) {
  const trade = structuredClone(input.scenarios[0]!);
  trade.name = 'swap starting WRs';
  for (const w of Object.keys(trade.lineups[0]!)) {
    trade.lineups[0]![+w] = trade.lineups[0]![+w]!.map(id => id === 3 ? 104 : id);
    trade.lineups[1]![+w] = trade.lineups[1]![+w]!.map(id => id === 104 ? 3 : id);
  }
  return trade;
}
