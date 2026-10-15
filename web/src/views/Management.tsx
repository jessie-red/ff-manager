import { batch, createEffect, createMemo, createResource, createSignal, onCleanup, For, Show } from "solid-js";
import { Logo, type TeamViewProps } from "../App.jsx";
import { fetchRoster, fetchScores, saveLineup, type Player, type RosterResponse, type ScoresResponse } from "../api.js";
import { statusTag } from "../../../src/model/player.js";
import { PendingTransactions } from "./PendingTransactions.jsx";
import { BENCH_SLOT, IR_SLOT, SLOT_FILL_ORDER } from "../../../src/espn/constants.js";
import {
  isStarter, lineupOptions, rosterAssignments, sameLineup, slotLabel, validateLineup,
  type LineupAssignment,
} from "../../../src/model/management.js";

interface Draft {
  week: number;
  previous: LineupAssignment[];
  assignments: LineupAssignment[];
}

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export function Management(props: TeamViewProps) {
  const [selected, setSelected] = createSignal<number>();
  const query = createMemo(() => ({
    league: props.league.id,
    season: props.league.season,
    teamId: props.ratings.find((t) => t.teamId === selected())?.teamId
      ?? (props.team.isMe ? props.team : props.ratings.find((t) => t.isMe) ?? props.team).teamId,
  }));
  const [data, { refetch }] = createResource(query, fetchRoster);

  return (
    <div class="management">
      <header class="team-head">
        <h2>Team Management</h2>
        <label class="field inline management-team">
          <span>Team</span>
          <select value={query().teamId} onChange={(e) => setSelected(Number(e.currentTarget.value))}>
            <For each={props.ratings}>{(t) => <option value={t.teamId}>{t.name}{t.isMe ? " (you)" : ""}</option>}</For>
          </select>
        </label>
      </header>
      <Show when={props.ratings.find((t) => t.teamId === query().teamId)?.isMe}>
        <PendingTransactions query={query()} />
      </Show>
      <Show when={data.loading}><p class="dim" role="status">Loading roster from ESPN…</p></Show>
      <Show when={data.error}>
        <div><p class="error" role="alert">{message(data.error)}</p><button class="more" onClick={() => refetch()}>Retry</button></div>
      </Show>
      <Show when={!data.loading && !data.error && data()} keyed>
        {(roster) => <RosterEditor data={roster} selectedWeek={props.week} />}
      </Show>
    </div>
  );
}

