# Functional Specification: Change Review

- **Topic:** A review screen in each session that shows everything the session changed in each repository, so the user can check, adjust and hand off the work before it leaves their machine.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Workers edit files and run commands freely once a plan is approved. The promise that makes this safe is that the user reviews the combined result at the end. Today that review happens outside Arc. The user has to switch to a terminal or editor, work out which commits came from the session, and compare the session branch with where it started, one repository at a time.

Change review brings that into the session. One screen shows every file the session changed, in every repository, compared with where the session branch started. For each change it shows which worker made it. From there the user can undo a change they don't want, or send a note to the brain asking for a fix, and see the result land in the same screen.

**Success looks like this:**

- The user can see every change a session made, across all its repositories, without leaving Arc.
- For any changed file, the user can tell which worker changed it.
- Undoing an unwanted file change takes one action and a confirmation.
- A note about a specific line reaches the brain with the file and line attached, so the user never has to describe where the problem is.

---

## 2. Functional Requirements (The "What")

### 2.1. Opening the review

- The session header has a **Review changes** button. It shows how many files the session has changed, for example "Review changes · 12". The count updates as workers' work is merged.
- Clicking it opens the review in place of the conversation and agent columns, with a **Back to session** button that returns to the conversation exactly as it was.
- When the session has no changes yet, the button is shown but disabled, with the tooltip "No changes yet".
- When the brain posts its final summary (spec 003, 2.8), the summary ends with a **Review changes** link that opens the same screen.
- **Acceptance Criteria:**
  - [x] Given a session whose workers have changed 12 files, when the user looks at the session header, then they see "Review changes · 12". _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-header-count.)_
  - [x] Given a session with no merged work, when the user hovers over Review changes, then the button is disabled and shows "No changes yet". _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-disabled-tooltip.)_
  - [x] When the user clicks Review changes and then Back to session, then the conversation shows the same messages and scroll position as before. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-back-to-session (scrollTop 150 before and after).)_
  - [x] Given the brain has posted its final summary, when the user clicks the Review changes link at its end, then the review opens. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-summary-link, summary-link-opened.)_

### 2.2. What the review shows

- The review compares each repository's session branch with the point it started from, such as "dev" when the session began. Changes made to "dev" by other people since then are not shown.
- The left side lists changed files, grouped by repository. Each file shows:
  - its path within the repository;
  - whether it was added, changed, deleted or renamed;
  - how many lines were added and removed, for example "+24 −3";
  - the worker or workers that changed it, for example "W1" or "W1, W3".
- The right side shows the selected file's changes, with removed lines in red and added lines in green, and a few unchanged lines around each change for context. Code is shown in the same monospaced font and colours as the rest of Arc.
- The user can switch between a single-column view (removed and added lines one under the other) and a side-by-side view. Single-column is the default; the choice is remembered.
- The user can filter the list by repository and by worker.
- Files that can't be shown as text, such as images, show "Binary file changed". Files with more than 2,000 changed lines show "Large change: 2,431 lines" with a **Show anyway** button.
- Changes the user has made by hand in their own copy of a repository, but not yet committed, are listed separately under "Not committed" for that repository, so the user can tell them apart from the session's committed work. Undo changes and notes are not offered for them; they are the user's own work.
- The review updates by itself when more work is merged, keeping the selected file open. A short notice says "Updated: 2 more files changed".
- **Acceptance Criteria:**
  - [x] Given a session with changes in the "api" and "web" repositories, when the user opens the review, then the file list shows an "api" group and a "web" group, each listing only that repository's changed files. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-repo-groups.)_
  - [x] Given W1 added a file and W3 later changed it, when the user looks at that file in the list, then it shows "W1, W3" and "Added". _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-attribution.)_
  - [x] Given someone pushed new commits to "dev" after the session started, when the user opens the review, then none of those commits' changes appear. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-dev-moves-on (dev-only.txt absent).)_
  - [x] When the user selects a changed file, then removed lines appear in red, added lines in green, and unchanged lines around each change are shown for context. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-diff-colours.)_
  - [x] Given the user filters by W2, when the list updates, then only files W2 changed are listed. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-worker-filter.)_
  - [x] Given a session changed a PNG image, when the user selects it, then the right side shows "Binary file changed". _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-binary.)_
  - [x] Given a file with 2,431 changed lines, when the user selects it, then they see "Large change: 2,431 lines" and the lines appear only after they click Show anyway. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-large-gate, large-shown.)_
  - [x] Given the single-column view, when the user switches to side-by-side, then removed lines appear on the left and added lines on the right, and the review opens in side-by-side the next time. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-side-by-side (kept after reload).)_
  - [x] Given the user edited a file by hand in their own api folder without committing, when they open the review, then that file is listed under "Not committed" in the api group, without Undo changes or notes. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-not-committed.)_
  - [x] Given the review is open on a file, when another worker's work is merged, then the list updates, the same file stays open, and "Updated: 2 more files changed" appears. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-live-update.)_

### 2.3. Undoing a change

