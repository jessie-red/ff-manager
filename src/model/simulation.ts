/** Pure, browser-safe season Monte Carlo. Inputs describe only FUTURE full weeks. */
import { weeklyCell, type ScoringFormat, type UncertaintyModel, type UncertaintyPosition } from './uncertainty.js';

export interface SimulationPlayer {
  /** Stable identity across scenarios, including players added/removed by a trade. */
  id: number;
  position: UncertaintyPosition;
  /** Explicit zero for bye/unavailable weeks; missing projections are errors. */
  projections: Record<number, number>;
}
export interface SimulationTeam {
  id: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}
export interface SimulationGame { home: number; away: number; weeks: number[] }
export interface SimulationScenario {
  name: string;
  /** team id -> week -> starting player ids. Choose using forecasts, never simulated scores. */
  lineups: Record<number, Record<number, number[]>>;
}
export interface SeasonSimulationInput {
  players: SimulationPlayer[];
  teams: SimulationTeam[];
  regularSeason: SimulationGame[];
  playoffs: {
    teams: number;
    /** One or more scoring weeks per round, in chronological order. */
    rounds: number[][];
    /** Default false: fixed seeded bracket. True: highest remaining seed plays lowest. */
    reseed?: boolean;
  };
  scenarios: SimulationScenario[];
  format: ScoringFormat;
}
export interface SimulationOptions {
  seed?: number;
  /** Fixed sample count; overrides precision-based sample sizing. */
  simulations?: number;
  /** Desired worst-case approximate 95% odds/delta half-width, in probability units. Default .005. */
  targetHalfWidth?: number;
  maxSimulations?: number;
  learningExponent?: number;
}
export interface Estimate { mean: number; standardError: number; interval95: [number, number] }
export interface SimulatedTeam {
  id: number;
  wins: Estimate;
  losses: Estimate;
  ties: Estimate;
  playoffOdds: Estimate;
  championshipOdds: Estimate;
  /** Final regular-season W-L-T -> probability. */
  records: Record<string, number>;
}
export interface SimulationResult {
  simulations: number;
  seed: number;
  targetHalfWidth: number;
  worstCaseOddsHalfWidth: number;
  worstCaseComparisonHalfWidth: number | null;
  precisionReached: boolean;
  scenarios: { name: string; teams: SimulatedTeam[] }[];
  /** Paired differences against the first scenario; probabilities are absolute, not relative. */
  comparisons: { name: string; teams: { id: number; wins: Estimate; playoffOdds: Estimate; championshipOdds: Estimate }[] }[];
}

// Counter-addressed random values: ownership, roster order, scenario order and unused
// players cannot shift a player's draws. Domains separate performance/week/tiebreak draws.
function mix(x: number): number {
  x = Math.imul(x ^ x >>> 16, 0x21f0aaad);
  x = Math.imul(x ^ x >>> 15, 0x735a2d97);
  return (x ^ x >>> 15) >>> 0;
}
function fail(message: string): never { throw new Error(`Season simulation: ${message}`); }
const validId = (n: number) => Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff;
const nonnegative = (n: number) => Number.isFinite(n) && n >= 0;

interface Moments { sum: number; squares: number }
const moments = (): Moments => ({ sum: 0, squares: 0 });
function add(m: Moments, x: number) { m.sum += x; m.squares += x * x; }
function estimate(m: Moments, n: number, probability = false): Estimate {
  const mean = m.sum / n;
  const se = Math.sqrt(Math.max(0, (m.squares - m.sum * mean) / (n - 1)) / n);
  if (!probability) return { mean, standardError: se, interval95: [mean - 1.96 * se, mean + 1.96 * se] };
  // Wilson interval retains uncertainty even with zero observed championships.
  const z2 = 1.96 ** 2, denominator = 1 + z2 / n;
  const center = (mean + z2 / (2 * n)) / denominator;
  const radius = 1.96 * Math.sqrt(mean * (1 - mean) / n + z2 / (4 * n * n)) / denominator;
  return { mean, standardError: se, interval95: [Math.max(0, center - radius), Math.min(1, center + radius)] };
}

interface PlayerDraws {
  key: number;
  scale: number;
  persistent: number[];
  weeks: { offset: number; mean: number; samples: number[]; key: number }[];
}

