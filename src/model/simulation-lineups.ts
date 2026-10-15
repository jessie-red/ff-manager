/** Integration boundary for the rating/trade pages; no ESPN settings are guessed. */
import type { Player } from './player.js';
import { optimalLineup } from './lineup.js';
import { blendedProjection } from './schedule.js';
import type { SimulationPlayer, SimulationScenario } from './simulation.js';
import type { UncertaintyPosition } from './uncertainty.js';

/** Build a scenario from a proposed roster state. Empty slots score zero.
 * Requires explicit projections for ALL requested weeks, including playoff weeks.
 * Known availability should be encoded as zero by the supplied projection callback.
 */
export function prepareSimulationLineups(name: string, rosters: Map<number, Player[]>,
  slots: Map<number, number>, weeks: number[],
  projection: (p: Player, week: number) => number = (p, w) => {
    if (p.espnByWeek[w] === undefined && p.sleeper?.byWeek[w] === undefined) {
      throw new Error(`Missing projection for ${p.name}, week ${w}; supply an explicit forecast or zero`);
    }
    return blendedProjection(p, w);
  }): { players: SimulationPlayer[]; scenario: SimulationScenario } {
  const players: SimulationPlayer[] = [];
  const scenario: SimulationScenario = { name, lineups: {} };
  const seen = new Set<number>();
  for (const [team, roster] of rosters) {
    for (const p of roster) {
      if (seen.has(p.id)) throw new Error(`Player ${p.id} appears on multiple rosters`);
      seen.add(p.id);
      const position = p.pos === 'D/ST' ? 'DEF' : p.pos;
      if (!['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(position)) throw new Error(`Unsupported position: ${position}`);
      players.push({ id: p.id, position: position as UncertaintyPosition,
        projections: Object.fromEntries(weeks.map(w => [w, projection(p, w)])) });
    }
    scenario.lineups[team] = Object.fromEntries(weeks.map(w => {
      const points = (p: Player) => players.find(x => x.id === p.id)!.projections[w]!;
      const lineup = optimalLineup([...roster].sort((a, b) => a.id - b.id), slots, { value: points, points });
      return [w, lineup.starters.flatMap(s => s.player ? [s.player.id] : [])];
    }));
  }
  return { players, scenario };
}
