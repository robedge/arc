<!--
This document describes HOW to build the feature at an architectural level.
It is NOT a copy-paste implementation guide.
-->

# Technical Specification: Change Review

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Completed
- **Author(s):** redgell, with the agent-orchestration, sqlite-database and svelte-frontend specialists

---

## 1. High-Level Technical Approach

Change review is a **read-mostly view over git** in the main process, plus a **review screen** in the renderer that temporarily replaces the session body. It reuses spec 003's machinery:

- **Git is the source of truth.** The review is computed on demand from `git diff` between each session project's recorded **base sha** and the session branch's **effective tip** (the pending ref when a merge is waiting, see spec 003 §2.7). Nothing about the diff is stored; results are cached in memory by `(repo, base, tip)`.
- **Attribution** maps the commits in `base..tip` to workers using the `worker_commits` and `merges` rows spec 003 already writes. Commits Arc can't map (the user's own, Undo commits) show as "You".
- **Undo** builds a revert commit for one file in the existing temporary `_merge` worktree and publishes it exactly like a merge, inside the per-repo `MergeQueue`. The user's checkout is only fast-forwarded when it is clean.
- **Push** is a new, narrowly allowlisted git operation reachable **only** from a renderer IPC call after the user clicks Push in a dialog. It is not exposed through the MCP bridge, so no agent can trigger it.
- **Notes and Reviewed marks** are the only new persisted state (SQLite, cascading with the session).
- **Renderer:** a custom Svelte diff renderer over parsed unified-diff hunks (no new diff library), styled with the HUD tokens. The conversation stays mounted (hidden) while the review is open, so Back to session restores it exactly.

### Affected areas

- **New:**
  - main: `src/main/review/` (`review-service.ts`, `attribution.ts`, `notes-service.ts`), `src/main/git/review-git.ts`, `src/main/git/push.ts`
  - shared: `src/shared/types/review.ts`
  - DB: migration `0015_change_review`, `ReviewMarksRepo`, `ReviewNotesRepo`
  - renderer: `lib/components/review/`, `lib/stores/review.svelte.ts`, `lib/review/diff-rows.ts`
- **Changed:**
  - `src/main/git/git.ts` (two narrow allowlist exceptions, `allowPush` option)
  - `src/main/git/session-git.ts` (`SessionBranchResult.baseSha`), `session-service.ts` (persist it)
  - `src/main/sessions/merge-coordinator.ts` (emit `session:review-changed`, tag the summary reply)
  - `src/main/sessions/orchestrator.ts` (`pendingUndoNotes`, `SessionPushEvent` union)
  - `src/shared/ipc/contract.ts`, `src/main/app/bootstrap.ts` (wiring)
  - renderer: `SessionScreen`, `SessionHeader`, `Conversation`, `event-kinds.ts`, `App.svelte` subscriptions, Design Preview
- **New dependencies:** none.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1. The base and the tip

- **Base sha:** new nullable `session_projects.base_sha`.
  - New sessions: `createSessionBranch` already computes the branch-point sha (`createdSha`); return it as `SessionBranchResult.baseSha` and store it with `setBranch`.
  - Sessions from before this spec: on the first review, compute `merge-base <base_branch> <branch tip>`, store it once and never change it.
  - If the stored base is no longer an ancestor of the tip (the user rewrote history outside Arc), recompute it with `merge-base` and log a warning.
- **Tip:** `MergeGit.sessionTip().effectiveTip` — the pending tip when a merge is waiting for the user's checkout, otherwise the branch tip. Changes pushed to `dev` by others after the session started are never shown, because the base is fixed.

### 2.2. Building the review (`src/main/git/review-git.ts`, `src/main/review/review-service.ts`)

| Step | Git call | Notes |
|---|---|---|
| File list + counts | `diff --raw --numstat -z -M -l1000 --no-ext-diff --no-textconv <base> <tip>` | One call gives status A/M/D/R with old and new paths, plus added/removed counts. Binary files report `-  -`. Skip `-M` when more than 2,000 files changed. Verified on a scratch repo. |
| One file's changes | `diff -M -U3 --no-ext-diff --no-textconv <base> <tip> -- <oldPath> <path>` | Fetched lazily when a file is selected. Parsed in main into hunks with old/new line numbers. |
| Attribution | `log --no-merges --no-renames --name-only -z --format=%x01%H <base>..<tip>`, and `log --merges --format=%H %P <base>..<tip>` | See 2.3. Cached by tip. |

