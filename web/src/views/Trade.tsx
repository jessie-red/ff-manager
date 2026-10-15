import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Logo, type TeamViewProps } from "../App.jsx";
import type { Player, TeamRating } from "../api.js";
import { findTrades, lineupPpg, tradePpg as ppg, tradeValue, type Trade as TradeIdea, type TradeTeam } from "../../../src/model/trade.js";
import { statusTag } from "../../../src/model/player.js";
import { fcPoints } from "../../../src/fantasycalc/values.js";

const num = (x: number, d = 1) => x.toFixed(d);
const signClass = (x: number) => (Math.abs(x) < 0.5 ? "dim" : x > 0 ? "up" : "down");
const signed = (x: number, d = 1) => (x > 0 ? "+" : "") + x.toFixed(d);
const posClass = (pos: string) => `pos-${pos.toLowerCase().replace(/[^a-z]/g, "")}`;
const injured = (p: Player) => p.injuryStatus !== "ACTIVE" && p.injuryStatus !== "NORMAL";
const rankLabel = (p: Player) => (p.rosRank === undefined ? "–" : `${p.pos}${Math.round(p.rosRank)}`);

const PAGE = 50;

const signedWhole = (x: number) => (x > 0 ? "+" : x < 0 ? "\u2212" : "") + Math.round(Math.abs(x)).toLocaleString();
/** A market gap under a couple of hundred is inside the noise of a list that moves daily. */
const marketClass = (x: number) => (Math.abs(x) < 200 ? "dim" : x > 0 ? "up" : "down");

/** FantasyCalc market value coming back minus what goes out, in FantasyCalc's own unit. */
const netMarket = (t: TradeIdea, market: (p: Player) => number) =>
  t.get.reduce((s, p) => s + market(p), 0) - t.give.reduce((s, p) => s + market(p), 0);

/** Sort accessors; `market` is the only one that needs the value table, so they all take it. */
const SORTS = {
  my: (t: TradeIdea) => t.myGain,
  their: (t: TradeIdea) => t.theirGain,
  value: (t: TradeIdea) => t.netValue,
  market: (t: TradeIdea, market: (p: Player) => number) => netMarket(t, market),
} as const satisfies Record<string, (t: TradeIdea, market: (p: Player) => number) => number>;
type SortKey = keyof typeof SORTS;

/** Everything a filter needs that lives on the view, not on the trade. */
interface Ctx {
  market: (p: Player) => number;
  value: (p: Player) => number;
  teamName: (id: number) => string;
}

/** Name, position and NFL team of every piece, as one haystack for `contains`. */
const names = (ps: Player[]) => ps.map((p) => `${p.name} ${p.pos} ${p.team}`).join(" ");
const sumBy = (ps: Player[], f: (p: Player) => number) => ps.reduce((s, p) => s + f(p), 0);

interface FieldDef {
  label: string;
  /** "team" is text matched against the partner's name, but offered as a picker rather than a box. */
  kind: "text" | "num" | "team";
  /** Offered only when FantasyCalc values loaded. */
  market?: boolean;
  get: (t: TradeIdea, c: Ctx) => string | number;
}

/**
 * Filterable columns. Text fields match a substring; number fields compare.
 * The per-side sums (ppg in/out, value in/out, market in/out) are totals over a
 * package, so on a 2-for-1 they answer "what did the whole side cost", not
 * "was any one player worth this much".
 */
const FIELDS = {
  partner: { label: "partner", kind: "team", get: (t, c) => c.teamName(t.partnerId) },
  player: { label: "any player", kind: "text", get: (t) => names([...t.give, ...t.get]) },
  give: { label: "you give", kind: "text", get: (t) => names(t.give) },
  get: { label: "you get", kind: "text", get: (t) => names(t.get) },
  my: { label: "your ppg", kind: "num", get: (t) => t.myAfter },
  myGain: { label: "your gain", kind: "num", get: (t) => t.myGain },
  their: { label: "their ppg", kind: "num", get: (t) => t.theirAfter },
  theirGain: { label: "their gain", kind: "num", get: (t) => t.theirGain },
  ppgOut: { label: "ppg out", kind: "num", get: (t) => sumBy(t.give, ppg) },
  ppgIn: { label: "ppg in", kind: "num", get: (t) => sumBy(t.get, ppg) },
  valueOut: { label: "value out", kind: "num", get: (t, c) => sumBy(t.give, c.value) },
  valueIn: { label: "value in", kind: "num", get: (t, c) => sumBy(t.get, c.value) },
  netValue: { label: "net value", kind: "num", get: (t) => t.netValue },
  marketOut: { label: "market out", kind: "num", market: true, get: (t, c) => sumBy(t.give, c.market) },
  marketIn: { label: "market in", kind: "num", market: true, get: (t, c) => sumBy(t.get, c.market) },
  netMarket: { label: "net market", kind: "num", market: true, get: (t, c) => netMarket(t, c.market) },
} as const satisfies Record<string, FieldDef>;
type FieldKey = keyof typeof FIELDS;

