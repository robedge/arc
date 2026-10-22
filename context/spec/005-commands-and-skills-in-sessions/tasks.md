# Tasks: Commands and Skills in Sessions

Verify tasks drive the built app with throwaway Playwright `_electron` scripts that launch `out/main/index.js` through `e2eEnv(userDataDir)` (sets `HARNESS_E2E=1` and `HARNESS_E2E_OFFSCREEN=1`) and `HARNESS_CLAUDE_BIN=tests/e2e/fixtures/fake-claude.mjs`. The fake CLI plays scenario scripts and fakes `control_request initialize`, `AskUserQuestion`, helper task events and `claude plugin …`; no Verify task makes a real model call or changes the user's `~/.claude`.

Every Verify task does the following:

- Uses temporary git repositories and a temporary fake `HOME` with a fake plugin cache (never the real `~/.claude`).
- Saves screenshots to the session scratchpad, never the repo.
- Ends by stopping the app and every fake process it started, by recorded PID.
- Deletes its scripts, screenshots, temporary repositories, fake HOME and userData folders.

The one real-CLI step is the Slice 1 check (spike S2), which runs only after the user approves it.

- [x] **Slice 1: The `/` command list**

  > Typing `/` in the message box lists the user's installed commands, skills and plugin commands ("Yours") and each repository's saved commands, filtered as they type, without any hooks or MCP servers from those plugins reaching Arc's agents. Picking one inserts it; nothing runs yet beyond today's behaviour.
  - [x] Run spike S2 against the real CLI on haiku, only after asking the user and getting approval (stop and report if not approved): typed and multi-select answer formats for `AskUserQuestion`, a deny-message fallback, and a repository `.claude/settings.json` with `hooks` / `enabledPlugins` under `--setting-sources project`. Record results in tech spec §2.1 and adjust §2.6 / §3 if they contradict it. **[Agent: agent-orchestration]**
  - [x] Add `src/main/plugins/plugin-view.ts` (tech spec §2.2): sources from `claude plugin list --json` (user scope, enabled, deduped), sanitized per-plugin folders (allow-listed `plugin.json` keys; links to `commands/`, `skills/`, `agents/` only), the `user` wrapper for `~/.claude/skills` and `~/.claude/commands`, hash, tmp build and rename, keep newest 3, sweep on start, rebuild triggers. `StartOptions.pluginViewDir` and `--plugin-dir` in `buildClaudeArgs` for the brain, workers and resolvers. Unit tests: no `hooks/`, `.mcp.json` or banned keys in the view; dedupe; hash stability; swap and cleanup; launch args. **[Agent: agent-orchestration]**
  - [x] Add `src/main/agents/command-probe.ts` and the catalogue (tech spec §2.3): no-model `control_request initialize` probe per repository, built-ins dropped, source mapping (`user`, `plugin:<name>`, `repo:<project>`), merge across repositories, cache keyed by view hash + repository + `.claude/commands` mtime. Extend the fake CLI to answer `initialize`. Add `src/shared/types/commands.ts`, `commands:list`, `commands:refresh`, `commands:changed` to the contract, wired in `bootstrap.ts`. Unit tests for parsing, mapping, merge and cache. **[Agent: agent-orchestration]**
  - [x] Build `CommandMenu.svelte`, `command-filter.ts` and `stores/commands.svelte.ts` (tech spec §2.10): opens while the box starts with `/` and the cursor is in the first word; prefix then substring filtering; Up/Down, Enter/Tab inserts `/name ` without sending, Escape closes keeping the text; source badges; argument hint as placeholder; combobox/listbox ARIA with a live count; loading, empty and error states; refresh on `commands:changed`. `MessageBubble` highlights a leading `/name`. Design Preview: menu states. jsdom tests for filtering, keyboard, ARIA and the bubble highlight. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build. Run lint, typecheck, format check and the full unit and e2e suites; specs 001–004 must still pass.
    - With a fake HOME holding two plugins (one with a `hooks/` folder and an MCP server) and a repo with `.claude/commands/awos/`, start a session: typing `/aw` lists `/awos:spec` with the repository name; `/super` lists the plugin's skills as "Yours"; the fake CLI log shows `--plugin-dir` on the brain launch, and the view folder contains no `hooks/` or `.mcp.json`.
    - Escape closes the list keeping the text; Enter inserts `/awos:spec ` without sending.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 2: Running a command in a worker**

  > Sending `/awos:spec …` starts a worker labelled "W1 · /awos:spec" in the right repository (asking which one when it's unclear), following the session's mode; its files merge and show in change review. Unknown commands go to the brain as text.
  - [x] Add `workers.command` (TEXT NULL) with the next migration and expose it on the worker row, repository and DTO. Repository test. **[Agent: sqlite-database]**
  - [x] Implement routing and launch (tech spec §2.4): catalogue match in the orchestrator's user-message path with the appended brain instruction; `spawn_worker` and `propose_plan` gain `command?` (validation `unknown_command`, `command_not_in_repo`; `plan-gate` matches the command); the worker's first user message is the command text; `worker-label.ts` renders "W2 · /awos:spec"; refuse commands in a group with no repositories. Extend the fake CLI to echo a `command-name` user event for a first message starting with `/`. Unit tests for routing, validation, plan matching, first message and label. **[Agent: agent-orchestration]**
  - [x] Show the command on worker cards ("W2 · /awos:spec", mono, truncated with the full title), in `WorkerDetails`, and as a chip on plan entries. Design Preview additions. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites as in Slice 1.
    - Autonomous session, one repo: send `/awos:spec retry settings`; a worker "W1 · /awos:spec" starts, the fake worker writes a spec file, it merges, and change review lists the file.
    - Plan-first session: the same command shows a plan with the command chip; nothing starts before approval.
    - Two repos, no repo named: the brain asks which repository with both names as choices.
    - `/does-not-exist` gets the "don't know that command" reply.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 3: Helper agents inside the worker**

  > A command that starts helper agents keeps its worker Working until the helpers finish; the card shows "2 helpers" and the worker's terminal shows their activity, with no extra worker cards.
  - [x] Parser and worker manager (tech spec §2.5): `task-started`, `task-ended`, `tasks-changed` events and `parentToolUseId`; no nudge, stop or done while helpers run; deferred stop after `report_done`; 10-minute cap; activity "Working (2 helpers)"; helper lines in the terminal log; helper permission cards say "(helper)"; `helpersRunning` on the worker DTO. Extend the fake CLI with task events and a first `result` before `task_notification`. Unit tests for the waits, the cap and the terminal lines. **[Agent: agent-orchestration]**
  - [x] Add the "2 helpers" chip on the worker card and in `WorkerDetails` (singular for 1, hidden at 0), and dim, indented helper lines in the worker terminal. Design Preview. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - A fake worker starts two helpers, emits a first `result`, then `task_notification` and a second `result`: the card shows "2 helpers" then clears, the worker stays Working until the second turn, the terminal shows the helper lines, and no extra cards appear.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 4: Questions from commands**

  > When a command asks a question, Needs attention shows it with its choices as buttons (checkboxes for multi-select) and a box for the user's own answer; only the user can answer, and the command continues with that answer.
  - [x] Attention flow (tech spec §2.6): also give the brain's `ask_user` tool optional `choices` (shown as buttons through the same structured card), so "which repository?" offers the repository names as choices (functional spec 2.2); recognise `AskUserQuestion` before classification and coverage (never auto-approved, never resolvable by the brain, brain told it can't answer); question rows with the structured `questions[]`; answers returned as `updatedInput.answers` (formats from spike S2); dismiss returns a deny; `AskUserQuestion` in the brain's disallowed tools; startup recovery cancels pending question rows and tells the resumed worker to ask again; `attention:answer` extended for structured answers. Extend the fake CLI with an `AskUserQuestion` step that waits for the permission response and echoes the answer. Unit tests. **[Agent: agent-orchestration]**
  - [x] Build `StructuredQuestionCard.svelte` mounted by `AttentionDialog` for requests with `questions[]`: header, question, option buttons with descriptions (checkboxes for multi-select), "Other" field, one Submit enabled when every question is answered, label from the worker ("W2 · /awos:spec"). Design Preview variants. jsdom tests for the submit gate, multi-select and Other. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - A fake command asks "Where should the review open?" with two options: Needs attention shows both buttons and the Other box; picking the first continues the worker and its next output names the choice; Auto-approve on does not answer it; the brain's log shows it was told it can't answer.
    - A multi-select question sends the chosen labels.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 5: The brain starting commands**

  > Asked in plain words for something a command does well, the brain uses that command: in Plan-first it appears in the plan; in Autonomous the brain starts it and says which command and why.
  - [x] Brain prompt v4 (tech spec §2.4): a "Commands available" block (up to 40 entries, clipped descriptions, with source) built at brain launch, guidance to prefer a matching command and name it with a one-sentence reason, `BRAIN_PROMPT_VERSION` 4 with a one-time note for older sessions. Unit tests for the block, the cap, presence only with repositories, and the note by version. **[Agent: agent-orchestration]**
  - [x] Verify:
    - Build and run the suites.
    - The fake CLI log shows the brain's launch prompt contains the commands block; a scripted brain that calls `propose_plan` with `command: "/awos:spec …"` in Plan-first shows the command chip in the plan; in Autonomous its `spawn_worker` with a command starts "W1 · /awos:spec".
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 6: Settings and the Plugins list**

  > A gear in the title bar opens Settings; its Plugins page lists the user's installed plugins with version, description, source, counts and badges, with the notes that changes apply in Claude Code and to agents started afterwards. Repositories with their own hooks or plugin settings get a warning.
  - [x] Add `src/main/plugins/plugin-service.ts` list support (tech spec §2.7): resolved binary, limited env, timeouts, `plugin list --json` (user scope, deduped), descriptions from `plugin.json`, counts from files, MCP and hooks flags, update detection against marketplace manifests; `plugins:list` in the contract and `bootstrap.ts`. Repo settings warning: detect `hooks` / `enabledPlugins` in a repository's `.claude/settings.json` at session start and log a one-line event. Extend the fake CLI with `plugin list --json` driven by a state file. Unit tests for parsing, dedupe, counts, flags, update comparison (sha and missing versions) and the warning. **[Agent: electron-main]**
  - [x] Build the Settings entry and page: gear `IconButton` in `TitleBar` opening `SettingsView.svelte` (left nav, "Plugins" first), `PluginsSettings.svelte`, `PluginRow.svelte`, `stores/plugins.svelte.ts`; rows with name, version, description, source, counts and badges ("MCP server not available in Arc", "Hooks are not run in Arc", "Update available"); the two notes; `CliBanner` when Claude Code is missing or signed out. Design Preview. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - With a fake HOME holding three plugins (one with MCP, one with hooks, one with a newer marketplace version), the gear opens Settings › Plugins listing all three with the right badges and counts; signed-out fake CLI shows the banner.
    - A repo with `.claude/settings.json` declaring `hooks` logs the warning in the session's event log.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 7: Installing, updating and removing plugins**

  > The Plugins page installs a plugin by name (with progress), updates one, removes one after confirmation, and checks for updates on request; failures show Claude Code's message; the `/` list follows the change.
  - [x] Add mutations to `plugin-service.ts` (tech spec §2.7): `install`, `update`, `uninstall`, `marketplace update` with `--json -s user -y`, one change at a time, timeouts, cancel on quit from `shutdown.ts`, verbatim error mapping; `plugins:install`, `plugins:update`, `plugins:uninstall`, `plugins:check-updates`, `plugins:progress`; after a change rebuild the plugin view, refresh catalogues and push `commands:changed`. Also queue a one-time note for open brains with the updated command list (a resumed brain keeps its old prompt, so the note is how it learns about new or removed commands). Extend the fake CLI `plugin` branch with mutations, failure and delay switches. Unit tests for the queue, errors, timeout, cancellation and the rebuild hook. **[Agent: electron-main]**
  - [x] Build `InstallPluginForm.svelte` (name, optional marketplace, progress), Update and Remove actions (confirm "Remove superpowers? Its commands stop working in Arc and in Claude Code."), Check for updates, and the verbatim error block. jsdom tests for the confirm text, progress, error and the `/` list refresh. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - Install a fake plugin by name: progress shows, it is listed, and its command appears in the `/` list of an open session.
    - Update a plugin flagged "Update available": the row shows the new version.
    - Remove with Cancel keeps it; Remove with confirm drops it from the list and the `/` list.
    - A failing install shows the fake CLI's message verbatim and leaves the list unchanged.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 8: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 005-commands-and-skills-in-sessions` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**

