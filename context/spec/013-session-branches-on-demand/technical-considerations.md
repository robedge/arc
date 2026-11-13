# Technical Specification: Session Branches on Demand

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Draft
- **Author(s):** redgell

---

## 1. High-Level Technical Approach

Today the brain's naming of a session triggers `applySessionStart` for every git project of the group: each gets `arc/<slug>` and the user's checkout is switched. Worker worktrees are already created on demand, so only the session branch is eager.

The change moves branch creation from "when the session is named" to "just before a worker's working copies are created":

1. **Naming only names.** When the brain names the session, Arc stores the slug and touches no repository. `sessions.slug` stops meaning "branches are done" and means "the name is chosen".
2. **One new unit creates branches on demand.** A `BranchOnDemand` unit is called from the single place every fresh worker passes through (`WorkerManager.startRow`'s two callers). It checks the worker's projects, and either creates the missing branches, or reports that the worker must wait for the user.
3. **Unsaved changes become a persisted question.** A dirty project gets one row in a new `branch_questions` table. It is shown as a card in Needs attention. Workers that need that project stay `queued` until it is answered.
4. **Everything else already copes.** Reopen, review, push, undo, merge retry and sync already skip projects whose `branch_name` is null (read-only projects work that way today), so they need little or no change.
5. **The start-time and project-added dirty flows are removed.** The dirty dialog stays only for reopening a session.

Affected systems: session service, worker manager, orchestrator (brain prompt and tool text), merge coordinator (final summary), one new table, the attention view, the session header and the new-session dialog. No provider adapter changes. No real provider turns are needed to design or test this; it is git plus the existing fakes.

This spec changes behaviour described in spec 003 sections 2.2 (the session branch) and 2.11 (a project added to the group).

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1. Naming and the branch name

| Topic | Design |
|---|---|
| When the slug is set | In `SessionService.startBranches` / `runBranchStart`, as soon as the brain's name arrives. No `applySessionStart` call. |
| How the name is chosen | `uniqueBranch` over all active git projects (read-only git), so a name left behind by an older session is avoided in every repository up front. The `-2`, `-3` suffix stays part of the slug, as today. |
| Branch name per project | `SESSION_BRANCH_PREFIX + slug`. `session_projects.branch_name` stays null until the branch really exists there, and stays the source of truth for "has a branch". |
| `branchesReady` | Keeps its signature but now resolves when the name is chosen. `ensureBranches` in the orchestrator still forces the fallback name for a spawn that arrives before the first reply. |
| Slug is fixed | The slug must not change once any project has a branch. Enforced in the service. |
| Sessions with a null slug | A session whose start was aborted under the old design (slug null, no branches) gets a slug the next time it is named or opened. No migration. |

**Decided (user, 2026-11-12):** if, at first use, the chosen name already exists in that one repository (created after the session was named), Arc uses the next free suffix in that repository only and records it in the event log. This is the one case where repositories of a session can differ in branch name. The existing project-added path already behaves this way.

### 2.2. `BranchOnDemand` (new, `src/main/sessions/branch-on-demand.ts`)

Responsibility: make sure a set of session projects have their branch, or say why not.

| Contract | Meaning |
|---|---|
| `ensure(projectIds, workerId)` → `ready` | Every project has a branch now. Rows were recorded and the header pushed. |
| → `waiting` | At least one project is dirty. A pending question exists for each dirty project. Nothing was created. |
| → `failed(reason)` | Git failed. Anything created in this call for an earlier project is kept and recorded. |
| `answer(questionId, choice)` | Applies the user's choice (see 2.4). |
| `cancelOrphans()` | Cancels questions that no queued worker is waiting on. |

Rules:

- **One lock per session.** All `ensure` and `answer` calls for a session run one at a time. Two spawns for the same project therefore share one question, and the second is a plain waiter.
- **All or nothing per worker.** For a worker with several projects, all are checked first. If any is dirty, no branch is created for any of them until every question is answered. A "Don't start" then leaves every repository untouched.
- **Creation reuses existing code.** One `planSessionStart` + `applySessionStart` call per project with the fixed branch name, then `recordResults` (branch, base branch, previous branch, base sha, dirty handling, stash ref). `applySessionStart` already rolls back a single project on failure.
- **Event log:** kind `branch`, text "Created arc/<slug> in <project> (from <base>)".
- **Crash safety:** if the branch already exists in a project whose row has no branch, and the user's checkout is on it with no commits beyond its base, Arc adopts and records it instead of creating another.
- **Dirty state is read live.** The changed files are never stored; they are read from git when the card is shown and again when it is answered.

Much of this is today's `createAddedBranch` in `session-service.ts`, moved and generalised.

### 2.3. Worker start (`src/main/sessions/worker-manager.ts`)

| Place | Change |
|---|---|
| `spawn` | `resolveRepos` no longer requires a branch; the `branch_not_ready` error goes away. Before `startRow`, call `ensure`. `ready`: re-read the project rows (they now carry the branch) and start. `waiting`: store the worker as `queued` and return `{status: 'queued', note}` so the brain's tool call does not block. `failed`: store the worker as `failed` and throw a `branch_failed` tool error, mirroring the existing `worktree_failed` path. |
| `startQueued` | Remove the "project has no branch" failure. Call `ensure` first; on `waiting` the worker stays `queued`, with no second "queued" event. |
| `drain` | A third reason to hold a queued worker: one of its projects has a pending branch question. This is derived from `project_ids_json` and the pending questions, not stored on the worker. The activity text is computed, for example "Waiting for your choice about unsaved changes in web". Held workers use no slot (`queued` is already excluded from the active count). |
| Order of checks | `ensure` runs after the worker-limit and provider usage-limit holds, so a held worker never creates a branch. |
| `createWorktrees` | Unchanged, but it now always receives rows read after `ensure`. |
| Relaunch, continue, resolvers | Unchanged. They reuse worktrees of branches that already exist. |

Brain spawns, command workers and plan-approved workers all reach `spawn`, so there is no other entry point to cover. Approving a plan starts nothing by itself.

`SpawnWorkerResult` and the `spawn_worker` bridge schema gain an optional `note`.

### 2.4. The unsaved-changes question

**Storage: new table `branch_questions`, migration `0031_branch_questions`.**

| Column | Notes |
|---|---|
| `id` | text primary key |
| `session_id` | FK to `sessions`, cascade |
| `session_project_id` | FK to `session_projects`, cascade |
| `status` | `pending`, `answered`, `cancelled` |
| `choice` | null, or `stash`, `commit`, `carry`, `skip` |
| `message` | null, or the reason "Bring them along" failed |
| `created_at`, `resolved_at` | |

Indexes: a partial unique index on `session_project_id` where `status = 'pending'` (at most one open question per project of a session), and an index on `session_id` for pending rows.

Repository `src/main/db/repositories/branch-questions-repo.ts`: `openFor`, `listPending`, `countPending`, `countPendingAll`, `getPendingFor`, `resolve`, `reopenWithMessage`, `cancel`.

A separate table was chosen over a new `source` in `attention_requests`. Every existing attention row is an agent's request whose answer is delivered back to an agent; a branch question is answered by Arc itself. Keeping it apart means no existing consumer (brain routing, delivery, restart clean-up) can mistake it for an agent request.

**View and answer path.**

| Piece | Design |
|---|---|
| Shared type | `AttentionView` gains a variant `kind: 'branch'` with `projectId`, `projectName`, `files` (at most 10), `moreFiles`, `workers` (labels such as "W3 web-fix"), `message?`. `from` is "Arc". |
| Where it is merged | `AttentionService` adds pending branch questions to the session snapshot and to the Needs attention counts (session list badge and notifications). |
| Push | The existing `session:attention` push, sent when a question opens, is re-offered, or closes. |
| Answer | New IPC channel `sessions:answer-branch-question` with `{questionId, choice}` where choice is `stash`, `commit`, `carry` or `skip`. |
| Restart | Rows are persisted and the unit keeps no memory, so a pending card and its queued workers come back as they were. |

**What each answer does (`BranchOnDemand.answer`, inside the session lock).**

| Choice | Effect |
|---|---|
| Set aside, Commit them first, Bring them along | Re-check the project (it may have changed). Mark the question answered. For each waiting worker whose projects now have no open question, create its branches and call `drain` so it starts. |
| Bring them along fails | The question stays pending with `message` set. The card shows the message and offers the other three choices. |
| Don't start | Mark the question answered with `skip`. Every queued worker that needs that project is not started (see assumption below). The repository is not touched. The brain gets one note: "[Arc] The user chose not to start work in web (unsaved changes). Not started: W3 web-fix. Nothing was changed in web. Tell the user or change your approach." Questions left with no waiting worker are cancelled. |

**Decided (user, 2026-11-12):** a worker that is not started because of "Don't start" ends as `failed` with the reason "Not started: you chose to leave web as it is". `stopped` is avoided because its Continue action would relaunch a worker that never had a working copy.

**Assumption:** "Don't start" does not keep the project out of the session. If the brain later starts another worker there and the repository is still dirty, the question is asked again. The `left_out` membership is no longer written; existing rows are still read.

**Orphans.** After a worker is stopped or removed, after a project leaves the group, and when a session is opened, questions with no waiting worker are cancelled.

### 2.5. Removed from the old flows

| Removed | Where |
|---|---|
| Dirty planning in `create()`, the `create` kind of pending dirty question, `startChoices` | `session-service.ts` |
| `needsDirtyChoice` in the `sessions:create` result | `src/shared/types/session.ts`, `src/shared/ipc/contract.ts`, `NewSessionDialog.svelte` |
| `applySessionStart` for all projects at naming | `runBranchStart` |
| `joinBranches`, `askAdd`, `resolveAdd`, the `add` kind, the `session:dirty-question` push | `session-service.ts`, contract, `App.svelte`, `active-session` store |

Kept: the `open` kind and `DirtyTreeDialog` for reopening a session, with its intro changed to say the repositories are being switched back to the session branch.

A project added to the group gets a `session_projects` row with no branch, and the brain is told: `"web" joined the group (<path>); it gets the session branch when a worker first starts there`.

### 2.6. Brain prompt and summary

- `BRAIN_PROMPT_VERSION` becomes 9, with an update note for resumed sessions.
- Text changes: the session branch is created in a repository when its first worker starts; `queued` can also mean the worker is waiting for the user's answer about unsaved changes, so do not spawn it again; a message follows when it starts or is not started. `branch_not_ready` is removed from the `spawn_worker` description.
- Worker prompt: where a worker has several projects, the branch name is taken per project instead of from the first one.
- Final summary (`merge-coordinator.ts` `sendSummary`): lists only repositories that have commits. The "(no commits)" line goes away, which also tidies sessions started before this change.

### 2.7. Renderer

| Component | Change |
|---|---|
| `components/sessions/SessionHeader.svelte` | One chip per project that has a branch, with the repository name. The existing single collapsed chip is kept only when every git project has the branch and the label is identical (sessions started before this change). After the chips, a count for git projects with no branch: "N more projects" when some have one, "N projects" when none do, singular "1 more project" and "1 project". Read only and Removed chips are unchanged and not counted. |
| `components/ui/PopoverList.svelte` (new) | The count is a button with `aria-expanded` and `aria-controls` that opens a labelled list of names. Escape and a click outside close it and return focus. Modelled on `UsageChip`. |
| `components/ui/attention/BranchQuestionCard.svelte` (new) | Titled "Unsaved changes in <project>". Lists the files and "and N more", names the waiting workers, shows four choices with descriptions and one Continue button. No free-text answer and no Decline. Shows `message` as a warning and then offers three choices. |
| `AttentionDialog.svelte`, `ui/attention/types.ts` | Add the `branch` variant. |
| `NewSessionDialog.svelte` | Remove the dirty state and the `DirtyTreeDialog` mount. |
| `App.svelte`, `stores/active-session.svelte.ts` | Remove `session:dirty-question` and `applyDirtyQuestion`; add the answer call. |
| `preview/DesignPreview.svelte` | Entries for the card (normal, long file list, failed carry) and the popover (closed, open). |

`header.branches` already includes git projects with a null branch, so the header needs no new field. Live updates arrive through the existing `session:header` push.

### 2.8. Documentation

`context/product/architecture.md` (git state section) and `product-definition.md` are updated when the feature is built. Stale comments that describe the eager design (`sessions.slug`, `SessionBranch`, `session:header`) are corrected.

### 2.9. Where the build differs from this design

Found while documenting the feature as built. `context/product/architecture.md` describes the built behaviour.

- **`ensure` signature (2.2).** It is `ensure(sessionId, projectIds, workerId)`. There is one `BranchOnDemand` per app, not one per session. The lock is per session.
- **Git fails partway (2.2, section 3).** The build takes back the branches made in that call and records nothing, so no repository of the worker keeps a new branch unless all do. The design kept and recorded the earlier ones. This follows the functional rule. `SessionGit` gained `adoptableBranch` and `undoSessionBranch` for adoption and the take-back.
- **A project that returns (2.5).** A project removed from the group and then added again is no longer asked about mid-session. It switches back to the session branch on the next session open. The old prompt used the `session:dirty-question` push, which this spec removed.
- **Worker prompt (2.6).** It lists the session branch per working copy: `- api: <path> (session branch arc/x)`.
- **Slot accounting (2.3).** `ensure` runs after the worker row is stored as `starting`, so the worker counts toward the active limit until `ensure` returns. A worker that then waits is set back to `queued` and uses no slot.
- **Held workers (2.3).** After the user answers, the repository gets its branch straight away for the workers that waited on it, even when such a worker is also held by the worker limit and starts later. The design said a held worker never creates a branch.
- **Reused answer (2.4).** An answered choice other than Don't start is reused for another worker that needs the same repository while a queued worker still waits on it and the answer is not applied yet. The user is not asked again.
- **Wait text and the brain note (2.3).** `SpawnWorkerResult.note` already existed for the model override note, so the wait text is appended to it. `BranchOnDemand.waitingOn` and the `branchWaits` dependency derive the hold. When a waiting worker starts, the brain gets "[Arc] <label> has started: the user chose how to handle the unsaved changes it was waiting on."
- **`branch_questions` (2.4).** `session_project_id` is an integer. `status` and `choice` have CHECK constraints. The repository also has `getById`, `lastAnsweredFor` and `countPendingByGroup`.
- **Quit.** A graceful quit keeps a worker that waits on an unsaved-changes question queued. Before, quit stopped every queued worker.
- **Card refresh.** While a question is pending, the cards are pushed again on the session service's summary timer, so the waiting workers and the file list stay current.
- **Bring them along (2.4).** The card is pushed only once the outcome is known, so a failed carry keeps the Needs attention dialog open with the warning. A failed carry in a different project (an earlier carry answer applied later) reopens that project's card.
- **Orphans (2.4).** `cancelOrphans` counts `starting` workers as waiting, so a spawn in progress keeps its question. It runs after a worker is stopped or removed and at the end of `syncProjects`, which also covers a session open.
- **Renderer (2.7).** The card lives in the existing Needs attention dialog, opened from the badge. `PopoverList` takes `label`, `listLabel`, `items` and `initiallyOpen`. A click outside closes it without moving focus, and Escape returns focus, as in `UsageChip`. When `message` is set, Bring them along is not offered.
- **Final summary (2.6).** `sendSummary` writes "(no commits in any repository)" when no repository has commits.
- **Test-only change.** `tests/unit/sessions/review-changed.test.ts` ("is pushed when a waiting merge lands") now retries `open` until the push arrives. Opening a session got faster, so its merge retry can run while the repository is still busy.

**Known gap.** A project removed from the group while a queued worker still waits on its card. The card is cancelled, but the worker stays queued and can reopen and cancel the question again on later drains.

---

## 3. Impact and Risk Analysis

**System dependencies:** session service, worker manager, orchestrator prompt, merge coordinator summary, attention service and counts, the session header, the new-session dialog. Review, push, undo, sync and reopen are affected only by the fact that fewer projects have a branch, which they already handle.

| Risk | Mitigation |
|---|---|
| The user's checkout is switched in the middle of a session, while they may be editing there. | This is the spec's behaviour. A dirty repository always asks first; a clean one is switched and logged in the event log, and the header updates. |
| A queued worker that goes back to waiting upsets `drain`'s slot accounting. | One transition helper; the active count is always recomputed from the database. Unit tests for limit plus branch wait together. |
| Two spawns race for the same project. | The per-session lock and the partial unique index on pending questions. |
| A worker spans a clean and a dirty project and the clean one is switched for nothing. | All-or-nothing check before any creation. |
| Git fails halfway through a multi-project worker. | Each project is one `applySessionStart` call that rolls itself back. Earlier projects are kept and recorded; the worker fails with the reason. |
| Arc crashes between creating a branch and recording it. | The adopt rule in 2.2. |
| The card's file list is out of date when answered. | Re-check on answer. |
| A Plan-first worker waiting in `queued` is spawned twice by the brain. | Verify that the approved-plan matching counts queued workers; prompt text says not to respawn; test. |
| A renderer path still expects `needsDirtyChoice` from create. | The field is removed from the shared type, so the compiler finds every use. |
| Branch names differ between repositories after a late collision. | Rare; logged; every consumer already reads the name per project. |
| Many existing tests assert a branch in every project right after start. | Listed in section 4; rewritten as part of the slices that change the behaviour. |

---

## 4. Testing Strategy

All tests use real git in temporary repositories and the existing fake providers. No real provider turn is needed.

**Unit (Vitest, real git rigs in `tests/unit/sessions/`):**

- Naming sets the slug and changes no repository; the name avoids a branch left by an older session.
- `BranchOnDemand`: clean project gets its branch at first worker; multi-project worker gets all before starting; mixed clean and dirty creates nothing before the answer; two concurrent spawns share one question; each of the four choices; failed carry re-offers; "Don't start" with two waiting workers; orphan question cancelled when its last worker is stopped; late name collision; crash adoption; git failure.
- Worker manager: `queued` with a branch wait uses no slot; limit and branch wait together; `spawn_worker` returns `queued` with a note; no `branch_not_ready`.
- Repository and migration tests for `branch_questions`, including the one-pending-per-project rule and cascade on session delete.
- Attention view and counts include branch questions; restart keeps a pending question and its queued worker.
- Final summary lists only repositories with commits. Brain prompt v9 and its update note.
- Project added to an open session joins with no branch.

**Renderer (jsdom):** header chip rules for 0 of 9, 1 of 9, 3 of 9, all 9 and read-only; singular copy; popover open, Escape and outside click; the branch card's content, choices, warning state and answer; new-session dialog no longer shows the dirty dialog; reopen dialog copy.

**End to end (Playwright with fakes):**

- Start a session and ask a question: every repository is on its original branch and has no `arc/` branch; the header shows "N projects".
- First worker in api: api is on the session branch, the others are untouched, the header lists api and "N more projects".
- Dirty web: card in Needs attention, worker queued, a worker in a clean repository starts; each choice; restart with the card pending.
- Project added to the group gets its branch on first worker.
- Reopen switches back only repositories that have a branch.
- A session created with a branch in every repository still opens and works.

**Existing tests that change:** `tests/unit/sessions/session-branches.test.ts`, `tests/unit/sessions/group-changes.test.ts`, parts of `tests/unit/git/session-git.test.ts` users, `tests/e2e/sessions-start.spec.ts`, `tests/e2e/sessions-group-changes.spec.ts`, `tests/renderer/session-header.test.ts`, `dirty-tree-dialog.test.ts`, `new-session-dialog.test.ts`, `new-session-attachments.test.ts`, `active-session.test.ts`, and the rigs that assume a branch exists before a spawn (`tests/unit/sessions/helpers.ts`, `merge-rig.ts`).