const NUM_OPS = { ">=": "\u2265", "<=": "\u2264", ">": ">", "<": "<", "=": "=" } as const;
const TEXT_OPS = { "~": "contains", "!~": "excludes" } as const;
const TEAM_OPS = { "~": "is", "!~": "is not" } as const;
type Op = keyof typeof NUM_OPS | keyof typeof TEXT_OPS;

const opsFor = (kind: FieldDef["kind"]) => (kind === "num" ? NUM_OPS : kind === "team" ? TEAM_OPS : TEXT_OPS);
const defaultOp = (kind: FieldDef["kind"]): Op => (kind === "num" ? ">=" : "~");

/** One filter row. `value` stays a string so a half-typed number doesn't reset the box. */
interface Rule {
  id: number;
  field: FieldKey;
  op: Op;
  value: string;
}

/** An empty (or unparseable) value passes everything, so a fresh row doesn't blank the table. */
function passes(r: Rule, t: TradeIdea, c: Ctx): boolean {
  const def: FieldDef = FIELDS[r.field];
  if (r.value.trim() === "") return true;
  if (def.kind === "num") {
    const n = Number(r.value);
    if (Number.isNaN(n)) return true;
    const x = def.get(t, c) as number;
    switch (r.op) {
      case ">=": return x >= n;
      case "<=": return x <= n;
      case ">": return x > n;
      case "<": return x < n;
      case "=": return Math.abs(x - n) < 0.05;
      default: return true;
    }
  }
  const hit = String(def.get(t, c)).toLowerCase().includes(r.value.trim().toLowerCase());
  return r.op === "!~" ? !hit : hit;
}

/** What the view was set to when it unmounted, so a trip to the calculator and back finds it as it was left. */
interface SavedView {
  maxSide: number;
  minTheirGain: number;
  rules: Rule[];
  showFilters: boolean;
  sort: { key: SortKey; desc: boolean };
  limit: number;
  scrollY: number;
}
/** Keyed by league and season for the life of the page: a partner filter names a team in one league only. */
const savedViews = new Map<string, SavedView>();

/** Every player the rating carried for a team: starters plus bench (IR players never start, so they aren't here). */
function roster(t: TeamRating): TradeTeam {
  const starters = t.ros.starters.map((s) => s.player).filter((p): p is Player => p !== null);
  return { teamId: t.teamId, players: [...starters, ...t.ros.bench] };
}

/** Slot counts read back off a rated lineup, so the view needn't ask the server for league settings. */
function slotsOf(t: TeamRating): Map<number, number> {
  const slots = new Map<number, number>();
  for (const s of t.ros.starters) slots.set(s.slotId, (slots.get(s.slotId) ?? 0) + 1);
  return slots;
}

/**
 * One player in a package. The position isn't printed on its own: `rankLabel`
 * already leads with it (WR30), and the two pieces columns are the widest
 * things in the table, so the row fits without a horizontal scrollbar.
 */
function Piece(props: { player: Player; ppg: (p: Player) => number; value: (p: Player) => number }) {
  return (
    <div class="piece">
      <b class={posClass(props.player.pos)}>{props.player.name}</b>{" "}
      <span class="dim">
        {props.player.team} · {rankLabel(props.player)}
      </span>
      <Show when={injured(props.player)}>
        <span class="inj" title={props.player.injuryStatus}> {statusTag(props.player.injuryStatus)}</span>
      </Show>
      <span class="n ppg">
        {num(props.ppg(props.player))} <span class="dim">/ {num(props.value(props.player), 0)}</span>
      </span>
    </div>
  );
}

