# Technical Specification: Choosing What Arc Agents Load

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Completed
- **Author(s):** redgell

---

## 1. High-Level Technical Approach

Arc already assembles what a Claude agent loads in three places: `PersonalConfigService` (one merged `--mcp-config` and a hooks-only `--settings` file), `PluginViewService` (the sanitized `--plugin-dir` folder, which also links `~/.claude/skills`) and `buildClaudeArgs` (the flags). Codex keeps the user's real `CODEX_HOME` and gets only per-thread overrides from `codex-config.ts`. This spec filters at exactly those points, per role.

1. **Store what is off.** One `app_settings` key, `agents.loadOff`, holds `{brain: string[], workers: string[]}` of item keys. Default `{brain: [], workers: []}`, so a new item is on.
2. **One selection object.** `LoadSelection` (`src/main/personal/load-selection.ts`) reads the setting on every call and answers `off(role)`. Nothing is cached, so a change applies to the next agent start.
3. **Filter per role** in the personal config (MCP servers, hooks), the plugin view (plugins, skills; one view per role) and the Codex thread config. The orchestrator passes `brain`, the worker manager and the command catalogue pass `workers`.
4. **List and estimate.** `LoadCatalogue` (`src/main/personal/load-catalogue.ts`) builds the items for Settings from what Arc already reads, and `ceil(chars / 4)` estimates.
5. **Show it.** A new Settings page, an `agent-load:get` channel, and a button in the Setup overhead suggestion.

One additive setting; no table and no migration.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 Facts checked before designing (no model call)

| # | Fact | How it was checked |
|---|---|---|
| F1 | Codex can turn one MCP server off for a thread: `config.mcp_servers.<name> = {enabled: false}` stops it from starting, and the entry merges with the user's own, so nothing else of the server is re-sent. | Spec 007 spike S10 (recorded against the app-server: `{enabled:false}` alone disabled all nine of the user's servers, only `arc` and `codex_apps` started). Re-checked on codex-cli 0.163.0: `codex -c 'mcp_servers.zz={command="true",enabled=false}' mcp list` (empty `CODEX_HOME`) prints the server with status `disabled`. The app-server JSON schema (`codex app-server generate-json-schema`) takes `config` as a free-form object. |
| F2 | `~/.claude/agents` does **not** load in an Arc agent. With `--setting-sources project --strict-mcp-config --plugin-dir <view>` and a temp HOME holding `agents/foo.md`, the `initialize` answer lists only the built-in agents. | The command probe's `initialize` request against a temp HOME (no user message, so no model turn). |
| F3 | A `user/skills/` folder made of one symlink per skill folder loads exactly those skills (`user:bar` listed, the omitted `qux` absent). Symlinked command files and command folders are **not** followed; a copied file is. | Same probe. |
| F4 | `McpToolCatalogue` only learns tool names while an agent asks about an approval, and only keeps them per agent. Arc never sees tool schemas. | `mcp-tool-catalogue.ts`. |
| F5 | The Setup overhead numbers come from `firstCall` of a new thread (`agent_setup.fixed_setup_tokens`, spec 008 §2.7), so they follow whatever flags the agent started with. | `usage-recorder.ts`, `setup-estimator.ts`. |

### 2.2 Items and keys

| Kind | Key | Source of the list | Filter point |
|---|---|---|---|
| MCP server (Claude) | `mcp:<merged name>` | user and local scope from `~/.claude.json`, `.mcp.json` of the projects Arc knows, plugin servers (`plugin_<plugin>_<server>`) | merged `--mcp-config`, after the merge; `arc` is never removed |
| Plugin | `plugin:<name@marketplace>` | `PluginViewService` (user-scope enabled plugins) | plugin view |
| Skill | `skill:<folder>` | `~/.claude/skills/*/SKILL.md` | the view's `user/skills` |
| Hook event | `hook:<Event>` | keys of `hooks` in `~/.claude/settings.json` | the generated hooks file |
| Codex MCP server | `codex-mcp:<name>` | `CodexProbe.listMcpServers(home)` | thread `config.mcp_servers` |

Roles: `brain` (the brain) and `workers` (workers and conflict resolvers, which both start in `worker-manager.ts`). A name clash between sources is one key, as in the merge.

### 2.3 Filtering

