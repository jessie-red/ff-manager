import { gameLabel } from "../game.js";
import { statusTag } from "../../../src/model/player.js";
import type { MatchupTeam } from "../../../src/server/dashboard.js";
import { isStarter, slotLabel } from "../../../src/model/management.js";
import { BENCH_SLOT, IR_SLOT, SLOT_FILL_ORDER } from "../../../src/espn/constants.js";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { fetchMatchup, type MatchupResponse, type MyTeam } from "../api.js";

export function Dashboard(props: { teams: MyTeam[]; loading: boolean; error?: unknown; onOpen: (team: MyTeam) => void }) {
  const seasons = createMemo(() => [...new Set(props.teams.map((t) => t.season))].sort((a, b) => b - a));
  const [selectedSeason, setSelectedSeason] = createSignal<number>();
  const season = () => selectedSeason() ?? seasons()[0];
  const teams = createMemo(() => props.teams.filter((t, i, all) => t.season === season() &&
    all.findIndex((x) => x.leagueId === t.leagueId && x.season === t.season && x.teamId === t.teamId) === i));
  return <div class="dashboard">
    <header class="team-head">
      <h2>Dashboard</h2>
      <label class="field inline"><span>Season</span>
        <select value={season()} onChange={(e) => setSelectedSeason(Number(e.currentTarget.value))}>
          <For each={seasons()}>{(s) => <option value={s}>{s}</option>}</For>
        </select>
      </label>
    </header>
    <p class="note dim">Your active matchup in every league. ESPN matchup totals update every 30 seconds while this tab is visible, including all weeks of a multi-week matchup.</p>
    <Show when={props.loading}><p class="dim" role="status">Loading your leagues…</p></Show>
    <Show when={props.error}><p class="error" role="alert">Could not load leagues: {String(props.error)}</p></Show>
    <Show when={!props.loading && !props.error && !teams().length}><p class="dim">No fantasy football teams found.</p></Show>
    <div class="dashboard-grid">
      <For each={teams()}>{(team) => <MatchupCard team={team} onOpen={() => props.onOpen(team)} />}</For>
    </div>
  </div>;
}

function MatchupCard(props: { team: MyTeam; onOpen: () => void }) {
  const [data, setData] = createSignal<MatchupResponse>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let disposed = false;
  async function refresh() {
    if (disposed || busy()) return;
    setBusy(true);
    try {
      const result = await fetchMatchup({ league: props.team.leagueId, season: props.team.season, teamId: props.team.teamId });
      if (!disposed) { setData(result); setError(""); }
    } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (!disposed) setBusy(false); }
  }
  void refresh();
  const visible = () => { if (!document.hidden) void refresh(); };
  const timer = setInterval(visible, 30_000);
  document.addEventListener("visibilitychange", visible);
  onCleanup(() => { disposed = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); });
  return <section class="dashboard-card" aria-label={props.team.leagueName}>
    <h3>{props.team.leagueName}</h3>
    <p class="dim"><button type="button" class="dashboard-team-link" onClick={props.onOpen}>{props.team.teamName}</button> · {props.team.season}</p>
    <Show when={data()} fallback={<p class="dim">{busy() ? "Loading matchup…" : "Scores unavailable"}</p>}>
      {(d) => <>
        <p class="dim">Week {d().week} · Matchup {d().matchupPeriod}</p>
        <p class="note dim">Player points: Week {d().week}. Team totals: full matchup. Game times are local.</p>
        <Show when={d().scheduleError}><p class="dim">{d().scheduleError}</p></Show>
        <For each={d().matchups} fallback={<p class="dim">No matchup scheduled for the current period.</p>}>
          {(m) => <div class="dashboard-matchup">
            <MatchupPlayers mine={m.mine} opponent={m.opponent} onOpen={props.onOpen} />
            <span class="dim">{m.status === "final" ? "Final" : m.status === "bye" ? "No opponent" : "Current matchup"}</span>
          </div>}
        </For>
        <p class="note dim">Last fetched {new Date(d().fetchedAt).toLocaleTimeString()}</p>
      </>}
    </Show>
    <Show when={error()}><p class="error" role="alert">{data() ? "Scores may be stale: " : "Scores unavailable: "}{error()}</p></Show>
  </section>;
}

type MatchupPlayer = NonNullable<MatchupTeam["players"]>[number];

function MatchupPlayers(props: { mine: MatchupTeam; opponent: MatchupTeam | null; onOpen: () => void }) {
  const players = (team: MatchupTeam | null, group: string) => (team?.players ?? [])
    .filter((p) => group === "Starters" ? isStarter(p.slotId) : p.slotId === (group === "Bench" ? BENCH_SLOT : IR_SLOT))
    .sort((a, b) => group === "Starters" ? SLOT_FILL_ORDER.indexOf(a.slotId) - SLOT_FILL_ORDER.indexOf(b.slotId) : 0);
  const groups = createMemo(() => ["Starters", "Bench", "IR"].map((label) => {
    const mine = players(props.mine, label);
    const opponent = players(props.opponent, label);
    return { label, rows: Array.from({ length: Math.max(mine.length, opponent.length) }, (_, i) => ({ mine: mine[i], opponent: opponent[i] })) };
  }));
  return <div class="dashboard-sides">
    <For each={[props.mine, props.opponent]}>{(team, index) => <div class="dashboard-side-head">
      <Show when={team} fallback={<p class="dim">Bye · No opponent</p>}>
        {(t) => <>
          <h4><Show when={index() === 0} fallback={t().name}><button type="button" class="dashboard-team-link" onClick={props.onOpen}>{t().name} (you)</button></Show></h4>
          <strong>{t().points?.toFixed(2) ?? "–"}</strong>
          <Show when={t().players === null}><p class="dim">Roster unavailable</p></Show>
          <Show when={t().players?.length === 0}><p class="dim">Empty roster</p></Show>
        </>}
      </Show>
    </div>}</For>
    <For each={groups()}>{(group) => <Show when={group.rows.length}>
      <h5 class="dashboard-group">{group.label}</h5>
      <For each={group.rows}>{(row) => <div class="dashboard-player-pair">
        <PlayerCell player={row.mine} teamName={props.mine.name} />
        <PlayerCell player={row.opponent} teamName={props.opponent?.name ?? "No opponent"} />
      </div>}</For>
    </Show>}</For>
  </div>;
}

function PlayerCell(props: { player?: MatchupPlayer; teamName: string }) {
  return <div class="dashboard-player-cell" aria-label={props.teamName}>
    <Show when={props.player} fallback={<span class="dim">–</span>}>
      {(p) => <>
        <div class="dashboard-player-name"><span>{p().name}<Show when={!["ACTIVE", "NORMAL"].includes(p().injuryStatus)}>
          <span class="dashboard-injury" title={p().injuryStatus.replaceAll("_", " ")} aria-label={p().injuryStatus.replaceAll("_", " ")}>{statusTag(p().injuryStatus)}</span>
        </Show></span><small class="dim">{[...new Set([slotLabel(p().slotId), p().position]), p().nflTeam].join(" · ")}</small><small class="dim">{gameLabel(p().game)}</small></div>
        <strong aria-label={`${p().name} actual points`}>{p().actual?.toFixed(1) ?? "–"}</strong>
      </>}
    </Show>
  </div>;
}
