# Technical Specification: Skip All Approvals

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Completed
- **Author(s):** redgell

---

## 1. High-Level Technical Approach

Skip all approvals builds on the existing Auto-approve **coverage path** in `AttentionCoordinator`. It never uses a provider's native bypass mode (`--dangerously-skip-permissions`, Codex `approvalPolicy: never`, Cursor allow-all). Every action must keep reaching Arc. Otherwise pushes and pull or merge requests could not keep asking.

The work has four parts:

1. **Decision layer (immediate).** A new per-session flag `sessions.skip_approvals`, separate from `auto_approve` and never writing it. `coverage()` gets a `skip` branch that approves every permission except publish actions and requests from a worker the user has stepped in on. The host reads the flag on every request, so this takes effect on the very next request from every running agent. The publish check is extended from Bash to MCP tools.
2. **Provider limits (per-agent, at the next turn or relaunch).**
   - **Codex:** the sandbox becomes `dangerFullAccess` through a per-turn `sandboxPolicy` override on `turn/start`, and through `sandbox` on thread start and resume.
   - **Cursor:** the deny file loses its `Write` entries and its non-publish `Shell` entries. Its publish entries are removed so pushes ask.
   - **Claude workers:** they are relaunched with `--resume` at the next idle turn boundary, without the read-only-folder edit denies.
   - Turning the switch off restores each limit the same way.
3. **Persistence and IPC.** One sessions column, one `app_settings` key, and fields on the header and summary DTOs and on `sessions:set-config` and `sessions:create`.
4. **Renderer.** A shared confirm dialog. The switch sits in the Approvals popover, with a red header marker and a list marker. Settings gets a new Approvals page, and the New Session dialog gets its own switch.

Systems affected: `src/main/sessions/` (attention coordinator, orchestrator, worker manager, session service), `src/main/policy/classify.ts`, the Codex, Cursor and Claude adapters, `src/main/db/`, `src/shared/`, and the renderer session and settings components.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1. Data model and persistence

| Change | Where | Detail |
|---|---|---|
| `sessions.skip_approvals` | `src/main/db/schema/sessions.ts`, migration `0032_skip_approvals.sql` via `pnpm db:generate` | `integer` boolean, `DEFAULT false NOT NULL`, beside `auto_approve`. Existing rows read false. |
| `SessionsRepo.setSkipApprovals(id, on)` | `src/main/db/repositories/sessions-repo.ts` | Mirrors `setAutoApprove`. `create()` takes an optional `skipApprovals` that defaults to false. |
| `app_settings` key `approvals.skipAllByDefault` | `app-settings-repo.ts` (`appSettingSchemas`, `appSettingDefaults`, `getAll`), `src/shared/types/provider.ts` `AppSettings`, the `settings:set` schema in `contract.ts` (strict), `src/main/ipc/handlers/settings.ts` | Boolean, default false. No migration, because the table is key-value. |
| Event kinds | `events.kind` is free text, so no schema change | `skip-approvals` for the toggle on or off. `skip-approved` for each approval skipped, with text `Approved (skipping approvals): <clip(action, 200)>` and the worker label in `dataJson`. |
| `attention_requests` | No change | Rows approved by the turn-on sweep settle as `approved`, as Auto-approve's sweep does. The `skip-approved` event tells them apart. No `attention-record` message is written for swept rows, as today. |

### 2.2. IPC contracts (`src/shared/ipc/contract.ts`)

| Channel / type | Change |
|---|---|
| `sessions:set-config` | Adds `skipApprovals?: boolean`. It returns `SessionHeader` as today. The confirmation dialog lives in the renderer; main does not require a confirm flag. |
| `sessions:create` | Adds `skipApprovals?: boolean` (strict schema). When it is omitted, main uses `approvals.skipAllByDefault`. |
| `settings:set` | Adds `'approvals.skipAllByDefault'?: boolean`. |
| `SessionHeader` | Adds `skipApprovals: boolean`, filled by `headerDto`. |
| `SessionSummary` | Adds `skipApprovals: boolean`, filled by `summaryDto` / `summaryOf`. It is pushed by the existing `session:summary` through `scheduleSummary`. |

### 2.3. Decision layer (`src/main/sessions/attention-coordinator.ts`, `src/main/policy/classify.ts`)

