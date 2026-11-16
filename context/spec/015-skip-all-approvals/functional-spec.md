# Functional Specification: Skip All Approvals

- **Topic:** An opt-in, clearly dangerous switch that lets the brain and workers do whatever they need without asking for permission, for one session or as the default for new sessions. Questions, pushes and pull or merge requests still reach the user.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Arc protects the user's machine by making agents ask before risky actions: changing files outside their own working copy, destructive commands, installs for the whole machine, and anything that leaves the machine. The session header's Auto-approve switch already approves most of these on its own. Even with Auto-approve on, agents are still held back:

- **Codex** workers run inside a sandbox that limits where they can write and whether they can use the network. Going beyond it means a request for more access.
- **Cursor** workers can't edit the user's project folders, the knowledge folder or other workers' copies. Arc blocks the action, tells the agent to ask the brain, and leaves a note in the session.
- **Claude** agents still check with Arc before each protected action, even when Arc approves it straight away.

When the user trusts the task and the machine, for example in a throwaway repository, on a long autonomous run, or when they are away from the screen, these limits make work stall or fail. The user would normally get past this in a terminal by running the provider in its own "skip permissions" or "bypass approvals and sandbox" mode. Arc offers no equivalent.

This spec adds **Skip all approvals**. While it is on, the brain and every worker run with all approvals and limits lifted, on every provider, and nothing waits in Needs attention for permission. Two things still need the user: questions, and actions that publish work (pushing a branch and opening or merging pull or merge requests). Because this is dangerous, it is off by default, it needs a confirmed warning to turn on, and it is clearly shown for as long as it is on.

**Success looks like this:**

- A user can start an autonomous session, turn Skip all approvals on, walk away, and come back to finished work instead of a queue of permission requests.
- Codex and Cursor workers no longer fail or stall on sandbox limits or blocked edits while it is on.
- Nobody turns it on by accident, and it is never on without the user being able to see that it is.
- Questions from workers and commands, and requests to push or open or merge pull or merge requests, still reach the user.

---

## 2. Functional Requirements (The "What")

### 2.1. Turning it on for a session

- **As a** user, **I want to** turn Skip all approvals on for the session I'm in, **so that** its agents stop waiting for my permission.
- The session header has a **Skip all approvals** switch next to Auto-approve. It is off unless the user turned it on for this session or it is the default (see 2.2).
- Turning the switch on opens a warning dialog. Nothing changes until the user confirms.
  - Title: "Skip all approvals?"
  - Text: "The brain and every worker in this session will run commands, change files anywhere on your Mac, install software and use the network without asking you. Codex's and Cursor's safety limits are turned off too. Arc will still ask before pushing a branch or opening or merging a pull or merge request, and questions still come to you."
  - Buttons: **Skip all approvals** (styled as dangerous) and **Cancel**. Cancel is the default button, so pressing Enter or Escape cancels.
- Turning the switch off needs no confirmation and applies straight away.
- **Acceptance Criteria:**
  - [x] Given a session with Skip all approvals off, when the user turns its switch on in the session header, then the "Skip all approvals?" warning dialog appears and the switch stays off.
  - [x] Given the warning dialog is open, when the user clicks Cancel or presses Escape, then the dialog closes and the switch is still off.
  - [x] Given the warning dialog is open, when the user presses Enter, then the dialog closes and the switch is still off.
  - [x] Given the warning dialog is open, when the user clicks "Skip all approvals", then the dialog closes and the switch is on.
  - [x] Given Skip all approvals is on in a session, when the user turns its switch off, then it turns off at once without any dialog.

### 2.2. Making it the default for new sessions

- **As a** user, **I want to** make Skip all approvals the default, **so that** I don't have to turn it on in every session.
- Settings has a **Skip all approvals by default** switch, off to begin with. Turning it on opens the same kind of warning dialog, worded for new sessions: "Every new session will start with Skip all approvals on. …" followed by the same explanation as in 2.1.
- The New Session dialog has a **Skip all approvals** switch that starts in the state of the default. Turning it on there opens the warning dialog too. Turning it off there affects only the new session.
- Changing the default does not change sessions that already exist.
- **Acceptance Criteria:**
  - [x] When the user turns on "Skip all approvals by default" in Settings, then a warning dialog appears, and only after they confirm is the setting on.
  - [x] Given the default is on, when the user opens the New Session dialog, then its Skip all approvals switch is on.
  - [x] Given the default is on, when the user turns the switch off in the New Session dialog and starts the session, then that session has Skip all approvals off and the default in Settings is still on.
  - [x] Given the default is off, when the user turns on the switch in the New Session dialog, then the warning dialog appears before the switch turns on.
  - [x] Given an existing session with Skip all approvals off, when the user turns the default on in Settings, then that existing session still has it off.

