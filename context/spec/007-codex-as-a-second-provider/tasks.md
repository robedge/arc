# Tasks: Codex as a Second Provider

- [x] **Slice 1: Provider status in Settings**

  > Settings gets a Providers page that shows whether Claude and Codex are installed and signed in, with the command to run and a Check again button. The pre-build spikes and the one approved real Codex recording also happen here, so later slices build on verified facts.
  - [x] Run the spikes from tech spec §3 and record the answers in a new "Spike results" section of `technical-considerations.md`.
    - No model call: S3 (sandbox roots, and committing in a linked worktree), S6 (interrupt cancels approvals), S7 (long tool-call timeout), S8 (the Claude flag set loads MCP and hooks but not permissions, via the command probe and a temp HOME), S10 (MCP override merge or replace) and S11 (`model/list` when signed in, read only).
    - Then make the ONE pre-approved real Codex recording with a dev-only `scripts/record-codex.mjs`: read a file, make one patch, run one command that needs approval, and call one MCP tool against a local fake bridge.
    - The recording answers S1, S2, S4 and S5. Save it scrubbed to `tests/fixtures/codex/0.162.1/real-turn.jsonl`.
    - Print the exact recording command before running it.
    - Never touch `~/.codex` or `~/.claude`, apart from read-only listing. **[Agent: agent-orchestration]**
  - [x] Implement provider status (tech spec §2.4 and §2.8):
    - `src/shared/types/provider.ts`;
    - `ProviderStatusService`;
    - `checkCodex` (`codex --version`, `codex login status`, minimum 0.162.0, the API-key label) and per-provider `CLI_MESSAGES`;
    - the `HARNESS_CODEX_BIN` override and the `FAKE_CODEX_` env allowlist under `HARNESS_E2E`;
    - IPC: `providers:get`, `providers:check` and the `providers:changed` push, replacing `cli:status` and `cli:retry-check`;
    - Claude missing still blocks sessions.
    - Start `tests/e2e/fixtures/fake-codex.mjs` with `--version` and `login status`, driven by `FAKE_CODEX_AUTH`.
    - Write unit tests for every state. **[Agent: electron-main]**
  - [x] Build the Settings "Providers" page (tech spec §2.9):
    - first in the Settings nav, and the default page;
    - a status row per provider with the message, the command with a copy button, and Check again;
    - `providers.svelte.ts` replaces `cli.svelte.ts`, and `CliBanner` uses it, still blocking for Claude.
    - Write jsdom tests and keep the a11y sweep passing. **[Agent: svelte-frontend]**
  - [x] Verify:
    1. Build, then run lint, typecheck and format, the full unit suite and the full e2e suite, one after another.
    2. Write a throwaway e2e spec using `fake-codex.mjs`. Check:
       - Settings shows "Codex · signed in";
       - with `FAKE_CODEX_AUTH=signed_out` it shows "Codex · not signed in" with "Run codex login in Terminal";
       - with the binary missing it shows "Codex · not installed";
       - Check again refreshes after the env changes;
       - Claude's banner still blocks when Claude is signed out.
    3. Take screenshots into the scratchpad and look at them.
    4. Clean up: delete the throwaway spec and screenshots, stop started processes by PID, and confirm `pgrep -fl fake-` is empty.

    **[Agent: svelte-frontend]**