- **Large and binary:** a file is `large` when added + removed > 2,000. `review:file` refuses large files unless `showAnyway` is set, and always refuses above 50,000 changed lines (shown as "Too large to display"), so output stays well under the wrapper's 32 MB buffer. Binary files return no hunks.
- **Not committed:** only when the user's checkout is on the session branch. Tracked changes come from the existing porcelain parser plus `diff --numstat HEAD`; untracked files are read with `fs` (1 MB cap, binary if a NUL byte is found) and their hunks built in main. If the checkout is on another branch or detached, the section returns `{ state: 'other-branch', current }` and the UI shows "Your checkout is on X, so uncommitted edits aren't shown."
- **Header count:** the number of changed files across all the session's repositories, included in the session snapshot and refreshed by `session:review-changed`.

### 2.3. Attribution (`src/main/review/attribution.ts`)

1. For each non-merge commit in `base..tip`, map its sha to a worker through `worker_commits`. Resolver workers (`isResolverRow`) are dropped.
2. For commits not in `worker_commits` (rewritten during a merge), use the merge commits: each merge with a `merges` row (`merge_sha`) attributes the commits it brought in (`P1..P2`) to that merge's worker.
3. Files changed by conflict resolution inside a merge commit (`merges.conflict_files_json`) are attributed to the merged worker.
4. Everything else — the user's own commits and Arc's Undo commits — is "You".
5. A file's workers are the union over its old and new paths, in worker-number order (e.g. "W1, W3").

### 2.4. Undo a file (`ReviewService.undo`)

Runs inside `MergeQueue.run(projectPath, …)`, so it never interleaves with a merge.

1. Read `sessionTip()`. If the branch has diverged, fail with `BRANCH_DIVERGED`.
2. Prepare the fresh `_merge` detached worktree at `effectiveTip` (existing helper).
3. Restore the file:
   - Changed or deleted: `checkout <baseSha> -- <path>`.
   - Added: remove the file, then `add -A -- <path>`.
   - Renamed: restore the old path from the base and remove the new path.
4. `commit --no-verify -m "Undo session changes to <path>"` (renames: `<old> -> <new>`).
5. Publish with `MergeGit.publish` — fast-forward the user's checkout when clean, the pending ref when dirty, `update-ref` when it's checked out elsewhere — retrying up to 3 times if the branch moved. Remove the worktree.
6. Delete the file's Reviewed mark, log event `undo` ("You undid changes to api/src/sync/queue.ts", data `{repo, path, commit}`), queue a brain note, and emit `session:review-changed`.

- **"W2 is still working" warning:** `review:undo-preview` returns the labels of running, non-resolver workers whose worktree has changed the path (or its old path) since their base (`worktrees.changedFiles`).
- **Telling the brain:** a new `pendingUndoNotes` list is prepended to the next brain message using the existing deferred-note pattern, without starting a turn: "[Arc] The user undid the session's changes to api/src/sync/queue.ts. Don't make that change again without asking."
- **Git allowlist:** one narrow exception in `assertGitAllowed`: `checkout <40-hex sha> -- <path>…`. Everything else stays refused.

### 2.5. Push branch (`src/main/git/push.ts`)

