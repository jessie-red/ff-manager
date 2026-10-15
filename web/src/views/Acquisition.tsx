import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { acquirePlayer, fetchAcquisition, fetchRatings, type AcquisitionResponse, type MyTeam, type Player, type TeamRating } from "../api.js";
import type { TradeSeed } from "../App.jsx";
import { POSITION_NAMES, PRO_TEAMS } from "../../../src/espn/constants.js";
import { findTrades, tradeValue } from "../../../src/model/trade.js";

type Candidate = AcquisitionResponse["players"][number];
const roster = (t: TeamRating) => ({ teamId: t.teamId, players: [
  ...t.ros.starters.map(s => s.player).filter((p): p is Player => p !== null), ...t.ros.bench,
] });
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

export function Acquisition(props: { teams: MyTeam[]; loading: boolean; error: unknown; onTrade: (m: MyTeam, seed: TradeSeed) => void }) {
  const [chosenSeason, setSeason] = createSignal<number>();
  const seasons = createMemo(() => [...new Set(props.teams.map(t => t.season))].sort((a, b) => b - a));
  const season = () => seasons().includes(chosenSeason()!) ? chosenSeason()! : seasons()[0];
  const teams = createMemo(() => props.teams.filter(t => t.season === season()));
  const [message, setMessage] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<Candidate>();
  const [tradesRequested, setTradesRequested] = createSignal(false);
  const selectPlayer = (player: Candidate | undefined) => {
    setTradesRequested(false);
    setSelected(player);
  };
  const [pools, { refetch }] = createResource(teams, async mine => Promise.all(mine.map(async team => {
    try { return { team, data: await fetchAcquisition({ league: team.leagueId, season: team.season, teamId: team.teamId }), error: "" }; }
    catch (error) { return { team, data: undefined, error: String(error instanceof Error ? error.message : error) }; }
  })));
  const results = createMemo(() => {
    if (pools.loading) return [];
    const all = new Map<number, Candidate>();
    for (const pool of pools() ?? []) for (const p of pool.data?.players ?? []) all.set(p.id, p);
    const words = query().toLowerCase().trim().split(/\s+/).filter(Boolean);
    return words.length ? [...all.values()].filter(p => words.every(w => `${p.name} ${POSITION_NAMES[p.positionId]} ${PRO_TEAMS[p.proTeamId]}`.toLowerCase().includes(w))).sort((a,b) => a.name.localeCompare(b.name)).slice(0, 30) : [];
  });
  return <section class="acquisition">
    <h1>Player Acquisition</h1>
    <p class="dim">Find a player, then expand each league to explore a trade, add a free agent or submit a waiver claim.</p>
    <label class="field">Season <select value={season()} onChange={e => { setSeason(Number(e.currentTarget.value)); selectPlayer(undefined); }}><For each={seasons()}>{year => <option value={year}>{year}</option>}</For></select></label>
    <label class="field acquisition-search">Player search<input type="search" placeholder="Player name, position or NFL team" value={query()} onInput={e => { setQuery(e.currentTarget.value); selectPlayer(undefined); }} /></label>
    <Show when={message()}><p role="status">{message()}</p></Show>
    <Show when={props.loading || pools.loading}><p role="status">Loading league player pools…</p></Show>
    <Show when={props.error || pools.error}><p class="error" role="alert">{String(props.error || pools.error)}</p></Show>
    <Show when={!props.loading && !teams().length}><p>No visible teams available for this season. Use Settings to show leagues.</p></Show>
    <Show when={!selected() && query().trim() && !pools.loading}>
      <div class="acquisition-results"><For each={results()} fallback={<p class="dim">No matching players in the loaded leagues.</p>}>{p => <button onClick={() => selectPlayer(p)}>{p.name} <span class="dim">{POSITION_NAMES[p.positionId]} · {PRO_TEAMS[p.proTeamId]}</span></button>}</For></div>
    </Show>
    <Show when={selected()}>{p => <h2>{p().name} <span class="dim">{POSITION_NAMES[p().positionId]} · {PRO_TEAMS[p().proTeamId]}</span></h2>}</Show>
    <button class="more" disabled={pools.loading} onClick={() => { setTradesRequested(false); refetch(); }}>Refresh availability</button>{" "}
    <button class="more" disabled={!selected() || pools.loading || tradesRequested()} onClick={() => setTradesRequested(true)}>
      {tradesRequested() ? "Trade proposals requested" : "Load trade proposals"}
    </button>
    <Show when={tradesRequested()}><p class="dim" role="status">Trade proposals load in every eligible league. Expand a league to see its results or retry a failed request.</p></Show>
    <Show when={!pools.loading}><For each={pools()}>{pool => <details class="acquisition-league">
      <summary>{pool.team.leagueName} <span class="dim">· {pool.team.teamName} · {pool.error ? "Unavailable" : selected() ? (() => { const p = pool.data?.players.find(p => p.id === selected()!.id); return !p ? "Unknown" : p.ownerId === pool.team.teamId ? "On your roster" : p.ownerId > 0 ? "Trade" : p.status === "WAIVERS" ? "Waivers" : p.status === "FREEAGENT" ? "Free agent" : "Unknown"; })() : "Select a player"}</span></summary>
      <Show when={pool.error}><p class="error" role="alert">{pool.error}</p></Show>
      <Show when={pool.data && selected()?.id} keyed>{id => <LeaguePlayer team={pool.team} data={pool.data!} playerId={id} loadTrades={tradesRequested()} onTrade={props.onTrade} onAcquired={message => { setMessage(message); setTradesRequested(false); void refetch(); }} />}</Show>
    </details>}</For></Show>
  </section>;
}