- [x] **Slice 2: Every agent shows its provider**

  > The data model and agent layer become provider-aware with Claude only, so nothing changes in behaviour. Worker cards, the plan card, details, the tab header, the brain card and the event log show "Claude · Sonnet" style labels.
  - [x] Write migration `0023_codex_provider` (tech spec §2.6):
    - `app_settings`;
    - `sessions.brain_provider` and `sessions.workers_pref_json`, with the backfill from `model`;
    - `brain_threads`, backfilled from `brain_claude_session_id`;
    - `workers.provider`, `requested_provider` and `fallback_reason`;
    - `RENAME COLUMN claude_session_id` to `provider_session_id`.
    - No CHECK constraints on `sessions` or `workers`. Verify the generated SQL contains `RENAME COLUMN`.
    - Repos: `AppSettingsRepo`, a brain-thread repo, and the worker provider setters. `parsePlanWorkers` normalizes a missing `provider`.
    - Write tests: the backfill, and an upgrade from a 0022 database in which worktrees and held messages survive. **[Agent: sqlite-database]**
  - [x] Refactor the agent layer to be provider-neutral (tech spec §2.1), with Claude only:
    - `CommonStartOptions` plus the `claude` block;
    - `ProviderRegistry` passed to the Orchestrator, WorkerManager and command probe;
    - the event union changes;
    - `BridgeToolNamer`;
    - session ids go through `provider_session_id` and `brain_threads`;
    - views gain `runningOn`;
    - event log lines use the shared `src/shared/provider-label.ts`, e.g. "started W1 api-retry · Claude · Sonnet".
    - All existing tests must pass unchanged, apart from label text. **[Agent: agent-orchestration]**
  - [x] Add `ProviderTag` with the shared formatter on WorkerCard, WorkerDetails, the ConversationTabs header, BrainCard, PlanCard and EventLog, and update the DesignPreview sample data. Write jsdom tests for the formatter and the cards. **[Agent: svelte-frontend]**
  - [x] Verify:
    1. Build, then run lint, typecheck and format, the full unit suite and the full e2e suite.
    2. Write a throwaway e2e spec against the fake Claude CLI. Check:
       - a worker card and its tab show "Claude · Sonnet";
       - the event log shows the provider in the start line;
       - a session created before the migration (seed a 0022 database) still resumes its brain and workers.
    3. Clean up as in Slice 1.

    **[Agent: svelte-frontend]**

- [x] **Slice 3: A Codex worker does real work**

  > With the session header set to "Workers · Codex", the brain's workers run on Codex. They edit and commit in their own working copy, ask before risky commands through Needs attention, and merge into Review changes.
  - [x] Build `CodexAdapter` (tech spec §2.1) in `src/main/agents/codex/`:
    - `codex-rpc`, `codex-parser` (tested against the recording), `codex-config` and `codex-types`;
    - the handshake with version and account checks;
    - `thread/start` and `thread/resume` with the overrides and the Arc bridge server (§2.3);
    - turn tracking, one-at-a-time queueing, the interrupt ladder, the stop ladder and crash relaunch;
    - the env rules (no `OPENAI_*`, `ARC_BRIDGE_TOKEN`, `ARC_AGENT*`).
    - Extend `fake-codex.mjs` with a scripted app-server, NDJSON scenarios written from the recording, and real MCP calls to the bridge.
    - Write tests for: the adapter (handshake, queueing, the interrupt race, the stop ladder), the rpc framing, and the parser fixtures. **[Agent: agent-orchestration]**
  - [x] Make approvals provider-neutral (tech spec §2.2):
    - `NormalizedAction`, `normalizeClaudeCall` and `toStoredCall`;
    - `classifyAction`, with `classify()` kept as a wrapper and a parity test over every existing case;
    - `AttentionCoordinator.requestAction`, with `requestPermission` and `brainRequestPermission` as wrappers;
    - the Codex `ApprovalHandler` for `commandExecution` (`unwrapShell`), `fileChange` and `permissions`;
    - never return a session-wide grant;
    - a best-effort steer after a decline;
    - restart behaviour through the undelivered-answer note;
    - the worker sandbox with the S3 writable roots (no full-access fallback);
    - write `<worktree>/.codex/rules/arc.rules` with `prompt` rules for Arc's protected prefixes, excluded from commits through the worktree's `info/exclude` (tech spec §5);
    - Write unit tests for each request type, including a Codex `git push` that must ask the user. **[Agent: agent-orchestration]**
  - [x] Wire models and the Workers setting (tech spec §2.5):
    - `ModelRegistry`, with Claude static and Codex from `model/list` through `codex-probe`, cached;
    - `resolveWorkerTarget`, the pure resolver, with a full matrix test;
    - `spawn_worker` and `propose_plan` gain `provider`, and the result echoes `{provider, model, note}`;
    - `sessions:set-config` takes `brainModel: ModelRef` and `workers: WorkersPref`;
    - `settings:get`, `settings:set` and `settings:changed`;
    - new sessions copy the Settings defaults. **[Agent: agent-orchestration]**
  - [x] Build the pickers (tech spec §2.9):
    - `HeaderMenu` and `Select` gain option groups;
    - Brain is grouped by provider;
    - Workers offers Auto, Claude, Codex, then grouped models;
    - Codex is hidden when unavailable, unless it is the current pick;
    - labels such as "Workers · Codex";
    - the default Brain and Workers pickers on the Settings Providers page.
    - Write jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    1. Build and run the suites.
    2. Write a throwaway e2e spec using `fake-codex.mjs` and the fake Claude brain. Check:
       - set Settings Workers to "Codex", start a session, and the header shows "Workers · Codex";
       - the brain spawns a worker whose card shows "Codex · <model>";
       - the worker edits a file and commits, merges, and Review changes lists the file with the worker's name;
       - a Codex `git push` appears in Needs attention with the exact command and Approve/Deny, and does not run until it is approved;
       - a header override to "Claude" makes the next worker Claude.
    3. Clean up as in Slice 1.

    **[Agent: svelte-frontend]**

