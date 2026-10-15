import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js";
import type { TradeSeed } from "../App.jsx";
import { acceptTrade, cancelTrade, fetchPending, type PendingPlayer, type PendingTransaction } from "../api.js";

type TeamQuery = { league: number; season: number; teamId: number };
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const names = (players: PendingPlayer[]) => players.length ? players.map((p) => p.name).join(", ") : "nothing";

export const date = (value: number | undefined) => value === undefined ? "" : new Date(value).toLocaleString([], {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

function Players(props: { players: PendingPlayer[] }) {
  return <For each={props.players} fallback={<span class="dim">None</span>}>{(p) => (
    <div>{p.name} <span class="dim">{p.pos} {p.team}</span></div>
  )}</For>;
}

/** Offers accepted during this page's life, by league:season:id, so the inbox and the calculator agree before ESPN's lists catch up. */
const [acceptedOffers, setAcceptedOffers] = createSignal<ReadonlySet<string>>(new Set());
const offerKey = (q: TeamQuery, id: string) => `${q.league}:${q.season}:${id}`;

/**
 * Accept another manager's offer: a confirm step, optional drops (opened by
 * ESPN's roster-limit refusal, or by hand) and the POST. Shared by the pending
 * requests panel and the trade calculator.
 */
export function AcceptTrade(props: {
  query: TeamQuery;
  transactionId: string;
  partner: string;
  incoming: PendingPlayer[];
  outgoing: PendingPlayer[];
  /** My roster to pick drops from; the players I'd send are left out. */
  roster: PendingPlayer[];
  onAccepted?: () => void;
  /** Shown beside the accept button until it's pressed. */
  children?: JSX.Element;
}) {
  const [confirming, setConfirming] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [choosingDrops, setChoosingDrops] = createSignal(false);
  const [drops, setDrops] = createSignal<ReadonlySet<number>>(new Set());
  const accepted = () => acceptedOffers().has(offerKey(props.query, props.transactionId));
  const droppable = () => props.roster.filter((p) => !props.outgoing.some((o) => o.id === p.id));
  const extra = () => props.incoming.length - props.outgoing.length - drops().size;
  const toggle = (id: number) => {
    const next = new Set(drops());
    if (!next.delete(id)) next.add(id);
    setDrops(next);
  };
  async function accept() {
    if (sending()) return;
    const query = { ...props.query };
    const transactionId = props.transactionId;
    setSending(true);
    setError("");
    try {
      const result = await acceptTrade({ ...query, transactionId, drop: [...drops()], send: true });
      if (result.rosterLimit) {
        setReason(`${result.rosterLimit.message} ${result.rosterLimit.resolution}`.trim());
        setChoosingDrops(true);
        return;
      }
      if (!result.sent) throw new Error("The acceptance was not submitted. Try again.");
      setAcceptedOffers((previous) => new Set(previous).add(offerKey(query, transactionId)));
      setConfirming(false);
      props.onAccepted?.();
    } catch (e) { setError(message(e)); }
    finally { setSending(false); }
  }
  return (
    <div class="accept-trade">
      <Show when={!accepted()} fallback={<p class="offer-sent" role="status">✓ Trade accepted. ESPN processes it after the league’s review period, if it has one.</p>}>
        <Show when={confirming()} fallback={
          <div class="management-actions">{props.children}<button class="accept" onClick={() => setConfirming(true)}>Accept trade…</button></div>
        }>
          <div class="accept-confirm" role="group" aria-label="Confirm trade acceptance">
            <p>
              Accept {props.partner}’s offer? You receive <b>{names(props.incoming)}</b> and send <b>{names(props.outgoing)}</b>
              <Show when={drops().size}>, dropping <b>{names(droppable().filter((p) => drops().has(p.id)))}</b></Show>.
            </p>
            <Show when={extra() > 0}>
              <p class="dim">You take on {extra()} more {extra() === 1 ? "player" : "players"} than you send. If that overfills your roster (ESPN counts your other pending trades too), ESPN refuses until you pick players to drop.</p>
            </Show>
            <Show when={reason()}><p class="error" role="alert">ESPN refused: {reason()} Choose players to drop, then accept again.</p></Show>
            <Show when={choosingDrops()}>
              <fieldset class="accept-drops" disabled={sending()}>
                <legend>Drop if the trade goes through</legend>
                <For each={droppable()} fallback={<span class="dim">No other players on your roster.</span>}>{(p) => (
                  <label><input type="checkbox" checked={drops().has(p.id)} onChange={() => toggle(p.id)} />{p.name} <span class="dim">{p.pos} {p.team}</span></label>
                )}</For>
              </fieldset>
            </Show>
            <div class="management-actions">
              <button class="accept" disabled={sending()} onClick={accept}>{sending() ? "Accepting…" : "Accept on ESPN"}</button>
              <button disabled={sending()} aria-expanded={choosingDrops()} onClick={() => setChoosingDrops(!choosingDrops())}>
                {drops().size ? `Dropping ${drops().size}…` : "Drop players…"}
              </button>
              <button disabled={sending()} onClick={() => { setConfirming(false); setError(""); setReason(""); }}>Back</button>
            </div>
            <p class="dim">This really accepts the trade on ESPN. Checked drops are released only if the trade goes through. Locked players, roster limits and the trade deadline are ESPN’s to enforce.</p>
          </div>
        </Show>
      </Show>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    </div>
  );
}

function RequestCard(props: {
  transaction: PendingTransaction;
  onCancel?: (id: string) => Promise<void>;
  accept?: { query: TeamQuery; roster: PendingPlayer[]; onAccepted: () => void; onReview?: (t: PendingTransaction) => void };
}) {
  const [cancelling, setCancelling] = createSignal(false);
  const [error, setError] = createSignal("");
  async function cancel() {
    if (cancelling() || !props.onCancel) return;
    setCancelling(true);
    setError("");
    try { await props.onCancel(props.transaction.id); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setCancelling(false); }
  }
  const t = () => props.transaction;
  const trade = () => t().kind === "trade";
  return (
    <article class="pending-request">
      <div class="pending-request-head">
        <strong>{trade() ? `${t().direction === "incoming" ? "From" : "To"} ${t().partners.join(", ") || "another team"}` : `Waiver claim${t().order !== undefined ? ` · #${t().order}` : ""}`}</strong>
        <span class="dim">{trade() ? t().accepted ? "Accepted · awaiting processing" : t().direction === "incoming" ? "Incoming offer" : "Outgoing offer" : "Pending"}</span>
      </div>
      <div class="pending-players">
        <div><h3>{trade() ? "You receive" : "Add"}</h3><Players players={t().incoming} /></div>
        <div><h3>{trade() ? "You send" : "Drop"}</h3><Players players={t().outgoing} /></div>
      </div>
      <div class="meta dim">
        <Show when={!trade() && t().bid !== undefined}><span>Bid: ${t().bid}</span></Show>
        <Show when={t().processesAt}><span>Processes {date(t().processesAt)}</span></Show>
        <Show when={trade() && !t().accepted && t().expiresAt}><span>Expires {date(t().expiresAt)}</span></Show>
        <Show when={t().proposedAt}><span>Requested {date(t().proposedAt)}</span></Show>
      </div>
      <Show when={t().note}><p class="pending-note">{t().note}</p></Show>
      <Show when={t().canAccept && props.accept}>{(a) => (
        <AcceptTrade query={a().query} transactionId={t().id} partner={t().partners.join(", ") || "another team"}
          incoming={t().incoming} outgoing={t().outgoing} roster={a().roster} onAccepted={a().onAccepted}>
          <Show when={a().onReview && t().partnerIds.length}><button onClick={() => a().onReview!(t())}>Review in calculator</button></Show>
        </AcceptTrade>
      )}</Show>
      <Show when={t().canCancel && props.onCancel}>
        <div class="management-actions"><button disabled={cancelling()} onClick={cancel}>{cancelling() ? "Cancelling…" : "Cancel offer"}</button></div>
      </Show>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    </article>
  );
}

/** A separate resource keeps opening/refreshing requests from resetting lineup drafts. */
export function PendingTransactions(props: {
  query: TeamQuery;
  /** The team's roster, for picking drops when accepting an offer. */
  roster?: PendingPlayer[];
  /** Open an incoming offer in the trade calculator. */
  onReview?: (seed: TradeSeed) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [data, { refetch, mutate }] = createResource(() => props.query, fetchPending);
  const [status, setStatus] = createSignal<{ key: string; text: string }>();
  const key = () => `${props.query.league}:${props.query.season}:${props.query.teamId}`;
  async function cancelOffer(transactionId: string) {
    const query = { ...props.query };
    const requestKey = key();
    const result = await cancelTrade({ ...query, transactionId, send: true });
    if (!result.sent) throw new Error("The cancellation was not submitted. Try again.");
    if (key() !== requestKey) return;
    // Remove the cancelled offer immediately, even if the following read fails.
    mutate((previous) => previous ? { ...previous, transactions: previous.transactions.filter((t) => t.id !== transactionId) } : previous);
    setStatus({ key: requestKey, text: "Trade offer cancelled." });
    void refetch();
  }
  function acceptedOffer() {
    setStatus({ key: key(), text: "Trade accepted. It stays listed until ESPN processes it." });
    void refetch();
  }
  const review = (t: PendingTransaction) => props.onReview?.({
    teamId: props.query.teamId, partnerId: t.partnerIds[0]!,
    give: t.outgoing.map((p) => p.id), get: t.incoming.map((p) => p.id),
    offer: { transactionId: t.id, partner: t.partners[0] ?? "another team", incoming: t.incoming, outgoing: t.outgoing, expiresAt: t.expiresAt, note: t.note },
  });
  const accept = () => ({ query: props.query, roster: props.roster ?? [], onAccepted: acceptedOffer, onReview: props.onReview ? review : undefined });
  const current = createMemo(() => {
    if (data.error) return undefined;
    const d = data();
    return d?.league.id === props.query.league && d.league.season === props.query.season && d.team.id === props.query.teamId ? d : undefined;
  });
  // An offer accepted here reads as accepted even if ESPN's list still lags the write.
  const trades = createMemo(() => (current()?.transactions.filter((t) => t.kind === "trade") ?? []).map((t) =>
    t.canAccept && acceptedOffers().has(offerKey(props.query, t.id)) ? { ...t, accepted: true, canAccept: false } : t));
  const waivers = () => current()?.transactions.filter((t) => t.kind === "waiver") ?? [];

  return (
    <div class="pending-transactions">
      <div class="management-actions">
        <button aria-expanded={open()} aria-controls="pending-transactions-panel" onClick={() => {
          const opening = !open();
          setOpen(opening);
          if (opening && !data.loading) void refetch();
        }}>
          Pending transactions<Show when={current() && !data.error}> ({current()!.transactions.length})</Show>
        </button>
      </div>
      <Show when={open()}>
        <section id="pending-transactions-panel" class="pending-panel" aria-label="Pending transactions" aria-busy={data.loading}>
          <div class="pending-head">
            <h3>Pending transactions</h3>
            <div class="management-actions"><button disabled={data.loading} onClick={() => refetch()}>Refresh requests</button><button onClick={() => setOpen(false)}>Close</button></div>
          </div>
          <Show when={data.loading}><p class="dim" role="status">Loading pending requests…</p></Show>
          <Show when={data.error}><p class="error" role="alert">{String(data.error?.message ?? data.error)}</p></Show>
          <Show when={status()?.key === key()}><p role="status">{status()?.text}</p></Show>
          <Show when={!data.loading && !data.error && current()}>
            <Show when={current()?.playersError}><p class="error" role="status">{current()!.playersError}</p></Show>
            <div class="pending-group">
              <h3>Trades <small>{trades().length}</small></h3>
              <For each={trades()} fallback={<p class="dim">No open trade requests.</p>}>{(t) => <RequestCard transaction={t} onCancel={cancelOffer} accept={accept()} />}</For>
            </div>
            <div class="pending-group">
              <h3>Waiver claims <small>{waivers().length}</small></h3>
              <For each={waivers()} fallback={<p class="dim">No pending waiver claims.</p>}>{(t) => <RequestCard transaction={t} />}</For>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  );
}