- **MCP (`personal-config.ts`).** `claude(request)` gets `role`. After `mergeServers(...)`, every non-`arc` name whose key is off is dropped. The file is named by the hash of its content, so a different selection writes a different folder.
- **Hooks.** `readUserHooks` stays; the personal config removes the off events. No events left means no `hooksSettingsPath`, and `buildClaudeArgs` already omits `--settings` then.
- **Plugin view (`plugin-view.ts`).** `current(repoPaths, role)` and `sources(repoPaths, role)` take the role. The plan drops plugins whose key is off. A plugin that is off but enabled by a repository's `.claude/settings.json` (the `shadowed` case) is written as a **stub**: a folder with only a manifest of the same name, so the same-name inline copy still beats the CLI's own load of the raw plugin (spec 007 §2.6). Stubs are left out of `sources()`.
- **Skills.** With no skill off, `user/skills` stays one symlink to `~/.claude/skills`, as today. With any off, it becomes a real folder with one symlink per remaining skill (F3). The plan hash includes the sorted skill names, so a new skill appears in the next view. `user/commands` is untouched (F3 says it cannot be filtered by symlink, and it is out of scope).
- **One view per role.** The hash includes the off plugin ids and the skill names kept, so brain and workers get different folders only when their selections differ. The current directory and hash are tracked per role; `onChanged` (which pushes `commands:changed`) fires for the `workers` role only. Both roles' current views are protected from pruning, and `KEEP_VIEWS` goes from 3 to 4.
- **Codex (`codex-config.ts`).** `CodexStartOptions` gets `disabledMcpServers`. `buildThreadConfig` writes `servers[name] = {enabled: false}` for each; those names are not in `personalMcpServers`, so the approval handler's covered set contains only the servers that run. `applyCodexMcp(codex, mcp, off)` does the split.
- **Not filtered:** the command probe's `initialize` for Codex, the launch plan check (own flags), `arc`.

### 2.4 Commands

- `CommandCatalogue.getViewDir` and `getPersonal` pass `workers`, so the probe starts with the worker view and the worker hooks and servers. The probe's cache key already contains the view hash and the personal file paths, so a new selection is a new probe.
- The orchestrator's routing and the brain's prompt read the catalogue, so a command of a plugin that is off for workers is "not in the catalogue" and the message is ordinary (spec 005).
- When `agents.loadOff.workers` changes, the `settings:set` handler calls the same sequence as a plugin change: `commandCatalogue.invalidate()`, `emit('commands:changed')` and `sessionService.pluginsChanged()` (the brain hears the new list with its next message). The Brain column alone does not trigger it.

### 2.5 Bypass report (spec 007)

