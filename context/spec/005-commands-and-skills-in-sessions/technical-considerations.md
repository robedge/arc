<!--
This document describes HOW to build the feature at an architectural level.
It is NOT a copy-paste implementation guide.
-->

# Technical Specification: Commands and Skills in Sessions

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Completed
- **Author(s):** redgell, with the agent-orchestration, electron-main and svelte-frontend specialists

---

## 1. High-Level Technical Approach

Agents keep running with `--setting-sources project` (no personal hooks, permission rules or user-enabled plugins). Arc instead hands every agent a **sanitized plugin view** — a generated folder containing only the commands, skills and agents of the user's enabled plugins and of `~/.claude/skills` / `~/.claude/commands` — through one `--plugin-dir`. Hooks, MCP servers and LSP servers never reach an agent.

- **Catalogue:** the `/` list comes from the CLI itself through a no-model `control_request initialize` probe, run per repository so repo commands are included.
- **Running:** a message starting with a known `/command` is routed to the brain with an instruction to start one worker whose first user message is the command text; the CLI expands it. Workers gain a `command` field (label "W2 · /awos:spec"). Plan-first plans carry the command. The brain's prompt lists the commands so it can choose one itself.
- **Questions:** `AskUserQuestion` calls arrive at Arc's existing permission-prompt tool; Arc turns them into structured Needs attention questions that only the user can answer, and returns the answers in the shape the CLI expects.
- **Helpers:** commands that start subagents run them in the background; the worker manager waits for them before treating a worker as done, and shows their activity in the worker's terminal.
- **Plugins page:** a Settings view that drives `claude plugin list/install/update/uninstall --json -s user` and rebuilds the plugin view after each change.

### Affected areas

- **New:** `src/main/plugins/` (`plugin-view.ts`, `plugin-service.ts`), `src/main/agents/command-probe.ts`, `src/shared/types/commands.ts`, `src/shared/types/plugins.ts`, migration `00xx_worker_command`; renderer `components/settings/` (Settings view, Plugins page), `components/sessions/CommandMenu.svelte`, `ui/attention/StructuredQuestionCard.svelte`, stores `commands.svelte.ts`, `plugins.svelte.ts`.
- **Changed:** `claude-adapter.ts` (`--plugin-dir`), `claude-parser.ts` (task events, `parent_tool_use_id`), `worker-manager.ts` (helpers, first message = command), `orchestrator.ts` (command routing, brain prompt v4), `attention-coordinator.ts` (AskUserQuestion), bridge tools `spawn_worker` / `propose_plan` (`command`), `plan-gate.ts`, `worker-label.ts`, `startup-recovery.ts`, `shutdown.ts`, IPC contract, `bootstrap.ts`; renderer `Composer`, `MessageBubble`, `WorkerCard`, `WorkerDetails`, `PlanCard`, `AttentionDialog`, `TitleBar` (Settings entry), `worker-terminals` store, Design Preview; test fake CLI.
- **New dependencies:** none.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1. Verified CLI facts (spikes S1 and S2, claude 2.1.302, haiku)

Recorded in the session scratchpad `s1/FINDINGS.md` and `s2/FINDINGS.md` with NDJSON streams. Rows marked "spike S2" are from the second spike.

