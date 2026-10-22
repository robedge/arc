# Technical Specification: Stepping In on a Worker

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Completed
- **Author(s):** redgell, with the agent-orchestration, svelte-frontend and sqlite-database specialists

---

## 1. High-Level Technical Approach

The user talks to the **same long-lived headless worker process** Arc already runs (`claude -p` stream-json). There is no node-pty, no xterm.js and no `claude --resume` TUI; this was the user's decision. Stepping in changes who drives the worker, not how it runs:

- **Step in:** Arc interrupts the current turn (the adapter's existing `interrupt()`, a stream-json `control_request` interrupt) and marks the worker as under user control. While it is under control, Arc stops nudging or settling it, holds the brain's messages for it, and refuses merges.
- **Typing:** the terminal tab gets an input line, and each line is sent verbatim as a stream-json user message. Slash commands pass through untouched because the CLI expands them (spec 005, spike S1). Escape sends an interrupt.
- **Approvals and questions:** the permission tool, the bridge, classification and Auto-approve all stay as they are. Requests from a controlled worker are sent to the terminal tab instead of Needs attention, and the brain cannot resolve them.
- **Hand back:** Arc tells the worker to carry on with its task, delivers the brain's held messages, and gives the brain a summary of what changed since step-in.
- **Persistence:** user control is a persisted overlay on the worker (`user_control`), not a new status, so it survives a quit. After a restart the worker is "paused". The first typed line, or Hand back, relaunches it with `--resume`.

Affected areas:
- main: worker manager, attention coordinator, merge coordinator, startup recovery, orchestrator and IPC contract, terminal log;
- db: migration 0022;
- renderer: the worker terminal tab, the worker card and details, and a new store.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1. State model

- **The overlay:** `workers.user_control` is `null`, `'active'` or `'paused'`, and the worker's `status` stays as it is. Control cuts across statuses (a controlled worker can be working or have a pending question). The status enum is also duplicated in `db/schema/workers.ts` and `shared/types/session.ts` and switched on across shutdown, relaunch and attention, so a new status would ripple through all of those.
  - **`active`:** the user is in control and the process is alive. "Keep it paused" in the close dialog only closes the tab, so the worker stays `active` with an idle process. The card keeps showing "You're in control", as functional criterion 2.5 requires.
  - **`paused`:** the user is in control but there is no process, because Arc quit or crashed, or the session closed. The card shows "You're in control (paused)".
- **In memory:** the worker manager's `Running` struct gains `controlActive` (set before the interrupt is sent), `controlReplying` (a turn is running while controlled) and `controlUserMessages`.
- **Renderer view:** `WorkerView` and `WorkerDetails` in `shared/types/session.ts` gain `userControl: 'active' | 'paused' | null` and `controlReplying: boolean`. Both ride the existing `session:worker` push and the session snapshot.

### 2.2. Data model (migration `0022_worker_user_control.sql`)

| Table | Column | Type | Purpose |
|---|---|---|---|
| `workers` | `user_control` | text, null (`active`/`paused`) | The control overlay. |
| `workers` | `control_started_at` | integer, null | When the user stepped in. |
| `workers` | `control_user_messages` | integer, default 0 | Count for the hand-back summary. |
| `workers` | `control_last_message` | text, null | Last typed line, cut to 200 characters, for the summary. |
| `worker_worktrees` | `control_base_sha` | text, null | Each repository's HEAD at step-in. Rows with `removed_at` set are skipped. |
| `attention_requests` | `route` | text not null, default `queue` (`queue`/`terminal`) | Where the request is answered. |

New table `worker_held_messages`:

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK autoincrement | Sets the delivery order. |
| `worker_id` | text not null | FK to `workers`, cascade on delete. |
| `session_id` | text not null | FK to `sessions`, cascade on delete. |
| `body` | text not null | The brain's message text. |
| `created_at` | integer not null | |
| `delivered_at` | integer, null | Set when delivered at hand-back. Rows are kept for audit. |

- **Index:** `(worker_id, delivered_at)`.
- **Backfill:** all new columns are nullable or have defaults, so none is needed.
- **One source for the values:** `UserControl` and `AttentionRoute` are defined once as const arrays in the schema and mirrored in the shared types. A unit test checks the two copies match, as already happens for the worker status enum.

**Repository functions:**
- `WorkersRepo`: `beginControl`, `setControl`, `endControl`, `recordControlMessage`, `listControlled(sessionId)`, `pauseAllActiveControl()`.
- `WorktreesRepo`: `setControlBase`, `listControlBases`, `clearControlBase`.
- New `HeldMessagesRepo`: `enqueue`, `listUndelivered(workerId)`, `markDelivered(ids, now)`.
- `AttentionRepo`:
  - the Needs-attention list and both counts filter on `route = 'queue'`;
  - new `rerouteToTerminal(workerId)`, `routeBack(workerId)` and `listPendingForTerminal(workerId)`.

### 2.3. IPC contract (`src/shared/ipc/contract.ts`)

| Channel | Request | Response | Notes |
|---|---|---|---|
| `workers:step-in` | `{ workerId }` | `{ ok: true }` | Error `VALIDATION_FAILED` when the worker isn't eligible. |
| `workers:hand-back` | `{ workerId }` | `{ ok: true }` | |
| `workers:send-input` | `{ workerId, text }` (1 to 20,000 characters) | `{ ok: true }` | Requires `userControl` to be set. |
| `workers:interrupt` | `{ workerId }` | `{ outcome }` | Stops the current reply and nothing else. |

- **Answers:** go through the existing `attention:answer` channel.
- **Terminal requests:** the renderer gets the pending terminal-routed requests for a worker from a `route` field added to the attention view. The `session:attention` push carries every pending request, and the renderer splits them by `route`.
- **Terminal text:** lines for the user's messages and the step-in, interrupt and hand-back markers come through the existing `worker:terminal` push.

### 2.4. Main process

**Eligibility** (`WorkerManager.canStepIn`):
- Allowed: status is `starting`, `working`, `needs_approval` or `has_question` (including a worker waiting out a rate limit), the worker is not a merge resolver, and `user_control` is null.
- **Confirmed by the user:** `queued` workers are not eligible. Arc has no separate "waiting for another worker's changes" state today: a dependency is only a hint to the brain, and `queued` means the worker limit is full and no process exists yet. Recorded in the functional spec's Change Log.

**Step in** (`WorkerManager.stepIn`), in this order:
1. Record the heads, and store each live worktree's HEAD in `control_base_sha`.
2. Persist `user_control='active'` and set `run.controlActive`.
3. Clear the helper timers and the rate-limit gate entry.
4. Call `handle.interrupt()`.
   - **`killed`:** the process didn't survive the interrupt. Store `paused` instead of failing it; the exit classifier respects `controlActive`.
   - **No process** (a paused row after a restart): go straight to `paused`.
5. `AttentionCoordinator.routeToTerminal(workerId)` moves pending requests into the terminal (below).
6. Append "You stepped in" to the terminal log.
7. Log `user-control` with "You stepped in on W1 · api-retry".
8. `notifyBrain`: "[Arc] The user stepped in on W1 · api-retry and is talking to it directly. Do not message, merge or stop it. You will be told when they hand it back."

**Keeping the worker alive while controlled:** `onTurnResult` and `settleTurn` (itself, because the helper timers call it directly) return early while `controlActive` is set. Interrupted or finished turns never cause a nudge, a failure or a stop.

**Typing** (`WorkerManager.sendInput`):
- **Paused:** `relaunch(row, text, undelivered)`, which resumes with `--resume`, with the typed text as the first message.
- **Otherwise:** `handle.send(text)`, verbatim.
- Then increment the message counter, store the last-message excerpt, and echo `> text` to the terminal log through `TranscriptFormatter.userInput()`.

**Escape** (`WorkerManager.interruptControlled`): `handle.interrupt()` plus an "Interrupted" log line.

**Attention while controlled** (`src/main/sessions/attention-coordinator.ts`):
- **At step-in:** each pending request from the worker gets `route='terminal'` and `escalated=true`, and its brain timer is cancelled. The bridge call stays waiting, so the worker's tool call stays blocked until the user answers.
- **New requests while controlled** (`requestPermission`, `requestQuestion`, `askBrain`):
  - Classification and coverage still run, as do allow rules and Auto-approve, which never covers protected actions. Anything that would have asked is created with `route='terminal'`. No brain timer is set and there is no brain note.
  - An `ask_brain` question goes to the user in the terminal, and the user's answer becomes the tool result.
- **Brain locked out:** `resolveRequest` on a terminal-routed request throws `BridgeToolError('not_resolvable', "The user is answering this in the worker's terminal.")`.
- **At hand-back:** `routeBack(workerId)` sets requests that are still pending back to `queue` and re-runs the normal brain-first or escalation path.

**Brain lockout** (`src/main/sessions/merge-coordinator.ts` and the worker manager):
- **Held messages:** `message()` on a controlled worker enqueues the text in `worker_held_messages` and returns `{ delivered: false, queued: true }`. The `message_worker` tool result and description gain `queued`. `syncWorker`'s message goes through the same path; the merge into the worktree still happens, and only the message is held.
- **Merges refused:** `mergeWorker` checks first: `BridgeToolError('worker_user_control', 'The user is controlling W1 · api-retry right now. Try again after they hand it back.')`. Auto-merge after a finish skips controlled workers.
- **Stop:** the brain has no stop tool. The user's own Stop still works and clears `user_control`.
- **`report_done` while controlled:** it is recorded (`reportedDone`, heads), but the worker isn't stopped. At hand-back the worker is told it already reported done, and the next settled turn stops it normally.

**Hand back** (`WorkerManager.handBack`), in this order:
1. Interrupt a running reply.
2. Build the summary:
   - a new `diffStatSince(path, sha)` helper in `src/main/git/` runs `git diff --stat <control_base_sha>` against the working tree, so uncommitted edits count;
   - plus the message count and last excerpt.
3. Clear the control columns and set `controlActive=false` and `nudged=false`.
4. Send one user turn to the worker (by `relaunch` if paused):
   > [Arc] The user has handed control back to you. Continue your original task, taking into account everything the user said and changed while they were in control (their messages are in the conversation above). Check your working copy with git status before you carry on. Commit and call report_done when you are finished.

   followed by each held message as "[Arc] Message from the brain (held while the user was in control): ...". Then mark the held messages delivered.
5. `routeBack` the attention requests.
6. Write the "You handed back" terminal line and log `user-control` with "You handed W1 · api-retry back".
7. `notifyBrain`: "[Arc] The user handed W1 · api-retry back. Changed since they stepped in: <diffstat or 'no file changes'>. They sent N message(s); last: "<excerpt>". It is continuing its task, and your held messages were delivered."

**Quit and startup recovery** (`src/main/sessions/startup-recovery.ts`, `workers-repo.ts`):
- `stopInterrupted` and `recoverInterrupted` skip rows with `user_control` set, so they are never marked stopped or crashed.
- Shutdown and startup run `pauseAllActiveControl()`, and the exit classifier treats a controlled worker's exit as paused.
- Startup's cancellation of pending AskUserQuestion requests still runs (that tool call died with the process), but it doesn't stop a controlled worker.
- If the working copy is gone (`cannotLaunch`), typing returns `VALIDATION_FAILED`, and the tab offers only Hand back or Stop.

### 2.5. Renderer

All paths are under `src/renderer/src/lib/`.

- **`worker-status.ts`:**
  - `STEPPABLE`: `starting`, `working`, `needs_approval`, `has_question`.
  - `canStepIn(worker)`: excludes resolvers and workers already controlled.
  - `controlLabel(worker)`: returns "You're in control", "You're in control (paused)" or null. It stays separate from `WORKER_STATUS`, because the real status still applies underneath.
- **`ConversationTabs.svelte`, worker tab header:**
  - a **Step in** button before Details when `canStepIn`, busy while the interrupt is in flight;
  - **Hand back** (primary) instead, whenever `userControl` is set, whatever the status;
  - a control chip next to the status, using the `attention` tone tokens.
- **New `components/sessions/StepInBar.svelte`:** rendered as a `shrink-0` sibling under `TerminalPanel`, only while the worker is under control, so the virtualized log keeps its `flex-1 min-h-0` scroller. It contains:
  - **Pinned cards:** the terminal-routed requests, rendered with the existing `PermissionCard`, `QuestionCard` and `StructuredQuestionCard` inside a group labelled "Needs your answer". `PermissionCard`'s Always-allow button becomes optional and is hidden here. Approve and Deny only, confirmed by the user.
  - **The input line:** its own textarea with id `worker-input-{id}` and label "Message to W1 · api-retry". It doesn't reuse the brain `Composer`, which is tied to brain state. The slash-menu logic is lifted out of `Composer.svelte` into a small shared helper, and `CommandMenu` and `filterCommands` are reused.
    - Enter sends, and Shift+Enter inserts a new line. IME composition is ignored.
    - Escape closes the slash menu if it is open; otherwise it interrupts if `controlReplying`; otherwise it does nothing.
    - The draft is kept per worker.
- **`WorkerCard.svelte`:**
  - shows `controlLabel` instead of the status label when control is set, with a `data-worker-control` attribute;
  - a controlled card never takes the attention tone or opens Needs attention.
- **`WorkerDetails.svelte`:** Step in, or Hand back, next to Stop. Step in also opens the tab and closes Details.
- **Closing a controlled tab:** the close button and the Delete key call `requestClose(id)`, which opens a small `Modal` titled "Hand W1 · api-retry back to the brain?".
  - **Hand back:** hands back, then closes the tab.
  - **Keep it paused:** closes the tab only.
  - **Cancel (or Escape):** leaves the tab open.
  - If hand-back fails, the error shows in the dialog through `ErrorText` and the dialog stays open.
- **New store `stores/worker-control.svelte.ts`:**
  - `stepIn`, `handBack`, `sendInput` (clears the draft only when the send succeeds) and `interrupt`;
  - `drafts`, `errors`, and the terminal requests for each worker;
  - `reset()` runs alongside `workerTerminals.reset()`.
  - Any request whose worker is under control is filtered out of the Needs-attention view, in case pushes arrive out of order.
- **Focus:** Step in moves focus to the input after `tick()`. Hand back returns focus to the Step in button. The dialog returns focus as `Modal` already does. "You stepped in" is a log line, so screen readers announce it through `role="log"`. No new animation.

---

## 3. Impact and Risk Analysis

- **System dependencies:** the worker manager's turn and settle logic, attention routing and badge counts, the merge queue and auto-merge, the brain bridge tools (`message_worker`, `merge_worker`, `sync_worker`), startup recovery, and the terminal log. It builds on the adapter's existing `interrupt()` and `--resume` support.
- **Risks and mitigations:**
  - **A late turn result triggers a nudge or failure after step-in:** `controlActive` is set before the interrupt is sent. `settleTurn` itself is guarded, and the helper timers are cleared.
  - **The interrupt escalates to a kill:** the worker is treated as `paused`, not failed, and the next line resumes it.
  - **Two writers on the worker's input** (the user's line and a brain message): brain messages, including the sync note, always go through the held queue while the worker is controlled.
  - **A request shows in both places:** routing is decided on the request (`route`), and the renderer also filters out requests whose worker is under control.
  - **A quit loses control, or recovery marks the worker as crashed:** recovery queries exclude controlled rows, and `active` becomes `paused` on shutdown and at startup.
  - **Auto-merge of a worker that reported done while controlled:** auto-merge checks `user_control`.
  - **Regressions from extracting the slash menu out of `Composer`:** run `composer.test.ts` and `command-menu.test.ts` unchanged.
  - **The input line changes the log's height and breaks scroll pinning:** the bar is a sibling outside the scroller, so the panel's measurements stay valid.
  - **The worker carries on badly after hand-back:** the hand-back text tells it to re-check `git status` and points it at the conversation. Real-model behaviour is listed as an Open Question.