- **Host:** a new `skipApprovals(): boolean` reads the session row on every call, like `autoApprove()` (`orchestrator.ts`).
- **`coverage(tool, input, verdict, ctx: { controlled: boolean })`**, in this order:
  1. A matching allow rule wins, unchanged.
  2. If skip is on:
     - a request from a controlled worker returns `null` (it asks in the terminal);
     - a publish action returns `null` (it asks the user);
     - otherwise it returns `{ by: 'skip' }`.

     Auto-approve is not consulted while skip is on.
  3. Otherwise the existing Auto-approve branch runs, untouched.
- **Controlled workers:** callers pass `controlled = isControlled(workerId)`. The brain is never controlled. This fixes the stepped-in gap for skip only. Auto-approve's current behaviour on stepped-in workers stays as it is (functional spec §3).
- **`resolveCovered()`:** when the cover is skip, it ignores `route === 'terminal'` rows and publish rows. Question rows are never covered, as today.
  - The turn-on sweep in `SessionService.setConfig` calls it.
  - `routeBack()` (hand-back) also calls `resolveCovered()` after moving the rows back to the queue. That way, requests still waiting at hand-back are approved when skip is on.
- **`logCovered`:** for `by: 'skip'` it writes kind `skip-approved`. No request record is created, so `AttentionService.push` raises no macOS notification. `NotificationService` needs no change.
- **Brain requests:** `classifyBrainAction` still refuses the brain's edit, `permission` and `other` actions outright. Skip does not give the brain edit tools. The brain's protected shell commands (`changes_checkout` and the worker categories) are covered.
- **Publish detection:** a new `isPublishMcpTool(storedName)` in `classify.ts` matches the tool segment of `mcp__<server>__<tool>`. The name format is the same for all three providers (`normalized-action.ts`).
  - It matches a verb (`create`, `merge`, `approve`, `submit`, `push`, `update_..._branch`) next to an object (`pull_request`, `merge_request`, `review`).
  - It also has an explicit list that commits to a remote: `push_files`, `create_or_update_file`, `delete_file` and `create_branch`.
  - It is used only in the skip branch, together with the existing Bash-only `isPublishAction`. **Confirmed:** `create_branch` asks too, because over-asking is the safe direction. `update_pull_request` (editing an existing PR) and `create_repository` / `fork_repository` do not ask.
  - **Escalation:** `classify.ts` gives `mcp_write` `mustEscalate: false`, so a changing MCP tool goes to the brain first and the brain may `resolve_request` it. While skip is on, an `isPublishMcpTool` hit has its verdict forced to `mustEscalate: true`, the same as a Bash push. It then goes straight to the user, and `resolve_request` on it returns `policy_requires_user`, the same code as for a Bash push. With skip off, routing is unchanged.
- **Attachments carve-out:** the skip branch also returns `null` (no cover) for a Bash, edit or `permission` action whose write paths fall inside the session's `attachments` folder. The request then follows the normal flow and reaches the user. This keeps attachments read-only against shell writes on Claude and Cursor (the edit denies cover their edit tools). Codex under `dangerFullAccess` can still write there without asking, which is the accepted gap in §3.
- **The brain:** it is not told about each covered request (unchanged). It gets one note when skip turns on or off, through the `pendingModeNote` path (`orchestrator.ts`):
  - **On:** "[Arc] Skip all approvals is on. Worker permission requests are approved automatically; don't wait on them or call resolve_request for them. Pushes, pull and merge requests, and questions still go to the user. Sandbox and blocked-edit limits are lifted from each agent's next turn, so don't suggest rerunning a step on another provider."
  - **Off:** "[Arc] Skip all approvals is off. Workers ask permission again; requests reach you as before."

### 2.4. Session service and orchestrator

- **`SessionService.setConfig`** (`session-service.ts` around line 1325) handles `skipApprovals`:
  - `repo.setSkipApprovals`;
  - an event `skip-approvals`, either "Skip all approvals turned on: every permission is approved except pushes and pull or merge requests; limits lift from each agent's next turn" or "Skip all approvals turned off; limits return from each agent's next turn";
  - on turning on, `resolveCoveredRequests()`;
  - `orchestrator.setSkipApprovals(on)`, which queues the brain note and fans out to the brain handle and to `WorkerManager`;
  - `configChanged`, `pushHeader` and `scheduleSummary`.