- Each file has an **Undo changes** action. It puts the file back the way it was when the session started, and records that as a new commit on the session branch. A file the session added is deleted; a file the session deleted comes back.
- Before undoing, Arc asks: "Undo all of this session's changes to `api/src/sync/queue.ts`? This adds a commit to arc/fix-order-sync." with **Undo changes** and **Cancel**.
- If a worker is still working and has changed the same file, Arc warns: "W2 is still working on this file. Its next merge may bring the change back." The user can still go ahead.
- The brain is told which files the user undid, so it doesn't redo them without asking.
- The event log records each undo, for example "You undid changes to api/src/sync/queue.ts".
- Undo works on whole files only. To change part of a file, the user leaves a note for the brain (see 2.4).
- **Acceptance Criteria:**
  - [x] When the user clicks Undo changes on a file and confirms, then the file disappears from the review list and the event log shows "You undid changes to" followed by the file's path. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-undo-done, undo-done-log (file restored on disk).)_
  - [x] When the user clicks Undo changes and then Cancel, then the file stays in the list unchanged. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-undo-dialog.)_
  - [x] Given the session added a file, when the user undoes it, then the file no longer exists in their own copy of the repository. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-undo-added-file (file gone from disk).)_
  - [x] Given W2 is still working and has changed the file, when the user clicks Undo changes, then the dialog includes "W2 is still working on this file." _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-undo-warning.)_
  - [x] Given the user undid a file, when the brain next replies about that file, then the brain's message acknowledges the undo instead of proposing to make the same change again. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-undo-ack (note reached the brain; scripted brain reply, real-model behaviour is an Open Question in tasks.md).)_

### 2.4. Asking for changes

- The user can click any line in the changes and write a note, for example "This retry limit should come from config". Notes appear under the line they belong to.
- Notes are collected until the user clicks **Send notes to brain** (showing the count, for example "Send 3 notes to brain"). The brain receives every note with its repository, file and line, as one message in the conversation.
- The message in the conversation lists each note with its file and line, so the user can see what was sent.
- The brain then plans or makes the fixes as it would for any other message, following the session's mode.
- After notes are sent, they stay visible in the review marked "Sent". When a later merge changes the line a note is on, the note shows "Changed since you wrote this".
- The user can edit or delete a note until it is sent.
- **Acceptance Criteria:**
  - [x] When the user clicks a line and writes a note, then the note appears under that line and the button reads "Send 1 note to brain". _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-note-composer, note-saved.)_
  - [x] Given three unsent notes, when the user clicks Send 3 notes to brain, then the conversation shows one message listing all three with their file and line, and the brain replies. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-notes-sent, note-sent-marked.)_
  - [x] Given a note was sent, when a later merge changes that line, then the note shows "Changed since you wrote this". _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-note-stale.)_
  - [x] Given an unsent note, when the user deletes it, then it disappears and the send button count drops by one. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-note-saved.)_

### 2.5. Marking files as reviewed

- Each file has a **Reviewed** checkbox. The header of the review shows progress, for example "5 of 12 reviewed".
- When a reviewed file changes again in a later merge, its checkbox clears and the file shows "Changed since reviewed".
- Reviewed marks are kept when the session is closed and reopened.
- **Acceptance Criteria:**
  - [x] When the user ticks Reviewed on 5 of 12 files, then the review header shows "5 of 12 reviewed". _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-reviewed-progress.)_
  - [x] Given a reviewed file, when a later merge changes it, then its Reviewed tick clears and it shows "Changed since reviewed". _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-changed-since-reviewed.)_
  - [x] Given the user marked files as reviewed, when they close and reopen the session, then the same files are still marked. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-reviewed-after-reopen (same 4 files after relaunch).)_

### 2.6. Handing off the work

- When the user is happy, they publish the work themselves. The review offers, per repository, a **Push branch** button.
- Clicking Push branch shows the exact command, for example `git push -u origin arc/fix-order-sync`, with **Push** and **Cancel**. Arc pushes only when the user clicks Push. The brain can never trigger it.
- If the push fails, the error the remote returned is shown in the dialog, and nothing else changes.
- After a successful push, the repository's group in the review shows "Pushed" with the time.
- Arc still never merges into "dev" itself.
- **Acceptance Criteria:**
  - [x] When the user clicks Push branch for "api", then a dialog shows the exact push command for arc/fix-order-sync with Push and Cancel, and nothing is pushed until they click Push. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-push-dialog (remote empty before Push).)_
  - [x] Given the remote rejects the push, when the user clicks Push, then the dialog shows the remote's error message and the repository is not marked "Pushed". _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-push-rejected.)_
  - [x] Given the push succeeds, when the dialog closes, then the "api" group shows "Pushed" with the time. _(Verified 2026-10-18 in the built app: see docs/screenshots/004-change-review-pushed (ls-remote shows the branch).)_

---

## 3. Scope and Boundaries

### In-Scope

- The Review changes button in the session header and the link at the end of the brain's summary.
- The review screen: changed files by repository, with change type, line counts and the workers that made each change.
- Viewing a file's changes, with filters by repository and worker.
- Undoing a file's changes, with confirmation.
- Single-column and side-by-side views.
- The user's own uncommitted edits, listed separately.
- Line notes sent to the brain together.
- Marking files as reviewed, kept across reopening.
- Pushing a session branch, only when the user clicks Push.

### Out-of-Scope

- Editing files directly in the review. Arc is not a code editor; the user edits in their own editor or asks the brain.
- Merging the session branch into "dev" from Arc.
- Reviewing changes from other sessions, or from outside any session.
- Undoing part of a file; undo is whole files only.
- Opening a pull or merge request from Arc; the user does that after pushing.
- Comments shared with other people, or syncing notes to a hosted merge request.

---

## Change Log

_Dated amendments made after the spec was first written. Leave empty until the first amendment._
