# Functional Specification: Plan Usage and Token Spend

- **Topic:** Showing how many tokens Arc uses and how much of each subscription plan is used, so the user can compare Arc with their terminal sessions and find what to optimize.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Arc runs a brain and several workers for every request, each on the user's Claude or Codex subscription. Today the user can't see how much of that subscription a session uses. They can't tell whether Arc costs more or less than doing the same work in a terminal, which part of a session used the most, or whether Arc's own setup (its instructions, the group's context and its tools) is a large share of the spend. They only find out about plan limits when a session pauses because one has been reached.

This spec makes spending visible. Every session, brain and worker shows its tokens. A Usage page shows totals over time and ranks the biggest spenders. Meters in the title bar show each plan's limits, with a warning before a limit is reached. Arc also points out patterns worth changing, such as a strong model used for a small task, or an agent re-reading the same files.

Token counts use the same terms as the terminal's own usage tools (input, cache write, cache read, output), so the user can compare an Arc session with a terminal session themselves.

**Success looks like this:**

- The user can say how many tokens any session, brain or worker used, and on which provider and model.
- The user can compare Arc's numbers with a terminal session's numbers, because both use the same terms.
- The user sees a plan limit coming before it pauses their work.
- The user can find the sessions, workers and commands that cost the most, and gets at least one concrete suggestion when a known wasteful pattern happens.

---

## 2. Functional Requirements (The "What")

### 2.1. Tokens in a session

- Each session shows a usage chip in its header with the session's total tokens, for example "Tokens · 1.2M". It updates while agents run.
- Clicking the chip opens a usage panel for the session. It lists the brain and each worker with their provider and model, and for each one: input tokens, cache write tokens (input saved for reuse in later turns, shown as "Cache write (cold)"), cache read tokens (input reused from earlier turns, shown as "Cache read (hit)"), output tokens and the total. The panel also shows the session total and a total per provider.
- While an agent runs a turn, its figure includes the tokens it has spent so far in that turn (see Amendment 2), marked with a dot; the header chip, the panel and worker details count them too. Worker details keep the setup split on saved turns only.
- Each worker card shows the worker's total tokens, for example "84k tokens". Worker details show the same breakdown as the usage panel.
- Numbers are shown in short form (950, 12.4k, 1.2M), with the exact count on hover.
- The panel and the Usage page's totals sum the buckets up in one line, for example "New 171k · From cache 1.5M (88%)": new is input + cache write + output, from cache is cache read with its share of the total.
- Next to the raw total, the panel and the Usage page show a price-weighted figure, for example "Weighted ≈ 410k". Tokens are weighted by cost relative to normal input, per provider (Claude: cache read x0.1, cache write x1.25, output x5; Codex: cached input x0.1, output x8). It is not a dollar amount, and the header chip stays raw.
- The panel always notes what Arc cannot see: "Not counted: CLI runs an agent starts itself, for example `claude -p` from its shell."
- Agents that ran before this feature show "Not recorded" instead of numbers.
- **Acceptance Criteria:**
  - [x] Given a session with a brain and two workers that have finished, when the user looks at the session header, then the usage chip shows the sum of the brain's and both workers' tokens. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-session-header-chip.png.)*
  - [x] Given an agent is in the middle of a long turn, when it makes a request, then its card and the header chip rise within about 2 seconds of that request, without waiting for the turn to end. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-live-mid-turn.png.)*
  - [x] Given an agent is mid-turn and has spent tokens, then its card, its row in the usage panel and the chip show a subtle in-progress dot with the accessible text "still counting", and the panel and chip totals include its figures. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-live-mid-turn.png.)*
  - [x] When the turn ends, then the dot goes and the card, the panel and the chip equal the saved row, with nothing counted twice. *(Verified in the built app with the fake CLIs; `tests/e2e/usage-tokens.spec.ts`.)*
  - [x] While a turn is running, then its in-flight tokens do not appear in the Usage page's totals and do not trigger a suggestion or a plan notice. *(Verified in the built app with the fake CLIs; `tests/e2e/usage-tokens.spec.ts`.)*
  - [x] When the user clicks the usage chip, then a panel lists the brain and each worker with provider, model, input, cache write, cache read, output and total tokens, and the session total. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-panel.png, docs/screenshots/008-plan-usage-and-token-spend-usage-panel-closeup.png.)*
  - [x] When the user opens the usage panel or a worker's details, then the columns read "Cache write (cold)" and "Cache read (hit)". *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-panel-closeup.png, docs/screenshots/008-plan-usage-and-token-spend-worker-details-setup-split.png.)*
  - [x] When the user opens the usage panel or the Usage page, then a line shows "New" (input + cache write + output) and "From cache" (cache read) with its percentage of the total, each number with its exact count on hover. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-panel-closeup.png, docs/screenshots/008-plan-usage-and-token-spend-usage-page-7-days.png.)*
  - [x] When the user opens the usage panel or the Usage page, then "Weighted ≈" shows the total with each provider's own ratios applied, its hover and accessible text explain the weights and say it is not a dollar amount, and the header chip shows no weighted figure. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-panel-closeup.png, docs/screenshots/008-plan-usage-and-token-spend-usage-page-7-days.png.)*
  - [x] When the user opens a session's usage panel, then it always shows the "Not counted" note, also when nothing was recorded. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-panel-closeup.png, docs/screenshots/008-plan-usage-and-token-spend-not-recorded.png.)*
  - [x] Given a session with one Claude worker and one Codex worker, when the user opens the usage panel, then it shows a separate total for Claude and for Codex. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-panel-closeup.png.)*
  - [x] When the user hovers a short number such as "12.4k", then the exact count appears. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-hover-exact-count.png.)*
  - [x] Given a session from before this feature, when the user opens its usage panel, then each agent from before shows "Not recorded". *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-not-recorded.png.)*