## Open Questions

- Real-model behaviour of the brain is not covered by an automated test (the e2e brains are scripted, so the tests prove Arc's plumbing, not the model's choices): that the brain, given only the user's words, picks the right repository or asks which one (2.2), says it does not know an unknown command such as `/does-not-exist` (2.1), and chooses a matching command on its own, naming it with a one-sentence reason (2.3). The e2e tests assert what Arc controls: the routing instruction and the "Commands available" block reach the brain, `ask_user` with the repository names as choices shows them as buttons, a `spawn_worker` or `propose_plan` entry with a `command` is validated, labelled and gated by the plan. Checking the model's own wording and choices needs a manual run with the real CLI.
- Real hook execution (2.5, "a personal hook does not run") is not asserted against the real CLI by the suite. `tests/e2e/commands-attention.spec.ts` runs a fake HOME with a personal `PostToolUse` hook and a plugin hook, plays the hooks the real CLI would load for the exact flags Arc passes (`FAKE_CLAUDE_RUN_HOOKS=1` in the fake CLI), and asserts that neither marker file appears, that every agent launch has `--setting-sources project`, and that the plugin view holds no `hooks/`, `.mcp.json` or hook/MCP keys. That the real CLI loads hooks only from those sources was verified by spikes S1 and S2, not by the fake; a CLI release that changes that is not caught by the suite.
- The real shape of `AskUserQuestion` answers (2.4) rests on spike S2 and the fake CLI's copy of it; a change in the CLI's expected `updatedInput.answers` format would not fail the suite.
- Not covered by an e2e flow (kept at unit and jsdom level only): the signed-out and missing-CLI banner on the Plugins page, the 10-minute helper cap, startup recovery of pending command questions, and the one-time note a resumed brain gets when plugins change.