function RosterEditor(props: { data: RosterResponse; selectedWeek: number }) {
  const [snapshot, setSnapshot] = createSignal(props.data);
  const [assignments, setAssignments] = createSignal(rosterAssignments(props.data.players));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [needsRefresh, setNeedsRefresh] = createSignal(false);
  const [scores, setScores] = createSignal<ScoresResponse>();
  const [scoreError, setScoreError] = createSignal("");
  const [scoreBusy, setScoreBusy] = createSignal(false);
  let disposed = false;
  async function updateScores() {
    if (scoreBusy() || disposed) return;
    setScoreBusy(true);
    try {
      const data = await fetchScores({ league: props.data.league.id, season: props.data.league.season, teamId: props.data.team.id });
      if (!disposed) { setScores(data); setScoreError(""); }
    } catch (e) { if (!disposed) setScoreError(message(e)); }
    finally { if (!disposed) setScoreBusy(false); }
  }
  void updateScores();
  const timer = setInterval(() => { if (!document.hidden) void updateScores(); }, 30_000);
  const onVisible = () => { if (!document.hidden) void updateScores(); };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => { disposed = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); });
  const currentScores = () => scores()?.week === snapshot().week ? scores() : undefined;
  const actual = (id: number) => currentScores()?.players.find((p) => p.playerId === id)?.actual;
  const storageKey = `lineup:${props.data.league.id}:${props.data.league.season}:${props.data.team.id}`;
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (saved) {
      const draft = JSON.parse(saved) as Draft;
      if (draft.week === snapshot().week && sameLineup(draft.previous, rosterAssignments(snapshot().players))) {
        validateLineup(snapshot().players, snapshot().slots, draft.assignments);
        setAssignments(draft.assignments);
        setNotice("Restored your unsaved lineup changes.");
      } else setNotice("The roster changed on ESPN. Loaded the latest lineup and cleared the old draft.");
    }
  } catch { /* Unavailable storage or an obsolete draft should not block the roster. */ }

  const changes = createMemo(() => {
    const slots = new Map(assignments().map((p) => [p.playerId, p.slotId]));
    return snapshot().players.filter((p) => slots.get(p.id) !== p.lineupSlotId)
      .map((p) => ({ player: p, from: p.lineupSlotId, to: slots.get(p.id)! }));
  });
  createEffect(() => {
    try {
      if (changes().length && !needsRefresh()) {
        sessionStorage.setItem(storageKey, JSON.stringify({
          week: snapshot().week, previous: rosterAssignments(snapshot().players), assignments: assignments(),
        } satisfies Draft));
      } else sessionStorage.removeItem(storageKey);
    } catch { /* Lineup editing also works without session storage. */ }
  });

  const currentSlot = (p: Player) => assignments().find((a) => a.playerId === p.id)!.slotId;
  const canEdit = () => snapshot().team.isMe && !busy() && !needsRefresh();
  const starterSlots = createMemo(() => Object.entries(snapshot().slots)
    .filter(([slot, count]) => count > 0 && isStarter(Number(slot)))
    .sort(([a], [b]) => SLOT_FILL_ORDER.indexOf(Number(a)) - SLOT_FILL_ORDER.indexOf(Number(b)))
    .flatMap(([slot, count]) => Array.from({ length: count }, (_, index) => ({ slot: Number(slot), index }))));
  const starterRows = () => starterSlots().map(({ slot, index }) => ({
    slot, player: snapshot().players.filter((p) => currentSlot(p) === slot)[index],
  }));
  const total = () => snapshot().players.filter((p) => isStarter(currentSlot(p)))
    .reduce((sum, p) => sum + (p.espnByWeek[snapshot().week] ?? 0), 0);

  function reset() {
    setAssignments(rosterAssignments(snapshot().players));
    setError("");
    setNotice("");
  }

  async function reload() {
    const data = await fetchRoster({ league: snapshot().league.id, season: snapshot().league.season, teamId: snapshot().team.id });
    batch(() => {
      setSnapshot(data);
      setAssignments(rosterAssignments(data.players));
      setNeedsRefresh(false);
    });
    void updateScores();
    return data;
  }

  async function refresh() {
    setBusy(true);
    setError("");
    setNotice("");
    try { await reload(); } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!canEdit() || !changes().length) return;
    const target = assignments();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await saveLineup({
        league: snapshot().league.id, season: snapshot().league.season,
        teamId: snapshot().team.id, week: snapshot().week,
        previous: rosterAssignments(snapshot().players), assignments: target, send: true,
      });
      // Don't let a failed read after submission invite a second submission.
      setNeedsRefresh(true);
      setNotice("Lineup submitted. Checking ESPN’s roster…");
      const live = await reload();
      if (sameLineup(target, rosterAssignments(live.players))) setNotice("Lineup saved to ESPN.");
      else {
        setNotice("");
        setError("ESPN’s roster does not match all requested changes. The latest lineup is shown; review it before trying again.");
      }
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }

  function RosterRow(row: { slot: number; player?: Player }) {
    const [moveOpen, setMoveOpen] = createSignal(false);
    const options = createMemo(() => row.player ? lineupOptions(row.player.id, snapshot().players, snapshot().slots, assignments()) : []);
    return (
      <tr classList={{ changed: !!row.player && row.slot !== row.player.lineupSlotId }}>
        <td class="dim">{slotLabel(row.slot)}</td>
        <Show when={row.player} fallback={<><td /><td class="dim">Empty slot</td><td class="n">–</td><td class="n">–</td></>}>
          {(p) => <>
            <td class="management-move">
              <Show when={snapshot().team.isMe}>
                <button type="button" class="management-move-button" aria-label={`Move ${p().name}`}
                  title={p().lineupLocked ? "Locked by ESPN — game started or lineup locked" : options().length ? `Move ${p().name}` : "No eligible moves"}
                  aria-expanded={moveOpen()} aria-controls={`move-options-${p().id}`}
                  disabled={!canEdit() || !options().length} onClick={() => setMoveOpen(!moveOpen())}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />
                  </svg>
                </button>
              </Show>
            </td>
            <td class="management-player">
              <b>{p().name}</b>
              <Show when={!["ACTIVE", "NORMAL"].includes(p().injuryStatus)}>
                <span class="inj" title={p().injuryStatus.replaceAll("_", " ")} aria-label={p().injuryStatus.replaceAll("_", " ")}>{statusTag(p().injuryStatus)}</span>
              </Show>
              <span class="dim">{p().team} · {p().pos}</span>
              <Show when={moveOpen() && canEdit()}>
                <div class="management-move-options" id={`move-options-${p().id}`}>
                  <label>
                    <span class="dim">Move {p().name}</span>
                    <select aria-label={`Choose a move for ${p().name}`} value=""
                      onChange={(e) => {
                        const option = options().find((o) => o.key === e.currentTarget.value);
                        if (option) { setMoveOpen(false); setAssignments(option.assignments); setNotice(""); setError(""); }
                      }}>
                      <option value="" disabled>Choose a move / swap…</option>
                      <For each={options()}>{(o) => <option value={o.key}>{o.label}</option>}</For>
                    </select>
                  </label>
                </div>
              </Show>
            </td>
            <td class="n">{p().espnByWeek[snapshot().week]?.toFixed(1) ?? "–"}</td>
            <td class="n">{actual(p().id)?.toFixed(1) ?? "–"}</td>
          </>}
        </Show>
      </tr>
    );
  }

  return (
    <>
      <div class="team-head">
        <h2><Logo src={snapshot().team.logo} size={28} />{snapshot().team.name}</h2>
        <div class="meta"><span>Current lineup · Week {snapshot().week}</span><span class="dim">{snapshot().players.length} players</span></div>
        <Show when={props.selectedWeek !== snapshot().week}>
          <p class="note dim">Team Management uses ESPN’s current week ({snapshot().week}). The sidebar week applies to analysis views.</p>
        </Show>
        <Show when={!snapshot().team.isMe}><p class="note dim">You can view this roster. Select a team you manage to edit its lineup.</p></Show>
      </div>

      <div class="management-actions">
        <Show when={snapshot().team.isMe}>
          <button class="management-save" disabled={!canEdit() || !changes().length} onClick={save}>{busy() ? "Updating…" : "Save lineup to ESPN"}</button>
          <button disabled={!canEdit() || !changes().length} onClick={reset}>Reset changes</button>
        </Show>
        <button disabled={busy()} onClick={refresh}>{changes().length ? "Discard changes & refresh" : "Refresh roster"}</button>
        <Show when={changes().length}><span class="dim">{changes().length} player moves unsaved</span></Show>
      </div>
      <p class="note dim" role="status">
        Saved ESPN starters: {currentScores()?.starterTotal?.toFixed(1) ?? "–"} actual points · Updates every 30 seconds while visible.
        {scores() ? ` Last fetched ${new Date(scores()!.fetchedAt).toLocaleTimeString()}.` : " Loading scores…"}
        <button class="more" disabled={scoreBusy()} onClick={updateScores}>Refresh scores</button>
      </p>
      <Show when={scoreError()}><p class="error" role="alert">Scores may be stale: {scoreError()}</p></Show>
      <Show when={scores() && scores()!.week !== snapshot().week}><p class="note dim">ESPN’s week changed. Refresh the roster to see current scores.</p></Show>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <Show when={notice()}><p class="management-notice" role="status">{notice()}</p></Show>
      <Show when={needsRefresh() && !busy()}><p class="dim">Refresh the roster to check the submitted lineup before making more changes.</p></Show>

      <Show when={snapshot().players.length} fallback={<p class="dim">No players on this roster yet.</p>}>
        <div class="scroll">
          <table class="management-roster">
            <thead><tr><th title="Position">Pos</th><th class="management-move" /><th>Player</th><th class="n">Projected</th><th class="n">Actual</th></tr></thead>
            <tbody>
              <tr class="management-section"><th colSpan={5}>Starters <span class="dim">· {total().toFixed(1)} projected points</span></th></tr>
              <For each={starterRows()}>{(row) => <RosterRow slot={row.slot} player={row.player} />}</For>
              <For each={[BENCH_SLOT, IR_SLOT]}>{(slot) => (
                <Show when={snapshot().slots[slot] || snapshot().players.some((p) => currentSlot(p) === slot)}>
                  <tr class="management-section"><th colSpan={5}>{slotLabel(slot)} <span class="dim">· {assignments().filter((p) => p.slotId === slot).length} / {snapshot().slots[slot] ?? 0}</span></th></tr>
                  <For each={snapshot().players.filter((p) => currentSlot(p) === slot)} fallback={<tr><td colSpan={5} class="dim">No players</td></tr>}>
                    {(p) => <RosterRow slot={slot} player={p} />}
                  </For>
                </Show>
              )}</For>
            </tbody>
          </table>
        </div>
        <p class="note dim">Projections are ESPN’s for Week {snapshot().week}. Moves and swaps are staged until you save. ESPN checks game locks and roster rules when saving.</p>
      </Show>
      <Show when={changes().length}>
        <section class="management-pending">
          <h3>Pending changes</h3>
          <ul><For each={changes()}>{(c) => <li>{c.player.name}: {slotLabel(c.from)} → {slotLabel(c.to)}</li>}</For></ul>
        </section>
      </Show>
    </>
  );
}
