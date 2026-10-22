# Technical Specification: Plan Usage and Token Spend

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Completed
- **Author(s):** redgell

---

## 1. High-Level Technical Approach

Both CLIs already report token usage and plan limits in their event streams; Arc's parsers read a fraction of it and then drop it (`orchestrator.ts:1926`, `worker-manager.ts:1439`). This spec:

1. **Parses more.** It widens the Claude and Codex parsers to emit a full per-turn `usage` event (four token buckets, largest single request, first request, request count, per-model split) and plan-limit windows, and it records the file path of read tools.
2. **Records it.** A new `UsageRecorder` folds usage events into one row per agent turn in a new `usage_turns` table. That table outlives sessions, so history stays correct. A `SetupEstimator` stores per-agent setup sizes.
3. **Tracks plan limits.** A `PlanUsageService` keeps the latest limit per provider and window, gets them from Arc's own runs, a no-model Codex read (on launch, on focus and every 5 minutes) and an optional tiny Claude request on launch. It raises 80% and 95% notices once per reset period.
4. **Suggests.** A `SuggestionService` detects the four waste patterns from recorded data and stores them deduplicated.
5. **Shows it.** The renderer adds:
   - a usage chip and panel in the session header;
   - token counts on worker cards and in worker details;
   - plan meters in the title bar;
   - plan notices;
   - a full-width Usage view opened from the title bar.

   All of it is fed by `usage:*` IPC with throttled pushes.

Everything is new code under `src/main/usage/` and `src/renderer/src/lib/components/usage/`, plus one additive migration (0024). The only real model call Arc adds is the opt-out Claude plan check.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 Facts from the recorded fixtures

| # | Fact | Source |
|---|---|---|
| F1 | Claude `result.usage` sums every API request in one user turn; it is not cumulative across turns. | `tests/fixtures/claude/2.1.302/tool-turn.jsonl`, `interrupt.jsonl` |
| F2 | The size of a single request (`input + cache_creation + cache_read`) is only on assistant `message.usage`. | same |
| F3 | An interrupted turn's `result` has zero usage although its assistant messages had usage. | `interrupt.jsonl`, `auth-failure.jsonl` |
| F4 | Helper (Agent tool) messages carry `parent_tool_use_id` and are not included in `result.usage`. | `subagent-background.jsonl` |
| F5 | One assistant `message.id` repeats once per content block, so it must be deduplicated. | `text-turn.jsonl` |
| F6 | Codex `tokenUsage.last` is one request; `total` is cumulative for the thread; `inputTokens` includes cached tokens. | `tests/fixtures/codex/0.162.1/real-turn.jsonl` |
| F7 | Codex limits are `primary`/`secondary` with `usedPercent` 0–100, `windowDurationMins`, `resetsAt`, `planType`. | same |
| F8 | Claude `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization` is a fraction (0.02), with `resetsAt`. | `text-turn.jsonl` |

### 2.2 Normalized events (`src/main/agents/agent-events.ts`)

**`usage` event** (replaces the current shape at :79–87; new fields optional so existing consumers compile):

| Field | Meaning |
|---|---|
| `scope` | `turn`, or `helper` for a Claude helper message (F4) |
| `turnId?` | Codex turn id; Claude: per-process sequence number |
| `model?` | full model id as reported |
| `input`, `cacheWrite`, `cacheRead`, `output` | non-overlapping buckets; `input` is fresh input only |
| `maxCallInput` | largest single request's `input + cacheWrite + cacheRead` in the turn |
| `callCount` | number of requests in the turn |
| `firstCall?` | `{input, cacheWrite, cacheRead}` of the agent's first request of a new thread |
| `contextWindow?` | model context window when reported |
| `perModel?` | per-model split (Claude `modelUsage`) |
| `partial` | true when built from assistant messages because `result` was zero (F3) |

**`rate-limit` event** gains `windows?: {windowId, label, usedPercent (0–100), resetsAt}[]` and `planType?`. Existing `status`/`resetsAt` stay, because `RateLimitGate` uses them.

**`tool-use` event** gains `readPath?: string` (at most 500 characters) for read tools.

### 2.3 Parser changes

**Claude (`src/main/agents/claude-parser.ts`)**
- Keep a per-turn accumulator of assistant `message.usage`, keyed by `message.id` (last write wins, F5). It gives `maxCallInput`, `callCount` and, on the agent's first top-level message, `firstCall`.
- An assistant line with `parent_tool_use_id` emits its own `usage` with `scope: 'helper'` straight away (deduplicated by id). It counts toward the worker's totals but not toward `maxCallInput` or `firstCall`.
- At `result`, totals come from `result.usage` and the per-model split from `modelUsage`. If `result.usage` is all zero but the accumulator isn't, emit the accumulator with `partial: true`. Reset the accumulator after each `result`. The `usage` event still precedes `turn-result`.
- `rateLimitSchema` (:121) and `parseRateLimit` (:407) read `unifiedWindows`, multiply `utilization` by 100 and clamp it to 0–100. A value above 1.5 is treated as already a percentage. Window labels: `five_hour` is "5h", `seven_day` is "Weekly".
- For `Read`, `readPath` comes from `input.file_path`. `Grep`/`Glob` count only when they target a single file.

