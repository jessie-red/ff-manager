import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { acquirePlayer, fetchAcquisition, type AcquisitionResponse, type MyTeam } from "../api.js";
import { POSITION_NAMES, PRO_TEAMS } from "../../../src/espn/constants.js";

export function FreeAgency(props: { team: MyTeam; week?: number }) {
  const [query, setQuery] = createSignal("");
  const [position, setPosition] = createSignal("");
  const [pool, { refetch }] = createResource(
    () => ({ league: props.team.leagueId, season: props.team.season, teamId: props.team.teamId, week: props.week, stats: 1 }),
    fetchAcquisition,
  );
  const available = createMemo(() => (pool()?.players ?? [])
    .filter(p => p.ownerId === 0 && (p.status === "FREEAGENT" || p.status === "WAIVERS"))
    .sort((a, b) => a.name.localeCompare(b.name)));
  const columns = [
    { key: "percentOwned", label: "Rostered %", title: "Percentage rostered across ESPN leagues" },
    { key: "espnProjection", label: "ESPN proj", title: "Selected week's projected points in league scoring" },
    { key: "sleeperProjection", label: "Sleeper proj", title: "Selected week's Sleeper projected points" },
    { key: "weekRank", label: "Weekly rank", title: "ESPN analyst consensus rank within position for the selected week" },
    { key: "rosRank", label: "ROS rank", title: "ESPN analyst consensus rest-of-season rank within position" },
  ] as const;
  type SortKey = typeof columns[number]["key"] | "name";
  const [sort, setSort] = createSignal<SortKey>("percentOwned");
  const [ascending, setAscending] = createSignal(false);
  const changeSort = (key: SortKey) => {
    if (sort() === key) setAscending(value => !value);
    else { setSort(key); setAscending(key === "name" || key === "weekRank" || key === "rosRank"); }
  };
  const sortLabel = (key: SortKey) => sort() === key ? ascending() ? "ascending" as const : "descending" as const : "none" as const;
  const arrow = (key: SortKey) => sort() === key ? ascending() ? " ↑" : " ↓" : " ↕";
  const display = (value: number | null) => value === null ? "—" : value.toFixed(1);
  const players = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return available().filter(p => (!position() || String(p.positionId) === position()) && words.every(word =>
      `${p.name} ${POSITION_NAMES[p.positionId] ?? ""} ${PRO_TEAMS[p.proTeamId] ?? ""} ${p.positionId === 16 ? "DST defense special teams" : ""}`.toLowerCase().includes(word))).sort((a, b) => {
        const av = a[sort()], bv = b[sort()];
        if (av === null) return bv === null ? a.name.localeCompare(b.name) : 1;
        if (bv === null) return -1;
        const compared = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv);
        return compared * (ascending() ? 1 : -1) || a.name.localeCompare(b.name);
      });
  });
  const [selected, setSelected] = createSignal<AcquisitionResponse["players"][number]>();
  const [drop, setDrop] = createSignal("");
  const [bid, setBid] = createSignal("0");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal("");
  const [message, setMessage] = createSignal("");
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const player = selected();
    if (!player || sending()) return;
    setSending(true);
    setError("");
    setMessage("");
    try {
      const result = await acquirePlayer({
        league: props.team.leagueId, season: props.team.season, teamId: props.team.teamId,
        addPlayerId: player.id, dropPlayerId: drop() ? Number(drop()) : undefined, send: true,
        ...(player.status === "WAIVERS" ? { type: "WAIVER" as const, bidAmount: Number(bid()) } : { type: "FREEAGENT" as const }),
      });
      if (!result.sent) throw new Error("The acquisition was not submitted.");
      setMessage(player.status === "WAIVERS" ? `Waiver claim submitted for ${player.name}.` : `${player.name} added to your team.`);
      setSelected(undefined);
      await refetch();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally { setSending(false); }
  };

  return <section class="free-agency">
    <h1>Free Agency</h1>
    <p class="dim">{props.team.leagueName} · {props.team.teamName} · {props.team.season}</p>
    <div class="free-agency-toolbar">
      <label class="field">Find a player
        <input type="search" placeholder="Name, position or NFL team" value={query()} onInput={e => setQuery(e.currentTarget.value)} />
      </label>
      <label class="field">Position
        <select value={position()} onChange={e => setPosition(e.currentTarget.value)}>
          <option value="">All positions</option>
          <For each={[1, 2, 3, 4, 5, 16]}>{id => <option value={id}>{POSITION_NAMES[id]}</option>}</For>
        </select>
      </label>
      <button class="more" disabled={pool.loading} onClick={() => refetch()}>Refresh availability</button>
    </div>
    <p class="dim">Green: free agent · Amber: on waivers. Choose a player to review your pickup.</p>
    <Show when={message()}><p role="status">{message()}</p></Show>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={selected()}>{p => <form class="free-agency-review" onSubmit={submit}>
      <h2>{p().status === "WAIVERS" ? "Claim" : "Add"} {p().name}</h2>
      <p>{p().status === "WAIVERS" ? "Submit a waiver claim for this player." : "This pickup takes effect immediately."}</p>
      <label class="field">Drop a player
        <select value={drop()} disabled={sending()} onChange={e => setDrop(e.currentTarget.value)}>
          <option value="">No drop</option>
          <For each={pool()?.players.filter(player => player.ownerId === props.team.teamId)}>{player => <option value={player.id}>{player.name}</option>}</For>
        </select>
      </label>
      <Show when={p().status === "WAIVERS"}><label class="field">FAAB bid
        <input type="number" min="0" step="1" required value={bid()} disabled={sending()} onInput={e => setBid(e.currentTarget.value)} />
      </label></Show>
      <Show when={drop()}><p>Drop {pool()?.players.find(player => player.id === Number(drop()))?.name} if this pickup succeeds.</p></Show>
      <div class="free-agency-toolbar">
        <button type="submit" class="free-agency-add" classList={{ "on-waivers": p().status === "WAIVERS" }} disabled={sending()}>
          {sending() ? "Submitting…" : p().status === "WAIVERS" ? "Submit waiver claim" : "Confirm add"}
        </button>
        <button type="button" class="more" disabled={sending()} onClick={() => setSelected(undefined)}>Cancel</button>
      </div>
    </form>}</Show>
    <Show when={pool.loading}><p role="status">Loading available players…</p></Show>
    <Show when={pool.error}><p class="error" role="alert">{String(pool.error?.message ?? pool.error)}</p><button class="more" onClick={() => refetch()}>Retry</button></Show>
    <Show when={!pool.loading && !pool.error && pool()}>
      <p class="dim">Week {pool()?.week} projections · ESPN positional rankings · Missing data: —{pool()?.sleeperScoring && pool()?.sleeperScoring !== "league" ? ` · Sleeper uses ${pool()?.sleeperScoring} preset scoring` : ""}</p>
      <Show when={pool()?.sleeperError}><p class="error" role="alert">Sleeper projections unavailable: {pool()?.sleeperError}</p></Show>
      <p class="dim" role="status">{players().length} of {available().length} available players</p>
      <div class="free-agency-table">
        <table>
          <thead><tr><th aria-sort={sortLabel("name")}><button class="fa-sort" onClick={() => changeSort("name")}>Player{arrow("name")}</button></th><th>Position</th><th>Team</th><For each={columns}>{c => <th class="n" aria-sort={sortLabel(c.key)}><button class="fa-sort" title={c.title} onClick={() => changeSort(c.key)}>{c.label}{arrow(c.key)}</button></th>}</For><th>Status</th><th>Add player</th></tr></thead>
          <tbody><For each={players()}>{p => <tr>
            <td>{p.name}</td><td>{POSITION_NAMES[p.positionId] ?? "—"}</td><td>{PRO_TEAMS[p.proTeamId] ?? "—"}</td>
            <For each={columns}>{c => <td class="n">{display(p[c.key])}{c.key === "percentOwned" && p[c.key] !== null ? "%" : ""}</td>}</For>
            <td title={p.status === "WAIVERS" ? "Waivers" : "Free agent"}>{p.status === "WAIVERS" ? "W" : "FA"}</td>
            <td><button class="free-agency-add" classList={{ "on-waivers": p.status === "WAIVERS" }} disabled={sending()}
              onClick={() => { setSelected(p); setDrop(""); setBid("0"); setError(""); setMessage(""); }}
              aria-label={`${p.status === "WAIVERS" ? "Claim" : "Add"} ${p.name}`}>
              {p.status === "WAIVERS" ? "+ Claim" : "+ Add"}
            </button></td>
          </tr>}</For></tbody>
        </table>
      </div>
      <Show when={!players().length}><p class="dim">{query().trim() || position() ? "No players match your filters." : "No available players in this league."}</p></Show>
    </Show>
  </section>;
}