| Need | Finding |
|---|---|
| User plugins under `--setting-sources project` | Not loaded (only built-in plugins). Arc must pass plugins explicitly. |
| Sanitized `--plugin-dir` | Works; a folder of plugins loads every child. Skills and commands appear namespaced (`superpowers:*`, `backend-development:*` agents). |
| Hooks | A raw plugin dir runs its `hooks/hooks.json` (SessionStart injected context). The sanitized copy must omit the `hooks/` directory, not just keys in `plugin.json`. |
| Plugin MCP servers | Not started under `--strict-mcp-config` (Arc already passes it); never present in a sanitized copy. |
| `~/.claude/skills`, `~/.claude/commands` | Not available under `project`; `--plugin-dir ~/.claude/skills` does not work. A generated `user` wrapper plugin with symlinks works; names gain a `user:` prefix. |
| Repo commands | `.claude/commands/**` in the cwd list as `awos:spec` etc. Their `@.awos/...` includes resolve from the cwd (the worktree has them). |
| `/cmd args` as message text | Expanded by the CLI (replayed as a `command-name` / `command-args` user event) and followed. Same for `/plugin:skill`. |
| `Skill` tool | Works without `--allowedTools Skill`; does not reach the permission tool. |
| Catalogue without a model call | `{"type":"control_request","request":{"subtype":"initialize"}}` on stdin returns commands (name, description, argumentHint, builtin) and agents. |
| `AskUserQuestion` | Available in `-p`; always reaches the permission tool. Input `{questions:[{question, header, options:[{label, description}], multiSelect}]}`. Answer: `{behavior:"allow", updatedInput:{...input, answers:{"<question>":"<label>"}}}` — the model saw the answer. |
| Answer formats (spike S2) | All confirmed. A typed answer matching no option is passed verbatim (`"Which food do you want?"="Spaghetti carbonara with extra truffle"`). A multi-select answer as the string `"Red, Blue"` is understood as both (no array needed). Two questions in one call are answered together in one `answers` object and one tool_result (`Your questions have been answered: "Pick colors"="Red, Blue", "Pick a size"="Large".`). The result prefix varies (`The user answered:` vs `Your questions have been answered:`), so never parse it. |
| Declined (spike S2) | `{behavior:'deny', message:'The user declined to answer.'}` gives the model that message as the tool_result with `is_error:true`; it did not guess, said the question was declined, asked the user in text and ended the turn normally. |
| Repo `hooks` (spike S2) | A repo `.claude/settings.json` `hooks` entry runs under `--setting-sources project` with Arc's flags: SessionStart, UserPromptSubmit and PostToolUse hooks all fired in the worker cwd. Only SessionStart emits `system/hook_started` / `hook_response` stream events; the others leave no event. The no-model `initialize` probe also fires SessionStart hooks (before the `control_response`). |
| Repo `enabledPlugins` (spike S2) | A plugin named there loads from the user's install without `--plugin-dir` (init `plugins` lists it; its commands join the catalogue) and its own hooks run unsanitized (warp and superpowers SessionStart hooks fired, the latter injecting `additionalContext`). Its MCP servers do not start under `--strict-mcp-config`. If Arc's sanitized `--plugin-dir` holds a plugin of the same name, only the inline copy loads and the raw plugin's hooks do not run. |
| Helper agents | The Agent call does not reach the permission tool; the helper's own tool calls do (policy applies). Helpers run **in the background**: the parent emits a first `result` while they run, then `task_notification` and a second turn. Events carry `parent_tool_use_id`; `system/task_started`, `task_progress`, `task_notification`, `background_tasks_changed`. |
| Plugin management | `claude plugin list --json`; `install`/`update`/`uninstall` take `-s user --json -y`. `list --json --available` excludes installed plugins, so it can't detect updates. `update` needs a restart of running agents to apply. |

### 2.2. The plugin view (`src/main/plugins/plugin-view.ts`)