**Codex (`src/main/agents/codex/codex-parser.ts`, `codex-types.ts`)**
- `onUsage` (:312) keeps `prevTotal` per thread. Each update's delta is `total - prevTotal`, field by field. If there is no previous total or the counter went backwards (resume, reset), it uses `last`. A re-emitted update gives a zero delta, so nothing is counted twice. If `last` differs from the delta, Arc logs it at debug level and trusts the delta.
- Mapping to the four columns:
  - `input = max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens)`
  - `cacheRead = cachedInputTokens`
  - `cacheWrite = cacheWriteInputTokens`
  - `output = outputTokens`, with reasoning assumed to be inside `outputTokens`
- `maxCallInput = last.inputTokens` (max over the turn). `firstCall` is the thread's first update. `contextWindow = modelContextWindow`. The model comes from the agent's configured model.
- `onRateLimits` (:331) emits `windows` from `primary` and `secondary`. `windowId` is `codex:<windowDurationMins>` and the label comes from the duration (300 is "5h", 10080 is "Weekly", otherwise "Nh"/"Nd").
- `commandItemSchema` (`codex-types.ts:90`) keeps `commandActions`; a `type: 'read'` action sets `readPath`.
- `codex-probe.ts` adds `account/rateLimits/read`, which makes no model call.

**`rate-limit-gate.ts:67–74`** takes the provider so the log line stops saying "Claude" for Codex agents.

### 2.4 Main-process services (`src/main/usage/`, new)

