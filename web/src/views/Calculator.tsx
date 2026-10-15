import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Logo, type TeamViewProps, type TradeSeed } from "../App.jsx";
import { proposeTrade, tradeOdds, type Estimate, type Player, type SimulationResult, type TeamRating } from "../api.js";
import { prepareSimulationLineups } from "../../../src/model/simulation-lineups.js";
import type { SeasonSimulationInput } from "../../../src/model/simulation.js";
import { lineupPpg, tradePpg as ppg, tradeValue } from "../../../src/model/trade.js";
import { optimalLineup } from "../../../src/model/lineup.js";
import { statusTag } from "../../../src/model/player.js";
import { fcPoints, lookupFc } from "../../../src/fantasycalc/values.js";
import { AcceptTrade, date } from "./PendingTransactions.jsx";

const num = (x: number, d = 1) => x.toFixed(d);
const signed = (x: number, d = 1) => (x > 0 ? "+" : "") + x.toFixed(d);
const deltaClass = (x: number) => (x > 0.05 ? "up" : x < -0.05 ? "down" : "dim");
const posClass = (pos: string) => `pos-${pos.toLowerCase().replace(/[^a-z]/g, "")}`;
const injured = (p: Player) => p.injuryStatus !== "ACTIVE" && p.injuryStatus !== "NORMAL";
const rankLabel = (p: Player) => (p.rosRank === undefined ? "–" : `${p.pos}${Math.round(p.rosRank)}`);
const whole = (x: number) => Math.round(x).toLocaleString();
const pct = (x: number) => (x * 100).toFixed(1) + "%";
/** Percentage points, the unit the paired championship difference is reported in. */
const signedPp = (x: number) => signed(x * 100, 1);
const signedWhole = (x: number) => (x > 0 ? "+" : x < 0 ? "\u2212" : "") + whole(Math.abs(x));
/** A market gap under a couple of hundred is inside the noise of a list that moves daily. */
const marketClass = (x: number) => (Math.abs(x) < 200 ? "dim" : x > 0 ? "up" : "down");

/** A roster row: the player plus the slot the rating's optimal lineup put them in (bench/IR otherwise). */
interface Row {
  player: Player;
  slot: string;
}

/** Every player the rating carried in lineup order: starters by slot, then bench by ppg (IR players never start, so they aren't here). */
function rosterRows(t: TeamRating): Row[] {
  const starters = t.ros.starters.filter((s) => s.player !== null).map((s) => ({ player: s.player!, slot: s.slotName }));
  const bench = t.ros.bench
    .slice()
    .sort((a, b) => ppg(b) - ppg(a))
    .map((p) => ({ player: p, slot: "BE" }));
  return [...starters, ...bench];
}

function slotsOf(t: TeamRating): Map<number, number> {
  const slots = new Map<number, number>();
  for (const s of t.ros.starters) slots.set(s.slotId, (slots.get(s.slotId) ?? 0) + 1);
  return slots;
}

/** One team's side of the trade: its roster with checkboxes, and the lineup before/after. */
interface SideResult {
  team: TeamRating;
  before: number;
  after: number;
  /** Players who start after the trade but didn't before, and vice versa. */
  starts: Player[];
  sits: Player[];
  giveValue: number;
  getValue: number;
  /** FantasyCalc market value of the same two packages, 0 when nothing in them is priced. */
  giveMarket: number;
  getMarket: number;
  rosterAfter: number;
}