- **Location:** `userData/agent-plugins/<hash>/`, hash = SHA-1 of the sorted `{id, version, installPath, plugin.json mtime}` of the source plugins plus the realpaths of `~/.claude/skills` and `~/.claude/commands` and the shadowed ids (below).
- **Sources:** `claude plugin list --json`, entries with `scope === 'user'` and `enabled`, deduped by id (latest `lastUpdated`). Project- and local-scope plugins are ignored.
- **Per plugin `<hash>/<name>/`:** a written `.claude-plugin/plugin.json` keeping only `name`, `version`, `description` (dropping `hooks`, `mcpServers`, `lspServers` and any other runtime keys), plus symlinks to `commands/`, `skills/`, `agents/` when present. Never `hooks/`, `.mcp.json`, `.lsp.json` or `settings.json`. Name collisions get a marketplace suffix.
- **Repository `enabledPlugins` (spike S2):** a repository's `.claude/settings.json` `enabledPlugins` loads those plugins raw, with their hooks, under `--setting-sources project`; a same-name plugin in Arc's `--plugin-dir` shadows it (only the inline copy loads, its hooks do not run). So `current(groupRepoPaths)` reads each repository's `.claude/settings.json` (read-only; a missing or invalid file counts as empty) and also adds sanitized copies of every enabled id that is installed at any scope (resolved from the plugin list), even when the plugin is not enabled at user scope. The shadowed ids are part of the hash. Repository-level `hooks` still run; `repoSettingsWarnings(repoPath)` returns `{hooks: boolean, enabledPlugins: string[]}` for the later warning.
- **`user` wrapper `<hash>/user/`:** `plugin.json` `{name:"user"}` with symlinks to `~/.claude/skills` and `~/.claude/commands` when present.
- **Build and swap:** build into `agent-plugins/.tmp-<rand>/`, rename to `<hash>/` (discard if it exists), update the in-memory current pointer; keep the newest 3 views and sweep `.tmp-*` on start.
- **Triggers:** app start; after every Plugins page change; `commands:refresh`; and lazily before an agent launch when the hash changed.
- **Use:** `StartOptions.pluginViewDir`; `buildClaudeArgs` adds `--plugin-dir <dir>` for the brain, workers and conflict resolvers. If the build failed, the flag is omitted and a warning logged.

### 2.3. Command catalogue (`src/main/agents/command-probe.ts`)

- **Probe:** spawn `claude -p --input-format stream-json --output-format stream-json --setting-sources project --plugin-dir <view> --strict-mcp-config` with cwd = the repository, send `control_request initialize`, read the `control_response`, close stdin. No model call; 10 s timeout; tracked by the process supervisor; at most 4 in parallel.
- **Entries:** `CommandInfo {name, description, argumentHint?, source: 'user' | 'plugin:<name>' | 'repo:<project>'}`. Built-ins are dropped. Names with a `user:` or known plugin prefix are the user's ("Yours"; plugin commands also show the plugin name); anything else came from the repository (the "(project)" suffix in descriptions is stripped). `user:` names are shown and sent as-is (`/user:plannotator-review`).
- **Merging:** one probe per repository of the group; user and plugin entries deduped by name; repo entries tagged with their repository.
- **Cache:** in memory, keyed by view hash + repository path + newest mtime under `.claude/commands`, 5-minute TTL; warmed at session open, refreshed after plugin changes or `commands:refresh`.

### 2.4. Running a command

- **Routing (orchestrator):** a user message matching `^/(\S+)` whose name is in the catalogue is sent to the brain with an appended instruction: start one worker with `spawn_worker(command: "<the full command text>")`, pick the repository from the request, and if unclear call `ask_user` with the repository names as choices. An unknown name is an ordinary message.
- **`spawn_worker`:** gains `command?: string` (must start with `/`). The orchestrator checks the name against the catalogue (`unknown_command`) and that a repo command exists in the chosen repository (`command_not_in_repo`). `task` stays required as a short description.
- **Plan-first:** `propose_plan` worker entries gain `command?`; `plan-gate` matches name, repositories and command.
- **Launch:** the worker's first user message is exactly the command text; the CLI expands it. The worker otherwise runs as today (working copy, merge, approvals).
- **Persistence and label:** `workers.command TEXT NULL` (migration); `worker-label.ts` renders "W2 · /awos:spec".
- **Brain-started commands:** the brain prompt gains a "Commands available" block (up to 40 entries, `name – description` clipped to 80 characters, with source) and guidance to use a command when the request matches and to name it and give the reason in one sentence. `BRAIN_PROMPT_VERSION` → 4 with a one-time note for older sessions. The list is built at brain launch; plugin changes apply to new sessions.
- **No repositories:** commands are refused with a plain message.

### 2.5. Background helper agents