// Keep numerical loops small and separate from validation/bracket bookkeeping so
// the JavaScript JIT can optimize them consistently, including very long runs.
function sampleScores(draws: PlayerDraws[], pathKey: number, scores: Float64Array) {
  for (let pi = 0; pi < draws.length; pi++) {
    const p = draws[pi]!;
    const playerKey = mix(pathKey ^ p.key);
    const f = 1 + p.scale * (p.persistent[Math.floor(mix(playerKey) / 4294967296 * p.persistent.length)]! - 1);
    for (let wi = 0; wi < p.weeks.length; wi++) {
      const w = p.weeks[wi]!;
      scores[w.offset] = w.mean * f * w.samples[Math.floor(mix(playerKey ^ w.key) / 4294967296 * w.samples.length)]!;
    }
  }
}
function scoreLineups(lineups: number[][], players: Float64Array, teams: Float64Array) {
  for (let i = 0; i < lineups.length; i++) {
    const lineup = lineups[i]!;
    let score = 0;
    for (let j = 0; j < lineup.length; j++) score += players[lineup[j]!]!;
    teams[i] = score;
  }
}

export function simulateSeason(model: UncertaintyModel, input: SeasonSimulationInput,
  options: SimulationOptions = {}): SimulationResult {
  const target = options.targetHalfWidth ?? .005;
  const max = options.maxSimulations ?? 1_000_000;
  const seed = options.seed ?? 42;
  const learning = options.learningExponent ?? model.defaultLearningExponent;
  if (!(target > 0 && target < 1) || !Number.isInteger(max) || max < 2 || !(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff) || !nonnegative(learning)) fail('invalid options');
  // A Bernoulli has SD <= .5; a paired {-1,0,1} difference has SD <= 1.
  const precisionScale = input.scenarios.length > 1 ? 1.96 : .98;
  const n = options.simulations ?? Math.min(max, Math.max(2, Math.ceil((precisionScale / target) ** 2)));
  if (!Number.isInteger(n) || n < 2 || n > max) fail('simulations must be an integer from 2 to maxSimulations');
  if (!input.scenarios.length || input.scenarios.some(s => !s.name) || new Set(input.scenarios.map(s => s.name)).size !== input.scenarios.length) fail('provide at least one scenario with unique, nonempty names');
  const teams = [...input.teams].sort((a, b) => a.id - b.id);
  const teamIndex = new Map(teams.map((t, i) => [t.id, i]));
  const nt = teams.length;
  if (teamIndex.size !== nt || teams.some(t => !validId(t.id) || ![t.wins, t.losses, t.ties].every(v => Number.isInteger(v) && v >= 0) || !Number.isFinite(t.pointsFor))) fail('invalid or duplicate teams');
  const count = input.playoffs.teams;
  if (!Number.isInteger(count) || count < 2 || count > nt) fail('playoff team count must be between 2 and league size');
  const roundCount = Math.ceil(Math.log2(count));
  if (input.playoffs.rounds.length !== roundCount) fail('wrong number of playoff rounds');
  const groups = [...input.regularSeason.map(g => g.weeks), ...input.playoffs.rounds];
  if (groups.some(g => !g.length || new Set(g).size !== g.length || g.some(w => !Number.isInteger(w) || w < 1 || w > model.seasonWeeks))) fail('invalid scoring weeks');
  const playoffWeeks = input.playoffs.rounds.flat();
  if (new Set(playoffWeeks).size !== playoffWeeks.length || input.playoffs.rounds.some((r, i) => i > 0 && Math.min(...r) <= Math.max(...input.playoffs.rounds[i - 1]!))) fail('playoff rounds overlap or are out of order');
  if (input.regularSeason.some(g => Math.max(...g.weeks) >= Math.min(...playoffWeeks))) fail('regular season must precede playoffs');
  const weeks = [...new Set(groups.flat())].sort((a, b) => a - b);
  const weekIndex = new Map(weeks.map((w, i) => [w, i]));
  const nw = weeks.length;
  const weekKeys = weeks.map(mix);
  const teamKeys = teams.map(t => mix(t.id));
  const seenGames = new Set<string>();
  const games = input.regularSeason.map(g => {
    if (!teamIndex.has(g.home) || !teamIndex.has(g.away) || g.home === g.away) fail('invalid matchup teams');
    for (const t of [g.home, g.away]) for (const w of g.weeks) {
      const key = `${t}:${w}`;
      if (seenGames.has(key)) fail('team has overlapping regular-season matchups');
      seenGames.add(key);
    }
    return { home: teamIndex.get(g.home)!, away: teamIndex.get(g.away)!, weeks: g.weeks.map(w => weekIndex.get(w)!) };
  });
  const players = [...input.players].sort((a, b) => a.id - b.id);
  const playerIndex = new Map(players.map((p, i) => [p.id, i]));
  if (playerIndex.size !== players.length || players.some(p => !validId(p.id))) fail('invalid or duplicate player ids');
  const format = model.formats[input.format];
  if (!format) fail('unsupported scoring format');
  const compiledPlayers = players.map(p => {
    const persistent = format.persistent[p.position];
    if (!persistent) fail(`unsupported position ${p.position}`);
    const projections = weeks.map(w => p.projections[w]);
    if (projections.some(p => p === undefined || !nonnegative(p))) fail(`missing or invalid projection for player ${p.id}`);
    const means = projections as number[];
    const active = means.filter(p => p > 0).length;
    return { key: mix(p.id), means, weekly: means.map(mean => weeklyCell(format, p.position, mean).multiplier.samples),
      persistent: persistent.available ? persistent.multiplier.samples : [1],
      scale: active ? Math.min(1, active / model.fullSeasonGames) ** learning : 0 };
  });
  if (compiledPlayers.some(p => !p.persistent.length || p.weekly.some(d => !d.length))) fail('empty uncertainty distribution');
  const scenarios = input.scenarios.map(s => {
    if (Object.keys(s.lineups).some(t => !teamIndex.has(Number(t)))) fail('lineup has unknown team');
    const used = weeks.map(() => new Set<number>());
    return teams.flatMap(t => weeks.map((w, wi) => {
      const ids = s.lineups[t.id]?.[w];
      if (!ids) fail(`missing lineup for ${s.name}, team ${t.id}, week ${w}`);
      return ids.map(id => {
        if (!playerIndex.has(id) || used[wi]!.has(id)) fail('unknown player or duplicate player in weekly lineups');
        used[wi]!.add(id);
        return playerIndex.get(id)! * nw + wi;
      }).sort((a, b) => a - b);
    }));
  });
  // Sample only player/weeks used by at least one scenario. Bench-only and zero
  // weeks cannot affect a result; counter-addressed draws make omission exact.
  const needed = new Set(scenarios.flat(2));
  const draws = compiledPlayers.map((p, pi) => ({ ...p, weeks: weeks.flatMap((_, wi) => {
    const offset = pi * nw + wi;
    return needed.has(offset) && p.means[wi]! > 0
      ? [{ offset, mean: p.means[wi]!, samples: p.weekly[wi]!, key: weekKeys[wi]! }] : [];
  }) })).filter(p => p.weeks.length);
  // Standard bracket: 1-v-8, 4-v-5, 2-v-7, 3-v-6. Missing seeds get byes.
  let bracket = [1, 2];
  for (let size = 4; size <= 2 ** roundCount; size *= 2) bracket = bracket.flatMap(s => [s, size + 1 - s]);
  const rounds = input.playoffs.rounds.map(r => r.map(w => weekIndex.get(w)!));
  const accum = scenarios.map(() => teams.map(() => ({ w: moments(), l: moments(), t: moments(), p: moments(), c: moments(), records: new Map<string, number>() })));
  const differences = scenarios.slice(1).map(() => teams.map(() => ({ w: moments(), p: moments(), c: moments() })));
  const playerScores = new Float64Array(players.length * nw);
  const teamScores = new Float64Array(nt * nw);
  const wins = new Float64Array(nt), losses = new Float64Array(nt), ties = new Float64Array(nt), pf = new Float64Array(nt);
  const qualified = new Uint8Array(nt);
  const lottery = new Float64Array(nt);
  const baselineW = new Float64Array(nt), baselineP = new Uint8Array(nt), baselineC = new Uint8Array(nt);
  for (let sim = 0; sim < n; sim++) {
    const pathKey = mix(seed ^ mix(sim));
    for (let ti = 0; ti < nt; ti++) lottery[ti] = mix(mix(pathKey ^ teamKeys[ti]!) ^ mix(100));
    sampleScores(draws, pathKey, playerScores);
    for (let si = 0; si < scenarios.length; si++) {
      scoreLineups(scenarios[si]!, playerScores, teamScores);
      qualified.fill(0);
      for (let ti = 0; ti < nt; ti++) {
        const t = teams[ti]!;
        wins[ti] = t.wins; losses[ti] = t.losses; ties[ti] = t.ties; pf[ti] = t.pointsFor;
      }
      for (const g of games) {
        let h = 0, a = 0;
        for (const wi of g.weeks) { h += teamScores[g.home * nw + wi]!; a += teamScores[g.away * nw + wi]!; }
        pf[g.home]! += h; pf[g.away]! += a;
        if (h === a) { ties[g.home]!++; ties[g.away]!++; }
        else { wins[h > a ? g.home : g.away]!++; losses[h > a ? g.away : g.home]!++; }
      }
      // Win percentage (ties count half), then regular-season PF, then a shared fair lottery.
      const pct = (i: number) => (wins[i]! + .5 * ties[i]!) / (wins[i]! + losses[i]! + ties[i]! || 1);
      const order = teams.map((_, i) => i).sort((a, b) => pct(b) - pct(a) || pf[b]! - pf[a]! || lottery[b]! - lottery[a]! || a - b);
      for (const ti of order.slice(0, count)) qualified[ti] = 1;
      let alive = bracket.map(s => s <= count ? s - 1 : -1); // seed indices, -1 is a bye
      for (let ri = 0; ri < rounds.length; ri++) {
        if (ri > 0 && input.playoffs.reseed) {
          const sorted = [...alive].sort((a, b) => a - b);
          alive = [];
          while (sorted.length) { alive.push(sorted.shift()!); alive.push(sorted.pop()!); }
        }
        const next: number[] = [];
        for (let j = 0; j < alive.length; j += 2) {
          const a = alive[j]!, b = alive[j + 1]!;
          if (a < 0 || b < 0) { next.push(Math.max(a, b)); continue; }
          let sa = 0, sb = 0;
          for (const wi of rounds[ri]!) { sa += teamScores[order[a]! * nw + wi]!; sb += teamScores[order[b]! * nw + wi]!; }
          next.push(sa === sb ? Math.min(a, b) : sa > sb ? a : b); // higher seed wins playoff ties
        }
        alive = next;
      }
      const champion = order[alive[0]!]!;
      for (let ti = 0; ti < nt; ti++) {
        const a = accum[si]![ti]!, w = wins[ti]!, p = qualified[ti]!, c = +(champion === ti);
        add(a.w, w); add(a.l, losses[ti]!); add(a.t, ties[ti]!); add(a.p, p); add(a.c, c);
        const record = `${w}-${losses[ti]}-${ties[ti]}`;
        a.records.set(record, (a.records.get(record) ?? 0) + 1);
        if (si === 0) { baselineW[ti] = w; baselineP[ti] = p; baselineC[ti] = c; }
        else { const d = differences[si - 1]![ti]!; add(d.w, w - baselineW[ti]!); add(d.p, p - baselineP[ti]!); add(d.c, c - baselineC[ti]!); }
      }
    }
  }
  const worst = .98 / Math.sqrt(n);
  return { simulations: n, seed, targetHalfWidth: target, worstCaseOddsHalfWidth: worst, worstCaseComparisonHalfWidth: scenarios.length > 1 ? 2 * worst : null,
    precisionReached: precisionScale / Math.sqrt(n) <= target,
    scenarios: accum.map((a, si) => ({ name: input.scenarios[si]!.name, teams: a.map((t, i) => ({ id: teams[i]!.id,
      wins: estimate(t.w, n), losses: estimate(t.l, n), ties: estimate(t.t, n), playoffOdds: estimate(t.p, n, true), championshipOdds: estimate(t.c, n, true),
      records: Object.fromEntries([...t.records].map(([r, count]) => [r, count / n])) })) })),
    comparisons: differences.map((a, si) => ({ name: input.scenarios[si + 1]!.name, teams: a.map((t, i) => ({ id: teams[i]!.id,
      wins: estimate(t.w, n), playoffOdds: estimate(t.p, n), championshipOdds: estimate(t.c, n) })) })) };
}