### 2.2. Where the tokens go

- The usage panel and worker details split each agent's input into:
  - **Arc's additions:** an estimate of what Arc itself adds (its instructions, the group's context and the tools Arc gives the agent), shown as "about", for example "Arc's additions: about 6.2k".
  - **Total fixed setup:** everything the agent receives before any work starts, which also includes the provider's own built-in instructions and the user's own tools, for example "Total fixed setup: 18.4k".
  - **The work:** everything else (the user's and brain's messages, files read, command output).
- The session shows the share of its tokens that went on setup, for example "Setup: 18% of this session (Arc's additions about 33% of it)".
- **Acceptance Criteria:**
  - [x] When the user opens a worker's details, then they see "Arc's additions" marked "about", "Total fixed setup" and "The work", and fixed setup plus the work add up to its input total. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-worker-details-setup-split.png.)*
  - [x] When the user opens a session's usage panel, then it shows what percentage of the session's tokens went on setup and what share of that was Arc's additions. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-panel-closeup.png.)*

### 2.3. The Usage page

- A **Usage** page, opened from the title bar, shows Arc's token use over a chosen range: **Today**, **7 days**, **30 days** or **All time** (default: 7 days). All usage is kept.
- The page shows:
  - the total for the range, and a total for each provider and each model;
  - a day-by-day chart of tokens for the range, split by provider;
  - a ranked list of the **biggest spenders** in the range, switchable between sessions, workers and commands. Each row shows the name, its group, its provider and model, and its total tokens. Clicking a session or worker row opens that session.
- Usage is counted on the day the tokens were used.
- When there is no usage in the range, the page says "No usage in this period."
- **Acceptance Criteria:**
  - [x] When the user opens the Usage page, then it shows the last 7 days with a total, a total per provider and per model, and a day-by-day chart. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-page-7-days.png, docs/screenshots/008-plan-usage-and-token-spend-usage-page-compact-chart.png.)*
  - [x] When the user picks "Today", then the totals, the chart and the rankings show only today's usage. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-page-today.png.)*
  - [x] Given the user ran three sessions this week, when they view Biggest spenders by session, then the three sessions are listed from most to fewest tokens with their group, provider, model and totals. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-spenders-by-session.png.)*
  - [x] When the user switches Biggest spenders to commands, then each slash command used in the range is listed with the total tokens of the workers that ran it. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-spenders-by-command.png.)*
  - [x] When the user clicks a session in Biggest spenders, then that session opens. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-spender-opens-session.png.)*
  - [x] Given there was no usage today, when the user picks "Today", then the page shows "No usage in this period." *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-page-empty-today.png.)*

### 2.4. Plan meters and warnings