- **`SessionService.startSession`:** copies `skipApprovals` from the create payload, or from `approvals.skipAllByDefault`, into the new row. It writes `skip-approvals` "Session started with Skip all approvals on" when it is true.
- **Resume:** no prompt. The flag is read from the row by every launch builder below.

### 2.5. Provider limits

#### Codex (`src/main/agents/codex/codex-config.ts`, `codex-adapter.ts`)

- **`buildThreadParams`** reads the live flag:
  - skip on: `sandbox: 'danger-full-access'` for workers and the brain;
  - skip off: as today (workers `workspace-write` with `writableRootsFor`, `network_access: false`; brain `read-only`).
- **`approvalPolicy`** stays `'untrusted'` and `approvalsReviewer` stays `'user'`. `arc.rules` prompt rules stay. They are the push gate against the user's own Codex allow rules.
- **`CodexHandle.setSandbox(policy)`:** stores an override that is sent as `sandboxPolicy` on every later `turn/start`, next to `modelOverride`.
  - Turning skip on sends `{ type: 'dangerFullAccess' }`. This applies to workers and, only if spike K1 passes for file changes (see below), to the brain.
  - Turning it off sends the explicit restored policy, because `null` keeps the previous value: `workspaceWrite` with `writableRoots`, `networkAccess: false`, `excludeSlashTmp: true` and `excludeTmpdirEnvVar: true` for workers (K2: without the two excludes the restored sandbox lets a worker write to the system temp folder), `readOnly` for the brain.
  - A turn already running keeps its sandbox until it ends. Its `extra_permissions` requests are covered meanwhile.
- **Evidence:** `TurnStartParams.sandboxPolicy` and `approvalPolicy` exist in the 0.163.0 app-server schema (`codex app-server generate-json-schema`). For the pinned 0.162.1 they are inferred from spec 007 tech notes and the `thread/settings/updated` echo in `tests/fixtures/codex/0.162.1/real-turn.jsonl`. It is unproven that approvals and prompt rules still reach Arc under `dangerFullAccess` (spikes K1, K2). **Fallback** if K1 shows approvals stop: `workspaceWrite` with `writableRoots: ['/']` and `networkAccess: true`.
- **Confirmed by the user, gated on K1:** the Codex brain's sandbox is lifted too. This is needed for the "brain runs `git commit`" criterion. The brain's `apply_patch` is refused by `classifyBrainAction` only if the file change still reaches Arc as an approval. If K1 shows file changes stop asking under `dangerFullAccess` (or the root-`/` fallback), the Codex brain stays `read-only`, its writing commands fail even when approved, and the user is asked again before building.
- **Cursor brain:** keeps `ask` mode and `Write(**)`; skip changes nothing for it. The "brain runs `git commit` without a request" criterion holds for Claude and Codex brains only.

#### Cursor (`src/main/agents/cursor/cursor-deny.ts`, `cursor-unasked.ts`, `worker-manager.ts`)

- **`cursorDenyText(…, { skip })`:** with skip on, workers' `.cursor/cli.json` drops:
  - every `Write(<dir>/**)` entry, apart from the attachments folder (see the assumption below);
  - the network, destructive and global-install `Shell` entries;
  - the publish entries (`Shell(git push)`, `Shell(gh)`, `Shell(glab)`), so a push becomes an ACP permission request that `isPublishAction` sends to the user.

  `mcpDenyEntries` stays. The brain's `Write(**)` and `ask` mode stay.
- **When the user's own Cursor config would let a push through unasked** (an allow entry, a hook or a non-allowlist mode, reported by `BypassDetector`, which must include a project `.cursor/cli.json` the repository commits itself: K4 proved a project allow for `Shell(git push)` skips the ask), the publish denies are kept. The session gets a note when a push is blocked: "W3 (Cursor) was blocked from pushing. Your Cursor settings allow pushes without asking, so Arc keeps them blocked; run the push from Review changes." **Confirmed.**
- **`writeCursorDenyFiles`** rewrites the files of running Cursor workers on toggle, as it already does on other changes.
  - K3 showed a running Cursor process does **not** re-read `cli.json`.
  - So a toggle marks each Cursor worker for a relaunch at its next idle turn boundary through ACP `session/load` (`n4-load.jsonl`), in both directions.
