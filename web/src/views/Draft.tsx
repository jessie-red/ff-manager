import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { Logo, type TeamViewProps } from "../App.jsx";
import { fetchDraft, type Alternative, type AuctionPick, type AuctionTeam, type DraftPick, type DraftPlayer, type DraftTeam } from "../api.js";
import { ANCHOR_ROUNDS, GAIN_SCALE } from "../../../src/model/draft.js";
import { BENCH_TAIL, BENCH_WEIGHTS } from "../../../src/model/auction.js";
import { statusTag } from "../../../src/model/player.js";

const num = (x: number, d = 1) => x.toFixed(d);
const gradeClass = (g: string) => `grade grade-${g[0]!.toLowerCase()}`;
const posClass = (pos: string) => `pos-${pos.toLowerCase().replace(/[^a-z]/g, "")}`;
const rankLabel = (p: DraftPlayer) => (p.rank === undefined ? "unranked" : `${p.pos}${Math.round(p.rank)}`);
const injured = (p: DraftPlayer) => p.injuryStatus !== "ACTIVE" && p.injuryStatus !== "NORMAL";
const money = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(0)}`;
/** Signed dollars: +$12, -$3, $0. */
const signed = (x: number) => (Math.abs(x) < 0.5 ? "$0" : x > 0 ? `+${money(x)}` : money(x));
const surplusClass = (x: number) => (x >= 0.5 ? "grade-a" : x <= -0.5 ? "grade-d" : "dim");
/** Auction picks and teams carry fair prices (model/auction.ts); snake ones don't. */
const auctionPick = (p: DraftPick): AuctionPick | null => ("fair" in p ? (p as AuctionPick) : null);
const auctionTeam = (t: DraftTeam): AuctionTeam | null => ("fair" in t ? (t as AuctionTeam) : null);

interface Hover {
  pick: DraftPick;
  x: number;
  y: number;
}

/** One line of the tooltip: who, what they'd have added, and where they actually went. */
function AltRow(props: { label: string; alt: Alternative | null; pick: DraftPick; teams: DraftTeam[] }) {
  const went = () => {
    const a = props.alt!;
    if (a.overall === props.pick.overall) return "this pick";
    const t = props.teams.find((x) => x.teamId === a.teamId);
    return `went #${a.overall}${t ? ` to ${t.abbrev}` : ""}`;
  };
  return (
    <Show when={props.alt} fallback={<div class="dim">{props.label}: –</div>}>
      {(a) => (
        <div class="alt">
          <span class="dim">{props.label}</span>
          <span>
            <b class={posClass(a().player.pos)}>{a().player.name}</b> <span class="dim">{a().player.pos} · {a().player.team} · {rankLabel(a().player)}</span>
          </span>
          <span class="n">
            {num(a().gain.value)} <span class="dim">val</span> {num(a().gain.ppg)} <span class="dim">ppg+</span>
          </span>
          <span class="dim">{went()}</span>
        </div>
      )}
    </Show>
  );
}