- **Allowlist:** `createGit({ allowPush: true })` is used only by the push module. With it, exactly `push -u <remote> <branch>` is accepted, where the remote matches `^[\w.-]+$` (no leading `-`) and the branch matches `^arc/[a-z0-9-]+$` and is the session's branch. No refspecs, `+`, `--force`, `--delete` or `--mirror`. `remote` (list remotes) is also allowed. The comment in `git.ts` that says Arc never pushes is updated to say pushes happen only from the user's click.
- **Remote:** the branch's configured remote, else the only remote, else `origin`, else `NO_REMOTE` (the button shows "No remote configured" and is disabled).
- **Credentials:** the push runner adds `SSH_AUTH_SOCK` to the minimal env and sets `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`; `HOME` is already passed, so `~/.ssh` and the osxkeychain helper work. `GIT_TERMINAL_PROMPT=0` makes HTTPS fail fast if no credential is stored. Timeout 120 s. Push runs outside the merge queue so it never stalls merges.
- **Result:** on failure the dialog shows git's stderr verbatim and nothing is recorded. On success Arc stores the remote, branch, pushed sha and time on `session_projects`, logs event `push`, and emits `session:review-changed`.
- **Staleness:** "Pushed 14:02 · 2 newer commits" when `rev-list --count <pushed_sha>..<tip>` > 0. While a merge is waiting for the user's checkout (pending ref), Push is disabled with "Waiting for your checkout", since push sends the real branch only.
- **Agents can't push from here:** `review:push` is a renderer IPC channel only and requires `confirm: true`; nothing in the MCP bridge calls it. Workers' own pushes still go through spec 003's always-ask approvals.

### 2.6. Notes (`src/main/review/notes-service.ts`)

- Drafts are saved as the user writes them; edit and delete are allowed only while a note is a draft.
- **Send:** all drafts for the session become one visible user message through `SessionService.sendMessage`, then are marked sent with that message's id, in one transaction. Format:

  ```
  Review notes (2):
  1. api · src/sync/queue.ts · line 42 (new)
     > const limit = 5
     This retry limit should come from config.
  ```

- **"Changed since you wrote this":** a note anchors on path + side + line number + the line's text. On each refresh the service re-checks the anchor against the current hunks; the note is stale when that side no longer has that text at that line.
- **Limits:** note body 1–4,000 characters, line text snapshot 500, at most 50 drafts per send.

### 2.7. "Review changes" link after the summary

After `sendSummary`, the merge coordinator sets a one-shot flag; when that brain turn completes, its reply is stored with `prompt_json = {kind: 'review-link'}` (a new kind in `message-prompt.ts`). `Conversation.svelte` renders a Review changes link after that message. Fallback if tagging the turn proves unreliable: post a short system message with the same prompt kind right after the summary.

### 2.8. Data Model / Database Changes (migration `0015_change_review`)

All new rows hang off `session_projects.id` (its integer PK) with `ON DELETE CASCADE`, so deleting a session removes them; removing a project from the group leaves them (as with spec 003 history).

**`session_projects` — new nullable columns**

| Column | Purpose |
|---|---|
| `base_sha` | Where the session branch started (2.1). Set once. |
| `pushed_remote`, `pushed_branch`, `pushed_sha`, `pushed_at` | Latest successful push only; a repush overwrites. History is in `events`. |

**`review_file_marks`** (Reviewed checkboxes)

| Column | Notes |
|---|---|
| `id` | integer PK |
| `session_project_id` | FK, cascade |
| `path` | repo-relative, exactly as git reports it (case-sensitive) |
| `fingerprint` | hash of base blob, tip blob and status at the time of marking |
| `marked_at` | epoch ms |

Unique `(session_project_id, path)`. A file counts as reviewed only while its fingerprint matches the current one; otherwise the UI shows "Changed since reviewed". Unticking deletes the row.

**`review_notes`**

| Column | Notes |
|---|---|
| `id` | ULID PK |
| `session_project_id` | FK, cascade |
| `path`, `side` (`old`/`new`), `line` (> 0), `line_text` | anchor |
| `body` | 1–4,000 chars |
| `state` | `draft` / `sent` |
| `message_id` | FK to `messages`, set null; set when sent |
| `created_at`, `updated_at` | epoch ms |

Index `(session_project_id, path)`; partial index on drafts for the send count.

**Repositories:** `ReviewMarksRepo` (`listByProject`, `mark`, `unmark`, `deleteByPath`), `ReviewNotesRepo` (`create`, `listBySessionProject`, `listDrafts`, `update`/`delete` guarded to drafts, `markSent`, `countDrafts`), and `SessionProjectsRepo` gains `setBaseSha` (only when null) and `recordPush`.

**Events:** no new table. New event kinds `undo` and `push` in `events`, with styles in `event-kinds.ts`.

### 2.9. IPC Contracts (`src/shared/ipc/contract.ts`)