---

## 4. Testing Strategy

Each new test must fail first, before the change it covers goes in.

- **Unit tests (main):**
  - eligibility;
  - step-in order and the `controlActive` guards in `onTurnResult` and `settleTurn`;
  - `paused` after a `killed` interrupt;
  - held messages enqueued, then delivered in order;
  - the `worker_user_control` merge refusal and the auto-merge skip;
  - `not_resolvable` for the brain;
  - rerouting at step-in and back at hand-back;
  - `report_done` while controlled;
  - the hand-back summary from `diffStatSince` against a temporary repository;
  - startup recovery with an `active` row;
  - the enum mirror test.
- **Renderer tests:** `worker-step-in.test.ts` and `worker-control-close.test.ts`, plus additions to `worker-status.test.ts`, `worker-terminal-tabs.test.ts`, `attention-live.test.ts` and `a11y-sweep.test.ts` (the input label).
- **End-to-end (Playwright with the fake CLI):** a new spec file `tests/e2e/sessions-step-in.spec.ts` with scenarios for:
  - stepping in mid-`delay`: the interrupt is logged, "You stepped in" shows, and no nudge follows;
  - a typed line is echoed and answered;
  - a pending push approval moves into the terminal and is approved there;
  - a waiting question moves out of Needs attention;
  - `message_worker` is held, then delivered after hand-back;
  - `merge_worker` is refused;
  - quitting and relaunching gives "You're in control (paused)", and typing resumes with `--resume`;
  - the close dialog's three outcomes;
  - a slash command reaches the worker verbatim.

  The fake CLI's existing `waitForStdin`, interrupt acknowledgement and `FAKE_CLAUDE_LOG` cover most of this. The scenarios need small new worker and brain scripts.

---

## 5. Decisions Confirmed

- Queued workers can't be stepped in (functional spec Change Log, 2026-10-19).
- The terminal approval card shows Approve and Deny, without Always allow.
- A `report_done` while the user is in control waits until hand-back.
- **Assumption:** "Keep it paused" leaves the process alive and idle rather than stopping it. Nothing the user sees depends on this.