- [x] **Slice 4: The brain on Codex, and the brain choosing Codex**

  > The brain itself can run on a Codex model. With Workers on "Auto", the brain may pick Codex for a review or second opinion and say why. The plan card shows and edits each worker's provider.
  - [x] Put the brain on Codex (tech spec §2.2, §2.5 and §2.6):
    - a read-only sandbox, `classifyBrainAction`, and every edit declined;
    - the Codex brain also gets `.codex/rules/arc.rules` (S2: a user allow rule would otherwise let it run `git push` outside the sandbox). Its working folder is the knowledge folder, which may be a linked folder the user owns, so run the Codex brain from an Arc-owned folder under userData that holds the rules file, and pass the knowledge folder as a readable directory;
    - the Codex brain model change through `turn/start.model`;
    - a provider switch resumes that provider's `brain_threads` row, or starts fresh with the capped hand-off preamble;
    - brain prompt v5 with the "Providers and models" block and the Auto guidance;
    - plan workers gain `provider` and `approvedProvider`, and plan approve takes per-worker `ModelRef`s.
    - Write unit tests: the brain switch and resume, prompt v5, the plan decisions. **[Agent: agent-orchestration]**
  - [x] Add a provider select plus a model select per worker on the plan card. Changing the provider resets the model, and the selects are disabled when the header pins a choice. Write jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    1. Build and run the suites.
    2. Write a throwaway e2e spec. Check:
       - switch the brain to a Codex model mid-reply, and the next reply comes from the fake Codex brain;
       - with Workers on "Auto", the user asks for a second opinion from Codex, and the scripted brain spawns a Codex worker and names Codex;
       - in Plan-first, change a worker from Claude to Codex and approve, and the card shows a Codex model;
       - switching the brain back to Claude resumes the earlier Claude conversation.
    3. Clean up as in Slice 1.

    **[Agent: svelte-frontend]**

- [x] **Slice 5: Falling back to Claude when Codex isn't available**

  > If Codex isn't installed or signed in, workers and the brain run on Claude instead. The card shows "Claude (Codex unavailable)", the event log explains what to run, and a non-blocking note offers Check again.
  - [x] Implement the fallback (tech spec §2.5):
    - the resolver's availability step, with tier mapping (fast becomes haiku, otherwise sonnet) and `requested_provider` and `fallback_reason` stored;
    - the brain's per-reply fallback to Claude · Sonnet, with the stored preference unchanged;
    - `ProviderUnavailableError` from the handshake;
    - the exact event-log texts;
    - a Codex-command worker fails with an explanatory line;
    - a stopped Codex worker is never moved to Claude;
    - a lazy re-check before a Codex spawn.
    - Write unit tests. **[Agent: agent-orchestration]**
  - [x] Build the fallback display:
    - "Claude (Codex unavailable)" on cards and the brain card, with the reason in the title and in details;
    - a dismissible `CodexNote`, shown only when the session uses Codex and Codex isn't ready, with Check again and a Settings link. It never disables the Composer.
    - Write jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    1. Build and run the suites.
    2. Write a throwaway e2e spec with `FAKE_CODEX_AUTH=signed_out`. Check:
       - with Workers "Codex", the worker runs on Claude, its card shows "Claude (Codex unavailable)", and the event log says to run `codex login`;
       - with a Codex brain, the reply comes from Claude · Sonnet and the brain card shows the note;
       - `CodexNote` appears, and Check again after switching the env to `ok` clears it;
       - the next worker runs on Codex.
    3. Clean up as in Slice 1.

    **[Agent: svelte-frontend]**