| Channel | Request | Response |
|---|---|---|
| `review:get` | `{sessionId}` | per repo: files (path, oldPath, status, added, removed, binary, large, workers, reviewed, changedSinceReviewed), not-committed section, push state; plus notes and `seq` |
| `review:file` | `{sessionId, projectId, path, source: 'session' \| 'uncommitted', showAnyway?}` | hunks with old/new line numbers, or `{binary}` / `{large, changedLines}` / `{tooLarge}` |
| `review:set-reviewed` | `{sessionId, projectId, path, reviewed}` | ok |
| `review:undo-preview` | `{sessionId, projectId, path}` | `{activeWorkers: string[]}` |
| `review:undo` | `{sessionId, projectId, path}` | ok, or `BRANCH_DIVERGED` / `IO_FAILED` |
| `review:note-create` / `-update` / `-delete` | note fields / `{noteId, body}` / `{noteId}` | the note, or `NOT_DRAFT` |
| `review:send-notes` | `{sessionId}` | `{messageId, count}` |
| `review:push-preview` | `{sessionId, projectId}` | `{command, remote}` or `NO_REMOTE` / `WAITING_FOR_CHECKOUT` |
| `review:push` | `{sessionId, projectId, confirm: true}` | `{pushedAt}` or `PUSH_FAILED` with git's message |

**Push event:** `session:review-changed {sessionId, projectId, seq, changedPaths, fileCount}` — added to `IpcEvents`, `eventNames` and `SessionPushEvent`; emitted after a merge is recorded, when a pending merge lands, after an undo and after a push.

### 2.10. Component Breakdown (renderer, `src/renderer/src/lib/components/review/`)