- **Parser:** new `AgentEvent`s `task-started {taskId, toolUseId, description, backgrounded}`, `task-ended {taskId, status}`, `tasks-changed {running}`; `parentToolUseId?` on assistant and tool events.
- **Worker manager:** tracks running helpers (authoritative count from `tasks-changed`). While helpers run, a `turn-result` neither nudges nor stops the worker nor marks it done; the follow-up turn after `task_notification` is handled normally. A `report_done` with live helpers defers the stop until helpers reach 0 and the next turn ends. Safety cap: 10 minutes.
- **Display:** activity reads "Working (2 helpers)"; helper events are written to the worker's terminal log as indented `↳ helper (<description>)` lines; a permission card from a helper says "(helper)". No worker cards for helpers.
- **Stop and interrupt:** Stop kills the process group (helpers included). An interrupt cancels the turn; if helpers keep running, the card says so and Stop ends them.

### 2.6. Questions from commands (`AskUserQuestion`)

- `attention-coordinator` recognises `tool_name === 'AskUserQuestion'` before classification and coverage: Auto-approve and allow rules never apply, and the brain cannot resolve it (it is told "W2 asks the user a question; you cannot answer it").
- **Row:** attention kind `question` with the structured `questions[]` kept in the stored input; worker status "has question".
- **Answer:** `{behavior:'allow', updatedInput:{...input, answers:{[question]: string}}}` — a single choice sends its label, a typed answer its text, a multi-select its labels joined with ", " (all confirmed by spike S2). Several questions in one call are answered together in one `answers` object keyed by each exact question string. Dismissing returns `{behavior:'deny', message:'The user declined to answer.'}`; the model sees that text as an error result, does not guess, and asks in text (spike S2).
- **Brain `ask_user`:** gains optional `choices` (2 to 6 labels); the row stores one single-select structured question (header "Question"), shown as buttons plus the free-text box, and the brain gets back the label or typed text. A helper's question is marked in `reason` ("helper") and shown as "W2 slug (helper)".
- **Brain:** `AskUserQuestion` is added to the brain's disallowed tools (the brain asks through `ask_user`).
- **Restart:** a pending tool call can't survive the worker process. On startup recovery such question rows get status `cancelled` (no migration: the status column is text), stay undelivered, and their worker (when nothing else is pending for it) becomes Stopped (crash) so Continue resumes it; the resume prompt carries "Your question was cancelled when Arc closed; ask it again if you still need the answer."

### 2.7. Plugin management (`src/main/plugins/plugin-service.ts`)

- **Execution:** the resolved `claude` binary (`cli-resolver`, `HARNESS_CLAUDE_BIN` in dev/e2e) via `execFile`, env limited to `HOME`, `PATH`, `USER`, `LANG`, `TMPDIR` plus `GIT_TERMINAL_PROMPT=0`; timeouts 15 s (list), 5 min (install/update), 60 s (uninstall); one change at a time (a second is refused with "Another plugin change is in progress"); cancelled on quit from `shutdown.ts`.
- **Operations:** `list` (`plugin list --json`, user scope, deduped); `install <name>[@marketplace] -s user --json -y`; `update <id> -s user --json -y`; `uninstall <id> -s user --json -y`. Errors: the CLI's JSON error message, else trimmed stderr, verbatim (ANSI stripped, 2 KB cap).
- **Row details:** description from the plugin's `.claude-plugin/plugin.json` (fallback: marketplace entry); counts from files (`commands/*.md`, `skills/*/SKILL.md`, `agents/*.md`); flags for MCP servers (`.mcp.json` or `mcpServers`) and hooks (`hooks/`).
- **Update detection:** compare the installed version with the plugin's entry in `~/.claude/plugins/marketplaces/<marketplace>/.claude-plugin/marketplace.json` (sha versions compared by prefix with the recorded commit). No comparable version → no badge, Update still offered. Marketplace data is refreshed only by an explicit **Check for updates** button (`claude plugin marketplace update`); Arc never runs it on its own.
- **After a change:** rebuild the plugin view, refresh catalogues, push `commands:changed`. Running workers keep their plugins.

### 2.8. Data Model / Database Changes

| Change | Notes |
|---|---|
| `workers.command` TEXT NULL | The command a worker runs; drives the label and plan matching. One additive migration. |
| `attention_requests` | No schema change: kind `question` already exists; the structured questions live in the stored tool input. |

No tables for plugins or catalogues — both come from the CLI and disk.

### 2.9. IPC Contracts