- [x] **Slice 6: Questions, step in and resuming with Codex**

  > Codex workers can ask questions that reach Needs attention, can be stepped in on and handed back as in spec 006, and Codex sessions resume after closing Arc.
  - [x] Implement these for Codex:
    - `ask_brain` over the bridge for Codex workers, with a 24-hour `tool_timeout_sec`, progress keepalives (per the S7 result) and an idempotent `ask_brain`;
    - `item/tool/requestUserInput` mapped to the structured question card, user only, if S5 showed it fires;
    - step-in through `handle.interrupt()` and `handle.send()`, with pending Codex approvals cancelled on interrupt (rows become `cancelled`);
    - typed `/skill` becomes a skill input, and other slash text gets an explanatory line;
    - hand-back composition unchanged;
    - quit, pause and relaunch through `thread/resume`;
    - a missing Codex history fails cleanly.
    - Write unit tests. **[Agent: agent-orchestration]**
  - [x] Verify:
    1. Build and run the suites.
    2. Write a throwaway e2e spec. Check:
       - a Codex worker's question the brain can't answer appears in Needs attention, and the worker continues after the answer;
       - Step in on a working Codex worker: type a message, the reply appears in the tab, and after Hand back the worker continues;
       - quit with a Codex brain and a Codex worker, relaunch on the same userData, and both histories are there and the user can continue.
    3. Clean up as in Slice 1.

    **[Agent: svelte-frontend]**

- [x] **Slice 7: Codex skills and prompts in the / list**

  > Typing `/` lists the user's Codex skills and saved Codex prompts marked "Codex". Running one starts a Codex worker labelled with its name, whatever the Workers setting.
  - [x] Implement the Codex catalogue (tech spec §2.7):
    - `codex-commands`: skills from `skills/list`, and prompts read from `$CODEX_HOME/prompts` with front matter, expanded by Arc;
    - catalogue entries gain `provider` and `kind`, with ids of the form `provider:name`;
    - Codex entries are listed only while Codex is `ok`;
    - a command forces its provider, and an ambiguous name returns both ids;
    - the brain prompt's command list tags each command with its provider.
    - Write unit tests: prompt expansion, catalogue listing, provider forcing. **[Agent: agent-orchestration]**
  - [x] Show a "Codex" badge in `CommandMenu` for skills and prompts. Same-named entries from both providers each show their own badge. Write jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    1. Build and run the suites.
    2. Write a throwaway e2e spec. Check:
       - with a fake Codex skill "publish-release" and a prompt "review", typing "/pub" and "/rev" shows them marked "Codex";
       - with Workers "Claude", running "/review" starts "W1 · /review" on a Codex model;
       - with Codex signed out, the Codex entries are not listed.
    3. Clean up as in Slice 1.

    **[Agent: svelte-frontend]**

- [x] **Slice 8: Personal MCP servers and hooks for both providers**

  > Claude and Codex agents (brain and workers) load the user's own and their plugins' MCP servers and hooks, but not their permission rules. Read-only MCP tools run; tools that change something go through Arc's approvals. Settings warns about hooks or rules that can skip Arc's approvals.
  - [x] Load the personal configuration (tech spec §2.3):
    - `PersonalConfigService` in `src/main/personal/`.
    - Claude:
      - keep `--setting-sources project`;
      - a hooks-only `--settings` file;
      - one merged `--mcp-config` with `--strict-mcp-config`, containing `arc`, the user's, the plugins' and the repo's servers;
      - the plugin view stops stripping hooks and MCP but still strips LSP servers and `settings`;
      - update the command probe flags to match.
    - Codex:
      - the real `CODEX_HOME`;
      - personal servers get only `default_tools_approval_mode:'prompt'` per server name (S10: overrides merge).
    - Applies to the brain and workers.
    - Invert the `plugin-view` tests.
    - Write `personal-config` tests: hooks kept, permissions dropped, MCP merged.
    - Add to `fake-claude.mjs`: an argv assertion and a personal MCP scenario. **[Agent: agent-orchestration]**
  - [x] Implement MCP approvals and the bypass detection:
    - `McpToolCatalogue`: Codex annotations from `mcpServerStatus/list`; Claude through an Arc-side `tools/list` client with a timeout and cache;
    - the `mcp_write` and `extra_permissions` categories;
    - Codex elicitation approvals per the S4 shape;
    - an exact `mcp__server__tool` allow rule;
    - bypass detection, reporting the user hook events and Codex `rules/*.rules` allow entries to Settings, plus one event-log note per session.
    - Add `tests/e2e/fixtures/fake-mcp.mjs`, with one read-only tool and one writing tool.
    - Write unit tests. **[Agent: agent-orchestration]**
  - [x] Build the renderer side:
    - an MCP approval card showing the server, tool and arguments;
    - the "Your hooks and Codex rules can skip Arc's approvals" warning on the Providers page, listing the hook events and prefixes.
    - Write jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    1. Build and run the suites.
    2. Write a throwaway e2e spec with `fake-mcp.mjs` configured as a personal server for both fakes. Check:
       - a Claude worker's read-only MCP call runs with nothing in Needs attention;
       - a Codex worker's read-only call does the same;
       - a writing call that the brain can't approve shows the server, tool and details in Needs attention with Approve/Deny, and does not run until approved;
       - with a fake user settings file that always allows "git push", a worker's push still asks;
       - the Settings warning lists a fake user hook.
    3. Clean up as in Slice 1.

    **[Agent: svelte-frontend]**