### 2.3. Always visible while on

- **As a** user, **I want to** see at a glance when a session is skipping approvals, **so that** I never forget it is on.
- While it is on, the session header shows a red **Skipping approvals** marker that can't be hidden. Clicking it asks "Turn Skip all approvals off?" with **Turn off** and **Cancel**. Turn off works the same as turning the switch off.
- In the session list, a session with Skip all approvals on shows a small red marker next to its name.
- While Skip all approvals is on, the Auto-approve switch is shown as on and can't be changed, with the tooltip "Covered by Skip all approvals". When Skip all approvals is turned off, Auto-approve returns to how the user had it.
- **Acceptance Criteria:**
  - [x] Given Skip all approvals is on, when the user looks at the session header, then a red "Skipping approvals" marker is shown.
  - [x] Given Skip all approvals is on, when the user clicks the "Skipping approvals" marker and then Turn off, then the marker disappears and the switch is off.
  - [x] Given Skip all approvals is on, when the user clicks the "Skipping approvals" marker and then Cancel, then the marker is still shown and the switch is still on.
  - [x] Given Skip all approvals is on in one session and off in another, when the user looks at the session list, then only the first session shows the red marker.
  - [x] Given Auto-approve was off and Skip all approvals is turned on, when the user looks at the header, then Auto-approve shows as on and can't be changed, and when Skip all approvals is turned off, then Auto-approve shows as off again.

### 2.4. What happens while it is on

- **As a** user, **I want** agents to run every action without waiting for me, apart from questions and publishing my work, **so that** long tasks finish without me.
- Every permission the brain or a worker would have asked for is approved without asking. This covers:
  - commands and file changes outside the worker's working copy, including the user's own project checkouts and other workers' copies;
  - destructive commands;
  - installs for the whole machine;
  - network access and any other request for more access than the worker normally has;
  - tools from the user's connected tool servers that change something;
  - the brain's own commands that change files or git state (on a Claude or Codex brain; a Cursor brain keeps its current limits).
- Codex workers and the Codex brain run without their sandbox. Cursor and Claude workers are no longer blocked from editing the user's project folders, the knowledge folder or other workers' copies, so the session shows no "blocked" notes for those edits.
- Attachments stay read-only for Claude and Cursor workers: their edits there are refused, and a command that would change an attachment still asks in Needs attention. Arc can't stop a Codex worker without its sandbox from changing them, but they are Arc's own copies, so the user's original files are never touched.
- These still go to the user in Needs attention:
  - pushing a branch;
  - opening, merging or approving a pull or merge request;
  - the same actions done through a tool from one of the user's connected tool servers, such as a GitHub or GitLab tool that opens or merges a pull request, reviews one, pushes files, changes or deletes a file in a repository, or creates a branch;
  - questions from the brain, from workers, and from commands, including questions with choices;
  - Arc's own choice about unsaved changes when a repository gets its session branch.
