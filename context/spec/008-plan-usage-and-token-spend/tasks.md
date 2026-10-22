# Tasks: Plan Usage and Token Spend

Conventions for every Verify task below, the same as earlier specs:
- **Build and gates (targeted, per the user's 2026-10-20 instruction):** build with `npx electron-vite build`, then run `pnpm lint && pnpm typecheck && pnpm format:check`. Run only the unit and renderer test files the slice added or changed, plus the existing ones that cover files it touched (narrow: `ELECTRON_RUN_AS_NODE=1 npx electron node_modules/vitest/vitest.mjs run <files>`). Run only the e2e spec files whose flows the slice touches, plus the throwaway spec. Do NOT run the full unit or e2e suites in slice Verify tasks. The full unit and e2e suites run once, in Slice 8, one after another.
- **Throwaway checks:** write a throwaway Playwright e2e spec that drives the built app with the fake CLIs only (`HARNESS_CLAUDE_BIN`, `HARNESS_CODEX_BIN`, a temp HOME/CODEX_HOME, `HARNESS_E2E=1`). Take screenshots into the scratchpad and look at them.
- **Clean up:** delete the throwaway spec and screenshots, stop every process you started by its PID, remove `test-results/` and any `arc-*`/`harness-*` temp dirs your run created, and confirm `pgrep -fl "fake-claude|fake-codex|fake-mcp"` is empty.
- **Never:** run the real `claude` or `codex` with a model turn (the only exception is the one approved plan-check spike in Slice 4), touch `~/.claude`, `~/.claude.json` or `~/.codex`, or reach the network.

- [x] **Slice 1: Token counts on worker cards and the session header**

  > Every brain and worker turn is recorded, for Claude and Codex, and the session header shows "Tokens · N" and each worker card shows its total, both updating live.
  - [x] Parsers (tech spec §2.2–2.3):
    - Widen the `usage` event in `agent-events.ts` (scope, turnId, model, the four buckets, maxCallInput, callCount, firstCall, contextWindow, perModel, partial).
    - Claude parser: assistant `message.usage` accumulator deduplicated by `message.id`; helper messages as `scope: 'helper'`; zero-`result` fallback with `partial: true`; per-model split from `modelUsage`.
    - Codex parser: delta of `total` with a `last` fallback after resume or reset; the four-column mapping; `maxCallInput`, `firstCall`, `contextWindow`.
    - Table-driven unit tests against the recorded fixtures for each case in tech spec §4.
    - Update `fake-claude.mjs` (deterministic `usage`/`modelUsage` on generated results, assistant usage with repeated ids) and `fake-codex.mjs` (cumulative `total` plus per-request `last`, two updates in one turn, one duplicate). **[Agent: agent-orchestration]**
  - [x] Persistence (tech spec §2.9–2.10):
    - Hand-written migration `0024_usage_turns.sql` with `usage_turns` (all columns and indexes from §2.9, `session_id` ON DELETE SET NULL, no provider CHECK) and the `usage.trackingStartedAt` app setting; journal entry; `schema/usage.ts`; `drizzle-kit generate` shows no diff.
    - `UsageRepo.record` (local `day`, `ON CONFLICT DO NOTHING` on `turn_key`), `sessionTotal` and `workerTotals`.
    - Migration test on a populated 0023 database, and a test that deleting a session keeps its usage rows with snapshots. **[Agent: sqlite-database]**
  - [x] Recording and IPC (tech spec §2.4, §2.11):
    - `src/main/usage/usage-recorder.ts` subscribed at `orchestrator.ts` (brain) and `worker-manager.ts` (workers and resolvers): one row per turn, flush on `turn-result` and on `exit`, helper rows, the per-turn recorded flag, snapshots of session, group, worker label and command.
    - IPC `usage:get-session` and the throttled `usage:session-changed` push (at most once per second per session); `WorkerView.tokens`.
    - Unit tests: one row per turn, flush on exit, no double row. **[Agent: agent-orchestration]**
  - [x] Renderer (tech spec §2.12):
    - `lib/format/tokens.ts` (`formatTokens`, `exactTokens`) with boundary tests.
    - `ui/TokenCount.svelte` (short form, exact count in `title` and `aria-label`).
    - `stores/usage.svelte.ts` (`bySession`, `applySession`, `loadSession`) with the push subscription in `App.svelte`.
    - `sessions/UsageChip.svelte` in `SessionHeader.svelte` before "Review changes" (no panel yet), and the token count on `WorkerCard.svelte`.
    - jsdom tests; keep the a11y sweep passing. **[Agent: svelte-frontend]**
  - [x] Verify (see conventions). The throwaway spec checks:
    - a session with a Claude brain, one Claude worker and one Codex worker shows a header chip equal to the sum of the fakes' tokens;
    - each worker card shows its own total;
    - after a worker turn finishes, the chip and the card increase within 5 seconds without user action;
    - hovering a short number shows the exact count.

    **[Agent: svelte-frontend]**

- [x] **Slice 2: Session usage panel and worker details**

  > Clicking the chip opens a panel listing the brain and every worker with provider, model and the four token columns, per-provider totals and the session total; worker details show the same; old agents show "Not recorded".
  - [x] `UsageRepo.sessionPanel` (per-agent rows grouped by agent, provider and model, plus `max_call_input`), the "Not recorded" and "since Arc started recording" rules against `usage.trackingStartedAt`, and repository tests. **[Agent: sqlite-database]**
  - [x] Build the full `SessionUsage` snapshot: agents joined to the session's brain and workers, per-provider totals, the session total. Extend `usage:get-session` and the push. Unit tests, including an agent created before tracking started. **[Agent: agent-orchestration]**
  - [x] Renderer:
    - `sessions/UsagePanel.svelte`, a popover anchored to the chip, with a row per agent (provider tag, model, input, cache write, cache read, output, total), per-provider totals and the session total, plus the `data-usage-*` hooks.
    - The same breakdown in `WorkerDetails.svelte`.
    - "Not recorded" via `TokenCount`.
    - jsdom tests (keyboard open and close, Escape returns focus). **[Agent: svelte-frontend]**
  - [x] Verify (see conventions). The throwaway spec checks:
    - the panel lists the brain and both workers with every column;
    - Claude and Codex have separate totals;
    - worker details show the breakdown;
    - a session seeded with workers created before the tracking start shows "Not recorded" for them.

    **[Agent: svelte-frontend]**

- [x] **Slice 3: Where the tokens go (setup split)**

  > The panel and worker details show "Arc's additions: about N", "Total fixed setup" (per request and in all) and "The work", and the session shows its setup share.
  - [x] Migration `0025_agent_setup.sql` (`agent_setup`), `AgentSetupRepo`, and `UsageRepo.record` filling `setup_tokens` and `arc_setup_tokens` at write time per tech spec §2.7. Tests. **[Agent: sqlite-database]**
  - [x] `src/main/usage/setup-estimator.ts` (`ceil(chars / 4)` over Arc's prompt, the group context manifest and the role's Arc bridge tool descriptions from `bridge/tools/registry.ts`), called at agent start and resume for brain, workers and resolvers.
    - Fixed setup is taken from `firstCall` of a new thread only, and kept across resumes.
    - Add the setup split and session setup share to `SessionUsage` and `TokenBreakdown`.
    - Unit tests, including that a resume doesn't overwrite fixed setup. **[Agent: agent-orchestration]**
  - [x] `sessions/SetupSplit.svelte` (three labelled figures plus a segmented bar) in the panel and worker details, and the "Setup: N% of this session (Arc's additions about M%)" line. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify (see conventions). The throwaway spec checks:
    - worker details show "Arc's additions" marked "about", "Total fixed setup" and "The work";
    - fixed setup in all plus the work equals the input total shown;
    - the panel shows the session's setup share with the share of Arc's additions.

    **[Agent: svelte-frontend]**

- [x] **Slice 4: Plan meters in the title bar**

  > The title bar shows a meter per set-up provider with the limits it reports, a popover with percentage, reset time and "as of" time, amber at 80% and red at 95%, "Not reported" and "Waiting for first use".
  - [x] Spike, recorded in a new "Spike results" section of `technical-considerations.md`:
    - Print the exact plan-check command from tech spec §2.5 (cheapest Claude model). Ask the user for approval (via `AskUserQuestion`) right before making the ONE allowed real run.
    - Run it from an empty scratch cwd. Never use `~/.claude` beyond what the CLI itself reads.
    - Record whether a `rate_limit_event` with `unifiedWindows` arrives and how many tokens the request used.
    - Save the scrubbed output to `tests/fixtures/claude/2.1.302/plan-check.jsonl`.
    - If the user declines, record that and continue from the existing fixtures. **[Agent: agent-orchestration]**
  - [x] Parsers and service (tech spec §2.3–2.6):
    - Claude `unifiedWindows` (fraction to percent, clamp) and Codex `primary`/`secondary` windows (label from `windowDurationMins`, `planType`) on the `rate-limit` event.
    - Forward these from the orchestrator and worker manager to `src/main/usage/plan-usage-service.ts` (newest observation per window, meter states `waiting`/`ok`/`not-reported`/`stale`).
    - `codex-rate-limit-reader.ts` (`account/rateLimits/read` added to `codex-probe.ts`; on launch, on window focus and every 5 minutes; shared in-flight request; skipped unless Codex is `ok`).
    - Fix the provider name in `rate-limit-gate.ts`.
    - IPC `plan:get`, `plan:refresh` and the `plan:changed` push.
    - Fakes: `fake-claude.mjs` scenario-driven `rate_limit_event`; `fake-codex.mjs` `account/rateLimits/read` responses and `account/rateLimits/updated` via `emit`.
    - Unit tests. **[Agent: agent-orchestration]**
  - [x] Migration `0026_plan_limits.sql` (`plan_limits` and `plan_notices`), `PlanLimitsRepo` and `PlanNoticesRepo` (`claim` as insert-or-ignore). Tests. **[Agent: sqlite-database]**
  - [x] Renderer:
    - `stores/plan-usage.svelte.ts`; `usage/derive.ts` (`limitSeverity`).
    - `ui/PlanMeters.svelte` with `usage/PlanLimitRow.svelte` in `TitleBar.svelte`: popover on hover, focus and click; severity by colour plus an icon with hidden text; collapse to the fullest limit at narrow widths without wrapping; `data-plan-*` hooks.
    - Call `plan:refresh` on window focus.
    - jsdom tests (states, severity at 79/80/94/95, keyboard). **[Agent: svelte-frontend]**
  - [x] Verify (see conventions). The throwaway spec checks:
    - the Claude meter shows 5h and Weekly percentages from the fake's `rate_limit_event`;
    - the popover shows reset and "as of" times;
    - the Codex meter shows its window after launch with no agent running;
    - a provider with no windows shows "Not reported", and one with no data shows "Waiting for first use";
    - at 81% the meter is amber, and at 96% it is red;
    - the title bar doesn't wrap at 1100 px.

    **[Agent: svelte-frontend]**

- [x] **Slice 5: Plan warnings and the Claude plan check on launch**

  > A notice appears once per limit per reset period at 80% and again at 95%. On launch Arc runs the small Claude plan check (behind a setting, on by default) so the Claude meter has a value straight away.
  - [x] `src/main/usage/plan-notices.ts`:
    - key is provider, window, `resetsAt` rounded to the minute, and threshold;
    - highest threshold crossed; insert-or-ignore; prune after 8 days;
    - IPC `plan:dismiss-notice`; notices included in `plan:changed`.
    - Unit tests: 79 → 81 → 96, a jump straight past 80, a new reset re-arming, jitter, survival across a restart. **[Agent: agent-orchestration]**
  - [x] `src/main/usage/claude-plan-probe.ts`:
    - the flags from tech spec §2.5; `ModelRegistry.cheapestFor`;
    - once per launch, after the status check, only when the setting is on, Claude is `ok` and the gate isn't paused;
    - 30 s timeout; failure leaves the meter as it was and writes one warning;
    - usage recorded as `plan_check` with no session.
    - Composition-root guard (`HARNESS_E2E`, `VITEST`) with the `HARNESS_PLAN_PROBE_BIN` override.
    - Setting `usage.checkClaudePlanOnLaunch` (default true) in the app-settings schema.
    - Unit tests: never spawns under `HARNESS_E2E=1` without the override; skipped when the setting is off or Claude isn't ready. **[Agent: agent-orchestration]**
  - [x] Renderer: `banners/PlanNotices.svelte` (the `UpdateNotices` pattern; warning at 80%, error at 95%; Dismiss; `data-plan-notice`), mounted next to `UpdateNotices` in `App.svelte`; the Toggle "Check Claude plan usage when Arc opens" on Settings › Providers. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify (see conventions). The throwaway spec checks:
    - 79% → 81% shows one notice naming the limit, 80% and the reset time;
    - after Dismiss, a rise to 90% shows nothing;
    - 96% shows the second notice;
    - relaunching in the same period shows no notice again;
    - with `HARNESS_PLAN_PROBE_BIN` set to the fake, launch gives the Claude meter a value with an "as of" time;
    - with the setting off and no agent run, the meter shows "Waiting for first use".

    **[Agent: svelte-frontend]**

- [x] **Slice 6: The Usage page**

  > A full-width Usage view opened from the title bar: ranges, totals by provider and model (with a Plan check line), a day-by-day chart, current plan limits, and biggest spenders by session, worker and command.
  - [x] `UsageRepo.rangeTotals`, `dailyByProvider` (days with no usage filled with zero) and `biggestSpenders` (session, worker and command; plan check excluded; "Mixed"; deleted sessions not clickable), plus the local range helper. Repository tests for range boundaries and ordering. **[Agent: sqlite-database]**
  - [x] IPC `usage:get-report` assembling `UsageReport` (including plans and the plan check), and the throttled `usage:changed` push (once per 5 s). Add one line to the session delete dialog's text saying usage history is kept. Unit tests. **[Agent: agent-orchestration]**
  - [x] Renderer:
    - the `'usage'` view in `ui.svelte.ts` and a Usage button in `TitleBar.svelte`;
    - `usage/UsageView.svelte` with `RangePicker`, `UsageTotals`, `PlanLimitsSection`, `DailyChart`, `SpendersList` and the "No usage in this period." empty state;
    - `DailyChart` as hand-rolled SVG with new `--color-chart-claude` and `--color-chart-codex` tokens (contrast guard extended), a pattern alongside colour, no animation under reduced motion or on live updates, focusable days with tooltips, and the always-present table alternative;
    - session and worker rows open the session;
    - stale report responses are ignored.
    - jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify (see conventions). The throwaway spec seeds usage across several days and sessions and checks:
    - 7 days is the default, with totals, per provider and per model;
    - the chart has a bar per day;
    - Today filters everything;
    - spenders by session, worker and command are ordered, with group, provider and model;
    - clicking a session row opens it;
    - an empty range shows "No usage in this period.";
    - the Plan check line appears after a fake plan check.

    **[Agent: svelte-frontend]**

- [x] **Slice 7: Suggestions**

  > Arc points out a model that was too strong, setup overhead, repeated reads and long-running agents, in the session panel and on the Usage page, each dismissible for good.
  - [x] Migration `0027_usage_suggestions.sql` (`usage_suggestions` and `session_file_reads`), `UsageSuggestionsRepo` (dedupe upsert that leaves dismissed rows alone) and `FileReadsRepo`. Tests. **[Agent: sqlite-database]**
  - [x] Suggestions:
    - `readPath` on tool-use events (Claude `Read` `file_path`; Grep/Glob only for a single file; Codex `commandActions` reads), normalized to repo-relative paths across worktrees.
    - `src/main/usage/suggestion-service.ts` with the four rules and timings from tech spec §2.8: deep tier and (no files changed or under 50k) on worker finish; setup share at least 30% after 20k; 3 reads; `max_call_input` over 200k. Text comes from templates.
    - IPC `usage:dismiss-suggestion`; suggestions in `SessionUsage` and `UsageReport`.
    - Fakes: a worker on the deep tier with no changes, repeated reads of one file, and a large-context turn.
    - Boundary unit tests. **[Agent: agent-orchestration]**
  - [x] Renderer: `usage/SuggestionsList.svelte` (kind, text, advice, session link, Dismiss with focus moving to the next item; `data-suggestion*`) in the usage panel and the Usage view (newest first); optimistic dismiss with rollback. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify (see conventions). The throwaway spec checks:
    - each of the four suggestions appears in the panel for its fake scenario, naming the worker, file or size;
    - the Usage page lists them newest first with session links;
    - a dismissed suggestion disappears from both places and stays gone after a relaunch.

    **[Agent: svelte-frontend]**

- [x] **Slice 8: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 008-plan-usage-and-token-spend` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**

## Open Questions

- No acceptance criterion in `functional-spec.md` depends on model behaviour, so none is left to the user's judgement; every criterion is covered by a durable e2e test (`tests/e2e/usage-tokens.spec.ts`, `usage-page.spec.ts`, `plan-meters.spec.ts`, `plan-notices.spec.ts`, `usage-suggestions.spec.ts`) on top of the unit and renderer tests.
- Plumbing-level only (spec text, not an acceptance criterion; covered by unit and jsdom tests but not by an e2e flow): the meters refresh when the window regains focus, the Codex limits poll every 5 minutes, and the meters collapse to the fullest limit below a 36rem container.
- The e2e flows use the fakes' numbers (`fake-claude` usage, `fake-codex` cumulative usage, `rate_limit_event` from a file). Whether the real CLIs report the same shapes was settled by the recorded fixtures and the one approved plan-check spike in Slice 4, not re-checked here.
- Usage-history flows (ranges, ranking, chart) seed `usage_turns` and `sessions` rows directly into Arc's database; the writing path from real turns is covered by the session flows in `usage-tokens.spec.ts` and by the recorder unit tests.

## Amendment (2026-10-20)

- [x] Shared weights module `src/shared/usage-weights.ts` (per-provider ratios, weighted total, new and cache-share helpers) with unit tests.
- [x] Panel columns "Cache write (cold)" and "Cache read (hit)", also in worker details.
- [x] `UsageSummary.svelte` (New / From cache line and "Weighted ≈" with explanation) in the usage panel and the Usage totals; renderer tests.
- [x] "Not counted" footnote in the usage panel.
- [x] Setup overhead reworked in `suggestion-service.ts`: one per session, 30,000 tokens per request trigger, qualifying agents worst first, advice by Arc's share; unit tests.
- [x] Migration `0028_reset_setup_overhead.sql` removing open setup-overhead suggestions; migration test.
- [x] Fake scenario `sg-setup` raised to 33,003 tokens of fixed setup; e2e specs `usage-suggestions`, `usage-tokens`, `usage-page` updated.
- [x] Functional and technical specs and the Change Log updated; screenshots retaken.

## Amendment 2 (2026-10-21)

- [x] Claude parser: `usage-progress` event with the running turn total; handled in the orchestrator, worker manager and terminal log; parser unit tests.
- [x] `UsageTracker` in-flight tracking (accumulate, clear on flush, no double count, exit) and `UsageRecorder` snapshot fields, throttled push and `inFlightOf`; unit tests.
- [x] Shared types: `AgentUsage.inFlight`, `WorkerView.tokensInFlight`; suggestions read saved rows only.
- [x] `LiveMark.svelte` on the card, chip, panel and details; renderer tests.
- [x] Fakes: `fake-codex` `{"usage":n}` step; scenarios `us-live-workers` and `us-live`.
- [x] E2E in `usage-tokens.spec.ts` replacing the "within 5 seconds of a finished turn" test (cards and chip rise mid-turn, marker, final total equals the saved rows, Usage page excludes in-flight); RED validated.
- [x] Functional and technical specs and the Change Log updated; screenshot `008-plan-usage-and-token-spend-live-mid-turn.png`.