export function Trade(props: TeamViewProps) {
  // The view only ever shows one league: App unmounts it while another league's ratings load.
  const leagueKey = `${props.league.id}:${props.league.season}`;
  const was = savedViews.get(leagueKey);
  const [maxSide, setMaxSide] = createSignal(was?.maxSide ?? 2);
  /** Floor on the partner's lineup gain; negative shows offers that cost them a little, the ones you'd have to sell. */
  const [minTheirGain, setMinTheirGain] = createSignal(was?.minTheirGain ?? -1);
  /** Filter rows, ANDed. All of them replace what used to be a partner dropdown and a target search box. */
  const [rules, setRules] = createStore<Rule[]>(was?.rules ?? []);
  const [showFilters, setShowFilters] = createSignal(was?.showFilters ?? false);
  const [limit, setLimit] = createSignal(was?.limit ?? PAGE);
  const [sort, setSort] = createSignal<{ key: SortKey; desc: boolean }>(was?.sort ?? { key: "my", desc: true });
  onCleanup(() => savedViews.set(leagueKey, {
    maxSide: maxSide(),
    minTheirGain: minTheirGain(),
    rules: rules.map((r) => ({ ...r })),
    showFilters: showFilters(),
    sort: sort(),
    limit: limit(),
    scrollY: window.scrollY,
  }));
  // After the table has laid out, so there's room to scroll back down to the row that was clicked.
  onMount(() => { if (was) requestAnimationFrame(() => window.scrollTo(0, was.scrollY)); });
  /** Click a sortable header: same key flips direction, a new key starts descending. */
  const sortBy = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: true }));
    setLimit(PAGE);
  };

  const hasSleeper = () => props.ratings.some((t) => t.sleeperRos !== null);
  const slots = () => slotsOf(props.team);
  /** The ratings' own rest-of-season VORP, so a trade's net value is in the same currency as the team grades. */
  const hasRos = () => props.ros !== null;
  const valueOf = createMemo(() => tradeValue(props.valuation, hasRos()));
  const value = (p: Player) => valueOf()(p);
  const hasMarket = () => props.fantasycalc !== null;
  const market = (p: Player) => fcPoints(props.fantasycalc, p);
  const baseline = createMemo(() => new Map(props.ratings.map((t) => [t.teamId, lineupPpg(roster(t).players, slots(), ppg)])));
  const trades = createMemo(() =>
    findTrades(
      roster(props.team),
      props.ratings.filter((t) => t.teamId !== props.team.teamId).map(roster),
      slots(),
      { maxSide: maxSide(), ppg, value, minTheirGain: minTheirGain() },
    ),
  );
  const teamOf = (id: number) => props.ratings.find((t) => t.teamId === id);
  const ctx = createMemo<Ctx>(() => ({ market, value, teamName: (id) => teamOf(id)?.name.trim() ?? String(id) }));
  const shown = createMemo(() => {
    const c = ctx();
    const rs = rules;
    const all = trades().filter((t) => rs.every((r) => passes(r, t, c)));
    const { key, desc } = sort();
    const dir = desc ? -1 : 1;
    // Stable on the model's order (your gain, then theirs) for ties.
    const sorted = all.slice().sort((a, b) => dir * (SORTS[key](a, market) - SORTS[key](b, market)));
    return { rows: sorted.slice(0, limit()), total: all.length };
  });
  /** Rows that actually narrow anything, for the button's badge. */
  const activeRules = createMemo(() => rules.filter((r) => r.value.trim() !== "").length);
  /** How many ideas each partner has, for the partner picker. */
  const perPartner = createMemo(() => {
    const m = new Map<number, number>();
    for (const t of trades()) m.set(t.partnerId, (m.get(t.partnerId) ?? 0) + 1);
    return m;
  });
  /** Names of everyone the suggestions move, most-traded first, to autocomplete the text boxes. */
  const playerNames = createMemo(() => {
    const m = new Map<string, number>();
    for (const t of trades()) for (const x of [...t.give, ...t.get]) m.set(x.name, (m.get(x.name) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  });
  /** Fields on offer: the market ones only exist when FantasyCalc loaded. */
  const fieldKeys = createMemo(() => (Object.keys(FIELDS) as FieldKey[]).filter((k) => !(FIELDS[k] as FieldDef).market || hasMarket()));

  let nextId = Math.max(0, ...rules.map((r) => r.id)) + 1;
  const addRule = (field: FieldKey = "player") => {
    setRules((rs) => [...rs, { id: nextId++, field, op: defaultOp(FIELDS[field].kind), value: "" }]);
  };
  const patchRule = (id: number, patch: Partial<Rule>) => {
    // Preserve row identity so <For> keeps the focused input mounted while typing.
    setRules((r) => r.id === id, patch);
    setLimit(PAGE);
  };
  /**
   * Switching field keeps the typed value only between fields of the same kind:
   * a name carries across you-give/you-get/any-player, but a partner's name
   * doesn't follow you into a text box where it would match nothing.
   */
  const setField = (r: Rule, field: FieldKey) => {
    const kind = FIELDS[field].kind;
    patchRule(r.id, { field, op: defaultOp(kind), value: FIELDS[r.field].kind === kind ? r.value : "" });
  };
  const dropRule = (id: number) => {
    setRules((rs) => rs.filter((r) => r.id !== id));
    setLimit(PAGE);
  };
  /** Opening an empty panel starts you with a row to fill in. */
  const toggleFilters = () => {
    if (!showFilters() && rules.length === 0) addRule();
    setShowFilters((v) => !v);
  };

  const SortHead = (p: { key: SortKey; label: string; title: string }) => (
    <th class="n sortable" classList={{ active: sort().key === p.key }} title={p.title} onClick={() => sortBy(p.key)}>
      {p.label}
      <span class="arrow">{sort().key === p.key ? (sort().desc ? " ▼" : " ▲") : " ◆"}</span>
    </th>
  );

  return (
    <div class="trade">
      <header class="team-head">
        <h2>
          <Logo src={props.team.logo} size={36} />
          {props.team.name.trim()} <small class="dim">trade ideas</small>
        </h2>
        <div class="meta">
          <span>
            lineup <b>{num(baseline().get(props.team.teamId) ?? 0)}</b> <span class="dim">pts/game</span>
          </span>
          <span class="dim">
            {activeRules() ? `${shown().total} of ${trades().length}` : trades().length} trades that improve your lineup
            {minTheirGain() >= 0 ? ` and theirs by ${minTheirGain()}+` : `, costing theirs at most ${num(-minTheirGain(), 2)}`}
          </span>
        </div>
        <div class="controls">
          <label class="field inline">
            <span>players a side</span>
            <select value={maxSide()} onChange={(e) => { setMaxSide(Number(e.currentTarget.value)); setLimit(PAGE); }}>
              <option value={1}>1 for 1</option>
              <option value={2}>up to 2 for 2</option>
            </select>
          </label>
          <label class="field inline" title="floor on the partner's lineup change in pts/game; negative shows offers that cost them a little">
            <span>min opponent ppg</span>
            <input
              type="number"
              step={0.25}
              value={minTheirGain()}
              onInput={(e) => { setMinTheirGain(Number(e.currentTarget.value) || 0); setLimit(PAGE); }}
            />
          </label>
          <button
            class="filters-toggle"
            classList={{ open: showFilters(), on: activeRules() > 0 }}
            title="filter the suggestions on any column"
            onClick={toggleFilters}
          >
            filters
            <Show when={activeRules()}>
              <span class="count">{activeRules()}</span>
            </Show>
          </button>
        </div>
        <Show when={showFilters()}>
          <div class="filters">
            <datalist id="trade-players">
              <For each={playerNames()}>{(n) => <option value={n} />}</For>
            </datalist>
            <For each={rules} fallback={<span class="dim">no filters</span>}>
              {(r) => {
                const def = () => FIELDS[r.field] as FieldDef;
                return (
                  <div class="rule">
                    <select value={r.field} onChange={(e) => setField(r, e.currentTarget.value as FieldKey)}>
                      <For each={fieldKeys()}>{(k) => <option value={k}>{FIELDS[k].label}</option>}</For>
                    </select>
                    <select value={r.op} onChange={(e) => patchRule(r.id, { op: e.currentTarget.value as Op })}>
                      <For each={Object.entries(opsFor(def().kind))}>{([op, label]) => <option value={op}>{label}</option>}</For>
                    </select>
                    <Show
                      when={def().kind === "team"}
                      fallback={
                        <input
                          type={def().kind === "num" ? "number" : "search"}
                          step="any"
                          list={def().kind === "text" ? "trade-players" : undefined}
                          placeholder={def().kind === "num" ? "0" : "name, pos or team"}
                          value={r.value}
                          onInput={(e) => patchRule(r.id, { value: e.currentTarget.value })}
                        />
                      }
                    >
                      <select value={r.value} onChange={(e) => patchRule(r.id, { value: e.currentTarget.value })}>
                        <option value="">any team</option>
                        <For each={props.ratings.filter((t) => t.teamId !== props.team.teamId)}>
                          {(t) => (
                            <option value={t.name.trim()}>
                              {t.name.trim()} ({perPartner().get(t.teamId) ?? 0})
                            </option>
                          )}
                        </For>
                      </select>
                    </Show>
                    <button class="clear" title="remove this filter" onClick={() => dropRule(r.id)} aria-label="remove filter">
                      ×
                    </button>
                  </div>
                );
              }}
            </For>
            <div class="rule-actions">
              <button onClick={() => addRule()}>+ filter</button>
              <Show when={rules.length}>
                <button onClick={() => { setRules([]); setLimit(PAGE); }}>clear all</button>
              </Show>
            </div>
          </div>
        </Show>
      </header>

      <section class="block">
        <Show when={shown().total} fallback={
            <p class="dim">
              {activeRules() && trades().length ? "no trade matches these filters" : "no trade clears these thresholds under these projections"}
            </p>
          }>
          <div class="scroll">
            <table class="trades">
              <thead>
                <tr>
                  <th>Partner</th>
                  <th>You give</th>
                  <th>You get</th>
                  <SortHead key="my" label="You" title="your optimal lineup's projected pts/game after the trade, and the change; click to sort" />
                  <SortHead key="their" label="Them" title="their optimal lineup's projected pts/game after the trade, and the change (negative when the offer costs them); click to sort" />
                  <SortHead
                    key="value"
                    label="Net value"
                    title="rest-of-season value over replacement you take in minus what you send out (the same number the team ratings are built on; the partner's net is the opposite); positive means you win the trade on value; click to sort"
                  />
                  <Show when={hasMarket()}>
                    <SortHead
                      key="market"
                      label="Net market"
                      title="FantasyCalc market trade value you take in minus what you send out; positive means you win the trade at market prices; click to sort"
                    />
                  </Show>
                </tr>
              </thead>
              <tbody>
                <For each={shown().rows}>
                  {(t: TradeIdea) => {
                    const team = () => teamOf(t.partnerId);
                    return (
                      <tr
                        class="idea"
                        title="open in the trade calculator"
                        onClick={() =>
                          props.openCalculator({
                            teamId: props.team.teamId,
                            partnerId: t.partnerId,
                            give: t.give.map((p) => p.id),
                            get: t.get.map((p) => p.id),
                          })
                        }
                      >
                        <td
                          class="with-logo partner"
                          onClick={(e) => { e.stopPropagation(); props.onSelectTeam(t.partnerId); }}
                          title="switch to this team"
                        >
                          <Logo src={team()?.logo} size={18} /> <span class="team-name">{team()?.name.trim() ?? t.partnerId}</span>
                        </td>
                        <td class="pieces">
                          <For each={t.give}>{(p) => <Piece player={p} ppg={ppg} value={value} />}</For>
                        </td>
                        <td class="pieces">
                          <For each={t.get}>{(p) => <Piece player={p} ppg={ppg} value={value} />}</For>
                        </td>
                        <td class="n">
                          {num(t.myAfter)} <span class="up">{signed(t.myGain)}</span>
                        </td>
                        <td class="n">
                          {num(t.theirAfter)} <span class={t.theirGain > 0 ? "up" : "down"}>{signed(t.theirGain)}</span>
                        </td>
                        <td class={"n " + signClass(t.netValue)}>{signed(t.netValue, 0)}</td>
                        <Show when={hasMarket()}>
                          <td class={"n " + marketClass(netMarket(t, market))}>{signedWhole(netMarket(t, market))}</td>
                        </Show>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={shown().total > shown().rows.length}>
            <button class="more" onClick={() => setLimit(limit() + PAGE)}>
              show {Math.min(PAGE, shown().total - shown().rows.length)} more of {shown().total}
            </button>
          </Show>
        </Show>
        <p class="dim note">
          each side is scored by its optimal lineup's projected pts/game (ESPN rest-of-season projection
          {hasSleeper() ? ", averaged with Sleeper's when the player matched" : ""}), bench worth nothing, so a
          trade only shows when it changes who starts on your team and moves the partner's lineup by at least the min
          opponent ppg set above (negative there means offers they lose a little on, which they have to be talked into); K and D/ST aren't offered; a 2-for-1 leaves the side
          taking two players a roster spot short, which costs nothing here; trades padded with a throw-in that a smaller
          trade already matches are hidden; net value is the rest-of-season value over replacement the team ratings are
          built on{hasRos() ? "" : ", falling back to the preseason tier value since no per-week projections loaded"};
          sorted by your gain, then theirs; filters AND together and the per-side sums (ppg, value and market in/out) total
          a whole package, so on a 2-for-1 they say what the side cost, not what any one player is worth; click a trade to
          open it in the calculator
          {hasMarket()
            ? "; net market is FantasyCalc's redraft trade values, a separate currency built from real trades, with K, D/ST and anyone outside its top ~200 unpriced"
            : ""}
        </p>
      </section>
    </div>
  );
}