- No macOS notification is sent for an approval that was skipped.
- Cursor workers' pushes now become a request in Needs attention. If the user's own Cursor settings would let a push run without asking, Arc keeps Cursor's pushes blocked instead, and the session shows: "W3 (Cursor) was blocked from pushing. Your Cursor settings allow pushes without asking, so Arc keeps them blocked; run the push from Review changes."
- The session's event history records each skipped approval, for example "Approved (skipping approvals): rm -rf build". The brain is told once when Skip all approvals is turned on or off, so it doesn't wait on approvals and knows pushes still go to the user.
- Plan-first sessions still show the plan and wait for the user to approve it. Skip all approvals covers permissions, not plans.
- **Acceptance Criteria:**
  - [x] Given Skip all approvals is on, when a worker runs a destructive command such as deleting a folder, then it runs without anything appearing in Needs attention, and the event history shows "Approved (skipping approvals):" followed by the command.
  - [x] Given Skip all approvals is on, when a Codex worker needs to write outside its working copy or use the network, then it does so without a request for more access appearing.
  - [x] Given Skip all approvals is on, when a Cursor worker edits a file in one of the user's project folders, then the edit is made and no "blocked" note appears in the session.
  - [x] Given Skip all approvals is on, when a worker uses a connected tool that changes something, then the tool runs without anything appearing in Needs attention.
  - [x] Given Skip all approvals is on and the brain runs on Claude or Codex, when the brain runs `git commit`, then it runs without a request.
  - [x] Given Skip all approvals is on, when a worker runs `git push`, then a permission request with Approve and Deny appears in Needs attention and the push does not run until the user approves.
  - [x] Given Skip all approvals is on, when a worker runs a command that opens a pull or merge request, then the request appears in Needs attention and the command does not run until the user approves.
  - [x] Given Skip all approvals is on, when a worker uses a GitHub tool from a connected tool server to open a pull request or push files, then the request appears in Needs attention and the tool does not run until the user approves.
  - [x] Given Skip all approvals is on, when a Cursor worker runs `git push` and the user's Cursor settings do not allow pushes on their own, then a push request appears in Needs attention.
  - [x] Given Skip all approvals is on and the user's Cursor settings allow pushes without asking, when a Cursor worker runs `git push`, then the push does not run and the session shows the "blocked from pushing" note.
  - [x] Given Skip all approvals is on, when a Claude worker tries to edit an attachment, then the edit is refused.
  - [x] Given Skip all approvals is on, when a Claude worker runs a command that deletes an attachment, then a permission request appears in Needs attention.
  - [x] Given Skip all approvals is on, when a worker asks a question, then the question goes to the brain and, if the brain can't answer it, appears in Needs attention as today.
  - [x] Given Skip all approvals is on, when a command asks a question with choices, then it appears in Needs attention with its choices.
  - [x] Given Skip all approvals is on in a Plan-first session, when the brain proposes a plan, then nothing runs until the user approves the plan.
  - [x] Given Skip all approvals is on and Arc is not the front app, when a worker's protected action is approved by Skip all approvals, then no macOS notification appears.

### 2.5. Turning it on or off mid-session

- **As a** user, **I want** the change to apply straight away, **so that** I don't have to restart work to get the effect.
- Turning Skip all approvals on approves, at once, every permission request already waiting in the session, except pushes and pull or merge requests. Waiting questions stay.
- Permission requests are approved, or ask again, from the very next request. Sandbox and editing limits change from each agent's next turn: a turn already running finishes with the limits it started with, and the agent then carries on with the new ones, without losing what it has done. The event history line for the change says so. A worker the user has stepped in on gets it only after hand-back. While the user is in control, approvals still appear in that worker's terminal with Approve and Deny, as today.
- Turning Skip all approvals off works the same way in reverse. From the next request, the brain and workers ask again as they did before it was turned on, and their sandbox and editing limits return from their next turn.
- **Acceptance Criteria:**
  - [x] Given two permission requests and one question are waiting, when the user turns Skip all approvals on and confirms, then both permission requests are approved, the question is still waiting, and the heading reads "Needs attention · 1".
  - [x] Given a push request is waiting, when the user turns Skip all approvals on and confirms, then the push request is still waiting.
  - [x] Given a worker is mid-task, when the user turns Skip all approvals on, then the worker continues its task without losing its progress, and its next protected action runs without asking.
  - [x] Given the user has stepped in on W1, when they turn Skip all approvals on and W1 wants to delete a folder, then Approve and Deny appear in W1's terminal, and after the user hands W1 back, then its next protected action runs without asking.
  - [x] Given Skip all approvals is on and a worker is running, when the user turns it off, then the worker's next protected action appears in Needs attention.

### 2.6. Closing and resuming

- **As a** user, **I want** a session to keep its setting when I reopen it, **so that** it behaves the same way it did before.
- A session's Skip all approvals setting is kept when the app is closed and when the session is resumed. A resumed session with it on shows the red marker straight away and carries on without asking again, so a long autonomous run can resume unattended.
- **Acceptance Criteria:**
  - [x] Given a session with Skip all approvals on, when the user quits Arc, reopens it and resumes the session, then the header shows the red "Skipping approvals" marker, the switch is on, and no warning dialog appears.