function LeaguePlayer(props: { team: MyTeam; data: AcquisitionResponse; playerId: number; loadTrades: boolean; onAcquired: (message: string) => void; onTrade: (m: MyTeam, seed: TradeSeed) => void }) {
  const player = () => props.data.players.find(p => p.id === props.playerId);
  const [ratings, { refetch }] = createResource(() => props.loadTrades && player() && player()!.ownerId > 0 && player()!.ownerId !== props.team.teamId ? { league: props.team.leagueId, season: props.team.season, championship: 0 as const } : false, fetchRatings);
  const ideas = createMemo(() => {
    const data = ratings();
    if (!data || ratings.loading || ratings.error) return [];
    const me = data.ratings.find(t => t.teamId === props.team.teamId);
    const owner = data.ratings.find(t => t.teamId === player()?.ownerId);
    if (!me || !owner) return [];
    const slots = new Map<number, number>();
    for (const s of me.ros.starters) slots.set(s.slotId, (slots.get(s.slotId) ?? 0) + 1);
    return findTrades(roster(me), [roster(owner)], slots, { maxSide: 2, minTheirGain: -1, value: tradeValue(data.valuation, !!data.ros) }).filter(t => t.get.some(p => p.id === props.playerId)).slice(0, 20);
  });
  const open = (give: number[], get: number[]) => props.onTrade(props.team, { teamId: props.team.teamId, partnerId: player()!.ownerId, give, get });
  return <Show when={player()} fallback={<p>Availability is unknown in this league. Refresh to check again.</p>}>{p => <>
    <Show when={p().ownerId === props.team.teamId}><p>Already on your roster.</p></Show>
    <Show when={p().ownerId === 0}>
      <Show when={p().status === "FREEAGENT" || p().status === "WAIVERS"} fallback={<p>Availability is unknown. Refresh to check again.</p>}>
        <Pickup team={props.team} data={props.data} player={p()} onAcquired={props.onAcquired} />
      </Show>
    </Show>
    <Show when={p().ownerId > 0 && p().ownerId !== props.team.teamId}>
      <p>Rostered by {props.data.teams.find(t => t.id === p().ownerId)?.name ?? `team ${p().ownerId}`}.</p>
      <button class="more" onClick={() => open([], [props.playerId])}>Build a custom trade</button>
      <Show when={ratings.loading}><p role="status">Loading trade data…</p></Show>
      <Show when={ratings.error}><p class="error" role="alert">{String(ratings.error)}</p><button onClick={() => refetch()}>Retry</button></Show>
      <Show when={ratings() && !ratings.loading && !ratings.error}>
        <p class="dim">Up to two players per side; improves your starting lineup and costs the other team at most 1 projected point per week.</p>
        <For each={ideas()} fallback={<p>No matching proposals. Try building a custom trade.</p>}>{trade => <div class="acquisition-offer">
          <div><strong>Give:</strong> {trade.give.map(p => p.name).join(" + ")}<br/><strong>Get:</strong> {trade.get.map(p => p.name).join(" + ")}<br/><span class="dim">Lineup ppg: you {signed(trade.myGain)} · them {signed(trade.theirGain)}</span></div>
          <button class="more" onClick={() => open(trade.give.map(p => p.id), trade.get.map(p => p.id))}>Review trade</button>
        </div>}</For>
      </Show>
    </Show>
  </>}</Show>;
}

