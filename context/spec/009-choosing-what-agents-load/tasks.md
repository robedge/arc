# Tasks: Choosing What Arc Agents Load

Conventions for every Verify task below, the same as specs 007 and 008:
- **Build and gates (targeted, per the user's 2026-10-20 instruction):** run `pnpm lint && pnpm typecheck && pnpm format:check`, then `npx electron-vite build`. Run only the tests the slice added or changed, plus the existing ones that cover files it touched (`ELECTRON_RUN_AS_NODE=1 npx electron node_modules/vitest/vitest.mjs run <name filters>`, `npx playwright test <files>`). Do NOT run the full unit or e2e suites in slice Verify tasks. They run once, in the last slice: `pnpm test:unit`, then `pnpm test:e2e`.
- **Tests come first:** write the failing test before the code it covers.
- **Fakes only:** the fake CLIs and a temp HOME (`HARNESS_CLAUDE_BIN`, `HARNESS_CODEX_BIN`, `HARNESS_E2E=1`). Never run the real `claude` or `codex` with a model turn, never touch `~/.claude`, `~/.claude.json`, `~/.codex` or Arc's own data, and no network.
- **Clean up:** delete throwaway specs, screenshots outside `docs/screenshots/` and `test-results/`, stop every process you started by its PID, and confirm `pgrep -fl "fake-claude|fake-codex|fake-mcp"` is empty.

- [x] **Slice 1: The Agent loading page lists items and saves the switches**

  > Settings has an "Agent loading" page with MCP servers, plugins, skills and hooks, a Brain and a Workers switch per row, estimates and column totals; the choice is stored and survives a relaunch. Nothing is applied to agents yet.
  - [x] Persistence: `agents.loadOff` in `app-settings-repo.ts`, `AppSettings`, the `settings:set` contract and handler; shared types in `src/shared/types/agent-load.ts`; `LoadSelection`. Unit tests. **[Agent: sqlite-database]**
  - [x] `LoadCatalogue` (items, estimates, `tokens()`), the `agent-load:get` channel and the MCP tool-name memory in `McpToolCatalogue`; Codex servers come from a separate `agent-load:codex` channel so a slow Codex start never holds the page. Unit tests for the estimate and the listing against a temp HOME. **[Agent: agent-orchestration]**
  - [x] Renderer: `agent-load.svelte.ts`, `AgentLoadSettings.svelte`, `LoadRow.svelte`, `ui.settingsPage`, the nav entry. jsdom tests and the a11y sweep. **[Agent: svelte-frontend]**
  - [x] Verify (see conventions): a throwaway or durable e2e opens the page against a temp HOME, switches an item off for Workers, relaunches and sees it still off.

- [x] **Slice 2: MCP servers and hooks follow the selection**

  > A brain or worker started after a change gets a merged MCP config and a hooks file without what is off for its role; the bypass warning follows.
  - [x] `PersonalConfigService.claude` takes the role and filters servers and hook events; the orchestrator passes `brain`, the worker manager `workers`; the command catalogue passes `workers`. Unit tests (per-role file contents, `arc` always present, hash). **[Agent: agent-orchestration]**
  - [x] `BypassDetector` per role, `claudeHookEventsByRole`, the `BypassReport` type and `BypassWarning.svelte` (the Providers page reads the report each time it opens, so no reload is needed after a save). Unit and jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify: an e2e reads the brain's and a worker's `--mcp-config` and `--settings` files from the fake's argv log.

- [x] **Slice 3: Plugins and skills follow the selection, and the `/` list with them**

  > A plugin or skill that is off for a role is missing from that role's plugin folder; for Workers it also leaves the `/` list.
  - [x] `PluginViewService` per role (selection, stubs, skill folder, hash, `KEEP_VIEWS`); `settings:set` refreshes the command catalogue and tells the brains when the Workers list changed. Unit tests. **[Agent: agent-orchestration]**
  - [x] Verify: an e2e checks the plugin folders of a brain and a worker, the `/` list before and after, and a typed command of a switched-off plugin.

- [x] **Slice 4: Codex servers follow the selection**

  > The page lists the Codex servers; a server that is off for a role is disabled on that role's Codex threads.
  - [x] `CodexStartOptions.disabledMcpServers`, `buildThreadConfig`, `applyCodexMcp`, the listing in `LoadCatalogue` (`codex` status). Unit tests. **[Agent: agent-orchestration]**
  - [x] Verify: an e2e reads the fake Codex's `thread/start` config for a Codex brain and a Codex worker.

- [x] **Slice 5: Setup overhead opens the page**

  > The CLI-heavy Setup overhead suggestion has a "Choose what agents load" button; a worker started after a change measures a smaller fixed setup.
  - [x] `SuggestionsList.svelte` button and `ui.openSettings('agent-load')`; jsdom test. **[Agent: svelte-frontend]**
  - [x] Confirm the measurement path (spec 008 §2.7) needs no change: the fake's first request grows with the servers and plugins it was started with (`FAKE_CLAUDE_SETUP_PER_ITEM`), and an e2e compares two workers. **[Agent: agent-orchestration]**
  - [x] Verify: the e2e from the suggestion to the page.

- [x] **Slice 6: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests for the whole feature across unit, renderer and e2e layers. Tag e2e tests `@spec: 009-choosing-what-agents-load` and `@regression`. RED-validate the e2e tests: break the behaviour, watch each fail, restore, and confirm with an md5 check of `src/`. **[Agent: testing-expert]**
  - [x] Run the full unit suite, then the full e2e suite. Fix the stale tests the change broke. Report counts and flakes. **[Agent: testing-expert]**
  - [x] Screenshots at 1280x800 with a 1.5 s settle in `docs/screenshots/009-choosing-what-agents-load-<state>.png` (page, some items off, the suggestion link), checked with Read.

## Open Questions

- Whether the real CLI lets a stub plugin shadow a repository-enabled plugin as a full copy does (assumed from spec 007).
- Whether `~/.claude/commands` should become switchable (needs copying, not symlinks).