function Tooltip(props: { hover: Hover; teams: DraftTeam[]; rounds: number }) {
  const pick = () => props.hover.pick;
  const p = () => pick().player;
  const team = () => props.teams.find((t) => t.teamId === pick().teamId);
  // Keep the box on screen: flip to the left of the cursor near the right edge, above it near the bottom.
  const style = () => {
    const w = 680;
    const h = 190;
    const left = props.hover.x + 16 + w > window.innerWidth ? props.hover.x - w - 12 : props.hover.x + 16;
    const top = props.hover.y + 16 + h > window.innerHeight ? props.hover.y - h - 12 : props.hover.y + 16;
    return { left: `${Math.max(4, left)}px`, top: `${Math.max(4, top)}px`, width: `${w}px` };
  };
  return (
    <div class="tip" style={style()}>
      <div class="tip-head">
        <span>
          #{pick().overall} <span class="dim">round {pick().round}, pick {pick().pickInRound}</span>
          <Show when={pick().bid}> <span class="dim">· ${pick().bid}</span></Show>
          <Show when={team()}>{(t) => <span class="dim"> · {t().name.trim()}</span>}</Show>
          <Show when={pick().keeper}> <span class="dim">· keeper</span></Show>
          <Show when={pick().auto}> <span class="dim">· autodraft</span></Show>
        </span>
        <span class={gradeClass(pick().grade)}>{pick().grade}</span>
      </div>
      <Show when={p()} fallback={<div class="dim">no player record</div>}>
        {(pl) => (
          <>
            <div class="alt">
              <span class="dim">pick</span>
              <span>
                <b class={posClass(pl().pos)}>{pl().name}</b>{" "}
                <span class="dim">
                  {pl().pos} · {pl().team} · {rankLabel(pl())}
                </span>
                <Show when={injured(pl())}>
                  <span class="inj" title={pl().injuryStatus}> {statusTag(pl().injuryStatus)}</span>
                </Show>
              </span>
              <span class="n">
                {num(pick().gain.value)} <span class="dim">val</span> {num(pick().gain.ppg)} <span class="dim">ppg+</span>
              </span>
              <span class="dim">
                {num(pl().ppg)} ppg
                <Show when={pl().sleeperPpg !== null}>
                  {" "}
                  <span title="ESPN / Sleeper season projections">({num(pl().espnPpg)} / {num(pl().sleeperPpg!)})</span>
                </Show>
                <Show when={pl().draftRank}> · ESPN pre-draft #{pl().draftRank}</Show>
              </span>
            </div>
            <Show when={auctionPick(pick())}>
              {(ap) => (
                <div class="alt">
                  <span class="dim">price</span>
                  <span>
                    paid <b>${ap().bid}</b> <span class="dim">· fair {money(ap().fair.overall)}</span>{" "}
                    <span class="dim" title="Fair price by tier value / by ppg over replacement; the pick's fair price is their average">
                      ({money(ap().fair.value)} val / {money(ap().fair.ppg)} ppg+)
                    </span>{" "}
                    <span
                      class="dim"
                      title="League-wide rank among drafted players at the position by value / by ppg+, and the slot weight the value is priced at: 1 for a starter, less each bench band"
                    >
                      · {ap().player!.pos}{ap().slot.value.rank}/{ap().slot.ppg.rank} ×{num(ap().slot.value.weight, 1)}/{num(ap().slot.ppg.weight, 1)}
                    </span>
                  </span>
                  <span class="n">
                    <b class={surplusClass(ap().surplus)}>{signed(ap().surplus)}</b> <span class="dim">surplus</span>
                  </span>
                  <span class="dim" />
                </div>
              )}
            </Show>
            <Show
              when={auctionPick(pick())}
              fallback={
                <>
                  <AltRow label="best value" alt={pick().bestValue} pick={pick()} teams={props.teams} />
                  <AltRow label="best ppg" alt={pick().bestPpg} pick={pick()} teams={props.teams} />
                  <div class="tip-foot dim">
                    {Math.round(pick().score.value * 100)}% of the value headroom, {Math.round(pick().score.ppg * 100)}% of the ppg+ headroom
                    {" → "}
                    {pick().grade}
                    <br />
                    <span title="Mean of every player still on the board, i.e. what a blind pick would have returned">
                      remaining pool averaged {num(pick().remaining.value)} val, {num(pick().remaining.ppg)} ppg+
                    </span>
                  </div>
                </>
              }
            >
              {(ap) => (
                <div class="tip-foot dim">
                  surplus z = {num(ap().z, 2)} across the league's picks {" → "} {ap().grade}
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "D/ST"];

export function Draft(props: Pick<TeamViewProps, "league" | "onSelectTeam"> & { team: { teamId: number } }) {
  const [data] = createResource(() => ({ league: props.league.id, season: props.league.season }), fetchDraft);
  const [hover, setHover] = createSignal<Hover | null>(null);
  const draft = () => data()?.draft ?? null;

  /** Board cells: rows are each team's nth pick, columns are teams in round-1 order. */
  const board = createMemo(() => {
    const d = draft();
    if (!d) return [];
    const byTeam = new Map<number, DraftPick[]>();
    for (const p of [...d.picks].sort((a, b) => a.overall - b.overall)) {
      const list = byTeam.get(p.teamId) ?? [];
      list.push(p);
      byTeam.set(p.teamId, list);
    }
    return Array.from({ length: d.rounds }, (_, r) => d.teams.map((t) => byTeam.get(t.teamId)?.[r] ?? null));
  });

  const replacementNote = () =>
    Object.entries(draft()?.ppgReplacement ?? {})
      .map(([pos, r]) => `${pos}${r.rank} at ${num(r.ppg)}`)
      .join(", ");

  const move = (pick: DraftPick) => (e: MouseEvent) => setHover({ pick, x: e.clientX, y: e.clientY });

  return (
    <div class="draft">
      <header class="team-head">
        <h2>Draft Analysis</h2>
        <Show when={data()}>
          {(d) => (
            <div class="meta dim">
              <span>{d().league.name} · {d().league.season}</span>
              <Show when={draft()}>{(dr) => <span>{dr().type.toLowerCase()} · {dr().picks.length} picks · {dr().teams.length} teams</span>}</Show>
              <Show when={d().sleeperError}>
                <span class="error">Sleeper unavailable, ppg is ESPN only</span>
              </Show>
              <Show when={d().curvesError}>
                <span class="error">history unavailable, linear value</span>
              </Show>
              <Show when={d().tiersError}>
                <span class="error">Boris tiers unavailable, valuing by rank</span>
              </Show>
              <Show when={d().byeError}>
                <span class="error">bye weeks unavailable</span>
              </Show>
            </div>
          )}
        </Show>
        <div class="legend">
          <For each={POSITIONS}>{(pos) => <span class={"chip " + posClass(pos)}>{pos}</span>}</For>
          <span class="dim">
            hover a pick for its grade{draft()?.type === "AUCTION" ? ", fair price and surplus" : " and the best players still on the board"} · ppg+ = season ppg over the last starter
          </span>
        </div>
      </header>

      <Show when={data.loading}>
        <p class="dim">loading draft…</p>
      </Show>
      <Show when={data.error}>
        <p class="error">{String(data.error?.message ?? data.error)}</p>
      </Show>
      <Show when={data()?.draftError}>{(e) => <p class="hint">{e()}</p>}</Show>

      <Show when={draft()}>
        {(d) => (
          <div class="scroll board-wrap">
            <table class="board">
              <thead>
                <tr>
                  <th class="round-head" />
                  <For each={d().teams}>
                    {(t) => (
                      <th
                        classList={{ selected: t.teamId === props.team.teamId, me: t.isMe }}
                        onClick={() => props.onSelectTeam(t.teamId)}
                        title={[t.name.trim(), t.owner].filter(Boolean).join(" · ")}
                      >
                        <div class="col-head">
                          <Logo src={t.logo} size={22} />
                          <span class="abbrev">{t.abbrev}</span>
                          <Show when={t.grade}>
                            {(g) => (
                              <span
                                class={gradeClass(g())}
                                title={
                                  auctionTeam(t)
                                    ? `spent $${auctionTeam(t)!.spent} of $${auctionTeam(t)!.spent + auctionTeam(t)!.unspent} · fair ${money(auctionTeam(t)!.fair)}: lineup ${money(auctionTeam(t)!.starterFair)} + weighted bench ${money(auctionTeam(t)!.benchFair)} = ${money(auctionTeam(t)!.weightedFair)} · surplus ${signed(auctionTeam(t)!.surplus)} (weighted fair minus budget), z = ${num(t.z ?? 0, 2)} across the league`
                                    : `average pick score ${num((t.score ?? 0) * 100, 0)}%, z = ${num(t.z ?? 0, 2)} across the league`
                                }
                              >
                                {g()}
                              </span>
                            )}
                          </Show>
                        </div>
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={board()}>
                  {(row, r) => (
                    <tr>
                      <td class="round-head dim">{r() + 1}</td>
                      <For each={row}>
                        {(pick, c) => (
                          <td classList={{ selected: d().teams[c()]!.teamId === props.team.teamId }}>
                            <Show when={pick} fallback={<div class="pick empty" />}>
                              {(p) => (
                                <div
                                  class={"pick " + (p().player ? posClass(p().player!.pos) : "")}
                                  classList={{ keeper: p().keeper, hot: hover()?.pick.overall === p().overall }}
                                  onMouseEnter={move(p())}
                                  onMouseMove={move(p())}
                                  onMouseLeave={() => setHover(null)}
                                >
                                  <div class="pick-top">
                                    <span class="num">
                                      #{p().overall}
                                      <Show when={p().bid}> ${p().bid}</Show>
                                    </span>
                                    <span class={gradeClass(p().grade)}>{p().grade}</span>
                                  </div>
                                  <Show when={p().player} fallback={<span class="name dim">unknown player</span>}>
                                    {(pl) => (
                                      <>
                                        <span class="name" classList={{ inj: injured(pl()) }}>
                                          {pl().name}
                                        </span>
                                        <span class="sub">
                                          {pl().pos} · {pl().team}
                                          <Show when={pl().bye}> · BYE {pl().bye}</Show>
                                        </span>
                                      </>
                                    )}
                                  </Show>
                                </div>
                              )}
                            </Show>
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </Show>

      <Show when={draft()}>
        <p class="dim note">
          Each pick is judged in hindsight with today's ESPN consensus ranks and season projections, on two yardsticks over a
          replacement anchored on the draft: at each position, the best player still on the board after round {ANCHOR_ROUNDS} (so the top kicker
          or D/ST is the replacement and worth nothing). Value is season VORP averaged over the player's Boris Chen tier, re-based on that rank.
          ppg+ is the ESPN/Sleeper average season projection minus the replacement's, read off the drafted pool ranked by ppg: {replacementNote()}.
          Neither is floored, so a negative figure means the pick was worse than the free option. The best available by each is the best among players
          drafted later by anyone (undrafted players are ignored); value ties within a tier go to Boris's own order. A pick's score per yardstick is the share of the
          board's headroom it captured: its lead over the average of everything still on the board (what a blind pick would return) as a share of the best available's lead,
          with the headroom counted as at least {GAIN_SCALE} points so small misses stay small. Measuring from the pool rather than from zero is what keeps the last
          rounds gradeable, where everything left is below replacement. The grade is the average of the two scores. A team's grade is its picks' average score as a z-score across the league (like the ratings), since every team's average lands near 50%.
          <Show when={draft()!.type === "AUCTION"}>
            {" "}
            In an auction the rows are nomination order, and each pick also gets a fair price: every roster spot costs at least $1, and the league's remaining
            money is shared out in proportion to positive value (once by tier value, once by ppg+, averaged), so players at or below replacement price at $1.
            Value is discounted by league-wide positional rank before pricing: the ranks the league starts count in full, and each band of one-per-team below them
            counts {BENCH_WEIGHTS.join(", ")} then {BENCH_TAIL}, so bench-calibre value is cheap and the money moves up to players who fit in a lineup.
            Surplus is fair minus paid, and a pick's grade is its surplus as a z-score across every pick in the league (so the $1 bodies land in the middle).
            A team's grade is its roster's fair price minus the whole budget, z-scored across the league, with the hindsight-optimal lineup (filled by fair price)
            counted in full and the bench, best first, at {BENCH_WEIGHTS.join(", ")} then {BENCH_TAIL} each, since bench value only becomes points when a starter
            doesn't. Money left unspent counts as spent on nothing.
            Best-available comparisons are skipped: in an auction, who was still on the board is only a matter of nomination order.
          </Show>
        </p>
      </Show>

      <Show when={hover() && draft()}>
        <Tooltip hover={hover()!} teams={draft()!.teams} rounds={draft()!.rounds} />
      </Show>
    </div>
  );
}