- **`noteUnasked`:** under skip, suppresses the `outside-edit` note and the non-publish `ran-unasked` and `blocked` notes. It keeps them for publish commands.

#### Claude (`src/main/agents/claude/claude-adapter.ts`, `worker-manager.ts`)

- **Brain:** no change. It has no edit tools, and its Bash goes through the permission tool, so skip covers it at once.
- **Workers, why a relaunch is needed:** `--disallowedTools` is fixed at launch. The `denyEditRules(readOnlyDirs)` rules (knowledge, other checkouts) are needed because those folders are `--add-dir`s under `acceptEdits`.
- **Workers, skip on:** the worker is launched without those rules, except for the attachments folder. A running worker gets a `pendingRelaunch` mark and is relaunched with `--resume` at its next idle turn boundary: after `turn-result`, or before a held or `message_worker` send. This reuses the `relaunch()` path (around line 2608). It is never killed mid-turn.
- **Flag on the worker:** the worker records `launchedSkip`, in memory, so turning skip off recycles it the same way to restore the denies.
- **Edits inside acceptEdits folders:** edits into those folders never reach Arc, whether skip is on or off, so they produce no `skip-approved` event. This is the same as edits inside the worktree today.
- **Natural relaunches:** continue, hand-back with no live handle, and crash recovery all read the current flag.

### 2.6. Renderer (`src/renderer/src/lib/components/`)

| Component | Change |
|---|---|
| `ui/ConfirmDialog.svelte` (new) | Wraps `Modal`, with title, body, `confirmLabel`, `confirmVariant` (default `danger`), `onconfirm` and `oncancel`. Cancel comes first in the DOM, so it gets the Modal's initial focus, and Enter on it cancels. The confirm button is `type="button"` and never a form submit. Escape cancels through the Modal. |
| `sessions/SkipApprovalsDialog.svelte` (new) | `scope: 'session' \| 'default'`. It supplies the warning text from functional spec §2.1 and §2.2. It is reused by the header, the New Session dialog and Settings. |
| `sessions/ApprovalsMenu.svelte` | A Skip all approvals `Toggle` (`id="skip-approvals-{id}"`) above Auto-approve. Turning it on opens the dialog and the toggle stays off until the user confirms. Turning it off calls `sessions:set-config` directly. Auto-approve renders `checked={autoApprove \|\| skipApprovals}` and is `disabled` while skip is on, wrapped with `title="Covered by Skip all approvals"` and `aria-describedby`. The store's `autoApprove` is never written, so turning skip off restores the user's setting. |
| `sessions/SkipApprovalsMarker.svelte` (new) | A red danger-toned pill button, "Skipping approvals" (`data-skip-approvals-on`, 44 px hit target, cyan focus ring), in `SessionHeader.svelte` next to the existing "Auto-approve on" badge, which it replaces while skip is on. A click opens `ConfirmDialog` "Turn Skip all approvals off?" with **Turn off** (not danger) and **Cancel**. |
| `sessions/SessionRow.svelte` | A small red marker next to the name when `summary.skipApprovals`, with `aria-label="Skipping approvals"`. It uses kind or Tone danger styling, not a bare `text-danger`, because of the a11y sweep. |
| `sessions/NewSessionDialog.svelte` | A Skip all approvals `Toggle` initialised from `approvals.skipAllByDefault`. Turning it on opens `SkipApprovalsDialog` (session scope) stacked above the dialog; check z-order and focus restore. Its value is sent in `sessions:create`. |
| `settings/ApprovalsSettings.svelte` (new) and `SettingsView.svelte` | A new "Approvals" page (`{ id: 'approvals', label: 'Approvals' }`, and the `settingsPage` union in `stores/ui.svelte.ts`) with "Skip all approvals by default". Turning it on is saved through `settings.save` only after the default-scope dialog is confirmed. Turning it off needs no dialog. |
| `sessions/event-kinds.ts` | Labels for `skip-approvals` and `skip-approved`. |
| Design Preview | `ConfirmDialog`, `SkipApprovalsMarker` and the list marker, inert. |

