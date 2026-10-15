import { Acquisition } from "./views/Acquisition.jsx";
import { FreeAgency } from "./views/FreeAgency.jsx";
import { Settings, leagueVisibilityKey } from "./Settings.jsx";
import { Dashboard } from "./views/Dashboard.jsx";
import { batch, createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { fetchDefaults, fetchLeagues, fetchRatings, type MyTeam, type RateQuery, type TeamRating } from "./api.js";
import { Rating } from "./views/Rating.jsx";
import { Draft } from "./views/Draft.jsx";
import { Aid } from "./views/Aid.jsx";
import { Trade } from "./views/Trade.jsx";
import { Calculator } from "./views/Calculator.jsx";
import { Management } from "./views/Management.jsx";
import type { FcValues, PendingPlayer, RateResponse, Valuation } from "./api.js";

/** Per-team views listed in the sidebar. Add a view here and it shows up in the menu. */
const VIEWS = [
  { id: "management", label: "Team Management", component: Management },
  { id: "freeagency", label: "Free Agency", component: FreeAgency },
  { id: "rating", label: "Team Rating", component: Rating },
  { id: "draft", label: "Draft Analysis", component: Draft },
  { id: "aid", label: "Draft Aid", component: Aid },
  { id: "trade", label: "Trade Suggestions", component: Trade },
  { id: "calc", label: "Trade Calculator", component: Calculator },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

/** A trade handed to the calculator: player ids leaving `teamId` for `partnerId` and coming back. */
export interface TradeSeed {
  teamId: number;
  partnerId: number;
  give: number[];
  get: number[];
  /** Set when this is another manager's open offer to `teamId`, so the calculator can accept it. */
  offer?: {
    transactionId: string;
    partner: string;
    incoming: PendingPlayer[];
    outgoing: PendingPlayer[];
    expiresAt?: number;
    note?: string;
  };
}

export interface TeamViewProps {
  league: { id: number; season: number };
  team: TeamRating;
  ratings: TeamRating[];
  /** Tier values, replacement ranks and historical curves behind every value. */
  valuation: Valuation;
  /**
   * FantasyCalc's market trade values for this league's shape, or null when
   * they couldn't be fetched. A second currency the trade views show next to
   * the projection-based one; nothing else reads it.
   */
  fantasycalc: FcValues | null;
  /**
   * Rest-of-season replacement levels, when the ratings were built on them
   * (see src/model/ros.ts); null when they fell back to `valuation`'s tiers.
   * Per-player projections ride on each Player as `ros`.
   */
  ros: RateResponse["ros"];
  /**
   * Standings, remaining schedule and playoff rules for the championship
   * simulation, or null when it couldn't run (each rating's championshipError
   * says why). The trade calculator re-runs the simulation with it.
   */
  championship: RateResponse["championship"];
  week: number;
  onSelectTeam: (id: number) => void;
  /** Switch to the trade calculator with this trade filled in. */
  openCalculator: (seed: TradeSeed) => void;
  /** The last trade sent to the calculator, if any. */
  calcSeed: TradeSeed | null;
  /** Return to the view that opened the calculator (trade suggestions as they were left, or team management); null otherwise. */
  back: { label: string; go: () => void } | null;
}

interface LeagueKey {
  leagueId: number;
  season: number;
}
const sameLeague = (a: LeagueKey | null, b: LeagueKey) => a?.leagueId === b.leagueId && a.season === b.season;

const stored = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};

export function Logo(props: { src: string | undefined; size?: number }) {
  const px = () => `${props.size ?? 20}px`;
  return (
    <Show when={props.src} fallback={<span class="logo placeholder" style={{ width: px(), height: px() }} />}>
      <img class="logo" src={props.src} alt="" width={props.size ?? 20} height={props.size ?? 20} loading="lazy" />
    </Show>
  );
}

export function App() {
  const savedHidden = stored<unknown>("hiddenLeagues", []);
  const [hiddenLeagues, setHiddenLeagues] = createSignal<string[]>(Array.isArray(savedHidden) ? savedHidden.filter((key): key is string => typeof key === "string") : []);
  const savedTheme = stored<unknown>("colorScheme", null);
  const [theme, setTheme] = createSignal<"light" | "dark">(savedTheme === "light" || savedTheme === "dark" ? savedTheme : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  createEffect(() => {
    document.documentElement.dataset.theme = theme();
    try { localStorage.setItem("colorScheme", JSON.stringify(theme())); } catch { /* Preferences still work when storage is unavailable. */ }
  });
  createEffect(() => {
    try { localStorage.setItem("hiddenLeagues", JSON.stringify(hiddenLeagues())); } catch { /* Preferences still work for this session. */ }
  });
  const [league, setLeague] = createSignal<LeagueKey | null>(stored("league", null));
  const [week, setWeek] = createSignal<number | undefined>(undefined);
  const [teamId, setTeamId] = createSignal<number | null>(null);
  const [view, setView] = createSignal<ViewId | "dashboard" | "acquisition">("management");
  const [calcSeed, setCalcSeed] = createSignal<TradeSeed | null>(null);
  /** The view that opened the calculator, when it's one the calculator offers a way back to. */
  const [calcFrom, setCalcFrom] = createSignal<"trade" | "management" | null>(null);
  const openCalculator = (seed: TradeSeed) => batch(() => {
    setCalcSeed(seed);
    const from = view();
    setCalcFrom(from === "trade" || from === "management" ? from : null);
    setView("calc");
  });
  // Leaving the calculator by any route forgets where it was opened from.
  createEffect(() => {
    if (view() !== "calc") setCalcFrom(null);
  });
  const calcBack = () => {
    const from = calcFrom();
    return from && { label: from === "trade" ? "suggestions" : "team management", go: () => setView(from) };
  };

  const [myTeams] = createResource(fetchLeagues);
  const visibleTeams = () => myTeams()?.filter((m) => !hiddenLeagues().includes(leagueVisibilityKey(m))) ?? [];
  const [defaults] = createResource(fetchDefaults);

  // Pick a league once the list arrives: last used, else LEAGUE_ID from .env, else the first one.
  createEffect(() => {
    const mine = myTeams();
    const d = defaults();
    if (!mine?.length || !d) return;
    const pick =
      mine.find((m) => sameLeague(league(), m)) ??
      mine.find((m) => m.leagueId === d.leagueId && m.season === d.season) ??
      mine[0]!;
    if (!sameLeague(league(), pick)) selectLeague(pick);
  });
  createEffect(() => localStorage.setItem("league", JSON.stringify(league())));

  const selectLeague = (m: MyTeam) => batch(() => {
    setLeague({ leagueId: m.leagueId, season: m.season });
    setWeek(undefined);
    setTeamId(m.teamId);
  });

  const needsRatings = () => ["rating", "trade", "calc"].includes(view());
  const query = createMemo<RateQuery | null>(() => {
    const l = league();
    return l && needsRatings() ? {
      league: l.leagueId, season: l.season, week: week(),
      championship: view() === "trade" ? 0 : 1,
    } : null;
  });
  // Reuse a calculation when revisiting a tab; share an in-flight calculation too.
  const ratingRequests = new Map<string, { request: Promise<RateResponse>; expires: number }>();
  const [result, { refetch }] = createResource(query, (q) => {
    const key = JSON.stringify(q);
    const cached = ratingRequests.get(key);
    if (cached && cached.expires > Date.now()) return cached.request;
    const request = fetchRatings(q).then((value) => {
      ratingRequests.set(key, { request, expires: Date.now() + 60_000 });
      return value;
    }).catch((error) => { ratingRequests.delete(key); throw error; });
    ratingRequests.set(key, { request, expires: Infinity });
    return request;
  });
  const data = () => {
    if (!needsRatings() || result.loading || result.error) return undefined;
    const value = result();
    return value && value.league.id === league()?.leagueId && value.league.season === league()?.season
      && (week() === undefined || value.week === week()) ? value : undefined;
  };
  const managedTeam = () => myTeams()?.find((m) => sameLeague(league(), m));
  const ratings = () => data()?.ratings ?? [];

  // Keep the selection valid; default to my team.
  createEffect(() => {
    const rs = ratings();
    if (rs.length && !rs.some((t) => t.teamId === teamId())) setTeamId((rs.find((t) => t.isMe) ?? rs[0]!).teamId);
  });
  const team = () => ratings().find((t) => t.teamId === teamId());

  return (
    <div class="layout">
      <aside class="sidebar">
        <div class="teams">
          <Show when={!myTeams.loading} fallback={<p class="dim">loading teams…</p>}>
            <Show when={myTeams()?.length} fallback={<p class="dim">no fantasy football teams on this ESPN account</p>}>
              <Show when={visibleTeams().length === 0}><p class="dim">All leagues hidden. Use Settings to show them.</p></Show>
              <For each={visibleTeams()}>
                {(m) => (
                  <button class="team-card" classList={{ active: sameLeague(league(), m) }} onClick={() => selectLeague(m)}>
                    <Logo src={m.logo} size={32} />
                    <span class="names">
                      <span class="league-name">{m.leagueName}</span>
                      <span class="team-name dim">
                        {m.teamName} · {m.season}
                      </span>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
          <Show when={myTeams.error}>
            <p class="error">{String(myTeams.error?.message ?? myTeams.error)}</p>
          </Show>
        </div>

        <label class="field week">
          <span>Week</span>
          <input
            type="number"
            min={1}
            max={18}
            placeholder="current"
            value={week() ?? data()?.week ?? ""}
            onChange={(e) => setWeek(e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value))}
          />
        </label>

        <nav class="menu">
          <button classList={{ active: view() === "dashboard" }} onClick={() => setView("dashboard")}>Dashboard</button>
          <button classList={{ active: view() === "acquisition" }} onClick={() => setView("acquisition")}>Player Acquisition</button>
          <For each={VIEWS}>
            {(v) => (
              <button classList={{ active: view() === v.id }} onClick={() => setView(v.id)}>
                {v.label}
              </button>
            )}
          </For>
        </nav>

        <footer class="status">
          <Show when={data()} fallback={<span>{needsRatings() && result.loading ? "loading…" : managedTeam()?.leagueName ?? "no league loaded"}</span>}>
            {(d) => (
              <span>
                {d().league.name} · week {d().week} · {d().ratings.length} teams
                <Show when={d().sleeper}>
                  {(s) => <> · Sleeper{s().scoring === "league" ? "" : ` (${s().scoring} preset)`}</>}
                </Show>
                <Show when={d().sleeperError}>
                  <span class="error"> · Sleeper unavailable</span>
                </Show>
                <Show when={d().projectedError}>
                  <span class="error"> · weekly ESPN projections unavailable</span>
                </Show>
                <Show when={d().curvesError}>
                  <span class="error"> · history unavailable, linear value</span>
                </Show>
                <Show when={d().tiers}>
                  {(t) => <> · Boris tiers ({t().scoring}, {t().updated.slice(0, 10)})</>}
                </Show>
                <Show when={d().tiersError}>
                  <span class="error"> · Boris tiers unavailable, valuing by rank</span>
                </Show>
              </span>
            )}
          </Show>
        </footer>
        <Settings teams={myTeams() ?? []} loading={myTeams.loading} error={myTeams.error}
          hidden={hiddenLeagues()} setHidden={setHiddenLeagues} theme={theme()} setTheme={setTheme} />
      </aside>

      <main class="content">
        <Show when={view() === "acquisition"}>
          <Acquisition teams={visibleTeams()} loading={myTeams.loading} error={myTeams.error}
            onTrade={(m, seed) => { selectLeague(m); openCalculator(seed); }} />
        </Show>
        <Show when={view() === "dashboard"}>
          <Dashboard teams={myTeams() ?? []} loading={myTeams.loading} error={myTeams.error}
            onOpen={(m) => { selectLeague(m); setView("management"); }} />
        </Show>
        <Show when={view() === "management" ? managedTeam() : undefined} keyed>
          {(m) => <Management league={{ id: m.leagueId, season: m.season }} teamId={m.teamId} week={week()} onReviewTrade={openCalculator} />}
        </Show>
        <Show when={view() === "freeagency" ? managedTeam() : undefined} keyed>
          {(m) => <FreeAgency team={m} week={week()} />}
        </Show>
        <Show when={league()}>
          {(l) => <>
            <Show when={view() === "draft"}>
              <Draft league={{ id: l().leagueId, season: l().season }} team={{ teamId: teamId() ?? managedTeam()?.teamId ?? 0 }} onSelectTeam={setTeamId} />
            </Show>
            <Show when={view() === "aid"}>
              <Aid league={{ id: l().leagueId, season: l().season }} />
            </Show>
          </>}
        </Show>
        <Show when={needsRatings()}>
        <Show when={result.loading}>
          <p class="dim" role="status">{view() === "trade" ? "Loading trade data…" : "Loading ratings…"}</p>
        </Show>
        <Show when={result.error}>
          <p class="error" role="alert">{String(result.error?.message ?? result.error)}</p>
          <button class="more" onClick={() => refetch()}>Retry</button>
        </Show>
        <Show when={team()}>
          {(t) => (
            // Show calls this function untracked, so the view must be picked through Dynamic to react to the menu.
            <Dynamic
              component={view() === "trade" ? Trade : view() === "calc" ? Calculator : Rating}
              league={{ id: league()!.leagueId, season: league()!.season }}
              team={t()}
              ratings={ratings()}
              valuation={data()!.valuation}
              fantasycalc={data()!.fantasycalc}
              ros={data()!.ros}
              championship={data()!.championship}
              week={data()!.week}
              onSelectTeam={setTeamId}
              openCalculator={openCalculator}
              calcSeed={calcSeed()}
              back={calcBack()}
            />
          )}
        </Show>
        </Show>
      </main>
    </div>
  );
}