function Pickup(props: { team: MyTeam; data: AcquisitionResponse; player: Candidate; onAcquired: (message: string) => void }) {
  const [review, setReview] = createSignal(false);
  const [drop, setDrop] = createSignal("");
  const [bid, setBid] = createSignal("0");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal("");
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const player = props.player;
    if (!player || sending()) return;
    setSending(true);
    setError("");
    try {
      const result = await acquirePlayer({
        league: props.team.leagueId, season: props.team.season, teamId: props.team.teamId,
        addPlayerId: player.id, dropPlayerId: drop() ? Number(drop()) : undefined, send: true,
        ...(player.status === "WAIVERS" ? { type: "WAIVER" as const, bidAmount: Number(bid()) } : { type: "FREEAGENT" as const }),
      });
      if (!result.sent) throw new Error("The acquisition was not submitted.");
      props.onAcquired(player.status === "WAIVERS" ? `Waiver claim submitted for ${player.name}.` : `${player.name} added to your team.`);
      setReview(false);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally { setSending(false); }
  };

  return <>
    <Show when={!review()}><button class="free-agency-add" classList={{ "on-waivers": props.player.status === "WAIVERS" }} onClick={() => { setDrop(""); setBid("0"); setError(""); setReview(true); }}>
      {props.player.status === "WAIVERS" ? "+ Claim" : "+ Add"} {props.player.name}
    </button></Show>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={review()}> <form class="free-agency-review" onSubmit={submit}>
      <h2>{props.player.status === "WAIVERS" ? "Claim" : "Add"} {props.player.name}</h2>
      <p>{props.player.status === "WAIVERS" ? "Submit a waiver claim for this player." : "This pickup takes effect immediately."}</p>
      <label class="field">Drop a player
        <select value={drop()} disabled={sending()} onChange={e => setDrop(e.currentTarget.value)}>
          <option value="">No drop</option>
          <For each={props.data.players.filter(player => player.ownerId === props.team.teamId)}>{player => <option value={player.id}>{player.name}</option>}</For>
        </select>
      </label>
      <Show when={props.player.status === "WAIVERS"}><label class="field">FAAB bid
        <input type="number" min="0" step="1" required value={bid()} disabled={sending()} onInput={e => setBid(e.currentTarget.value)} />
      </label></Show>
      <Show when={drop()}><p>Drop {props.data.players.find(player => player.id === Number(drop()))?.name} if this pickup succeeds.</p></Show>
      <div class="free-agency-toolbar">
        <button type="submit" class="free-agency-add" classList={{ "on-waivers": props.player.status === "WAIVERS" }} disabled={sending()}>
          {sending() ? "Submitting…" : props.player.status === "WAIVERS" ? "Submit waiver claim" : "Confirm add"}
        </button>
        <button type="button" class="more" disabled={sending()} onClick={() => setReview(false)}>Cancel</button>
      </div>
    </form></Show>
  </>;
}