| File | Responsibility |
|---|---|
| `usage-recorder.ts` | Subscribes where usage is dropped today (orchestrator for the brain, worker manager for workers and resolvers) and for the plan check. It sums usage events per turn, flushes one `UsageTurnInput` on `turn-result` or on `exit`, and passes helper events through as their own rows. A per-turn flag stops a partial row and a later `result` from both being recorded. After writing, it pushes `usage:session-changed` (throttled) and calls the suggestion checks. |
| `setup-estimator.ts` | `estimateSetup({instructions, toolDescriptions}) → {tokens, chars}` using `ceil(chars / 4)`. It runs at agent start and resume, inside the adapters' `start()`/`resume()`, which already receive the instructions, with the Arc bridge tools for the role from `bridge/tools/registry.ts`. It upserts `agent_setup`. |
| `plan-usage-service.ts` | `ingest(provider, windows, source)` takes the newest `observedAt` per window and persists to `plan_limits`. It exposes `meters()`, calls `plan-notices.ts` and pushes `plan:changed`. Inputs: `rate-limit` events forwarded from the orchestrator and worker manager, the Codex reader and the Claude probe. |
| `codex-rate-limit-reader.ts` | Calls `account/rateLimits/read` through the no-model Codex probe on launch, on window focus (the same hook `ProviderStatusService` uses) and every 5 minutes (an unref'd interval, cleared on dispose). Overlapping calls share one request. It is skipped unless Codex status is `ok`. |
| `claude-plan-probe.ts` | The launch plan check (2.5). |
| `plan-notices.ts` | Threshold and notice logic (2.6). |
| `suggestion-service.ts` | Detects the four patterns (2.7) and upserts `usage_suggestions`. |

### 2.5 Claude plan check on launch

- **Command**, spawned through `ProcessSupervisor` and `CliResolver` like `command-probe.ts`. Every flag exists in CLI 2.1.302 (`claude --help`):
  `claude -p "." --model <cheapest> --output-format stream-json --verbose --tools "" --strict-mcp-config --disable-slash-commands --setting-sources project --settings <generated {"disableAllHooks":true}> --system-prompt "." --no-session-persistence`
- **Excluded:** no `--plugin-dir`, no `--add-dir` and no Arc bridge. The cwd is an empty `userData/plan-probe/`. `--bare` is not used, because it only accepts an API key and would not use the subscription.
- **Model:** `ModelRegistry.cheapestFor('claude')`, a new helper that returns the `fast` tier (Haiku). The alias is not hard-coded.
- **When:** once per launch, after the provider status check, and only if all of these hold: the setting `usage.checkClaudePlanOnLaunch` is on (default true, in `app_settings`, with a Toggle on Settings › Providers); Claude status is `ok`; and the rate-limit gate isn't paused.
- **Limits:** 30 s timeout, then the existing graceful-stop-then-kill. No retry.
- **Failure or no rate-limit event:** the meter keeps its last value (or stays "Waiting for first use") and Arc writes one `log.warn`. The user sees nothing.
- **Usage:** recorded as `agent_role = 'plan_check'` with `session_id` null. It counts in the Usage page totals, per provider, per model and per day, and appears as its own "Plan check" line. It is excluded from the biggest-spenders rankings.
- **Test guard:** the composition root enables the probe only when the setting is on, and `HARNESS_E2E !== '1'`, and `VITEST` is not set. E2E opts in with `HARNESS_PLAN_PROBE_BIN`, pointing at the fake Claude. A unit test asserts the probe never spawns under `HARNESS_E2E=1` without the override.

### 2.6 Plan limits and notices

- **Meter state** per provider is one of four:
  - `waiting`: no observation yet;
  - `ok`: limits known;
  - `not-reported`: the provider answered with no windows;
  - `stale`: shown when a window's `resetsAt` has passed. That window shows "Reset" until a new observation arrives, and Arc never shows an old high percentage as current.
- **Severity** comes from `usedPercent` alone: amber at 80% or more, red at 95% or more.
- **Notices.** The key is `provider|windowId|resetsAt rounded to the minute|threshold`. Rounding to the minute absorbs jitter in reset times. The flow:
  1. On each ingest, find the highest threshold crossed: 95, otherwise 80.
  2. `INSERT OR IGNORE` into `plan_notices`.
  3. If the row was new, push the notice.
- **What that gives:**
  - once per limit per reset period, and it survives restarts;
  - a jump from 79% straight to 96% shows only the 95% notice;
  - a drop below 80% doesn't re-arm; only a new reset period does;
  - launching Arc at 85% shows the 80% notice once.
- **Dismissal** writes `dismissed_at`. Rows whose reset is more than 8 days past are pruned.

### 2.7 Setup and the work

- **Arc's additions:** the stored estimate from 2.4: Arc's prompt (brain, worker or resolver builder, the commands and providers sections, the group context manifest) plus the descriptions and schemas of the Arc bridge tools for the agent's role. It is shown as "about N".
- **Total fixed setup:** the agent's first request of a new thread, `firstCall.input + cacheWrite + cacheRead`. It includes the CLI's own system prompt and the user's own MCP tools. After a resume the first request also carries the old conversation, so the stored value is kept rather than overwritten.
- **Per-turn setup:** each request resends the fixed setup (mostly as cache reads). Each `usage_turns` row stores two values at write time, so shares don't shift when an estimate is refreshed:
  - `setup_tokens = min(turn input, fixed setup × callCount)`;
  - `arc_setup_tokens = min(setup_tokens, Arc's additions × callCount)`.
- **Display:**
  - "Total fixed setup" shows the per-request size and the total across requests, for example "18.4k per request · 92k in all".
  - **The work** = total input minus the summed `setup_tokens`.
  - Fixed setup in all plus the work equals the total input, as the functional spec's 2.2 acceptance criterion requires.
- **Session share:** `SUM(setup_tokens) / SUM(total tokens)`, with the share of Arc's additions from `SUM(arc_setup_tokens)`.

### 2.8 Suggestions

| Kind | Rule | When checked |
|---|---|---|
| Model too strong | Worker's model tier is `deep` (`ModelRegistry.tierOf`), AND it changed no files (the review diff-stat for the worker) or used under 50,000 tokens in total. Suggests `defaultFor(provider)`. Workers only. | On worker finish (`report_done` or exit) |
| Setup overhead | One per session (`setup-overhead\|<sessionId>`). Any agent of the session (brain, worker, resolver) whose `agent_setup.fixed_setup_tokens` for its current provider is 30,000 or more per request. The text lists those agents worst first; Arc's share is `SUM(arc_setup_tokens) / SUM(setup_tokens)` over them, and the advice is about Arc's additions at 25% or more, otherwise about the CLI, plugins, skills and MCP servers. Helpers and the plan check are not judged. The service reads the agents from `UsageRecorder.snapshot().agents`. | After each recorded turn |
| Repeated work | The same repo-relative file is read 3 or more times in one session, by any agents. Names the file and the workers. | On each counted read; the suggestion is created when the count reaches 3 |
| Long-running agent | A turn's `max_call_input` is over 200,000 (brain or worker). Shows the size and, when known, its share of the context window. | After each recorded turn |

- **Read paths:** relative paths are resolved against the worker's worktree, and the worktree prefix is stripped, so two workers' copies of one file count as one path.
- **Text:** rendered in main from templates, in plain words.
- **Dedupe and dismissal:** a unique `dedupe_key` per kind (`kind|session|agent`, `kind|session|path`, or `kind|session` for Setup overhead). An upsert refreshes the numbers only while the suggestion is open, so a dismissed suggestion is never recreated. Suggestions are read from the table, newest first.

### 2.9 Data model (migration `0024_usage_tracking.sql`, hand-written, additive only)

Schema file `src/main/db/schema/usage.ts`, exported from `schema/index.ts`. Times are epoch ms.

**`usage_turns`** (append-only, one row per agent turn or helper message)

| Column | Notes |
|---|---|
| id | integer PK |
| session_id | FK `sessions.id` **ON DELETE SET NULL**; null for the plan check |
| agent_key | `brain`, worker id, `resolver:<id>` or `plan-check`; no FK, because usage outlives workers |
| agent_role | `brain` / `worker` / `resolver` / `plan_check` (CHECK) |
| worker_id | nullable, no FK |
| provider, model | text; no CHECK on provider, so Cursor needs no migration |
| command | copy of `workers.command` at write time |
| session_name, group_id, group_name, worker_label | snapshots at write time; queries use `COALESCE(live, snapshot)` |
| at, day | `day` is the local `YYYY-MM-DD`, stored at write time |
| input_tokens, cache_write_tokens, cache_read_tokens, output_tokens | non-negative |
| max_call_input, call_count, context_window | for the long-running rule and setup |
| setup_tokens, arc_setup_tokens | see 2.7 |
| source | `turn` / `helper` / `partial` |
| turn_key | idempotency key; unique `(agent_key, turn_key)` where not null |

Indexes: `(day)`, `(session_id, agent_key)`, `(provider, model, day)`, and the partial unique index on `turn_key`.

**`agent_setup`:** one row per (session, agent_key, provider). Columns: `arc_additions_tokens`, `fixed_setup_tokens` (nullable until the first request), `model`, `estimated_at`. FK cascades with the session.

**`plan_limits`:** PK (provider, `"window"`). Columns: `label`, `used_percent`, `resets_at`, `observed_at`, `source`, `plan_type`.

**`plan_notices`:** PK `key`. Columns: `provider`, `window`, `threshold`, `resets_at`, `notified_at`, `dismissed_at`.

**`usage_suggestions`:**
- id PK, kind (CHECK), session_id (FK cascade), agent_key, worker_id;
- `dedupe_key` UNIQUE;
- text, advice, params_json, usage_day, created_at, dismissed_at.

Indexes: `(session_id)`, `(dismissed_at, created_at DESC)`.

**`session_file_reads`:** PK (session_id, agent_key, path). Columns: `read_count`, `last_read_at`. FK cascades with the session. The count survives restarts, which matters because workers resume.

**Tracking start:** the migration inserts `app_settings` key `usage.trackingStartedAt` with `INSERT OR IGNORE`. An agent created before that time with no usage rows shows "Not recorded". One with rows but created before it shows its numbers with "since Arc started recording". One created after it with no rows shows 0.

The SQL follows 0023's conventions, including the hand-edited `meta/_journal.json`. Afterwards `drizzle-kit generate` must report no diff. A migration test runs 0024 on a populated 0023 database.

### 2.10 Repositories (`src/main/db/repositories/`)

| Repo | Key methods |
|---|---|
| `UsageRepo` | `record(turn) → {inserted}` (fills `day` and the setup columns; `ON CONFLICT DO NOTHING`); `sessionPanel(sessionId)`; `sessionTotal(sessionId)`; `workerTotals(sessionId)`; `rangeTotals(range, now)` (total, by provider, by model, plan check); `dailyByProvider(range, now)`; `biggestSpenders(range, by, limit, now)` |
| `AgentSetupRepo` | `upsert`, `get`, `forSession` |
| `PlanLimitsRepo` | `upsertObservation`, `list` |
| `PlanNoticesRepo` | `claim(key, …) → boolean` (insert-or-ignore), `dismiss(key)`, `pending()`, `prune(before)` |
| `UsageSuggestionsRepo` | `upsert` (dedupe rule), `dismiss`, `forSession`, `listForRange` |
| `FileReadsRepo` | `bump(sessionId, agentKey, path, now)`, `repeated(sessionId, min)` |

**Range helper:** one helper turns a range into local `fromDay`/`toDay` strings. Today is the local date, 7d is today and the 6 days before, 30d is today and the 29 days before, and all has no filter.

**Biggest spenders:**
- Rows are ordered by `SUM(total) DESC`, and the plan check is excluded.
- Provider and model show the pair with the most tokens, or "Mixed".
- A row whose session was deleted is shown but can't be clicked.
- The command ranking groups by `command` and includes a run count.

### 2.11 IPC (`src/shared/ipc/contract.ts`; types in `src/shared/types/usage.ts`)

| Channel | Kind | Payload |
|---|---|---|
| `usage:get-session` | invoke | `{sessionId}` → `SessionUsage` (agents with `tokens: TokenBreakdown \| null` (null means "Not recorded"), `maxCallInput`, setup split; per-provider totals; session total; setup share; open suggestions) |
| `usage:get-report` | invoke | `{range: 'today'\|'7d'\|'30d'\|'all'}` → `UsageReport` (totals, by provider, by model, plan check, daily by provider, spenders by session/worker/command, suggestions, plans) |
| `usage:dismiss-suggestion` | invoke | `{id}` |
| `plan:get` | invoke | `{}` → `{plans: ProviderPlan[], notices: PlanNotice[]}` |
| `plan:refresh` | invoke | `{}`; runs the Codex read (Claude uses data already received) |
| `plan:dismiss-notice` | invoke | `{key}` |
| `usage:session-changed` | push | a full `SessionUsage` snapshot, throttled to at most once per second per session (trailing edge) |
| `usage:changed` | push | invalidation for the Usage view, throttled to once per 5 s |
| `plan:changed` | push | `{plans, notices}` |

`TokenBreakdown` is `{input, cacheWrite, cacheRead, output, total, arcAdditions, fixedSetupPerRequest, fixedSetupTotal, work}`. `WorkerView` gains `tokens?: TokenBreakdown | null` so cards render without an extra call. The setting goes through the existing `settings:get`/`settings:set`.

### 2.12 Renderer (`src/renderer/src/lib/`)

**Helpers**
- `format/tokens.ts`:
  - `formatTokens` gives 950 / 12.4k / 1.2M, and 999,950 becomes 1.0M;
  - `exactTokens` gives the grouped number for hover;
  - `formatPercent`, `formatResetTime` and `formatAsOf`.
- `usage/derive.ts` holds pure functions: `limitSeverity` (ok / warn ≥ 80 / critical ≥ 95), the totals, and the setup share.

**Stores** (class stores like `providers.svelte.ts`)
- `stores/usage.svelte.ts`:
  - state: `bySession`, `range` (default `7d`), `report` and `spenderKind`;
  - `loadReport` ignores stale responses;
  - dismiss is optimistic, with rollback on failure.
- `stores/plan-usage.svelte.ts`: `byProvider`, `notices`, and a derived `meters` list for set-up providers only.
- `ui.svelte.ts` gains the `'usage'` view; `settings.svelte.ts` gains `checkClaudePlanUsage`.
- Push subscriptions live in `App.svelte`, next to `providers:changed`.

**Components**

| Component | Notes |
|---|---|
| `ui/TokenCount.svelte` | Every number in the feature: short form, exact count in `title` and `aria-label`, "Not recorded" for null; `data-tokens` |
| `sessions/UsageChip.svelte` | "Tokens · 1.2M" in `SessionHeader.svelte`, before "Review changes"; opens the panel; `data-usage-chip` |
| `sessions/UsagePanel.svelte` | Popover anchored to the chip. A row per agent (provider tag, model, input, cache write, cache read, output, total), per-provider totals, session total, setup share line, the session's suggestions. Hooks `data-usage-panel`, `data-usage-row`, `data-usage-total`, `data-usage-provider-total`, `data-setup-share` |
| `sessions/SetupSplit.svelte` | "Arc's additions: about N", "Total fixed setup", "The work", with a segmented bar; shared with `WorkerDetails.svelte`; `data-setup-split` |
| `WorkerCard.svelte`, `WorkerDetails.svelte` | Token count near `ProviderTag` (:70); details show the breakdown and `SetupSplit` (:121) |
| `usage/UsageView.svelte` | Full-width view (`ui.view === 'usage'`), with a Usage button in `TitleBar.svelte`. Contains a Back button, `RangePicker`, `PlanLimitsSection`, `UsageTotals` (with the Plan check line), `DailyChart`, `SpendersList`, `SuggestionsList`, and the empty state "No usage in this period." |
| `usage/DailyChart.svelte` | Hand-rolled inline SVG stacked bars per day by provider, with no library. Colours come from new tokens `--color-chart-claude` and `--color-chart-codex`, covered by the contrast guard, plus a pattern so hue isn't the only signal. There is no entrance animation under reduced motion and none on live updates. Focusable days with tooltips, and a "Show as table" option (the table is always present for screen readers). Hooks `data-daily-chart`, `data-day`, `data-chart-table` |
| `usage/SpendersList.svelte`, `usage/RangePicker.svelte` | Segmented radiogroups; session and worker rows open the session; `data-spender-kind`, `data-spender-row`, `data-range` |
| `usage/SuggestionsList.svelte` | Kind, text, advice, session link, Dismiss (focus moves to the next item); `data-suggestion`, `data-suggestion-dismiss` |
| `ui/PlanMeters.svelte` + `usage/PlanLimitRow.svelte` | In `TitleBar.svelte`, one button per set-up provider ("Claude · 5h 42% · Weekly 18%"). The popover shows each limit's percentage, reset time and "as of" time, "Not reported" or "Waiting for first use". Below the minimum width the meter collapses to its fullest limit, and never wraps. Severity is shown by colour and an icon with hidden text. Hooks `data-plan-meter`, `data-severity`, `data-plan-meter-state` |
| `banners/PlanNotices.svelte` | Copies the `UpdateNotices.svelte` pattern; mounted next to it in `App.svelte`; warning at 80% (`role="status"`), error at 95% (`role="alert"`); `data-plan-notice` |
| Settings › Providers | Toggle "Check Claude plan usage when Arc opens" |

**Live counters** don't use `aria-live`; only plan notices are live regions.

---

## 3. Impact and Risk Analysis

**System dependencies**
- **Parsers and adapters:** both CLIs' parsers (2.3), the Codex probe, and the orchestrator and worker manager (event routing, setup measurement at start and resume).
- **Supporting code:** the bridge tool registry (setup estimate), `ModelRegistry` (`cheapestFor`, `tierOf`, `defaultFor`), the review diff-stat (files changed), `ProviderStatusService` (focus hook, provider readiness) and `app_settings`.
- **Session deletion:** usage snapshots now survive it, so deleting a session no longer removes everything about it. The delete dialog gains one line saying usage history is kept.

**Risks and mitigations**

| Risk | Mitigation |
|---|---|
| Double counting: repeated Claude message ids, helper messages, a partial row plus a later result, duplicate Codex updates, a resume reseeding Codex `total` | Dedupe by message id (F5); helpers are separate rows (F4); a per-turn recorded flag; Codex delta of `total` with a reset fallback; `turn_key` unique index; table-driven fixture tests for each case |
| CLI fields drift between versions | `looseObject` schemas; unparsable data goes to the existing unknown path; fixtures per CLI version; meters show "Not reported" when the shape is missing; fraction vs percent clamp with a test |
| Codex semantics unconfirmed (whether cache writes are inside `inputTokens`; reasoning inside `outputTokens`) | The mapping in 2.3 assumes yes for both; `cacheWriteInputTokens` has been 0 in every fixture. Recheck when a fixture with cache writes exists |
| The Claude plan check uses the real plan (a few thousand tokens per launch; it counts toward the 5-hour window it measures) | Opt-out setting, cheapest model, `--system-prompt "."`, no tools or MCP; visible as "Plan check" in Usage; once per launch |
| The plan-check flags are only confirmed to exist, not to still produce a `rate_limit_event` | The first implementation task is a spike that needs the user's approval for one real run on the cheapest model, recording a fixture. If no event arrives, the meter stays "Waiting for first use" (handled as failure) |
| Plan check accidentally running in tests | The composition-root guard plus a unit test (2.5); `HARNESS_PLAN_PROBE_BIN` for e2e |
| The 4-characters-per-token estimate can be 20–40% off for code or non-English text | Labelled "about"; the setup-overhead rule uses the measured fixed setup, not the estimate; both are shown, so a gap is visible |
| Usage lost when a process is killed mid-turn | The recorder flushes on `exit` with the assistant accumulator; totals are a lower bound, noted in the panel's help text |
| Reset-time jitter re-arming notices | `resetsAt` rounded to the minute in the notice key |
| `codexTier` marking several Codex models `deep`, so "model too strong" fires too often | It applies only to the registry's top tier; revisit if it's noisy |
| Title bar space at the 1100 px minimum width | Meters collapse to the fullest limit; the popover keeps the full detail; measure the real `TitleBar.svelte` first |
| Growth (about 50k rows ≈ 8 MB) | Day index; add a daily rollup only if range queries pass about 100 ms |
| Stored local day splits a day's usage across two dates if the user travels | Accepted trade-off; history never re-buckets |
| Cursor | No provider CHECK in the usage tables; the Cursor spec extends the parser and meters |

---

## 4. Testing Strategy

- **Parser unit tests** (table-driven, using fixture lines):
  - Claude: dedupe by message id, the interrupted-turn fallback, helper usage after a result, `unifiedWindows` normalization, and `readPath`.
  - Codex: delta of `total`, duplicate updates, a reset after resume, the cache mapping, the window label from duration, and `commandActions` read paths.
- **Service unit tests:**
  - recorder: one row per turn, flush on exit, no double row;
  - setup estimator;
  - plan notices: 79 → 81 → 96, a jump straight past 80, a new reset re-arming, jitter, and survival across a restart;
  - suggestion boundaries: 49,999/50,000; 29.9%/30% with the 20k floor; the 3rd read; 199,999/200,000; dismissed never recreated;
  - plan-check guards: setting off, not signed in, `HARNESS_E2E=1`.
- **Repository and migration tests:**
  - 0024 on a populated 0023 database;
  - deleting a session keeps usage rows with snapshots;
  - range boundaries in local time;
  - biggest spenders ordering and "Mixed";
  - "Not recorded" against `usage.trackingStartedAt`.
- **Renderer unit tests:**
  - helpers: `formatTokens` boundaries and `limitSeverity`;
  - stores: snapshot replace, stale report ignored, optimistic dismiss with rollback, meter states;
  - components: `TokenCount`, `PlanMeters` keyboard and popover, `DailyChart` bars and table, `SuggestionsList` dismiss and focus;
  - guards: contrast of the chart tokens, no default palette.
- **Fakes:**
  - `fake-claude.mjs`: deterministic `usage`/`modelUsage` on generated results; assistant `message.usage` with repeated ids; a `rate_limit_event` with `unifiedWindows` driven by the scenario (79% → 81% → 96%); a zero-usage interrupted result; a helper message after the result.
  - `fake-codex.mjs`: a cumulative `total` with a per-request `last`; two updates per turn and one duplicate; `account/rateLimits/read` responses; `account/rateLimits/updated` through the generic `emit` line.
- **E2E (Playwright, built app, fakes only):** cover each functional acceptance criterion:
  - chip sum and live update within 5 s, panel rows and provider totals, hover exact count, "Not recorded";
  - setup split;
  - Usage view ranges, spenders and click-through, empty state;
  - meters and states, 80% and 95% notices, dismiss-once;
  - plan check via `HARNESS_PLAN_PROBE_BIN`, and setting off;
  - each suggestion kind and dismissal.

  No test runs the real CLIs, the real home folder or the network.

---

## 5. Decisions (user-confirmed, 2026-10-20)

- Token columns match the terminal's usage tools: input, cache write, cache read, output, total.
- The setup split shows both Arc's additions (estimate) and total fixed setup (measured first request).
- The Claude plan meter updates from Arc's own runs and from one small request on launch (cheapest model, setting on by default). The Codex meter uses the no-model read on launch, on focus and every 5 minutes.
- Usage history is kept when a session is deleted (snapshots); the delete dialog says so.
- The setup-overhead suggestion uses the measured fixed setup, with a 20,000-token floor.
- One real Claude plan-check run on the cheapest model is allowed as the first implementation spike, to record a fixture. The user is asked again right before it runs.

---

## Spike results (Slice 4, plan check, CLI 2.1.302)

- **Command** (one real run, from an empty scratch cwd, stdin `/dev/null`):
  `claude -p "." --model haiku --output-format stream-json --verbose --tools "" --strict-mcp-config --disable-slash-commands --setting-sources project --settings <file with {"disableAllHooks":true}> --system-prompt "." --no-session-persistence`
- **Outcome:** exit 0, 7 lines of output, `duration_ms` 1860 (`duration_api_ms` 1816, `ttft_ms` 1470), about 3 s wall clock including start-up. Fixture: `tests/fixtures/claude/2.1.302/plan-check.jsonl`.
- **Rate-limit event arrived:** one `rate_limit_event`, after the assistant message and before `result`. Shape: `rate_limit_info.{status:"allowed", resetsAt, rateLimitType:"five_hour", overageStatus:"rejected", overageDisabledReason, isUsingOverage:false, unifiedWindows:{five_hour:{utilization:0.05,resetsAt}, seven_day:{utilization:0.28,resetsAt}}}`. `utilization` is a 0-1 fraction and `resetsAt` is epoch seconds, as in the older fixtures.
- **Cost:** `result.usage` input 2, cache_creation 582 (all `ephemeral_1h`), cache_read 0, output 159 (52 of them thinking). `modelUsage` key `claude-haiku-5-5`. `total_cost_usd` 0.0001961. About 745 tokens in all.
- **Behaved as expected:**
  - `--tools ""` gave `tools: []`; `--disable-slash-commands` gave `slash_commands: []` and `skills: []`; `--strict-mcp-config` gave `mcp_servers: []`.
  - `--system-prompt "."` shrank the fixed setup to 584 input tokens, against the several thousand of the normal CLI prompt, so the check is cheap.
- **Implications for the design:**
  - The `unifiedWindows` event is enough; the check can stop reading once it has the event and the `result`.
  - The event arrives after the model text, so the 30 s timeout is generous (about 2 s observed). Do not kill on the event before `result`, or the usage row is lost.
  - `memory_paths.auto` and `cwd` in `init` contain the scratch path, so the probe cwd path also creates a `~/.claude/projects/<cwd>/memory` name (the CLI only names it; nothing was written there by us). Keep the cwd stable so no more than one such name exists.
  - The init `agents` list still holds built-in agents, and three built-in plugins load; neither costs tokens in the request (582 cache-creation total).
  - The model replied with text (`num_turns` 1), so the check needs no special handling of an empty reply.

## Amendment (2026-10-20): user decisions after real use

- **Weights** (`src/shared/usage-weights.ts`, shared by main and renderer): relative to normal input, Claude input 1, cache write 1.25, cache read 0.1, output 5; Codex input 1, cache write 1, cache read 0.1, output 8. **Assumption:** these are the API price ratios. Anthropic and OpenAI do not publish how plan limits weight tokens, so the figure is an estimate of relative cost, never a dollar amount or a plan percentage. The weighted figure is computed per provider and summed, in the usage panel (from `SessionUsage.byProvider`) and on the Usage page (from `RangeTotals.byProvider`, which already carries all four buckets). No IPC shape changed; the zod contract is untouched. The header chip stays raw.
- **Summary line** (`UsageSummary.svelte`, shared by the panel and the Usage totals): new = input + cache write + output, from cache = cache read over the total, both with `TokenCount`.
- **Setup overhead trigger:** replaces the 30%-share-after-20k rule (`SETUP_FLOOR_TOKENS` and `SETUP_SHARE_PERCENT` are gone) with `SETUP_PER_REQUEST_TOKENS = 30_000` and `ARC_SHARE_PERCENT = 25`. `SuggestionServiceDeps` gains `agents(sessionId)`. A refresh of the open suggestion's text as numbers change is kept, as for the other kinds; a dismissed one is never recreated.
- **Existing data:** migration `0028_reset_setup_overhead.sql` (custom SQL) deletes undismissed `setup_overhead` rows, both the per-agent ones and the old session-wide ones, whose text follows the removed rule. A migration runs exactly once and is covered by the migration test; the new rule recreates what still applies at the next turn. Dismissed rows stay.

## Amendment 2 (2026-10-21): live token counts

- **Claude needed parser work.** Per-message usage was accumulated in the parser (`calls`, by `message.id`) but only reached the recorder inside the turn's `usage` event at `result`. The parser now also emits `usage-progress` (new `AgentEvent`: running total of the turn's top-level requests, `turnId` = the id the final `usage` event will carry) whenever a message adds or changes a request; unchanged totals are not resent. Codex needed none: each `thread/tokenUsage/updated` already reaches `UsageTracker.pending` mid-turn.
- **Recorder** (`usage-recorder.ts`): `UsageTracker` keeps `progress` next to `pending`; `inFlight()` is their sum (the final `usage` event replaces the progress of its turn, `flush` clears both before writing so a snapshot never sees a turn twice). The recorder registers live trackers and sums them per agent. `onEvent` now returns true when a row was written or the in-flight figure changed (the worker's token total), and each change calls `schedulePush`, the existing 1 s trailing `usage:session-changed` window. `usage:changed` (the Usage page) is only scheduled by saved rows. Memory only, no schema change; a tracker is dropped at its `exit`.
- **Snapshot:** `snapshot(sessionId, includeInFlight = true)`. `AgentUsage.tokens`, `SessionUsage.total` and `byProvider` include in-flight usage; `AgentUsage.inFlight?: TokenTotals` is the part not yet saved (absent when none). Shares, `byModel`, `setup` and `maxCallInput` are over saved rows. The suggestion service reads `snapshot(id, false)`, so in-flight never triggers a suggestion; plan notices and the Usage report read the database only. A crash still writes the same partial row on `exit` (Codex); a Claude process that dies mid-turn writes no row, as before, and its in-flight figure disappears.
- **Worker view:** `WorkerView.tokensInFlight?: boolean`, fed by `UsageRecorder.inFlightOf` through `buildWorkerViews`; the card follows within the existing 250 ms worker push, driven by per-request events. No zod change (responses are typed in `contract.ts`, requests are unchanged).
- **Renderer:** `LiveMark.svelte` (accent dot, eased opacity, off under reduced motion, text "still counting") on the worker card, the chip, panel rows, the Session total row and the details heading; a panel note explains it. The setup split in the panel and details subtracts the in-flight part, so it stays on saved rows.
- **Decision:** the setup split (worker details, panel) keeps saved rows; in-flight appears in the totals, rows and cards only.
- **Late Codex updates** after a turn's row keep their handling: they are written at once as `late<n>` rows, never in flight.
- **Fakes:** `fake-codex.mjs` step `{"usage":n}` sends updates mid-turn (with `turnCompleted` `usageUpdates:0`); `fake-claude` needed none (each `say` is a request). Scenarios `us-live-workers` and `us-live`.