export function Calculator(props: TeamViewProps) {
  const others = (id: number) => props.ratings.filter((t) => t.teamId !== id);
  const seed = () => props.calcSeed;

  const [aId, setAId] = createSignal(seed()?.teamId ?? props.team.teamId);
  const [bId, setBId] = createSignal(seed()?.partnerId ?? others(aId())[0]?.teamId ?? aId());
  const [give, setGive] = createSignal<Set<number>>(new Set(seed()?.give ?? []));
  const [get, setGet] = createSignal<Set<number>>(new Set(seed()?.get ?? []));

  // A trade clicked in the suggestions tab lands here fully filled in.
  createEffect(
    on(seed, (s) => {
      if (!s) return;
      setAId(s.teamId);
      setBId(s.partnerId);
      setGive(new Set(s.give));
      setGet(new Set(s.get));
    }, { defer: true }),
  );
  // Follow the app's selected team when it changes (e.g. a partner click elsewhere).
  createEffect(
    on(() => props.team.teamId, (id) => {
      if (id === aId()) return;
      if (id === bId()) setBId(aId());
      setAId(id);
      setGive(new Set<number>());
      setGet(new Set<number>());
    }, { defer: true }),
  );

  const teamOf = (id: number) => props.ratings.find((t) => t.teamId === id);
  const teamA = () => teamOf(aId()) ?? props.team;
  const teamB = () => teamOf(bId()) ?? others(aId())[0] ?? props.team;

  const chooseA = (id: number) => {
    if (id === bId()) setBId(aId());
    setAId(id);
    setGive(new Set<number>());
    setGet(new Set<number>());
  };
  const chooseB = (id: number) => {
    if (id === aId()) setAId(bId());
    setBId(id);
    setGive(new Set<number>());
    setGet(new Set<number>());
  };
  const swap = () => {
    const [a, b, g, r] = [aId(), bId(), give(), get()];
    setAId(b);
    setBId(a);
    setGive(r);
    setGet(g);
  };
  const toggle = (set: () => Set<number>, update: (s: Set<number>) => void, id: number) => {
    const next = new Set(set());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
  };

  const hasSleeper = () => props.ratings.some((t) => t.sleeperRos !== null);
  const hasMarket = () => props.fantasycalc !== null;
  /** FantasyCalc's price for a player: what the market will actually pay, in its own unit. 0 when unlisted. */
  const market = (p: Player) => fcPoints(props.fantasycalc, p);
  const marketRank = (p: Player) => {
    const v = lookupFc(props.fantasycalc, p);
    return v ? `${p.pos}${v.positionRank} overall ${v.overallRank}${v.trend30Day ? `, ${signed(v.trend30Day, 0)} in 30 days` : ""}` : "not in FantasyCalc's top ~200";
  };
  const slots = () => slotsOf(teamA());
  /** The ratings' own rest-of-season VORP, so value out/in is in the same currency as the team grades. */
  const hasRos = () => props.ros !== null;
  const valueOf = createMemo(() => tradeValue(props.valuation, hasRos()));
  const value = (p: Player) => valueOf()(p);

  const players = (t: TeamRating) => rosterRows(t).map((r) => r.player);
  const starterIds = (ps: Player[]) =>
    new Set(
      optimalLineup(ps, slots(), { value: ppg, points: ppg })
        .starters.map((s) => s.player?.id)
        .filter((id): id is number => id !== undefined),
    );

  const side = (team: TeamRating, out: Set<number>, from: TeamRating, incoming: Set<number>): SideResult => {
    const mine = players(team);
    const arriving = players(from).filter((p) => incoming.has(p.id));
    const leaving = mine.filter((p) => out.has(p.id));
    const afterRoster = mine.filter((p) => !out.has(p.id)).concat(arriving);
    const beforeIds = starterIds(mine);
    const afterIds = starterIds(afterRoster);
    return {
      team,
      before: lineupPpg(mine, slots(), ppg),
      after: lineupPpg(afterRoster, slots(), ppg),
      starts: afterRoster.filter((p) => afterIds.has(p.id) && !beforeIds.has(p.id)),
      sits: mine.filter((p) => beforeIds.has(p.id) && !afterIds.has(p.id)),
      giveValue: leaving.reduce((s, p) => s + value(p), 0),
      getValue: arriving.reduce((s, p) => s + value(p), 0),
      giveMarket: leaving.reduce((s, p) => s + market(p), 0),
      getMarket: arriving.reduce((s, p) => s + market(p), 0),
      rosterAfter: afterRoster.length,
    };
  };
  const resultA = createMemo(() => side(teamA(), give(), teamB(), get()));
  const resultB = createMemo(() => side(teamB(), get(), teamA(), give()));
  const anything = () => give().size + get().size > 0;

  /**
   * Who wins the trade on FantasyCalc's market prices, and by how much of the
   * larger package. Under 5% is a coin flip on a list that moves every day, so
   * it reads as even; unpriced players (K, D/ST, anyone outside the top ~200)
   * count as zero, which is what makes a lopsided-looking package fair.
   */
  const verdict = createMemo(() => {
    if (!hasMarket() || !anything()) return null;
    const r = resultA();
    const gap = r.getMarket - r.giveMarket;
    const big = Math.max(r.giveMarket, r.getMarket);
    if (!big) return { team: null, gap: 0, edge: 0 };
    const edge = Math.abs(gap) / big;
    if (edge < 0.05) return { team: null, gap, edge };
    return { team: gap > 0 ? teamA() : teamB(), gap, edge };
  });

  // Offering the trade to ESPN. Only possible from a team the logged-in cookie
  // manages, and only from my side of the board, so `mine` picks which of the
  // two columns is me and flips give/get when it's the right-hand one.
  const mySide = createMemo(() => (teamA().isMe ? "a" : teamB().isMe ? "b" : null));
  const offerGive = () => (mySide() === "a" ? [...give()] : [...get()]);
  const offerGet = () => (mySide() === "a" ? [...get()] : [...give()]);
  const myTeam = () => (mySide() === "a" ? teamA() : teamB());
  const theirTeam = () => (mySide() === "a" ? teamB() : teamA());
  /** The picked ids as players, for the offer's "you send X for Y" line. */
  const offerPlayers = (picked: number[]) => [...players(teamA()), ...players(teamB())].filter((p) => picked.includes(p.id));

  const [offering, setOffering] = createSignal(false);
  const [days, setDays] = createSignal(1);
  const [note, setNote] = createSignal("");
  /** My players to release if the trade goes through, for an offer that would overfill my roster. */
  const [drops, setDrops] = createSignal<Set<number>>(new Set());
  /** ESPN's reason when it refused the offer for overfilling my roster; the drops dialog then offers to resend. */
  const [dropReason, setDropReason] = createSignal<string | null>(null);
  let dropDialog: HTMLDialogElement | undefined;
  /** Players I take on beyond those I send, before drops. */
  const netIncoming = () => offerGet().length - offerGive().length;
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal<string | null>(null);
  const [offerError, setOfferError] = createSignal<string | null>(null);

  // Editing the trade invalidates whatever the last send said about it, and which drops it needs.
  createEffect(
    on([give, get, aId, bId], () => {
      setSent(null);
      setOfferError(null);
      setDrops(new Set<number>());
      setDropReason(null);
    }, { defer: true }),
  );

  const send = async () => {
    setSending(true);
    setOfferError(null);
    setSent(null);
    try {
      const res = await proposeTrade({
        league: props.league.id,
        season: props.league.season,
        teamId: myTeam().teamId,
        partnerId: theirTeam().teamId,
        give: offerGive(),
        get: offerGet(),
        drop: [...drops()],
        days: days(),
        note: note(),
        send: true,
      });
      if (res.rosterLimit) {
        const reason = `${res.rosterLimit.message} ${res.rosterLimit.resolution}`.trim();
        setDropReason(reason);
        setOfferError(`ESPN refused the offer: ${reason}`);
        dropDialog?.showModal();
        return;
      }
      setDropReason(null);
      setSent(`offer sent to ${theirTeam().name.trim()}, expires ${new Date(res.expiresAt).toLocaleString()}`);
      setOffering(false);
    } catch (e) {
      setOfferError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  /**
   * An incoming offer opened from Team Management. It's accepted as ESPN has
   * it, so the accept button only shows while the board still matches it --
   * my side sends what it asks for and gets what it offers, whichever column
   * I'm in -- and the banner hides once either team picker moves off its pair.
   */
  const offer = () => seed()?.offer;
  const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((id) => b.includes(id));
  const offerTeams = () => {
    const s = seed();
    return !!s?.offer && [aId(), bId()].sort().join() === [s.teamId, s.partnerId].sort().join();
  };
  const showingOffer = () => {
    const s = seed();
    return !!s?.offer && !!mySide() && myTeam().teamId === s.teamId && theirTeam().teamId === s.partnerId
      && sameIds(offerGive(), s.give) && sameIds(offerGet(), s.get);
  };
  const resetToOffer = () => {
    const s = seed()!;
    setAId(s.teamId);
    setBId(s.partnerId);
    setGive(new Set(s.give));
    setGet(new Set(s.get));
  };
  /** Offer players the board can't show: IR (rosterRows leaves it out) or moved since the ratings loaded. */
  const offerMissing = () => {
    const o = offer();
    if (!o) return [];
    const listed = new Set([...players(teamA()), ...players(teamB())].map((p) => p.id));
    return [...o.incoming, ...o.outgoing].filter((p) => !listed.has(p.id));
  };
  const offerRoster = () => players(teamOf(seed()!.teamId) ?? props.team).map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team }));

  /**
   * The championship simulation, re-run for this trade. Both rosters are
   * composed in the browser from the ratings already on the page -- no ESPN
   * refetch -- and sent as ONE paired run: the same simulated player weeks are
   * played out under both rosters, so the difference is the trade's effect and
   * not two independent estimates subtracted (see src/simulation/README.md).
   * Every team is re-simulated, since a trade moves the whole playoff race.
   */
  const simSlots = createMemo(() => new Map(Object.entries(props.championship?.slots ?? {}).map(([id, n]) => [Number(id), n])));
  /** What actually changes the answer: the two teams and the two packages. */
  const tradeKey = createMemo(() => JSON.stringify([aId(), bId(), [...give()].sort((x, y) => x - y), [...get()].sort((x, y) => x - y)]));

  const simulationInput = (): SeasonSimulationInput => {
    const setup = props.championship!;
    const [a, b] = [aId(), bId()];
    const before = new Map(props.ratings.map((t) => [t.teamId, players(t)]));
    const mineA = before.get(a) ?? [], mineB = before.get(b) ?? [];
    const after = new Map(before);
    after.set(a, mineA.filter((p) => !give().has(p.id)).concat(mineB.filter((p) => get().has(p.id))));
    after.set(b, mineB.filter((p) => !get().has(p.id)).concat(mineA.filter((p) => give().has(p.id))));
    const now = prepareSimulationLineups("before", before, simSlots(), setup.weeks);
    const then = prepareSimulationLineups("after", after, simSlots(), setup.weeks);
    return {
      teams: setup.teams,
      regularSeason: setup.regularSeason,
      playoffs: setup.playoffs,
      format: setup.format,
      // One forecast per player/week across both scenarios; a trade varies ownership, not projections.
      players: [...new Map([...now.players, ...then.players].map((p) => [p.id, p])).values()],
      scenarios: [now.scenario, then.scenario],
    };
  };

  const [odds, setOdds] = createSignal<SimulationResult | null>(null);
  const [oddsError, setOddsError] = createSignal<string | null>(null);
  const [simulating, setSimulating] = createSignal(false);
  /** Why the rating page's own run didn't happen; the same reasons block this one. */
  const noSimulation = () => props.ratings.find((t) => t.championshipError)?.championshipError ?? null;

  let controller: AbortController | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    controller?.abort();
    controller = undefined;
    clearTimeout(pending);
  };
  onCleanup(stop);

  // Tens of seconds of server CPU, so settle the clicking first, then run one
  // simulation and abandon it the moment the trade changes underneath it.
  createEffect(
    on([tradeKey, () => props.championship], () => {
      stop();
      setOdds(null);
      setOddsError(null);
      if (!props.championship || !anything()) return setSimulating(false);
      setSimulating(true);
      pending = setTimeout(() => {
        let input: SeasonSimulationInput;
        try {
          input = simulationInput();
        } catch (e) {
          setOddsError(e instanceof Error ? e.message : String(e));
          return setSimulating(false);
        }
        const mine = new AbortController();
        controller = mine;
        tradeOdds({ input }, mine.signal)
          .then((r) => {
            if (mine.signal.aborted) return;
            setOdds(r.result);
            setSimulating(false);
          })
          .catch((e: unknown) => {
            if (mine.signal.aborted) return;
            setOddsError(e instanceof Error ? e.message : String(e));
            setSimulating(false);
          });
      }, 500);
    }),
  );

  /** One team's title odds before and after, with the paired difference's own Monte Carlo interval. */
  const champ = (teamId: number) => {
    const r = odds();
    if (!r) return null;
    const find = (i: number) => r.scenarios[i]?.teams.find((t) => t.id === teamId);
    const [before, after] = [find(0), find(1)];
    const delta = r.comparisons[0]?.teams.find((t) => t.id === teamId)?.championshipOdds;
    if (!before || !after || !delta) return null;
    return { before: before.championshipOdds.mean, after: after.championshipOdds.mean, delta };
  };
  /** Half of the paired 95% interval: a difference smaller than this is simulation noise, not a finding. */
  const halfWidth = (e: Estimate) => (e.interval95[1] - e.interval95[0]) / 2;

  const Roster = (p: { team: TeamRating; picked: () => Set<number>; onToggle: (id: number) => void; omit?: number[] }) => (
    <div class="scroll">
      <table class="calc-roster">
        <thead>
          <tr>
            <th />
            <th class="slot">Slot</th>
            <th>Player</th>
            <th class="n" title="ESPN rest-of-season projection, pts/game">ESPN</th>
            <Show when={hasSleeper()}>
              <th class="n" title="Sleeper rest-of-season projection, pts/game">Sleeper</th>
            </Show>
            <th class="n" title="rest-of-season value over replacement: the same number the team ratings are built on">Value</th>
            <Show when={hasMarket()}>
              <th class="n" title="FantasyCalc market trade value: what managers in leagues this shape actually trade the player for">Market</th>
            </Show>
          </tr>
        </thead>
        <tbody>
          <For each={rosterRows(p.team).filter((r) => !p.omit?.includes(r.player.id))}>
            {(r) => {
              const on = () => p.picked().has(r.player.id);
              return (
                <tr classList={{ picked: on() }} onClick={() => p.onToggle(r.player.id)}>
                  <td class="check">
                    <input type="checkbox" checked={on()} onClick={(e) => e.stopPropagation()} onChange={() => p.onToggle(r.player.id)} />
                  </td>
                  <td class="slot dim">{r.slot}</td>
                  <td class="who">
                    <b class={posClass(r.player.pos)}>{r.player.name}</b>{" "}
                    <span class="dim">
                      {r.player.pos} · {r.player.team} · {rankLabel(r.player)}
                    </span>
                    <Show when={injured(r.player)}>
                      <span class="inj" title={r.player.injuryStatus}> {statusTag(r.player.injuryStatus)}</span>
                    </Show>
                  </td>
                  <td class="n">{num(r.player.rosPpg)}</td>
                  <Show when={hasSleeper()}>
                    <td class="n">{r.player.sleeper ? num(r.player.sleeper.rosPpg) : "–"}</td>
                  </Show>
                  <td class="n">{num(value(r.player))}</td>
                  <Show when={hasMarket()}>
                    <td class="n" title={marketRank(r.player)}>{market(r.player) ? whole(market(r.player)) : "–"}</td>
                  </Show>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
    </div>
  );

  const Names = (p: { players: Pick<Player, "name" | "pos">[] }) => (
    <For each={p.players}>
      {(pl, i) => (
        <>
          {i() > 0 ? ", " : ""}
          <b class={posClass(pl.pos)}>{pl.name}</b>
        </>
      )}
    </For>
  );

  /** One side of the offer as names, or "nothing" for a giveaway. */
  const Pkg = (p: { ids: number[] }) => (
    <Show when={p.ids.length} fallback={<i>nothing</i>}>
      <Names players={offerPlayers(p.ids)} />
    </Show>
  );

  /** An offer's players by its own names, since IR players aren't on the board for Pkg to find. */
  const OfferNames = (p: { players: Pick<Player, "name" | "pos">[] }) => (
    <Show when={p.players.length} fallback={<i>nothing</i>}>
      <Names players={p.players} />
    </Show>
  );

  const Summary = (p: { r: SideResult }) => {
    const delta = () => p.r.after - p.r.before;
    return (
      <div class="calc-summary">
        <div class="line">
          <span class="dim">lineup pts/game</span>
          <span class="n">
            {num(p.r.before)} → <b>{num(p.r.after)}</b>{" "}
            <span class={deltaClass(delta())}>{signed(delta())}</span>
          </span>
        </div>
        <div class="line">
          <span class="dim">value out / in</span>
          <span class="n">
            {num(p.r.giveValue)} / {num(p.r.getValue)}{" "}
            <span class={deltaClass(p.r.getValue - p.r.giveValue)}>{signed(p.r.getValue - p.r.giveValue)}</span>
          </span>
        </div>
        <Show when={hasMarket()}>
          <div class="line">
            <span class="dim">market out / in</span>
            <span class="n">
              {whole(p.r.giveMarket)} / {whole(p.r.getMarket)}{" "}
              <span class={marketClass(p.r.getMarket - p.r.giveMarket)}>{signedWhole(p.r.getMarket - p.r.giveMarket)}</span>
            </span>
          </div>
        </Show>
        <Show when={props.championship && anything()}>
          <div class="line">
            <span class="dim" title="odds of winning the league, from the same Monte Carlo the rating page runs, with this trade applied to every team's remaining season">
              title odds
            </span>
            <Show
              when={champ(p.r.team.teamId)}
              fallback={
                <span class="dim n">
                  {oddsError() ?? (simulating() ? "simulating…" : "")}
                </span>
              }
            >
              {(c) => (
                <span class="n">
                  {pct(c().before)} → <b>{pct(c().after)}</b>{" "}
                  <span class={Math.abs(c().delta.mean) <= halfWidth(c().delta) ? "dim" : deltaClass(c().delta.mean * 100)}>
                    {signedPp(c().delta.mean)} ±{num(halfWidth(c().delta) * 100, 1)} pp
                  </span>
                </span>
              )}
            </Show>
          </div>
        </Show>
        <Show when={p.r.starts.length || p.r.sits.length}>
          <div class="line changes">
            <Show when={p.r.starts.length}>
              <span>
                <span class="dim">starts </span>
                <Names players={p.r.starts} />
              </span>
            </Show>
            <Show when={p.r.sits.length}>
              <span>
                <span class="dim">sits </span>
                <Names players={p.r.sits} />
              </span>
            </Show>
          </div>
        </Show>
      </div>
    );
  };

  const TeamPicker = (p: { value: number; exclude: number; onChange: (id: number) => void }) => (
    <select value={p.value} onChange={(e) => p.onChange(Number(e.currentTarget.value))}>
      <For each={props.ratings}>
        {(t) => (
          <option value={t.teamId} disabled={t.teamId === p.exclude}>
            {t.name.trim()}
            {t.isMe ? " (me)" : ""}
          </option>
        )}
      </For>
    </select>
  );

  return (
    <div class="trade calc">
      <header class="team-head">
        <h2>
          Trade calculator{" "}
          <small class="dim">
            <Show when={anything()} fallback="pick players on each roster to build a trade">
              {give().size} for {get().size}
            </Show>
          </small>
        </h2>
        <Show when={verdict()}>
          {(v) => (
            <div class="meta market-verdict" title="FantasyCalc trade values for a league this size, QB count and reception scoring">
              <Show
                when={v().team}
                fallback={
                  <span class="dim">
                    {v().edge ? "an even trade" : "neither side has a priced player"} on FantasyCalc's market values
                  </span>
                }
              >
                {(t) => (
                  <span>
                    <span class="dim">FantasyCalc market:</span> <b>{t().name.trim()}</b>{" "}
                    <span class={v().gap > 0 ? "up" : "down"}>
                      +{whole(Math.abs(v().gap))} ({Math.round(v().edge * 100)}%)
                    </span>
                  </span>
                )}
              </Show>
            </div>
          )}
        </Show>
        <div class="controls">
          <Show when={props.back}>
            {(back) => (
              <button class="swap" onClick={() => back().go()} title={`back to the ${back().label}${back().label === "suggestions" ? ", with the same filters" : ""}`}>
                ← {back().label}
              </button>
            )}
          </Show>
          <button class="swap" onClick={swap} title="swap sides">
            ⇄ swap
          </button>
          <button class="swap" onClick={() => { setGive(new Set<number>()); setGet(new Set<number>()); }} disabled={!anything()}>
            clear
          </button>
          <button
            class="propose"
            onClick={() => setOffering(!offering())}
            disabled={!anything() || !mySide()}
            title={
              !mySide()
                ? "you can only offer a trade from a team you manage; put one of your own teams on a side"
                : `offer this trade to ${theirTeam().name.trim()} on ESPN`
            }
          >
            propose trade…
          </button>
        </div>
      </header>

      <Show when={offerTeams() ? offer() : undefined}>
        {(o) => (
          <section class="block offer incoming-offer">
            <div class="offer-head">
              <b>Incoming offer from {o().partner}</b>
              <span class="dim">
                you receive <OfferNames players={o().incoming} /> for <OfferNames players={o().outgoing} />
              </span>
              <Show when={o().expiresAt}>
                <span class="dim">expires {date(o().expiresAt)}</span>
              </Show>
            </div>
            <Show when={o().note}>
              <p class="pending-note">{o().note}</p>
            </Show>
            <Show when={offerMissing().length}>
              <p class="dim note">
                {offerMissing().map((p) => p.name).join(", ")} {offerMissing().length === 1 ? "isn't" : "aren't"} on the
                calculator's rosters (IR, or moved since the ratings loaded), so the numbers below leave{" "}
                {offerMissing().length === 1 ? "that player" : "them"} out
              </p>
            </Show>
            <Show
              when={showingOffer()}
              fallback={
                <div class="offer-fields">
                  <span class="dim">the board no longer matches this offer; accepting takes the offer as ESPN has it</span>
                  <button class="swap" onClick={resetToOffer}>
                    reset to offer
                  </button>
                </div>
              }
            >
              <AcceptTrade
                query={{ league: props.league.id, season: props.league.season, teamId: seed()!.teamId }}
                transactionId={o().transactionId}
                partner={o().partner}
                incoming={o().incoming}
                outgoing={o().outgoing}
                roster={offerRoster()}
              />
            </Show>
          </section>
        )}
      </Show>

      <Show when={offering() && anything() && mySide()}>
        <section class="block offer">
          <div class="offer-head">
            <b>
              Offer to {theirTeam().name.trim()}
            </b>
            <span class="dim">
              you send <Pkg ids={offerGive()} /> for <Pkg ids={offerGet()} />
              <Show when={drops().size}>
                , dropping <Pkg ids={[...drops()]} />
              </Show>
            </span>
          </div>
          <div class="offer-fields">
            <label class="field">
              <span class="dim">expires in</span>
              <input
                type="number"
                min={1}
                max={14}
                step={1}
                value={days()}
                onInput={(e) => setDays(Math.max(1, Math.min(14, Math.round(Number(e.currentTarget.value) || 1))))}
              />
              <span class="unit dim">{days() === 1 ? "day" : "days"}</span>
            </label>
            <label class="field grow">
              <span class="dim">note</span>
              <input
                type="text"
                placeholder="optional message to the other manager"
                value={note()}
                onInput={(e) => setNote(e.currentTarget.value)}
              />
            </label>
            <button class="swap" onClick={() => dropDialog?.showModal()} disabled={sending()} aria-haspopup="dialog">
              {drops().size ? `dropping ${drops().size}…` : "drop players…"}
            </button>
            <button class="send" onClick={() => void send()} disabled={sending()}>
              {sending() ? "sending…" : "send offer"}
            </button>
            <button class="swap" onClick={() => setOffering(false)} disabled={sending()}>
              cancel
            </button>
          </div>
          <Show when={netIncoming() > drops().size}>
            <p class="dim note">
              you take on {netIncoming() - drops().size} more{" "}
              {netIncoming() - drops().size === 1 ? "player" : "players"} than you send
              {drops().size ? " and drop" : ""}; if that overfills your roster (ESPN counts your other pending trades toward
              it too) the offer is refused until you pick players to drop
            </p>
          </Show>
          <dialog
            ref={dropDialog}
            class="settings-dialog drop-dialog"
            aria-labelledby="drop-title"
            onClick={(e) => {
              if (e.target !== dropDialog) return;
              const r = dropDialog.getBoundingClientRect();
              if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dropDialog.close();
            }}
          >
            <div class="settings-header">
              <h2 id="drop-title">Drop from {myTeam().name.trim()}</h2>
              <button class="settings-close" aria-label="Close drops" onClick={() => dropDialog?.close()}>
                ×
              </button>
            </div>
            <p class="dim note">
              optional; checked players are released only if the trade goes through
              {netIncoming() > 0
                ? ` · you take on ${netIncoming()} more ${netIncoming() === 1 ? "player" : "players"} than you send`
                : ""}
            </p>
            <Show when={dropReason()}>{(r) => <p class="error drop-reason">ESPN refused the offer: {r()}</p>}</Show>
            <Roster team={myTeam()} omit={offerGive()} picked={drops} onToggle={(id) => toggle(drops, setDrops, id)} />
            <div class="drop-actions">
              <span class="dim">
                <Show when={drops().size} fallback="no drops">
                  dropping <Pkg ids={[...drops()]} />
                </Show>
              </span>
              <button class="swap" onClick={() => setDrops(new Set<number>())} disabled={!drops().size}>
                clear
              </button>
              <Show
                when={dropReason()}
                fallback={
                  <button class="send" onClick={() => dropDialog?.close()}>
                    done
                  </button>
                }
              >
                <button
                  class="send"
                  disabled={!drops().size || sending()}
                  onClick={() => {
                    dropDialog?.close();
                    void send();
                  }}
                >
                  send offer
                </button>
              </Show>
            </div>
          </dialog>
          <p class="dim note">
            this really submits the trade to ESPN as {myTeam().name.trim()}; checked drops are released only if the trade
            goes through; roster limits, locked players and the trade deadline are ESPN's to enforce and its rejection will
            say which one bit
          </p>
        </section>
      </Show>
      <Show when={sent()}>{(m) => <p class="offer-sent">✓ {m()}</p>}</Show>
      <Show when={offerError()}>{(m) => <p class="error">{m()}</p>}</Show>

      <div class="calc-sides">
        <For each={[resultA, resultB] as const}>
          {(r, i) => {
            const isA = () => i() === 0;
            const t = () => r().team;
            return (
              <section class="block calc-side" classList={{ me: t().isMe }}>
                <div class="calc-team">
                  <Logo src={t().logo} size={28} />
                  <label class="field">
                    <TeamPicker
                      value={t().teamId}
                      exclude={isA() ? bId() : aId()}
                      onChange={isA() ? chooseA : chooseB}
                    />
                  </label>
                  <span class="dim roster-count" title="roster size after the trade">
                    {r().rosterAfter} players
                  </span>
                </div>
                <Summary r={r()} />
                <Roster
                  team={t()}
                  picked={isA() ? give : get}
                  onToggle={(id) => (isA() ? toggle(give, setGive, id) : toggle(get, setGet, id))}
                />
              </section>
            );
          }}
        </For>
      </div>

      <p class="dim note">
        each side is scored by its optimal lineup's projected pts/game (ESPN rest-of-season projection
        {hasSleeper() ? ", averaged with Sleeper's when the player matched" : ""}), bench worth nothing; value is the
        rest-of-season value over replacement the team rating is built on
        {hasRos() ? ", projected points from here to the end of the regular season over what streaming the spot would yield, floored at zero" : " (falling back to the preseason tier value, since no per-week projections loaded)"};
        checked players move across; IR players aren't listed; roster-size limits and waiver moves aren't checked
        {props.championship
          ? "; title odds re-run the rating page's season Monte Carlo over the whole league with the trade applied, both rosters sharing one set of simulated player weeks, so the ± is the paired 95% interval of the difference and a change inside it is unresolved noise"
          : noSimulation()
            ? `; title odds are unavailable (${noSimulation()})`
            : ""}
        {hasMarket()
          ? "; market is FantasyCalc's redraft trade value for a league this shape, an entirely separate currency built from real trades rather than projections — K, D/ST and anyone outside its top ~200 are unpriced and count as zero"
          : ""}
      </p>
    </div>
  );
}
