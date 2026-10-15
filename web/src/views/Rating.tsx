import { For, Show } from "solid-js";
import { Logo, type TeamViewProps } from "../App.jsx";
import type { Lineup, Player } from "../api.js";
import { rankValue } from "../../../src/model/value.js";
import { statusTag } from "../../../src/model/player.js";
import { recordLabel } from "../../../src/model/schedule.js";
import type { TeamRating } from "../../../src/model/rate.js";

const num = (x: number, d = 1) => x.toFixed(d);
const signed = (x: number, d = 1) => (x > 0 ? "+" : "") + x.toFixed(d);
const deltaClass = (x: number) => (Math.abs(x) < 3 ? "dim" : x > 0 ? "up" : "down");
const gradeClass = (g: string) => `grade grade-${g[0]!.toLowerCase()}`;
const injured = (p: Player) => p.injuryStatus !== "ACTIVE" && p.injuryStatus !== "NORMAL";
/** "RB5" for a consensus rank of 5.4; "–" when unranked. */
const rankLabel = (pos: string, rank: number | undefined) => (rank === undefined ? "–" : `${pos}${Math.round(rank)}`);
/** "T3" for Boris tier 3; "–" when the player isn't in any tier list. */
const tierLabel = (tier: number | undefined) => (tier === undefined ? "–" : `T${tier}`);

const percent = (p: number) => `${(p * 100).toFixed(1)}%`;

/**
 * Mean wins-losses over the simulated seasons the championship odds come from,
 * falling back to schedule.ts's single deterministic path when the simulation
 * didn't run. Ties only show in leagues that can actually tie.
 */
function ProjectedRecordCell(props: { team: TeamRating }) {
  const sim = () => props.team.simulatedRecord;
  return (
    <Show
      when={sim()}
      fallback={
        <Show when={props.team.projected} fallback={<span class="dim">–</span>}>
          {r => <span class="dim" title="every remaining matchup decided by the two teams' projected points; no simulation">{recordLabel(r())}</span>}
        </Show>
      }
    >
      {r => (
        <span class="dim" title={`mean record over 100,000 simulated seasons (${num(r().wins.mean, 2)}-${num(r().losses.mean, 2)})`}>
          {num(r().wins.mean)}-{num(r().losses.mean)}
          <Show when={r().ties.mean >= 0.05}>-{num(r().ties.mean)}</Show>
        </span>
      )}
    </Show>
  );
}
function ChampionshipCell(props: { team: TeamRating }) {
  return <Show when={props.team.championshipOdds} fallback={<span class="dim" title={props.team.championshipError ?? 'Championship odds unavailable'}>–</span>}>
    {odds => <span title={`100,000 simulated seasons; 95% simulation interval ${percent(odds().interval95[0])}–${percent(odds().interval95[1])}. Measures Monte Carlo noise, not model uncertainty.`}>{percent(odds().mean)}</span>}
  </Show>;
}

/** Player name with team and injury flag. */
function PlayerCell(props: { player: Player }) {
  return (
    <span title={`${props.player.name} (${props.player.team})`}>
      {props.player.name} <span class="dim">{props.player.team}</span>
      <Show when={props.player.onIR}>
        <span class="dim"> IR</span>
      </Show>
      <Show when={!props.player.onIR && injured(props.player)}>
        <span class="inj" title={props.player.injuryStatus}> {statusTag(props.player.injuryStatus)}</span>
      </Show>
    </span>
  );
}

/** "-0" for a value a shade under replacement reads better as 0. */
const val = (x: number) => (num(x, 0) === "-0" ? "0" : num(x, 0));
/**
 * An optimal lineup: each starter's consensus rank, their Boris tier (when
 * `tiers` is set), their rest-of-season value (when `ros` is set), the lineup's
 * points column under `pts` as its heading, and (when `alt` is given) a second
 * projection as a delta from it.
 */
