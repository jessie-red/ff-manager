import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { TeamViewProps } from "../App.jsx";
import { fetchAid, fetchPicks, type AidPick, type AidPlayer, type AidTeam, type DraftStatus } from "../api.js";
import { compareVona, snakePicker, vonaPick, vonaValues, VONA_ROUNDS } from "../../../src/model/aid.js";
import { rollout } from "../../../src/model/rollout.js";
import { statusTag } from "../../../src/model/player.js";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "D/ST"];
/** How many players each position block lists. */
const BLOCK_DEPTH: Record<string, number> = { QB: 12, RB: 15, WR: 15, TE: 12, K: 8, "D/ST": 8 };
/** How often the draft is re-read from ESPN while it's live (ms). */
const POLL_MS = 15_000;

const num = (x: number, d = 1) => x.toFixed(d);
const posClass = (pos: string) => `pos-${pos.toLowerCase().replace(/[^a-z]/g, "")}`;
const injured = (p: AidPlayer) => p.injuryStatus !== "ACTIVE" && p.injuryStatus !== "NORMAL";
const rankLabel = (p: AidPlayer) => (p.rank === undefined ? "–" : `${p.pos}${Math.round(p.rank)}`);
const tierLabel = (p: AidPlayer) => (p.tier === undefined ? "–" : `T${p.tier}`);
const valueLabel = (p: AidPlayer) => (p.value === null ? "–" : p.value.toFixed(0));
const vonaLabel = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(0));
/** Tier background class cycling like Jay's aid (green, yellow, blue, grey), so tier breaks are visible. */
const tierClass = (p: AidPlayer) => (p.tier === undefined ? "t-none" : `t${(p.tier - 1) % 4}`);

/** How the board is scored: rolled-forward drafts, or VONA against the whole board or the player's own position. */
type Method = "rollout" | "board" | "position";
const METHODS: { id: Method; label: string; title: string }[] = [
  { id: "rollout", label: "rollout", title: "simulate the rest of the draft from your own pick schedule and score each player by the roster he leads to" },
  { id: "board", label: "VONA", title: "value minus the best player ADP says survives two rounds, anywhere on the board" },
  { id: "position", label: "VONA·pos", title: "value minus the best player ADP says survives two rounds at the same position" },
];

/** One drafted player, either an ESPN pick or a click. */
interface HistoryRow {
  n: number;
  player: AidPlayer | undefined;
  playerId: number;
  pick: AidPick | null;
}

const stored = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};

function PlayerName(props: { p: AidPlayer }) {
  return (
    <>
      <b classList={{ inj: injured(props.p) }}>{props.p.name}</b>{" "}
      <span class="dim">
        {props.p.team}
        <Show when={props.p.bye}> · {props.p.bye}</Show>
      </span>
      <Show when={injured(props.p)}>
        <span class="inj" title={props.p.injuryStatus}> {statusTag(props.p.injuryStatus)}</span>
      </Show>
    </>
  );
}