| Channel / event | Shape |
|---|---|
| `commands:list` | `{sessionId}` → `CommandInfo[]` |
| `commands:refresh` | `{sessionId}` → `CommandInfo[]` |
| `commands:changed` (push) | `{}` — after plugin changes |
| `plugins:list` | → `PluginRow[]` `{id, name, marketplace, version, description, source, counts:{commands, skills, agents}, hasMcp, hasHooks, updateAvailable?}` |
| `plugins:install` | `{name, marketplace?}` → `{opId}` |
| `plugins:update` | `{id}` → `{opId}` |
| `plugins:uninstall` | `{id}` → `{opId}` |
| `plugins:check-updates` | → `{opId}` (runs `marketplace update`) |
| `plugins:progress` (push) | `{opId, state: 'running' \| 'done' \| 'failed', message}` |
| `attention:answer` | extended with two strict variants: `{requestId, answers: {[question]: string[]}}` (per question the chosen labels, or one typed string; every question needs an answer, a single-select takes one) and `{requestId, decline: true}` (dismiss: the command gets `deny` "The user declined to answer."). Decline is a variant of this channel, not a separate one. |

Worker and plan DTOs gain `command?`; worker DTOs gain `helpersRunning`.

### 2.10. Component Breakdown (renderer)

- **Settings entry (new):** Arc has no app-level Settings screen yet. A gear `IconButton` in `TitleBar` opens a Settings view (`components/settings/SettingsView.svelte`) with a left nav; "Plugins" is its first page.
- **`CommandMenu.svelte` + `command-filter.ts` + `stores/commands.svelte.ts`:** opens while the box starts with `/` and the cursor is in the first word; filters by name prefix then substring on name or description; Up/Down, Enter/Tab inserts `/name ` (does not send), Escape closes; source badges ("Yours", plugin name, repository name); the argument hint becomes the placeholder; ARIA combobox/listbox with a live count; loading, empty ("Sent to the brain as a message") and error states. Cache per session, refreshed on `commands:changed`.
- **`MessageBubble`:** highlights a leading `/name` in user messages (mono, accent).
- **`WorkerCard` / `WorkerDetails` / `PlanCard`:** command label "W2 · /awos:spec" (mono, truncated with full title), a "2 helpers" chip while helpers run, command chip on plan entries; helper lines dimmed and indented in the worker terminal.
- **`StructuredQuestionCard.svelte`:** one block per question (header, text, options as buttons with descriptions or checkboxes for multi-select, an "Other" field); one Submit, enabled when every question has an answer; mounted by `AttentionDialog` when a request carries `questions[]`.
- **`PluginsSettings.svelte`, `PluginRow.svelte`, `InstallPluginForm.svelte`, `stores/plugins.svelte.ts`:** list with badges ("MCP server not available in Arc", "Hooks are not run in Arc", "Update available"), Install form with progress, Update, Remove with the spec's confirm text, Check for updates, verbatim error block, the notes that changes apply in Claude Code and to agents started afterwards, and `CliBanner` reuse disabling actions.
- **Design Preview:** menu states, worker card with command and helpers, plan chip, structured question variants, Plugins page states.

---

## 3. Impact and Risk Analysis

### System Dependencies

- Spec 003's agent adapter, worker manager, attention flow, plan gate, bridge tools and startup recovery; spec 004's change review for command output.
- The user's Claude Code install: plugin cache paths, marketplace manifests and the CLI's plugin subcommands (2.1.302 behaviour, spike S1).