- The title bar shows a plan meter for each provider that is set up, with the limits that provider reports, for example "Claude · 5h 42% · Weekly 18%". Hovering or clicking a meter shows each limit's percentage and when it resets, for example "Resets at 3:40 PM".
- The meters update while agents run and when the user returns to Arc, and show when each value was last updated, for example "as of 2:10 PM". When Arc opens it refreshes every meter: for Claude this sends one very small request using the lightest Claude model, which uses a tiny amount of the plan and appears in Arc's usage as "Plan check". A setting, **Check Claude plan usage when Arc opens** (on by default), turns this off. If a provider doesn't report a limit, its meter shows "Not reported". If Arc has no value for a provider yet, the meter shows "Waiting for first use".
- When a limit reaches **80%**, its meter turns amber and a notice appears once: "Claude's 5-hour limit is at 80%. It resets at 3:40 PM." At **95%** the meter turns red and a second notice appears once. Each notice is shown once per limit per reset period, and can be dismissed.
- The Usage page also shows the current plan limits for each provider.
- These numbers come from the provider and cover all use of that subscription, including the terminal, so they can differ from Arc's own token totals.
- **Acceptance Criteria:**
  - [x] Given Claude reports a 5-hour limit at 42% and a weekly limit at 18%, when the user looks at the title bar, then the Claude meter shows both percentages. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-title-bar-meters-42-18.png, docs/screenshots/008-plan-usage-and-token-spend-title-bar-closeup.png.)*
  - [x] When the user hovers a plan meter, then each limit's percentage and its reset time are shown. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-meter-popover-reset-times.png, docs/screenshots/008-plan-usage-and-token-spend-usage-page-plan-limits.png.)*
  - [x] Given Claude's 5-hour limit goes from 79% to 81%, when the meters next update, then the Claude meter turns amber and a notice names the limit, says 80% and gives the reset time. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-meter-79-ok.png, docs/screenshots/008-plan-usage-and-token-spend-meter-amber-80-notice.png.)*
  - [x] Given the user dismissed the 80% notice, when the same limit rises further but stays under 95% in the same reset period, then no new notice appears. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-meter-90-dismissed-no-notice.png.)*
  - [x] Given the limit reaches 95%, when the meters next update, then the meter turns red and a second notice appears. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-meter-red-95-notice.png.)*
  - [x] Given a provider doesn't report a limit, when the user looks at its meter, then the meter shows "Not reported". *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-meter-not-reported.png.)*
  - [x] Given "Check Claude plan usage when Arc opens" is on, when the user opens Arc, then the Claude meter shows a value with an "as of" time from that launch, and the Usage page lists a "Plan check" entry. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-launch-plan-check-as-of.png, docs/screenshots/008-plan-usage-and-token-spend-usage-page-plan-check-entry.png.)*
  - [x] Given the setting is off and no Claude agent has run yet, when the user opens Arc, then the Claude meter shows "Waiting for first use". *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-setting-plan-check-off.png, docs/screenshots/008-plan-usage-and-token-spend-meter-waiting-for-first-use.png.)*

### 2.5. Suggestions

- Arc points out patterns that waste tokens. Suggestions appear in the session's usage panel and in a **Suggestions** list on the Usage page. Each one names the session and the agent, says what happened in plain words, and says what to try instead. Each can be dismissed.
- Arc looks for four patterns:
  - **Model too strong:** a worker on a provider's strongest model finished a small task, for example "W2 used Opus for a task that read 2 files and changed none. Sonnet would likely do." A task counts as small when the worker changed no files or used under 50k tokens in total.
  - **Setup overhead:** one suggestion per session, shown when any agent of the session (brain, worker or conflict resolver) has a measured fixed setup of 30,000 tokens or more per request. It lists those agents worst first, for example "Setup is about 47k tokens per request for W4, the brain and W2 (Arc's additions about 5% of it)." When Arc's additions are 25% or more of that setup, the advice is "Fewer knowledge files, a shorter group context or a shorter task description would reduce it." Otherwise it is "Most of it is the CLI's own instructions plus your plugins, skills and MCP servers, which Arc agents load just as the terminal does. Turning off the ones the agents don't need shrinks every request."
  - **Repeated work:** the same file was read again and again by one agent, or by several workers in the same session, for example "W1 and W3 both read schema.sql (120k tokens each)." This appears when the same file is read 3 or more times in one session.
  - **Long-running agent:** an agent's conversation grew so large that each turn is expensive, for example "The brain's conversation is now 400k tokens, so each reply costs more. Starting a new session for unrelated work would reduce it." This appears when one turn's input passes 200k tokens.