- **Diff rendering — custom, no library.** Main sends parsed hunks; `lib/review/diff-rows.ts` (pure functions: `toUnifiedRows`, `toSplitRows` pairing removed/added runs) flattens them into rows that are rendered and windowed like `TerminalPanel`. This gives exact note anchors on old/new line numbers and plain HUD-token styling. `@codemirror/merge` was rejected (needs both full documents, awkward gutters for notes in unified mode, heavy for a read-only view); diff2html was rejected (its own CSS, HTML strings that don't take Svelte note widgets). **No syntax highlighting in this version** — only red/green colouring with +/− signs; a follow-up can add lezer highlighting per line.
- **`ReviewScreen`** — replaces the session body (`SessionScreen` body grid) with a file list column (260–320 px) and the diff; `SessionHeader` stays above it.
- **`ReviewHeader`** — Back to session, "5 of 12 reviewed" progress, repository and worker filters, Single/Side-by-side toggle, the "Updated: 2 more files changed" notice (`aria-live`), and "Send N notes to brain".
- **`ReviewFileList` / `ReviewFileRow`** — groups by repository with the Push branch button and "Pushed" tag; each row shows status, path, +/− counts, worker chips, Reviewed checkbox and "Changed since reviewed". "Not committed" subgroup without actions. Keyboard: list with arrow keys; `j`/`k` files, `n`/`p` changes, only outside text inputs.
- **`DiffView`, `DiffUnified`, `DiffSplit`, `DiffLine`** — the file toolbar (Undo changes, Reviewed), binary / large / too-large states with Show anyway, and line-number gutters with an "Add note" button per line.
- **`NoteComposer`, `NoteThread`** — write, edit and delete drafts; "Sent" and "Changed since you wrote this" badges.
- **`UndoDialog`, `PushDialog`** — on the existing `Modal`; Undo shows the active-worker warning; Push shows the exact command and, on failure, git's message without closing.
- **`SessionHeader`** — "Review changes · N" button in the controls row before the branch chips; at 0 it uses `aria-disabled` with the "No changes yet" tooltip so the tooltip still shows on hover.
- **`Conversation`** — renders the Review changes link after a `review-link` message.
- **Back to session:** `SessionScreen` keeps the conversation block mounted and hides it (`inert`) while the review is open, so scroll position, composer draft and terminal tabs are untouched. `Conversation` also saves and restores `scrollTop` per session as a fallback, which fixes the existing jump on tab switch.
- **Store `review.svelte.ts`** — same class pattern as `active-session`: files, uncommitted, selected file, diff cache, notes, filters, layout, notice, `baseSeq`. Subscribes to `session:review-changed` in `App.svelte`, debounced 300 ms; re-fetches `review:get`, keeps the selected file if it still exists, re-fetches its diff if it changed, and sets the notice.
- **Layout preference:** `localStorage` key `arc.review.layout` (`unified` default), every access in try/catch. It's a per-machine view preference, so no settings table.
- **Design Preview:** diff lines (context/added/removed/with note), unified and split samples, file rows in each state, binary and large placeholders, note states, Undo and Push dialogs, the header button enabled and disabled.

---

## 3. Impact and Risk Analysis

### System Dependencies

- Spec 003's merge coordinator, merge queue, pending-ref handling, `worker_commits` and `merges` rows, deferred brain notes and the session event log.
- The git wrapper's allowlist (two deliberate, narrow additions) and the user's own SSH agent or credential helper for pushes.
- The session screen layout and header from spec 003.

### Potential Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Huge repositories or diffs stall the UI | One `diff --raw --numstat` per repo, cached by tip; lazy per-file patches; 2,000-line Show anyway and a 50,000-line hard cap; rename detection limited and skipped above 2,000 files. |
| Undo races a merge | Undo runs in the same per-repo `MergeQueue` and publishes with the same moved-branch retry. |
| Undo or merge while the user's checkout is dirty | Same rule as merges: the commit waits on the pending ref and lands when the checkout is clean; the review shows the pending tip. |
| A worker brings an undone change back | The warning before undo, and the brain note telling it not to redo the change. |
| Push hangs on authentication | `BatchMode=yes`, `GIT_TERMINAL_PROMPT=0`, 120 s timeout; git's error is shown verbatim. |
| Push widened beyond intent | Exact argument shape only, session branch only, opt-in runner used by one module, renderer-only channel with `confirm: true`, unit tests for refused forms. |
| User switches branches or rewrites history outside Arc | "Not committed" degrades to an explanation; the base is re-derived if it stops being an ancestor; undo fails with a clear error if the branch diverged. |
| Attribution wrong after rewritten commits | Falls back to the merge commit's worker; unknown commits show "You" rather than a wrong worker. |
| Repo config runs external diff tools or text conversion | `--no-ext-diff --no-textconv` on every diff. |
| Paths differ only by case on macOS | Paths stored and compared exactly as git reports them. |

---

## 4. Testing Strategy

- **Unit (main, `tests/unit/review/`, `tests/unit/git/`):**
  - `review-git` parsing of raw+numstat for added, changed, deleted, renamed, binary and large files; hunk parsing with old/new line numbers.
  - Attribution: worker commits, rewritten commits through merges, conflict-resolved files, resolver rows excluded, user commits as "You".
  - Undo for each status, with a dirty checkout (pending), a moved branch (retry), and the active-worker warning.
  - `git.ts` allowlist: the `checkout <sha> --` exception, the exact push form accepted, and force, refspec, delete, other-branch and leading-dash forms refused.
  - Push against a new `createRemoteFixture()` (bare remote plus clone): success, rejected non-fast-forward with git's message, no remote, staleness count, and waiting-for-checkout.
  - Repositories and migration 0015: cascade on session delete, draft-only edits, fingerprint-based reviewed state.
  - Notes: message format, send marking, stale detection.
- **Renderer (jsdom, `tests/renderer/`):** `diff-rows` pure functions; red/green rendering and the 2,000-line gate; note flow and send-count text; the store keeping the selected file across `session:review-changed` and ignoring stale seq; reviewed progress; layout preference with a throwing `localStorage`; header button count and disabled tooltip; the summary link; the Undo dialog warning.
- **End-to-end (Playwright, fake CLI, off-screen windows):** review opens from the header with two repositories and multi-worker attribution; a merge while the review is open keeps the selected file and shows the notice; Back to session keeps the conversation's scroll position; undo with confirm and cancel; three notes become one conversation message; Reviewed marks survive a relaunch; push succeeds against a bare remote and a rejected push shows git's message; binary and large files; a hand edit appears under "Not committed"; the side-by-side choice survives a reload.

---

## Change Log

- 2026-10-18 — task planning — The schema lands one migration per slice (`0015_review_base`, `0016_review_marks`, `0017_review_notes`, `0018_review_push`) instead of a single `0015_change_review`, so each slice ships only the tables it uses, as spec 003 did.