### Potential Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Plugin hooks or MCP servers leak into agents | The view copies only `plugin.json` (allow-listed keys) and links `commands/`, `skills/`, `agents/`; unit tests assert no `hooks/`, `.mcp.json` or banned keys; `--strict-mcp-config` stays. |
| A repository's own `.claude/settings.json` declares `hooks` or `enabledPlugins` (confirmed in spike S2: both load under `project`; repo hooks run, and `enabledPlugins` plugins load with their own unsanitized hooks, no plugin MCP under `--strict-mcp-config`) | Treated as trusted repo code (its code already runs in the worker); Arc shows a one-line warning in the session's event log and on the Plugins page when the repo declares `hooks` or `enabledPlugins`. The warning is a read-only parse of the repo's `.claude/settings.json`. Arc cannot suppress them with its flags. A plugin Arc already includes in the sanitized view wins over a same-name `enabledPlugins` entry (its raw hooks do not run). The command probe also fires SessionStart hooks once per repository, so the probe parser must skip `system/hook_*` lines before the `control_response`. |
| Worker marked done while helpers still run | Helper tracking; no stop or nudge while helpers run; 10-minute cap. |
| Answer formats (typed, multi-select, several questions) | Confirmed by spike S2; no remaining risk beyond the CLI changing the format, covered by the fake CLI tests. |
| Stale plugin view after `plugin update` removes the old install path | Hash includes versions and paths, so the next launch rebuilds. |
| Arc changes the user's global Claude Code config | The Plugins page says so; Remove confirms; one change at a time; list refreshed after each change. A terminal running `claude plugin` at the same time can race — the list is re-read after every operation. |
| Probe cost at session open | One short process per repository, cached, at most 4 in parallel. |
| Brain prompt grows with many commands | Capped at 40 entries with clipped descriptions. |

---

## 4. Testing Strategy

- **Fake CLI (`tests/e2e/fixtures/fake-claude.mjs`, unit fakes):** answer `control_request initialize` with a command list (including a built-in to drop); a step that calls the permission tool with `AskUserQuestion`; a step emitting `task_started`, a first `result`, `task_notification` and a second `result`; echo a `command-name` user event for a first message starting with `/`; a `plugin` branch for `list --json`, `install`, `update`, `uninstall`, `marketplace update` driven by a state file, with failure and delay switches.
- **Unit (main):** plugin view sanitizing, dedupe, hash stability, swap and cleanup; `--plugin-dir` in launch arguments; probe parsing and source mapping; catalogue cache; command routing, `spawn_worker` validation, plan matching, label and migration; parser task events; worker manager helper waits; AskUserQuestion bypassing auto-approve and the brain, answer shapes, multiple questions, restart cancellation; plugin service parsing, update comparison, error mapping, busy refusal, timeout and cancellation.
- **Renderer (jsdom):** command filtering and keyboard behaviour, ARIA, store refresh; command label and helpers chip; structured question card (submit gate, multi-select, Other); Plugins page confirm text, verbatim error, banner disabling actions.
- **End-to-end (Playwright, fake CLI, off-screen):** `/aw` → `/awos:spec` → worker "W1 · /awos:spec" → files in change review; Plan-first plan with the command; a command question answered through Needs attention; helpers shown in the terminal with no extra cards; Plugins install → command in the menu, update, remove with Cancel and confirm, failing install message.
- **Real-CLI check:** done in spike S2 (answer formats, deny, repository `hooks` and `enabledPlugins`); no further real-CLI check is required for these.

---

## Change Log

_Dated amendments made after the spec was first written._

- **2026-10-18 (spike S2):** Added the answer-format, declined, repo `hooks` and repo `enabledPlugins` results to the section 2.1 table. Section 2.6: the typed and multi-select formats (comma-joined with ", ") are confirmed, several questions are answered in one `answers` object, and a decline gives the model an error result it handles by asking in text. Section 3: the repo-settings risk is now confirmed rather than untested (repo hooks run; `enabledPlugins` plugins load with unsanitized hooks but no plugin MCP; the sanitized same-name plugin wins), the mitigation names the read-only settings parse for the warning and the probe's SessionStart side effect, and the untested-answer-formats row and the real-CLI check bullet are closed. No contradiction with the planned answer formats; the repo-settings behaviour is worse than assumed only in that `enabledPlugins` hooks bypass the sanitizer.
- **2026-10-19 (Slice 1, plugin view):** Section 2.2 gained the repository `enabledPlugins` shadow copies (spike S2: a same-name inline plugin suppresses the raw plugin and its hooks) and `repoSettingsWarnings`; the shadowed ids join the view hash. The view API is `PluginViewService.current(groupRepoPaths?)`, `rebuild()`, `dispose()`.