`BypassDetector.detect` computes the allow-capable hook events once per role (user hooks minus the off events, plus the hooks of the plugins in that role's view) and returns the union as `claudeHookEvents` (unchanged meaning) plus `claudeHookEventsByRole: {brain, workers}`. The event-log note (`noteBypassOnce`) keeps using the union, so it says something only when some agent can still bypass. `BypassWarning.svelte` shows one list when the roles agree and "Brain" / "Workers" lists when they differ. The Settings page reloads the report after a save.

### 2.6 Estimates and the catalogue

`LoadCatalogue.list()` returns `{items, codex}`; each item is `{key, kind, label, detail, tokens: number | null, note?}`.

- Skill: `tokens(name + ': ' + description)` from the `SKILL.md` front matter (folded `>` and `|` values handled).
- Plugin: the same rule over its `skills/*/SKILL.md`, `commands/**/*.md` and `agents/*.md`. A plugin that ships hooks gets a note that their output is not counted. Its MCP servers are their own rows.
- MCP server: `tokens(names)` where names are `mcp__<server>__<tool>` for the tools `McpToolCatalogue` has seen in this Arc run (F4), labelled as names only; otherwise `null`. Because Claude defers MCP tools, the list per request is names, so this is an honest lower bound.
- Hook, Codex server: `null`.
- `tokens(text) = ceil(text.length / 4)`, the rule of spec 008's `setup-estimator.ts`.
- The page sums each column over items that are on and counts those with `null`.

Reads are read-only (`~/.claude`, `~/.claude.json`, plugin install folders, project `.mcp.json`); the projects are those in Arc's database. Values of server entries (env, headers, tokens) are never read into the result; only names.

### 2.7 Persistence and IPC

- `appSettingSchemas['agents.loadOff'] = z.object({brain: z.array(z.string().max(300)).max(500), workers: ...})`, default empty; `AppSettings` and `getAll()` carry it, so `settings:get`, `settings:set` and `settings:changed` need no new channel. The `settings:set` contract and handler list the key.
- `agent-load:get` (`{}` → `{items}`) lists the Claude-side items from files; `agent-load:codex` (`{}` → `{items, state: 'ok' | 'unavailable' | 'unreadable'}`) lists the Codex servers separately, because Codex has to start to answer. Both are read-only and rebuilt on each call; the page shows the Claude items first.
- Keys that no longer match an item stay in the stored lists and cost nothing.

### 2.8 Renderer

- `stores/agent-load.svelte.ts`: `items`, `status`, `load()`, `isOn(key, role)`, `set(key, role, on)` (computes the new off lists and calls `settings.save`), and `totals(role)`.
- `settings/AgentLoadSettings.svelte` (page) and `settings/LoadRow.svelte`: `Panel`-style groups with the existing `Toggle`; two columns of switches with labels "<item>, Brain" and "<item>, Workers" through `aria-label`-bearing `Toggle`s (the visible column header is a heading). Column totals in a header strip with `role="status"` text. `data-load-item`, `data-load-total`.
- `SettingsView.svelte` uses `ui.settingsPage`; `ui.openSettings(page?)` selects it.
- `SuggestionsList.svelte`: a "Choose what agents load" button for a `setup-overhead` suggestion whose Arc share is under 25% (the same integer rule as the service, computed from `params.setupTokens` and `params.arcSetupTokens`).
- `BypassWarning.svelte`: the per-role lists.

---

## 3. Impact and Risk Analysis

**System dependencies:** `personal-config.ts`, `plugin-view.ts`, `bypass-detector.ts`, `command-probe.ts` (wiring only), `claude-adapter.ts` (no change: it already omits flags when the paths are unset), `codex-config.ts`, `orchestrator.ts`, `worker-manager.ts`, `bootstrap.ts`, `app-settings-repo.ts`, the IPC contract, `SettingsView`, `BypassWarning`, `SuggestionsList`.

| Risk | Mitigation |
|---|---|
| A repository's `enabledPlugins` loads a plugin the user switched off | Stub folder of the same name (2.3); unit test; stated as an assumption since the shadowing was verified for full copies only |
| Pruning removes the other role's plugin view while an agent uses it | both current views are protected from pruning; views are named by hash, so equal selections share one |
| Estimates mislead (names only for MCP, hooks unknown) | Labelled "about", "size unknown" and "tool names only"; the measured fixed setup (spec 008) remains the truth |
| The user switches off something an agent needs (a hook that guards pushes) | Defaults are on; hook rows say a hook may protect; the bypass warning follows the selection |
| `settings:set` with a huge list | zod caps on array and string length |
| A project's `.mcp.json` server shown for a project the user later removes | Listed only for projects Arc knows now; the stored key stays harmless |
| Codex servers of a project-level `config.toml` | Only the home-level config is listed; a project server cannot be switched (stays on) |
| Brain started before a change keeps its servers | Documented in the page: applies to agents started afterwards, resumes on next start |

---

## 4. Testing Strategy

Tests come first in every slice. During slices only the touched test files run; the full suites run once, in the last slice.

- **Unit:**
  - persistence: default, round trip, invalid value rejected, `getAll`;
  - selection: per role, unknown keys ignored;
  - estimate: `ceil(chars / 4)` boundaries, folded descriptions, plugin sums, MCP names, `null` cases;
  - personal config per role: merged `mcp.json` without an off server and always with `arc`, hooks file with and without events, no file when none left, different hashes;
  - plugin view per role: plugin folders, stub for a repository-enabled off plugin, skills real folder with symlinks, wholesale link when nothing is off, brain and workers differing, `sources()`;
  - Codex config: `enabled:false` entries, covered names exclude them, a server that is on still `prompt`;
  - bypass detector per role;
  - command catalogue uses the worker view.
- **Renderer (jsdom):** the page (groups, switches, accessible names, totals, "size unknown", copy), the store, `BypassWarning` per role, the suggestion button, and the a11y sweep.
- **E2E (Playwright, built app, fakes only; `@spec: 009-choosing-what-agents-load`, `@regression`):** the fake CLI logs its argv; the tests read `--mcp-config`, `--settings` and `--plugin-dir` files of a brain and a worker, and the fake Codex logs the `thread/start` config. Cover each functional criterion group, the `/` list, the bypass warning and the Setup overhead button.
- **RED validation:** each new e2e test is run against deliberately broken behaviour, restored and checked with an md5 of `src/`.

---

## 4b. As built

- `role` on `ClaudePersonalRequest` is optional; left out, nothing is filtered (listings). The three launch paths pass it (orchestrator `brain`, worker manager and command catalogue `workers`), checked by unit tests and e2e.
- `PersonalLaunchConfig.codexMcp(cwd, role?)` splits the servers into running and `disabled`.
- The fake CLI got `FAKE_CLAUDE_SETUP_PER_ITEM`, so the measured fixed setup (spec 008) can be seen to fall.
- The `commands:changed` push after a Workers change is belt and braces: the catalogue's cache key already contains the view hash, so the `/` list refreshes anyway; no e2e test depends on the push.

## 5. Decisions

- **User-confirmed (2026-10-20):** per-item checklist in Settings; default all on with only off items stored; separate Brain and Workers columns; probes and the plan check unchanged; one-pass spec.
- **Skills and agents granularity:** skills are per item (F3 makes it practical and a skill is the unit Claude lists). `~/.claude/agents` is not listed because Arc agents don't load it (F2); the page says so. Per-command switches for `~/.claude/commands` are out of scope (symlink filtering does not work for them and the user did not ask).
- **Hooks are per event**, not one switch, so a `SessionStart` injector can go while a `PreToolUse` guard stays. Plugin hooks follow their plugin.
- **Codex:** supported (F1), so its servers are in the checklist with the same split.
- **"All on" / "All off"** buttons are not built; the user didn't ask.