- [x] **Slice 9: New models and provider updates**

  > When Arc opens it refreshes each provider's models and checks for a newer version of each command-line tool. The Providers page shows "Update available" with the update command, and a one-time notice appears. After the user updates in Terminal, new workers and the brain's next reply use the new version without restarting Arc. A restart prompt appears only when a live switch isn't possible.
  - [x] Implement the update checks and pickup (tech spec §2.10):
    - checks at launch, on Check again, and on window focus after 10 minutes;
    - diff the model registry and push `providers:changed`;
    - look up the latest version on the npm registry (time-boxed, cached, silent on failure);
    - derive the update command (`claude update`, `codex update`, or brew);
    - `ProviderStatus` update fields and the `providers.update_dismissed.<provider>` setting;
    - a version change marks the brain stale, so it is resumed on the new binary at its next reply; running workers are untouched;
    - `providers:dismiss-update` and `app:relaunch` IPC.
    - `fake-claude.mjs` and `fake-codex.mjs` get a settable version.
    - Write unit tests: version compare, the cache, the dismiss rule, the stale-brain restart. **[Agent: agent-orchestration]**
  - [x] Build the renderer:
    - "Update available: X → Y" with the command and a copy button on the Providers page;
    - a dismissible one-time update notice per version;
    - the "Restart Arc to finish updating" modal with Restart now and Later;
    - model pickers that update live from `providers:changed`.
    - Write jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    1. Build and run the suites.
    2. Write a throwaway e2e spec using the fake CLIs and a stubbed registry response. Check:
       - an update shows on the Providers page with "codex update", and the notice appears once and stays dismissed after a relaunch;
       - a new fake Codex model appears in the header list without restarting, and the brain can switch to it;
       - change the fake Codex version and press Check again: the next worker starts on it, and the brain's next reply is resumed on it with the conversation kept;
       - force the restart case: the modal appears, Restart now relaunches, and the session resumes.
    3. Clean up as in Slice 1.

    **[Agent: svelte-frontend]**

- [x] **Slice 10: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 007-codex-as-a-second-provider` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**

---

## Open Questions

Slice 10 found no criterion where the product behaved differently from the spec. These parts cannot be proved with scripted fakes, and are listed so they are not mistaken for tested:

- 2.2 "the brain may pick Codex when it suits the task" and "names the provider and says why": this is model behaviour. `tests/e2e/codex-provider-brain.spec.ts` checks the plumbing only: the brain's prompt tells it to choose Codex for a review or a second opinion, a `spawn_worker` call that names `codex` starts a Codex worker, and the card, the log and the reply show it. Whether a real brain makes that call needs a manual check on a real Codex subscription.
- 2.6 "a Claude worker asked to read a Figma file uses the Figma tool": a model deciding to call the tool is not testable with a fake. `tests/e2e/codex-personal-mcp.spec.ts` checks that the user's server reaches the worker's `--mcp-config`, that a read-only call runs without a question and that its result is in the terminal. The "always allow git push" criterion checks the launch flags (`--setting-sources project`, `--settings` with hooks only), not the real Claude CLI's use of them.
- 2.8 "Restart now reopens Arc": the e2e test replaces `app.relaunch` with a stub that records the call, then starts Arc again on the same data. A real relaunch is not exercised, to avoid leaving a second Electron process behind.
- 2.8 "a copy button": the tests check that it is shown, not that the clipboard receives the command.
