import { createSignal, For, Show } from "solid-js";
import type { MyTeam } from "./api.js";

export const leagueVisibilityKey = (team: MyTeam) => `${team.leagueId}:${team.season}`;

export function Settings(props: {
  teams: MyTeam[];
  loading: boolean;
  error: unknown;
  hidden: string[];
  setHidden: (keys: string[]) => void;
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
}) {
  let dialog!: HTMLDialogElement;
  const [tab, setTab] = createSignal("leagues");
  const tabs = [{ id: "leagues", label: "League visibility" }, { id: "theme", label: "Color scheme" }];
  const leagues = () => props.teams.filter((team, index, all) =>
    all.findIndex((other) => leagueVisibilityKey(other) === leagueVisibilityKey(team)) === index);
  return <>
    <button class="settings-trigger" onClick={() => dialog.showModal()} aria-haspopup="dialog">
      <span aria-hidden="true">⚙</span> Settings
    </button>
    <dialog ref={dialog} class="settings-dialog" aria-labelledby="settings-title"
      onClick={(event) => { if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
      } }}>
      <header class="settings-header">
        <h2 id="settings-title">Settings</h2>
        <button class="settings-close" aria-label="Close settings" onClick={() => dialog.close()}>×</button>
      </header>
      <div class="settings-tabs" role="tablist" aria-label="Settings categories">
        <For each={tabs}>{(item, index) => <button role="tab" id={`settings-tab-${item.id}`}
          aria-selected={tab() === item.id} aria-controls={`settings-panel-${item.id}`}
          tabIndex={tab() === item.id ? 0 : -1} onClick={() => setTab(item.id)}
          onKeyDown={(event) => {
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
              : event.key === "ArrowRight" ? (index() + 1) % tabs.length
              : event.key === "ArrowLeft" ? (index() + tabs.length - 1) % tabs.length : null;
            if (next === null) return;
            event.preventDefault();
            setTab(tabs[next]!.id);
            dialog.querySelector<HTMLButtonElement>(`#settings-tab-${tabs[next]!.id}`)?.focus();
          }}>{item.label}</button>}</For>
      </div>
      <section role="tabpanel" id="settings-panel-leagues" aria-labelledby="settings-tab-leagues" hidden={tab() !== "leagues"}>
        <p class="dim">Choose which leagues appear in the left menu and Player Acquisition.</p>
        <Show when={!props.loading} fallback={<p class="dim" role="status">Loading leagues…</p>}>
          <Show when={!props.error} fallback={<p class="error">Unable to load leagues. Reload the page to try again.</p>}>
            <Show when={leagues().length} fallback={<p class="dim">No leagues available.</p>}>
              <div class="settings-leagues">
                <For each={leagues()}>{(team) => <label class="settings-option">
                  <input type="checkbox" checked={!props.hidden.includes(leagueVisibilityKey(team))}
                    onChange={(event) => props.setHidden(event.currentTarget.checked
                      ? props.hidden.filter((key) => key !== leagueVisibilityKey(team))
                      : [...props.hidden, leagueVisibilityKey(team)])} />
                  <span>{team.leagueName}<small>{team.teamName} · {team.season}</small></span>
                </label>}</For>
              </div>
            </Show>
          </Show>
        </Show>
      </section>
      <section role="tabpanel" id="settings-panel-theme" aria-labelledby="settings-tab-theme" hidden={tab() !== "theme"}>
        <p class="dim">Choose your preferred appearance.</p>
        <For each={["light", "dark"] as const}>{(theme) => <label class="settings-option">
          <input type="radio" name="color-scheme" checked={props.theme === theme} onChange={() => props.setTheme(theme)} />
          <span>{theme === "light" ? "Light mode" : "Dark mode"}</span>
        </label>}</For>
      </section>
    </dialog>
  </>;
}