function LineupTable(props: {
  title: string;
  note: string;
  lineup: Lineup;
  pts: string;
  tiers?: boolean;
  ros?: boolean;
  alt?: (p: Player) => number | undefined;
}) {
  const altTotal = () =>
    props.lineup.starters.reduce((sum, s) => sum + (s.player ? (props.alt?.(s.player) ?? 0) : 0), 0);
  return (
    <section class="block">
      <h3>
        {props.title} <small>{props.note}</small>
      </h3>
      <table class="lineup">
        <thead>
          <tr>
            <th />
            <th />
            <th class="n">rank</th>
            <Show when={props.tiers}>
              <th class="n" title="Boris Chen tier">tier</th>
            </Show>
            <Show when={props.ros}>
              <th class="n" title="projected points from here on, over what streaming the slot would yield">value</th>
            </Show>
            <th class="n">{props.pts}</th>
            <Show when={props.alt}>
              <th class="n">Slpr</th>
            </Show>
          </tr>
        </thead>
        <tbody>
          <For each={props.lineup.starters}>
            {(s) => (
              <tr>
                <td class="slot">{s.slotName}</td>
                <td>
                  <Show when={s.player} fallback={<span class="dim">— empty —</span>}>
                    {(p) => <PlayerCell player={p()} />}
                  </Show>
                </td>
                <td class="n dim">{s.player ? rankLabel(s.player.pos, s.rank) : ""}</td>
                <Show when={props.tiers}>
                  <td class="n">{s.player ? tierLabel(s.player.tier) : ""}</td>
                </Show>
                <Show when={props.ros}>
                  <td class="n">{s.player ? val(s.value) : ""}</td>
                </Show>
                <td class="n">{num(s.points)}</td>
                <Show when={props.alt}>
                  {(alt) => {
                    const v = () => (s.player ? alt()(s.player) : undefined);
                    return (
                      <td class="n" classList={{ [deltaClass((v() ?? 0) - s.points)]: v() !== undefined }}>
                        {v() === undefined ? "–" : signed(v()! - s.points)}
                      </td>
                    );
                  }}
                </Show>
              </tr>
            )}
          </For>
          <tr class="total">
            <td />
            <td class="dim">total</td>
            <td />
            <Show when={props.tiers}>
              <td />
            </Show>
            <Show when={props.ros}>
              <td class="n">{val(props.lineup.total)}</td>
            </Show>
            <td class="n">{num(props.lineup.points)}</td>
            <Show when={props.alt}>
              <td class={"n " + deltaClass(altTotal() - props.lineup.points)}>{signed(altTotal() - props.lineup.points)}</td>
            </Show>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

export function Rating(props: TeamViewProps) {
  const hasRos = () => props.ros !== null;
  /** Bench is sorted the way it's graded: by rest-of-season value, or by rank value without it. */
  const value = (p: Player) => (props.ros ? (p.ros?.vorp ?? 0) : rankValue(props.valuation, p.pos, p.rosRank));
  const bench = () => [...props.team.ros.bench].sort((a, b) => value(b) - value(a) || b.rosPpg - a.rosPpg);
  const hasTiers = () => props.valuation.tiers !== null;
  const replacementNote = () => {
    const ros = props.ros;
    return Object.entries(props.valuation.replacement)
      .map(([pos, r]) => (ros ? `${pos}${ros.replacementRank[pos] ?? r} (${num(ros.replacement[pos] ?? 0)}/wk)` : `${pos}${r}`))
      .join(", ");
  };
  const rankNote = () =>
    props.valuation.curves
      ? "historical pts/game at consensus rank − pts/game at replacement"
      : "replacement rank + 1 − consensus rank";
  const valueNote = () => {
    const ros = props.ros;
    if (ros)
      return `value = projected points over weeks ${ros.weeks[0]}–${ros.weeks.at(-1)} (ESPN and Sleeper averaged) − replacement pts/game × games projected`;
    return hasTiers() ? `value = season VORP averaged over the player's Boris Chen tier` : `value = ${rankNote()}`;
  };
  const slots = () => props.ratings[0]?.positions.map((p) => p.slot) ?? [];
  const showOwner = () => props.ratings.some((t) => t.owner !== "");
  const hasSleeper = () => props.ratings.some((t) => t.sleeperWeek !== null);
  /** ESPN + Sleeper pair under a shared label, or a single column when Sleeper isn't loaded. */
  const PairHead = (p: { label: string }) => (
    <Show when={hasSleeper()} fallback={<th class="n" rowSpan={2}>{p.label}</th>}>
      <th class="n group" colSpan={2}>
        {p.label}
      </th>
    </Show>
  );
  const PairCells = (p: { espn: number; sleeper: number | null }) => (
    <>
      <td class="n">{num(p.espn)}</td>
      <Show when={hasSleeper()}>
        <td class="n">{p.sleeper === null ? "–" : num(p.sleeper)}</td>
      </Show>
    </>
  );

  return (
    <div class="rating">
      <header class="team-head">
        <h2>
          <Logo src={props.team.logo} size={36} />
          <span class="rank">#{props.team.rank}</span> {props.team.name.trim()}
        </h2>
        <div class="meta">
          <span class={gradeClass(props.team.grade)}>{props.team.grade}</span>
          <Show when={props.team.owner}>
            <span>{props.team.owner}</span>
          </Show>
          <span>{props.team.record}</span>
          <span>Championship <ChampionshipCell team={props.team} /></span>
          <Show when={props.team.espnProjectedRank}>
            <span class="dim">ESPN proj. #{props.team.espnProjectedRank}</span>
          </Show>
        </div>
        <div class="positions">
          <For each={props.team.positions}>
            {(p) => (
              <div class="pos">
                <span class="slot">{p.slot}</span>
                <span class={gradeClass(p.grade)}>{p.grade}</span>
              </div>
            )}
          </For>
          <div class="pos" title="every bench player's value (K and D/ST aside), z-scored across the league; not part of the overall">
            <span class="slot">Bench</span>
            <span class={gradeClass(props.team.benchGrade)}>{props.team.benchGrade}</span>
          </div>
        </div>
      </header>

      <div class="columns">
        <LineupTable
          title="Rest of season"
          note={
            hasRos()
              ? `ROS rank${hasTiers() ? ", tier" : ""}, value, ESPN/Sleeper averaged ppg`
              : [`ROS rank${hasTiers() ? ", tier" : ""}, ESPN pts/game`, ...(hasSleeper() ? ["Sleeper Δ"] : [])].join(", ")
          }
          lineup={props.team.ros}
          pts={hasRos() ? "ROS ppg" : "ESPN"}
          tiers={hasTiers()}
          ros={hasRos()}
          alt={hasRos() || !hasSleeper() ? undefined : (p) => p.sleeper?.rosPpg}
        />
        <LineupTable
          title={`Week ${props.week}`}
          note={hasSleeper() ? "weekly rank, ESPN proj, Sleeper Δ" : "weekly rank, ESPN proj"}
          lineup={props.team.week}
          pts="ESPN"
          alt={hasSleeper() ? (p) => p.sleeper?.weekProj : undefined}
        />
        <section class="block">
          <h3>
            Bench <small>ROS rank{hasTiers() ? ", tier" : ""}{hasRos() ? ", value, ROS ppg" : ", ESPN pts/game"}</small>
          </h3>
          <table class="lineup">
            <thead>
              <tr>
                <th />
                <th />
                <th class="n">rank</th>
                <Show when={hasTiers()}>
                  <th class="n" title="Boris Chen tier">tier</th>
                </Show>
                <Show when={hasRos()}>
                  <th class="n" title="projected points from here on, over what streaming the slot would yield; not floored, so a below-replacement bench still orders">
                    value
                  </th>
                </Show>
                <th class="n">{hasRos() ? "ROS ppg" : "ESPN"}</th>
              </tr>
            </thead>
            <tbody>
              <For each={bench()}>
                {(p) => (
                  <tr classList={{ dim: p.onIR }}>
                    <td class="slot">{p.pos}</td>
                    <td>
                      <PlayerCell player={p} />
                    </td>
                    <td class="n dim">{rankLabel(p.pos, p.rosRank)}</td>
                    <Show when={hasTiers()}>
                      <td class="n">{tierLabel(p.tier)}</td>
                    </Show>
                    <Show when={hasRos()}>
                      <td class="n">{p.ros ? val(p.ros.vorp) : ""}</td>
                    </Show>
                    <td class="n">{num(p.ros?.ppg ?? p.rosPpg)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <p class="dim note">
            grades are z-scores across the league; overall = every starter's value, K and D/ST included (they get no grade
            of their own); the bench is graded separately and left out of it, summing every bench player's{" "}
            {hasRos() ? "value, unfloored" : "rank value"}; {valueNote()}; replacement at{" "}
            {replacementNote()}
          </p>
        </section>
      </div>

      <p class="dim note">Championship odds use current rosters and forecast-selected weekly lineups through the playoffs, with no future injuries or waiver moves. Current-week games are simulated in full; live scores are not included. Hover over odds for the simulation interval.</p>
      <Show when={props.team.championshipError}><p class="error">Championship odds unavailable: {props.team.championshipError}</p></Show>
      <section class="block">
        <h3>
          League <small>click a row to switch team</small>
        </h3>
        <div class="scroll">
          <table class="league">
            <thead>
              <tr>
                <th class="n" rowSpan={2}>#</th>
                <th rowSpan={2}>Team</th>
                <Show when={showOwner()}>
                  <th rowSpan={2}>Owner</th>
                </Show>
                <th rowSpan={2} title="actual record so far">Rec</th>
                <th class="n" rowSpan={2} title="mean regular-season record over the same 100,000 simulated seasons as the championship odds">
                  Proj
                </th>
                <th class="n champ" rowSpan={2} title="Chance of winning the championship in 100,000 simulated seasons">Champ%</th>
                <th rowSpan={2} title="z-score of starters' value, K and D/ST included; bench not included">
                  Grade
                </th>
                <Show when={hasRos()} fallback={<PairHead label="ROS pts/wk" />}>
                  <th class="n" rowSpan={2} title="optimal lineup's projected points per game, ESPN and Sleeper averaged">
                    ROS ppg
                  </th>
                </Show>
                <th class="n" rowSpan={2} title="ESPN's projected finish">
                  ESPN
                </th>
                <For each={slots()}>{(s) => <th rowSpan={2}>{s}</th>}</For>
                <th rowSpan={2} title="every bench player's value (K and D/ST aside), z-scored across the league; not part of the overall">
                  Bench
                </th>
              </tr>
              <tr class="sub">
                <Show when={hasSleeper() && !hasRos()}>
                  <th class="n">ESPN</th>
                  <th class="n">Sleeper</th>
                </Show>
              </tr>
            </thead>
            <tbody>
              <For each={props.ratings}>
                {(t) => (
                  <tr
                    classList={{ selected: t.teamId === props.team.teamId, me: t.isMe }}
                    onClick={() => props.onSelectTeam(t.teamId)}
                  >
                    <td class="n">{t.rank}</td>
                    <td class="with-logo">
                      <Logo src={t.logo} size={18} /> <span class="team-name">{t.name.trim()}</span>
                    </td>
                    <Show when={showOwner()}>
                      <td class="dim">{t.owner}</td>
                    </Show>
                    <td>{t.record}</td>
                    <td class="n">
                      <ProjectedRecordCell team={t} />
                    </td>
                    <td class="n champ">
                      <ChampionshipCell team={t} />
                    </td>
                    <td>
                      <span class={gradeClass(t.grade)}>{t.grade}</span>
                    </td>
                    <Show when={hasRos()} fallback={<PairCells espn={t.ros.points} sleeper={t.sleeperRos?.total ?? null} />}>
                      <td class="n">{num(t.ros.points)}</td>
                    </Show>
                    <td class="n">{t.espnProjectedRank ?? "–"}</td>
                    <For each={t.positions}>
                      {(p) => (
                        <td>
                          <span class={gradeClass(p.grade)}>{p.grade}</span>
                        </td>
                      )}
                    </For>
                    <td>
                      <span class={gradeClass(t.benchGrade)}>{t.benchGrade}</span>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