export function Aid(props: Pick<TeamViewProps, "league">) {
  const key = () => `${props.league.id}:${props.league.season}`;
  const [data] = createResource(() => ({ league: props.league.id, season: props.league.season }), fetchAid);

  // Clicked-as-drafted player ids in click order, kept per league; ESPN's own picks are merged in when `sync` is on.
  const [manual, setManual] = createSignal<number[]>(stored(`aid:${key()}`, []));
  const [sync, setSync] = createSignal<boolean>(stored("aid:sync", true));
  const [showDrafted, setShowDrafted] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [posFilter, setPosFilter] = createSignal<string | null>(null);
  // How the board is scored: simulated rollouts, or VONA against the whole board / the player's own position.
  const [method, setMethod] = createSignal<Method>(stored<Method>("aid:method", stored("aid:vonapos", false) ? "position" : "rollout"));
  const byPos = () => method() === "position";
  createEffect(() => localStorage.setItem(`aid:${key()}`, JSON.stringify(manual())));
  createEffect(() => localStorage.setItem("aid:sync", JSON.stringify(sync())));
  createEffect(() => localStorage.setItem("aid:method", JSON.stringify(method())));

  // The draft as ESPN sees it: seeded by the pool response, then re-read every POLL_MS until it's over.
  const [live, setLive] = createSignal<DraftStatus | null>(null);
  const [polled, setPolled] = createSignal<Date | null>(null);
  const [pollError, setPollError] = createSignal<string | null>(null);
  createEffect(() => {
    const d = data();
    if (d) setLive(d.draft);
  });
  const draft = () => live() ?? data()?.draft ?? null;
  createEffect(() => {
    if (!sync() || !data() || draft()?.drafted) return;
    const q = { league: props.league.id, season: props.league.season };
    const tick = () =>
      fetchPicks(q)
        .then((d) => {
          setLive(d);
          setPollError(null);
          setPolled(new Date());
        })
        .catch((e: unknown) => setPollError(e instanceof Error ? e.message : String(e)));
    const timer = setInterval(tick, POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const byId = createMemo(() => new Map((data()?.players ?? []).map((p) => [p.id, p])));
  const teams = () => data()?.teams ?? [];
  const teamOf = (id: number): AidTeam | undefined => teams().find((t) => t.teamId === id);
  const espnPicks = () => (sync() ? (draft()?.picks ?? []) : []);

  /** Draft history: ESPN's picks in order, then the clicks. */
  const history = createMemo<HistoryRow[]>(() => {
    const rows: HistoryRow[] = [];
    const seen = new Set<number>();
    for (const pick of espnPicks()) {
      seen.add(pick.playerId);
      rows.push({ n: rows.length + 1, player: byId().get(pick.playerId), playerId: pick.playerId, pick });
    }
    for (const id of manual()) {
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ n: rows.length + 1, player: byId().get(id), playerId: id, pick: null });
    }
    return rows;
  });
  const drafted = createMemo(() => new Set(history().map((r) => r.playerId)));
  const available = createMemo(() => (data()?.players ?? []).filter((p) => !drafted().has(p.id)));

  /** The pick VONA measures availability at: VONA_ROUNDS rounds past the one on the clock (history so far + 1). */
  const nextPick = createMemo(() => vonaPick(teams().length, history().length + 1));
  const vona = createMemo(() => vonaValues(data()?.players ?? [], drafted(), nextPick(), byPos()));

  /** My roster so far as the rollout needs it: the players ESPN says my team has taken. */
  const myPlayers = createMemo(() => history().flatMap((r) => (r.pick && teamOf(r.pick.teamId)?.isMe && r.player ? [r.player] : [])));

  /**
   * The rollout: simulate the rest of the draft from the pick on the clock and score each
   * candidate by the roster it leads to (model/rollout.ts). Needs no horizon constant --
   * the snake order says when I pick again -- and keeps discriminating at a turn, where
   * VONA correctly but uselessly collapses to zero.
   */
  const roll = createMemo(() => {
    const d = data();
    if (!d || method() !== "rollout") return null;
    const started = performance.now();
    const r = rollout(d.players, drafted(), {
      pickOrder: d.pickOrder,
      teamCount: d.teams.length,
      myTeamId: d.teams.find((t) => t.isMe)?.teamId,
      currentPick: history().length + 1,
      myRoster: myPlayers(),
      slots: d.slots,
      benchSize: d.benchSize,
    });
    return { ...r, ms: performance.now() - started };
  });
  /** What the board is sorted and labelled by, whichever method is on. */
  const score = createMemo(() => roll()?.edge ?? vona());

  const listed = createMemo(() => {
    const q = search().trim().toLowerCase();
    const pos = posFilter();
    const pool = showDrafted() ? (data()?.players ?? []) : available();
    return pool.filter((p) => (!pos || p.pos === pos) && (!q || p.name.toLowerCase().includes(q) || p.team.toLowerCase() === q)).sort(compareVona(score()));
  });
  const byPosition = createMemo(() => POSITIONS.map((pos) => ({ pos, players: available().filter((p) => p.pos === pos) })));

  const pick = (p: AidPlayer) => {
    if (drafted().has(p.id)) return;
    setManual([...manual(), p.id]);
  };
  const unpick = (row: HistoryRow) => {
    if (row.pick) return;
    setManual(manual().filter((id) => id !== row.playerId));
  };
  const undo = () => setManual(manual().slice(0, -1));
  const reset = () => setManual([]);

  /** Who's on the clock at ESPN, in a snake draft with a known order. */
  const onClock = createMemo(() => {
    const d = data();
    const dr = draft();
    if (!d || !dr || dr.drafted || dr.type !== "SNAKE" || !d.pickOrder.length) return null;
    const n = dr.picks.length + 1;
    const teamId = snakePicker(d.pickOrder, n);
    const team = teamId === undefined ? undefined : teamOf(teamId);
    let mine = 0;
    for (let k = n; k <= n + d.pickOrder.length * 2; k++) {
      const t = snakePicker(d.pickOrder, k);
      if (t !== undefined && teamOf(t)?.isMe) {
        mine = k - n;
        break;
      }
    }
    return { n, round: Math.floor((n - 1) / d.pickOrder.length) + 1, team, untilMine: mine };
  });

  /** My roster so far, by position, from ESPN's picks. */
  const mine = createMemo(() => {
    const counts = new Map<string, number>();
    for (const r of history()) {
      if (!r.pick || !teamOf(r.pick.teamId)?.isMe || !r.player) continue;
      counts.set(r.player.pos, (counts.get(r.player.pos) ?? 0) + 1);
    }
    return POSITIONS.filter((pos) => counts.has(pos)).map((pos) => `${pos} ${counts.get(pos)}`);
  });

  const draftNote = () => {
    const dr = draft();
    if (!dr) return "";
    if (dr.drafted) return `ESPN draft complete, ${dr.picks.length} picks`;
    if (dr.inProgress) return `ESPN draft live, ${dr.picks.length} picks so far`;
    return "ESPN draft not started";
  };
  const replacementNote = () =>
    Object.entries(data()?.valuation.replacement ?? {})
      .map(([pos, r]) => `${pos}${r}`)
      .join(" ");

  return (
    <div class="aid">
      <section class="aid-col">
        <header class="aid-head">
          <h3>
            Available by {roll() ? "rollout" : "VONA"}
            <small>
              {available().length} of {data()?.players.length ?? 0} ·{" "}
              <Show when={roll()} fallback={<>VONA at pick #{nextPick()}, {byPos() ? "own position" : "whole board"}</>}>
                {(r) => (
                  <>
                    {r().sims} rollouts to pick #{r().myPicks[r().myPicks.length - 1] ?? nextPick()} ({r().myPicks.length}{" "}
                    <span title={r().slotKnown ? "your picks, from ESPN's draft order and the team your SWID owns" : "ESPN's draft order or your team is unknown, so the pick on the clock is assumed to be yours"}>
                      {r().slotKnown ? "of mine" : "assumed mine"}
                    </span>
                    , {Math.round(r().ms)} ms)
                  </>
                )}
              </Show>
            </small>
          </h3>
          <div class="aid-controls">
            <input class="aid-search" type="search" placeholder="search name or team" value={search()} onInput={(e) => setSearch(e.currentTarget.value)} />
            <label class="aid-check" title="keep drafted players in the list, struck through">
              <input type="checkbox" checked={showDrafted()} onChange={(e) => setShowDrafted(e.currentTarget.checked)} /> drafted
            </label>
            <span class="aid-methods">
              <For each={METHODS}>
                {(m) => (
                  <button class="chip" classList={{ on: method() === m.id }} title={m.title} onClick={() => setMethod(m.id)}>
                    {m.label}
                  </button>
                )}
              </For>
            </span>
          </div>
          <div class="legend">
            <button class="chip" classList={{ on: posFilter() === null }} onClick={() => setPosFilter(null)}>
              all
            </button>
            <For each={POSITIONS}>
              {(pos) => (
                <button class={"chip " + posClass(pos)} classList={{ on: posFilter() === pos }} onClick={() => setPosFilter(posFilter() === pos ? null : pos)}>
                  {pos}
                </button>
              )}
            </For>
          </div>
        </header>
        <Show when={data.loading}>
          <p class="dim">loading player pool…</p>
        </Show>
        <Show when={data.error}>
          <p class="error">{String(data.error?.message ?? data.error)}</p>
        </Show>
        <div class="aid-scroll">
          <table class="aid-list">
            <thead>
              <tr>
                <th class="n">#</th>
                <th
                  class="n"
                  title={
                    roll()
                      ? "edge: the expected value of your finished starting lineup if you take him here, minus what the best alternative gets you"
                      : `value over next available: value minus the best value among the players ${byPos() ? "at the same position " : ""}expected (by ADP) to survive ${VONA_ROUNDS} rounds from now`
                  }
                >
                  {roll() ? "edge" : "VONA"}
                </th>
                <th title="Boris Chen tier at the position, from the draft-time consensus">tier</th>
                <th>pos</th>
                <th>player · team · bye</th>
                <th class="n" title="ESPN consensus rest-of-season positional rank">ESPN</th>
                <th class="n" title="season points per game, ESPN and Sleeper averaged">ppg</th>
                <th class="n" title="ESPN average draft position">ADP</th>
              </tr>
            </thead>
            <tbody>
              <For each={listed()}>
                {(p, i) => (
                  <tr classList={{ gone: drafted().has(p.id), pickable: !drafted().has(p.id) }} onClick={() => pick(p)}>
                    <td class="n dim">{i() + 1}</td>
                    <td class="n">{vonaLabel(score().get(p.id))}</td>
                    <td class="dim">{tierLabel(p)}</td>
                    <td class={posClass(p.pos)}>{p.pos}</td>
                    <td class="who">
                      <PlayerName p={p} />
                    </td>
                    <td class="n dim">{rankLabel(p)}</td>
                    <td class="n">{num(p.ppg)}</td>
                    <td class="n dim">{p.adp === undefined ? "–" : num(p.adp, 0)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </section>

      <section class="aid-col">
        <header class="aid-head">
          <h3>
            Top picks by position <small>replacement {replacementNote()}</small>
          </h3>
        </header>
        <div class="aid-scroll aid-blocks">
          <For each={byPosition()}>
            {(b) => (
              <div class="aid-block">
                <div class="aid-block-title">
                  <span class={posClass(b.pos)}>{b.pos}</span> <span class="dim">{b.players.length} left</span>
                </div>
                <table>
                  <tbody>
                    <For each={b.players.slice(0, BLOCK_DEPTH[b.pos] ?? 10)}>
                      {(p) => (
                        <tr class={"pickable " + tierClass(p)} onClick={() => pick(p)}>
                          <td class="dim tier">{tierLabel(p)}</td>
                          <td class="who">
                            <PlayerName p={p} />
                          </td>
                          <td class="n">{valueLabel(p)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            )}
          </For>
        </div>
      </section>

      <section class="aid-col">
        <header class="aid-head">
          <h3>
            Draft history <small>{history().length} picks</small>
          </h3>
          <div class="aid-controls">
            <button class="more" onClick={undo} disabled={manual().length === 0} title="take back the last click">
              undo
            </button>
            <button class="more" onClick={reset} disabled={manual().length === 0} title="clear every click (ESPN's picks stay)">
              reset
            </button>
            <label class="aid-check" title="count ESPN's draft picks as drafted, refreshed every 15 s while the draft is live">
              <input type="checkbox" checked={sync()} onChange={(e) => setSync(e.currentTarget.checked)} /> ESPN picks
            </label>
          </div>
          <div class="aid-status dim">
            <Show when={draft()}>
              <div>{draftNote()}</div>
            </Show>
            <Show when={onClock()}>
              {(c) => (
                <div>
                  on the clock: #{c().n} (R{c().round}) {c().team?.abbrev ?? "?"}
                  <Show when={c().team?.isMe}> <b class="up">you</b></Show>
                  <Show when={!c().team?.isMe && c().untilMine > 0}> · yours in {c().untilMine}</Show>
                </div>
              )}
            </Show>
            <Show when={mine().length}>
              <div>my picks: {mine().join(" · ")}</div>
            </Show>
            <Show when={sync() && polled()}>{(t) => <div>refreshed {t().toLocaleTimeString()}</div>}</Show>
            <Show when={pollError()}>{(e) => <div class="error">{e()}</div>}</Show>
          </div>
        </header>
        <div class="aid-scroll">
          <table class="aid-history">
            <tbody>
              <For each={[...history()].reverse()}>
                {(r) => (
                  <tr classList={{ manual: !r.pick, me: !!r.pick && !!teamOf(r.pick.teamId)?.isMe }} onClick={() => unpick(r)} title={r.pick ? undefined : "click to put back"}>
                    <td class="n dim">{r.n}</td>
                    <td class={r.player ? posClass(r.player.pos) : "dim"}>{r.player?.pos ?? "?"}</td>
                    <td class="who">
                      <Show when={r.player} fallback={<span class="dim">player {r.playerId}</span>}>
                        {(p) => <PlayerName p={p()} />}
                      </Show>
                    </td>
                    <td class="dim team">{r.pick ? (teamOf(r.pick.teamId)?.abbrev ?? r.pick.teamId) : "click"}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </section>

      <Show when={data()}>
        {(d) => (
          <p class="dim note aid-note">
            {d().league.name} · {d().league.season}
            <Show when={d().tiers}>{(t) => <> · Boris tiers ({t().scoring}, {t().updated.slice(0, 10)})</>}</Show>
            <Show when={d().tiersError}>
              <span class="error"> · Boris tiers unavailable, valuing by rank</span>
            </Show>
            <Show when={d().sleeperError}>
              <span class="error"> · Sleeper unavailable, ppg is ESPN only</span>
            </Show>
            <Show when={d().curvesError}>
              <span class="error"> · history unavailable, linear value</span>
            </Show>
            <Show when={d().byeError}>
              <span class="error"> · bye weeks unavailable</span>
            </Show>
            {" "}· Value is season points over the waiver wire (the replacement ranks above, as the ratings use), averaged over the player's Boris Chen tier and not floored.
            <Show
              when={roll()}
              fallback={
                <>
                  {" "}VONA is that value minus the best value among the players{byPos() ? " at the same position" : ", any position,"} whose ESPN ADP says they'll still be there {VONA_ROUNDS} rounds from the pick on the clock (#{nextPick()}), so the best of those sits at 0 and a positive figure is what waiting would cost; the whole value when nobody would survive.
                  {byPos()
                    ? " “VONA·pos” is the classic version: it measures how much of a position's supply falls off before your next pick, so the last good TE rises even when the raw values on the board are all running back — but figures at different positions are no longer on one scale."
                    : " Measured against the whole board it asks what the pick costs against the best thing that will still be there, which keeps every position on one scale."}
                  {" "}Both readings hang on a horizon picked by hand and on ADP as a yes/no cutoff, and at a turn — back-to-back picks — every VONA correctly collapses to zero, because waiting costs nothing when you pick again immediately.
                </>
              }
            >
              {(r) => (
                <>
                  {" "}“Edge” drops the horizon. It rolls the rest of the draft forward {r().sims} times from the pick on the clock — opponents picking from a softmax on ADP, damped at positions they've already filled — and scores each of the top {r().scored} players by the starting lineup you finish with if you take him now and then draft greedily through your own remaining picks (#{r().myPicks.join(", #")}). The figure is that expectation minus the best alternative's, so the pick is the single positive number and everyone else's is what taking them instead would give up; players past the scored set take their position's average continuation, below which the order is value order anyway.
                  {" "}Because availability is sampled rather than thresholded, a faller is still on the board rather than assumed gone, exactly one player leaves per pick, and positional runs are correlated across simulations. And because the continuation is marginal lineup value against the roster you already hold, a turn still discriminates: it picks the pair, not the player.
                </>
              )}
            </Show>
            {" "}The list is sorted by that figure, so the top row is the pick; ties go to value, then Boris's own order. Untiered players sit at the bottom by ESPN draft rank. Click a player to mark them
            drafted; clicks are remembered per league in this browser.
          </p>
        )}
      </Show>
    </div>
  );
}
