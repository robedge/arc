# Tasks: Change Review

Verify tasks drive the built app with throwaway Playwright `_electron` scripts that launch `out/main/index.js` with `e2eEnv(userDataDir)` (sets `HARNESS_E2E=1` and `HARNESS_E2E_OFFSCREEN=1`) and `HARNESS_CLAUDE_BIN=tests/e2e/fixtures/fake-claude.mjs`. The fake CLI plays a scenario script; no task makes a real model call.

Every Verify task does the following:

- Uses temporary git repositories made by the fixture helpers (and, from Slice 9, a bare remote).
- Saves screenshots to the session scratchpad, never the repo.
- Ends by stopping the app and every fake `claude` process it started, by recorded PID.
- Deletes its scripts, screenshots, temporary repositories and temporary userData folders.

Each slice adds its own migration (`0015_…`, `0016_…`), as spec 003 did, instead of the single `0015_change_review` named in the tech spec.

- [x] **Slice 1: Review changes button and the file list**

  > The session header shows "Review changes · N". Clicking it replaces the session body with a review listing each repository's changed files (status and +/− counts). Back to session restores the conversation exactly as it was. No diffs yet.
  - [x] Add `session_projects.base_sha` (migration `0015_review_base`) and `SessionProjectsRepo.setBaseSha` (only when null). Repository tests against a temporary SQLite file. **[Agent: sqlite-database]**
  - [x] Record the base and build the file list (tech spec 2.1, 2.2):
    - `SessionBranchResult.baseSha` from `createdSha`, stored by `session-service` at session start.
    - Lazy backfill for older sessions via `merge-base <base_branch> <tip>`, stored once; re-derived with a warning when it is no longer an ancestor.
    - `src/main/git/review-git.ts`: `diff --raw --numstat -z -M -l1000 --no-ext-diff --no-textconv <base> <effectiveTip>` parsed into files (path, oldPath, status A/M/D/R, added, removed, binary, large > 2,000); skip `-M` above 2,000 files.
    - `src/main/review/review-service.ts` with an in-memory cache keyed by `(repo, base, tip)`, and the session-wide changed-file count.

    Unit tests with git fixtures for each status, binary, large, a pending tip, and `dev` moving after the session started. **[Agent: agent-orchestration]**
  - [x] Add `src/shared/types/review.ts`, the `review:get` channel and the changed-file count in the session snapshot; wire them in `bootstrap.ts`. **[Agent: electron-main]**
  - [x] Build the review shell:
    - `SessionHeader`: "Review changes · N" before the branch chips; at 0 it is `aria-disabled` with the "No changes yet" tooltip.
    - `review/ReviewScreen.svelte` replacing the session body, `ReviewHeader` with Back to session, `ReviewFileList`/`ReviewFileRow` grouped by repository (status, path, +/−).
    - `stores/review.svelte.ts` (class pattern of `active-session`).
    - `SessionScreen` keeps the conversation mounted and `inert` while the review is open; `Conversation` saves and restores `scrollTop` per session.

    jsdom tests for the count, the disabled tooltip, grouping and Back to session. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build. Run lint, typecheck, format check and the full unit and e2e suites; specs 001–003 must still pass.
    - Fake-CLI session in a group with two repositories where workers merge changes into both. The header shows the right count; the review lists an "api" and a "web" group with the right statuses and counts.
    - A session with no merged work shows the disabled button with "No changes yet".
    - Scroll the conversation up, open the review, click Back to session: same messages and scroll position.
    - Commit to `dev` after the session started: those changes don't appear.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 2: Viewing a file's changes, live**

  > Selecting a file shows its changes in a single column: removed lines red, added lines green, three lines of context. Binary and large files show their placeholders. The review refreshes by itself when more work is merged.
  - [x] Add `review:file` (tech spec 2.2, 2.9): `diff -M -U3 --no-ext-diff --no-textconv <base> <tip> -- <oldPath> <path>` parsed into hunks with old/new line numbers; `binary`, `large` (unless `showAnyway`) and `tooLarge` above 50,000 lines. Emit `session:review-changed {sessionId, projectId, seq, changedPaths, fileCount}` from the merge coordinator after a merge is recorded and when a pending merge lands; add it to `IpcEvents`, `eventNames` and `SessionPushEvent`. Unit tests for hunk parsing, the caps and the event. **[Agent: agent-orchestration]**
  - [x] Build the diff view:
    - `lib/review/diff-rows.ts` (`toUnifiedRows`), `DiffView`, `DiffUnified`, `DiffLine` with windowed rows like `TerminalPanel`, HUD tokens, +/− signs, no syntax highlighting.
    - Binary ("Binary file changed"), large ("Large change: 2,431 lines" with Show anyway) and too-large states.
    - The store subscribes to `session:review-changed` in `App.svelte` (debounced 300 ms, stale seq ignored), keeps the selected file, refetches its diff if it changed, and shows "Updated: N more files changed".
    - File list keyboard navigation (arrows, `j`/`k`, `n`/`p` outside inputs).
    - Design Preview: diff lines and the placeholders.

    jsdom tests for `diff-rows`, colours, the 2,000-line gate and the live update. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites as in Slice 1.
    - Select a changed file: red and green lines with context. A PNG shows "Binary file changed"; a 2,431-line file waits for Show anyway.
    - With the review open on a file, let another fake worker merge: the list updates, the same file stays open, and the notice shows.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 3: Which worker changed each file**

  > Each file shows the workers that changed it ("W1, W3"), with "You" for the user's own and Undo commits. The list can be filtered by repository and by worker.
  - [x] Add `src/main/review/attribution.ts` (tech spec 2.3): worker commits from `worker_commits`, rewritten commits through `merges.merge_sha` parent ranges, conflict-resolved files from `merges.conflict_files_json`, resolver rows excluded, everything else "You"; union over old and new paths; cached by tip. Include `workers` in `review:get`. Unit tests for each rule. **[Agent: agent-orchestration]**
  - [x] Show worker chips on file rows and add the repository and worker filters in `ReviewHeader`. jsdom tests for the chips and filtering. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - W1 adds a file and W3 later changes it: the row shows "W1, W3" and "Added". A hand commit on the session branch shows "You".
    - Filter by W2: only W2's files are listed.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 4: Side-by-side view**

  > A Single/Side-by-side toggle switches the diff layout, and the choice is remembered.
  - [x] Add `toSplitRows` (pairing removed and added runs), `DiffSplit`, the toggle in `ReviewHeader`, and the `arc.review.layout` preference in `localStorage` (try/catch, default unified). Design Preview split sample. jsdom tests for pairing, line numbers on both sides, and a throwing `localStorage`. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - Switch to side-by-side: removed lines on the left, added on the right. Reload the window: the review opens side-by-side.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 5: Not committed**

  > Edits the user made by hand in their own copy, without committing, are listed under "Not committed" for that repository, viewable but without Undo or notes.
  - [x] Add the not-committed section to `review:get` and `review:file` with `source: 'uncommitted'` (tech spec 2.2): porcelain status plus `diff --numstat HEAD`, untracked files read with `fs` (1 MB cap, NUL means binary) and hunks built in main; `{state: 'other-branch', current}` when the checkout isn't on the session branch. The section is recomputed on every `review:get` (no file watcher). Unit tests for tracked, untracked, binary, and other-branch. **[Agent: agent-orchestration]**
  - [x] Render the "Not committed" subgroup without actions, and the other-branch explanation "Your checkout is on X, so uncommitted edits aren't shown." jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - Edit a file in the user's api folder without committing: it appears under "Not committed" in the api group, with no Undo or note buttons, and its changes display.
    - Switch the checkout to another branch outside Arc: the explanation shows.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 6: Reviewed checkboxes**

  > Each file has a Reviewed checkbox with "5 of 12 reviewed" progress. A tick clears when the file changes again ("Changed since reviewed"), and ticks survive reopening the session.
  - [x] Add `review_file_marks` (migration `0016_review_marks`, tech spec 2.8) and `ReviewMarksRepo`. Repository tests including the cascade on session delete. **[Agent: sqlite-database]**
  - [x] Add `review:set-reviewed`; compute each file's fingerprint (base blob, tip blob, status) and return `reviewed` and `changedSinceReviewed` in `review:get`. Unit tests for marking, unticking and a later merge changing the file. **[Agent: agent-orchestration]**
  - [x] Add the Reviewed checkbox on rows and in the file toolbar, the progress in `ReviewHeader` (`aria-live`), and "Changed since reviewed". Design Preview file-row states. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - Tick 5 of 12: "5 of 12 reviewed". Merge a change to a ticked file: the tick clears and it shows "Changed since reviewed".
    - Relaunch the app and reopen the session: the same files are ticked.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 7: Undo a file's changes**

  > Undo changes on a file asks for confirmation (warning when a worker is still working on it), then adds a commit that puts the file back. The event log records it and the brain is told.
  - [x] Add the git allowlist exception `checkout <40-hex sha> -- <path>…` in `git.ts`, with tests that every other `checkout --` form is still refused. Add `review:undo-preview` and `review:undo` (tech spec 2.4): inside `MergeQueue`, the `_merge` worktree at the effective tip, restore per status (changed, deleted, added, renamed), `commit --no-verify -m "Undo session changes to <path>"`, publish with the moved-branch retry, drop the file's Reviewed mark, event `undo`, `pendingUndoNotes` in the orchestrator, and `session:review-changed`. Unit tests for each status, a dirty checkout (pending), a moved branch, `BRANCH_DIVERGED`, the active-worker warning, and the brain note text. **[Agent: agent-orchestration]**
  - [x] Add Undo changes in the file toolbar, `UndoDialog` (exact text, the "W2 is still working on this file." warning), and the `undo` event style in `event-kinds.ts`. Design Preview dialog states. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - Undo a changed file and confirm: it leaves the list, the event log shows "You undid changes to …", and the user's folder has the original content. Cancel leaves it unchanged.
    - Undo an added file: it no longer exists in the user's folder.
    - With a fake worker still running on the file: the dialog shows the warning.
    - The fake CLI log shows the undo note prepended to the next brain message.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 8: Notes for the brain**

  > Clicking a line opens a note composer. Drafts collect until "Send N notes to brain", which posts one conversation message listing each note with its file and line. Sent notes go stale when the line changes.
  - [x] Add `review_notes` (migration `0017_review_notes`, tech spec 2.8) and `ReviewNotesRepo` with draft-only edit and delete and `markSent` in one transaction. Repository tests. **[Agent: sqlite-database]**
  - [x] Add `src/main/review/notes-service.ts` and the `review:note-create`, `-update`, `-delete` and `review:send-notes` channels (tech spec 2.6): limits, the message format, sending through `SessionService.sendMessage`, and stale detection against the current hunks. Unit tests for the format, `NOT_DRAFT`, the 50-draft cap and stale detection. **[Agent: agent-orchestration]**
  - [x] Add the "Add note" gutter button per line (old and new side), `NoteComposer` (Esc cancels, Cmd+Enter saves), `NoteThread` (edit, delete, "Sent", "Changed since you wrote this"), and "Send N notes to brain" with the count. Design Preview note states. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - Write three notes on two files: the button reads "Send 3 notes to brain". Send: the conversation shows one message with all three and their file and line, and the fake brain replies.
    - Delete an unsent note: the count drops.
    - Merge a change to a noted line: the sent note shows "Changed since you wrote this".
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 9: Push branch**

  > Each repository has Push branch. The dialog shows the exact command and pushes only on Push; failures show git's message; success shows "Pushed" with the time.
  - [x] Add `pushed_remote`, `pushed_branch`, `pushed_sha`, `pushed_at` on `session_projects` (migration `0018_review_push`) and `SessionProjectsRepo.recordPush`. Repository tests. **[Agent: sqlite-database]**
  - [x] Add `src/main/git/push.ts` and the `allowPush` option (tech spec 2.5): exactly `push -u <remote> <session branch>` and `remote`; remote selection; `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`, 120 s timeout, outside the merge queue. Add `review:push-preview` and `review:push` (`confirm: true`), staleness ("· N newer commits"), `WAITING_FOR_CHECKOUT` while a pending merge exists, event `push`, and `session:review-changed`. Confirm nothing in the MCP bridge can reach it. Add `createRemoteFixture()` (bare remote plus clone) to `tests/helpers/git-fixtures.ts`. Unit tests: accepted form, refused force/refspec/delete/other-branch/leading-dash forms, success, rejected non-fast-forward with git's message, no remote, staleness, waiting. **[Agent: agent-orchestration]**
  - [x] Add Push branch per repository group, `PushDialog` (command in a code block, busy state, error without closing), the "Pushed 14:02" tag with newer-commit count, "No remote configured" and "Waiting for your checkout" disabled states, and the `push` event style. Design Preview dialog states. jsdom tests. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - With a bare remote: Push branch shows the exact command; nothing is pushed until Push; after Push the remote has the branch and the group shows "Pushed" with the time.
    - Make the remote reject the push (a diverged remote branch): the dialog shows git's message and the group isn't marked Pushed.
    - A repository with no remote shows "No remote configured".
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 10: Review link after the brain's summary**

  > When the brain posts its final summary, the message ends with a Review changes link that opens the review.
  - [x] Tag the brain's reply after `sendSummary` with `prompt_json {kind: 'review-link'}` (new kind in `message-prompt.ts`), falling back to a system message with the same kind if tagging the turn is unreliable (tech spec 2.7). Unit tests with the fake adapter. **[Agent: agent-orchestration]**
  - [x] Render the Review changes link after a `review-link` message in `Conversation.svelte`. jsdom test. **[Agent: svelte-frontend]**
  - [x] Verify:
    - Build and run the suites.
    - A fake-CLI session where every worker merges and the brain summarises: the summary ends with Review changes, and clicking it opens the review.
    - Clean up as described above.

    **[Agent: svelte-frontend]**

- [x] **Slice 11: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 004-change-review` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**

## Open Questions

- Criterion 2.3 "the brain's message acknowledges the undo instead of proposing the same change again" is covered only up to the brain's input: `tests/e2e/review-actions.spec.ts` proves the "[Arc] The user undid the session's changes to ..." note reaches the brain in front of its next message, and the scripted fake brain answers it. Whether a real model then declines to redo the change cannot be checked without a real model call, which the test rules forbid.
- Observation while writing the undo e2e (not a failing criterion): the "still working on this file" warning lists a worker that was only given a file through "sync", not one that changed it. A synced worker's working copy differs from its recorded base by the shared commit, so `WorktreeGit.changedFiles(worktree, baseSha)` reports that file for it. `tests/e2e/fixtures/claude-scenarios/review-main` therefore leaves W4 unsynced so the warning names only W5. If the warning should list only workers that changed the file themselves, `UndoService.preview` needs the worker's own commits instead of the base diff.