---

## 3. Scope and Boundaries

### In-Scope

- A Skip all approvals switch in the session header, a default in Settings, and a switch in the New Session dialog.
- A confirmed warning dialog every time it is turned on.
- A red marker in the session header and in the session list while it is on; Auto-approve shown as covered.
- Skipping every permission for the brain and all workers on Claude, Codex and Cursor, including lifting Codex's sandbox and Cursor's blocked edits.
- Pushes, pull or merge requests, questions and the unsaved-changes choice still reaching the user.
- Applying the change straight away mid-session, including approving waiting permission requests.
- Event history entries for skipped approvals, and the setting kept across closing and resuming.

### Out-of-Scope

- Skipping approvals for a single worker instead of the whole session.
- Skipping plan approval in Plan-first mode (use Autonomous mode instead).
- Pushing branches or opening or merging pull or merge requests without asking.
- Changing how Auto-approve, "Always allow this in this session" rules, or the brain answering requests work when Skip all approvals is off.
- Any effect on Claude Code, Codex or Cursor used in the terminal outside Arc.

---

## Verification

Verified 2026-11-16 by /awos:verify. All 37 criteria are met.

- **On-screen criteria (2.1, 2.2, 2.3, 2.6)** were checked in the real Electron app with fake CLIs. The run covered: the switch and its warning, the Settings default and the New Session switch, the header and sidebar markers, the marker's Turn off and Cancel, Auto-approve shown on and locked and then off again, an existing session left off when the default is turned on, and a session kept on after a restart. The user confirmed the look from these screenshots:
  - `docs/screenshots/015-skip-all-approvals-warning-dialog.png`
  - `docs/screenshots/015-skip-all-approvals-on-header.png`
  - `docs/screenshots/015-skip-all-approvals-auto-approve-locked.png`
  - `docs/screenshots/015-skip-all-approvals-turn-off-dialog.png`
  - `docs/screenshots/015-skip-all-approvals-switched-off.png`
  - `docs/screenshots/015-skip-all-approvals-settings-default-on.png`
  - `docs/screenshots/015-skip-approvals-header-marker.png`
- **Behaviour while on and mid-session (2.4, 2.5)** was checked in the real app with fake CLIs. All 26 tests passed across `sessions-approvals`, `skip-approvals-asks`, `skip-approvals-claude`, `skip-approvals-default`, `codex-workers` and `cursor-approvals`. They cover:
  - the event text and the sweep;
  - pushes and pull requests still asking, both as commands and through tool-server tools;
  - questions, Plan-first and notifications;
  - the Codex sandbox, the Cursor deny file and blocked-push note, and the Claude restart;
  - a stepped-in worker and turning it off.
- **Decision-layer cases** were checked by unit tests (374 passed, `attention-allow`, `classify`, `attention-terminal`, `claude-args`, `worker-skip-relaunch`, `session-service`). They cover: the brain's `git commit`, `gh pr create` and `glab mr merge` still asking, choice questions, the sweep of two permissions with a question left waiting, and an attachment delete still asking.
- **Cursor push asking** without the deny entry was shown by real check K4 (`real-turns.md`).
- **Claude attachment edit refused** was accepted by the user on indirect evidence: the attachments entry stays in `--disallowedTools` under skip (`claude-args.test.ts`, the argv checks in `skip-approvals-claude.spec.ts`), and real check K5 showed that these launch arguments are what allow or stop an edit.

## Change Log

- 2026-11-15 — /awos:tech findings and user decisions — Pushes and pull or merge requests done through connected tool servers (GitHub, GitLab) now ask too, not only shell commands; creating a branch through such a tool asks as well. Cursor pushes, which were silently blocked before, now ask, unless the user's own Cursor settings would let them through, in which case they stay blocked with a note. Attachments stay read-only for Claude and Cursor workers, including against commands. The brain is told once when the switch changes, rather than "as for Auto-approve" (it is not told about Auto-approve). A Cursor brain keeps its current limits. Sandbox and editing limits change from each agent's next turn, while approvals change from the next request, because a running turn keeps the limits it started with.