Existing tokens are enough: `--color-danger`, `--color-danger-ink` and `--shadow-glow-danger`.

---

## 3. Impact and Risk Analysis

### System Dependencies

- Auto-approve, allow rules and stepping in (spec 006) share `coverage()`. Skip is a separate branch, and Auto-approve's behaviour with skip off is unchanged.
- Spec 007 (Codex sandbox, `arc.rules`), spec 010 (Cursor deny file, unasked notes) and spec 012 (attachments read-only).
- Spec 013's merge and pending flow, and spec 004's review attribution: both are affected when workers write into the user's checkout.

### Potential Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Codex under `dangerFullAccess` stops sending approvals or ignores `arc.rules` prompt rules, so pushes would run unasked. | Spike K1 before building. Fallback: `workspaceWrite` with root `/` and network on. Pushes stay gated by `isPublishAction` in every case where Codex asks. |
| Cursor does not re-read `cli.json` mid-process. | Spike K3. Fallback: relaunch at the turn boundary through `session/load`. |
| Removing Cursor's publish denies lets a push through when the user's own Cursor config allows it. | Keep the publish denies when `BypassDetector` reports a covering allow, hook or mode, and note the block. Spike K4 checks the ask path. |
| Limits lag the toggle: a running turn keeps its old sandbox or deny rules until its next turn, in both directions. When skip is turned off, a Claude worker can still edit knowledge or other copies until it is recycled. | The toggle event and the brain note say limits change from each agent's next turn. Recycle at the earliest idle boundary. The functional spec is amended to say "next turn". |
| Workers writing into the user's main checkout make it dirty. Merges then wait on `refs/arc/pending`, the edits show as "You" in Review changes, and the unsaved-changes question can appear. | Accepted and documented. The warning dialog already says "change files anywhere on your Mac". |
| A worker rewrites its own `.codex/rules/arc.rules`, `.cursor/cli.json`, or `.git/hooks` and `.git/config`. | Accepted risk of the mode, listed in the warning-dialog rationale. `arc.rules` is rewritten at each Codex launch. |
| Publishes not detected: scripts that push (`npm run deploy`), `curl` to a forge API, or MCP tools with unusual names. A command that first changes directory into the attachments folder and then uses relative paths also slips past the attachments carve-out. | The same limit as Auto-approve today. The MCP heuristic errs toward asking. Documented. |
| Codex can't keep the attachments folder read-only without a sandbox. | **Confirmed:** attachments stay read-only for Claude and Cursor: the edit denies are kept, and the skip branch does not cover shell writes into the folder, so those ask. A Codex write there may not reach Arc at all. It is Arc's own copy, so the user's originals are safe. |
| A Codex brain without its sandbox edits files directly, because file changes no longer reach Arc for `classifyBrainAction` to refuse. | K1 gates it. If file changes stop asking, the Codex brain stays `read-only` and the user is asked again. |
| Tool-server publishes are approved by the brain, because `mcp_write` does not have to reach the user. | Under skip, publish MCP hits are forced to must-escalate (§2.3). Unit-tested. |
| Enter confirming the dangerous dialog by accident. | Cancel has default focus, and the confirm button is not a submit. Covered by a renderer test. |

---

## 3a. Spike outcomes (2026-11-15)

See [real-turns.md](./real-turns.md). K1: under `dangerFullAccess` with `untrusted`, command and file-change approvals still reach Arc and `arc.rules` prompt rules still ask over a user allow, so the Codex brain's sandbox is lifted as planned and the root-`/` fallback is not needed. K2: the per-turn override works; a turn with no override keeps the last policy, so the restore must be explicit. K3: Cursor does not re-read `cli.json` mid-process. K4: a Cursor push asks over ACP once its deny is removed; a project allow skips the ask; a user-level allow is unproven. K5: a Claude `--resume` without the deny rules lets edits into added folders through without a prompt.

---

## 4. Testing Strategy

The project rule applies: each slice runs only the tests it touches, and the full suites run once at the end.

### Unit, main (`tests/unit/`)