- Suggestions are advice only. Arc never changes a model, a worker or a session because of them.
- **Acceptance Criteria:**
  - [x] Given a worker on Opus finishes a task that read 2 files and changed none, when the user opens the session's usage panel, then a "Model too strong" suggestion names the worker and suggests a lighter model. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-suggestion-model-too-strong.png.)*
  - [x] Given an agent's measured fixed setup is 30,000 tokens or more per request, when the user opens the session's usage panel, then one "Setup overhead" suggestion names the qualifying agents worst first with the setup per request and Arc's share of it, with advice that depends on whether Arc's additions are 25% or more of the setup. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-suggestion-setup-overhead.png.)*
  - [x] Given workers in a session read the same file 3 times in total, when the user opens the session's usage panel, then a "Repeated work" suggestion names the file and the workers. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-suggestion-repeated-work.png.)*
  - [x] Given one of the brain's turns has more than 200k input tokens, when the user opens the usage panel, then a "Long-running agent" suggestion names the brain and its conversation size. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-suggestion-long-running.png.)*
  - [x] When the user dismisses a suggestion, then it disappears from the session and the Usage page and doesn't come back. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-suggestion-dismissed-panel.png, docs/screenshots/008-plan-usage-and-token-spend-suggestion-dismissed-usage-page-after-relaunch.png.)*
  - [x] When the user opens the Usage page, then the Suggestions list shows undismissed suggestions from the selected range, newest first, each linking to its session. *(Verified in the built app; see docs/screenshots/008-plan-usage-and-token-spend-usage-page-suggestions-list.png.)*

---

## 3. Scope and Boundaries

### In-Scope

- Token counts for every brain and worker, on Claude and Codex, in the session header, a session usage panel, worker cards and worker details.
- A split of each agent's input into Arc's additions, total fixed setup and the work.
- A Usage page with ranges, totals by provider and model, a daily chart, biggest spenders by session, worker and command, and suggestions.
- Plan meters in the title bar for the limits each provider reports, with warnings at 80% and 95%.
- Four kinds of suggestions: model too strong, setup overhead, repeated work, long-running agent.

### Out-of-Scope

- Reading the user's terminal session history to show terminal usage inside Arc. The user compares Arc's numbers with the terminal themselves.
- The brain choosing lighter models or changing its plans because of plan usage; planned as a later spec.
- Cursor usage. The Cursor provider spec must extend everything here (token counts, the Usage page, plan meters and suggestions) to Cursor workers; this is recorded in the product definition and architecture.
- An estimated money figure (what the tokens would cost at API prices). Everything runs on subscriptions, so Arc shows tokens and plan percentages only.

---

## Change Log

- 2026-10-20 — user decisions during /awos:tech — token columns now match the terminal's usage tools (input, cache write, cache read, output); the setup split shows both Arc's own additions (an estimate) and the total fixed setup including the provider's own instructions; Arc refreshes the Claude plan meter on launch with one very small request, behind a setting that is on by default.
- 2026-10-20 — /awos:verify — all 28 acceptance criteria verified in the built app with the fake CLIs; screenshots in `docs/screenshots/008-plan-usage-and-token-spend-*.png`, look-and-feel confirmed by the user. Two display fixes made during verification at the user's request: "Arc's additions" per request is capped at the measured fixed setup, and a session where every agent predates recording shows "Not recorded" in the Session total row and the header chip instead of 0.
- 2026-10-20 — user decisions after real use — cache columns renamed "Cache write (cold)" and "Cache read (hit)"; a "New / From cache" summary line and a price-weighted figure (panel and Usage page only) added; a "Not counted" note in the panel; the Setup overhead suggestion reworked to one per session, triggered by 30,000 tokens or more of fixed setup per request, with advice by source. Existing open Setup overhead suggestions were removed by a migration.
- 2026-10-20 — review of the amendment — the panel's setup line now gives Arc's additions as a share of the setup ("about 33% of it"), the same measure as the Setup overhead suggestion, instead of a share of the whole session.
- 2026-10-21 — Amendment 2: live token counts — an agent's tokens now stream while its turn runs (card, header chip, panel and worker details), marked as in progress, and the row is still written once when the turn ends. Suggestions, plan notices and the Usage page keep using saved rows only. Replaces the "increase within 5 seconds of a finished turn" criterion.