- **`db/migration-0032.test.ts`:** an existing session reads `skip_approvals = 0` and the column is NOT NULL.
- **`db/sessions-repo.test.ts` and `db/app-settings-repo.test.ts`:** the new setter, the create field and the setting default.
- **`sessions/attention-allow.test.ts`:** a new skip describe block.
  - Each covered category is approved, with the `skip-approved` event text.
  - `git push`, `gh pr create` and MCP `create_pull_request` / `push_files` still escalate.
  - Questions and `AskUserQuestion` still escalate.
  - The turn-on sweep approves waiting permissions but not publish or question rows.
  - Auto-approve is unchanged when skip is off.
- **`sessions/attention-allow.test.ts` (more):** under skip, MCP `create_pull_request` from a worker is escalated straight to the user and the brain's `resolve_request` on it returns `policy_requires_user`; a shell write into the attachments folder is not covered.
- **`sessions/attention-terminal.test.ts`:** under skip, a controlled worker's `rm -rf build` is routed to the terminal and is not swept. Hand-back approves it. This uses a non-publish command, unlike the existing push-only test.
- **`policy/classify.test.ts`:** `isPublishMcpTool` cases.
- **`agents/codex/codex-config.test.ts`, `codex-adapter.test.ts`:** sandbox per flag; the `turn/start` override, including the explicit restore.
- **`agents/cursor/cursor-deny.test.ts`, `cursor-unasked.test.ts`:** the deny set per flag and bypass report; note suppression.
- **`agents/claude/claude-args.test.ts`, `sessions/worker-control.test.ts`:** the deny rules per flag; the relaunch at the turn boundary on toggle, and never mid-turn.
- **`sessions/notification-service.test.ts`:** no notification for skipped approvals.
- **`sessions/session-service.test.ts`:** create with and without the default; resume keeps the flag; the brain note is queued.

### Renderer (`tests/renderer/`)

- **`session-auto-approve.test.ts`:** the skip toggle opens the dialog, the toggle stays off on Cancel, and the right `set-config` calls are made. Auto-approve shows as locked and on, and turning skip off restores it.
- **`session-header.test.ts`:** the marker, the turn-off confirm, and Cancel.
- **`session-list-ui.test.ts`:** the marker appears only on the skipping row.
- **`new-session-dialog.test.ts`:** the default state, the dialog on turn-on, the create payload, and that the default is not changed.
- **New `skip-approvals-dialog.test.ts`:** Cancel focused first; Enter and Escape cancel; the danger button confirms.
- **New `approvals-settings.test.ts`:** turning on needs the dialog; turning off does not.
- **Design Preview and contrast:** extend `design-preview.test.ts` and add a contrast check for the danger marker text.

### E2E (`tests/e2e/`, scripted fakes only)

- **`sessions-approvals.spec.ts`:**
  - turn skip on through the dialog;
  - the marker, the locked Auto-approve and the list marker;
  - a worker's destructive command runs with the event text;
  - `git push` still docks a request;
  - quit and resume shows the marker and no dialog.
- **`codex-workers.spec.ts` and `cursor-approvals.spec.ts`:** a scripted run checks the `turn/start` sandbox override and the rewritten deny file.
- **Settings default → New Session switch flow.**
- Screenshots go to `docs/screenshots/`.

### Real-turn spikes (each needs the user's approval before it runs)

| ID | Provider | What it proves |
|---|---|---|
| K1 | Codex 0.163.0, scripted Responses provider (no model) | Under `dangerFullAccess` with `untrusted`, command and file-change approvals still reach Arc, and an `arc.rules` prompt rule still asks over a user allow rule. |
| K2 | Codex 0.163.0, scripted Responses provider (no model) | A per-turn `sandboxPolicy` override applies and an explicit restore takes effect. An accepted command runs unsandboxed. |
| K3 | Cursor, real turn (Free tier, Auto) | Two prompts in one process with `cli.json` rewritten between them: is the deny re-read? |
| K4 | Cursor, real turn (Free tier, Auto) | With no `git push` deny, the push asks over ACP; what the agent sees after `reject_once`; and whether a user `allow` entry for `Shell(git push)` skips the ask (earlier spikes saw `ls` ask despite a user allow), which decides when the "keep blocked" fallback is needed. |
| K5 | Claude, real turn | A `--resume` relaunch without the deny rules accepts an Edit into an added folder without asking. |
