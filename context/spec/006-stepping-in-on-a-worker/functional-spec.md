# Functional Specification: Stepping In on a Worker

- **Topic:** Letting the user take over a running worker in its terminal tab, talk to it directly, and hand it back to the brain.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Today the user can watch any worker's terminal in Arc, but can't touch it. When a worker heads the wrong way, gets stuck on something the user could explain in one sentence, or needs a quick hands-on correction, the user's only options are to tell the brain and hope the message gets passed on correctly, or to stop the worker and lose its progress.

This spec lets the user step in. From a worker's terminal tab they click **Step in**: the worker stops what it's doing and the tab becomes a live conversation with that worker, in its own working copy, with everything it has done so far. The user types directly to it, the same way they would in Claude Code in a terminal. When they're done they click **Hand back**, and the worker carries on with its task by itself, aware of what the user did. The brain is kept informed throughout and waits instead of interfering.

**Success looks like this:**

- The user can correct a worker directly without stopping it and starting over.
- Taking over and handing back each take one click.
- The worker keeps all its progress and conversation across the takeover.
- Arc's protections still apply while the user is in control: risky actions still ask first.
- The brain never talks over the user or acts on a worker the user is controlling.

---

## 2. Functional Requirements (The "What")

### 2.1. Stepping in

- A worker's terminal tab gets a **Step in** button next to Details. The worker's details have the same button.
- Step in is offered only while the worker is still in progress: starting, working, or waiting on a question or approval. A worker that is queued because the worker limit is full hasn't started yet, so it can't be stepped in. Finished, merged, stopped and failed workers don't offer it.
- Clicking Step in interrupts the worker's current step at once. Edits it has already made stay in its working copy.
- The tab then becomes interactive. The worker's earlier output stays above, followed by a line "You stepped in" and a prompt where the user types. The worker's replies, the tools it uses and their results appear in the tab as they happen, as in Claude Code in a terminal.
- While the user is in control, the worker's card and its tab show "You're in control", and the event log records "You stepped in on W1 api-retry".
- If the worker was waiting on a question or approval when the user stepped in, that item leaves Needs attention and the worker's question is shown in the terminal for the user to answer there.
- **Acceptance Criteria:**
  - [x] Given a worker that is working, when the user opens its terminal tab and clicks Step in, then the worker stops its current step, the tab shows "You stepped in" with a prompt to type at, and the card shows "You're in control".
  - [x] Given a worker that has finished or merged, when the user opens its terminal tab, then no Step in button is shown.
  - [x] Given the worker had edited a file before the user stepped in, when the user steps in, then that edit is still in the worker's working copy.
  - [x] Given a worker is waiting on a question in Needs attention, when the user steps in on it, then the question leaves Needs attention and appears in the worker's terminal for the user to answer there.
  - [x] When the user steps in on a worker, then the event log shows "You stepped in on" followed by the worker's name.

### 2.2. Working with the worker

- The user types messages and presses Enter to send them. The worker answers with the full memory of its task and everything it did before the takeover, in its own working copy.
- The user can interrupt the worker's reply with Escape, as in Claude Code.
- The user's own slash commands work here as they do in the message box.
- Arc's approval rules still apply. Pushing, opening merge requests, destructive commands, global installs and writing outside the working copy still ask before running. While the user is in control, the question appears right in the terminal with Approve and Deny, not in Needs attention, and the brain never answers it.
- **Acceptance Criteria:**
  - [x] Given the user has stepped in, when they type "What have you changed so far?" and press Enter, then the worker's answer appears in the tab and refers to its earlier work.
  - [x] Given the user has stepped in, when the worker tries to push a branch, then the terminal shows the exact push command with Approve and Deny, nothing is added to Needs attention, and the push does not run until the user approves.
  - [x] Given the worker is replying, when the user presses Escape, then the reply stops and the prompt returns.

### 2.3. The brain while the user is in control

- The brain is told when the user steps in and when they hand back.
- While the user is in control, messages the brain sends that worker are held and delivered after hand-back. The brain can't merge or stop that worker meanwhile, and is told why if it tries.
- Other workers and the brain carry on as normal. The user can still chat with the brain in the Brain tab.
- **Acceptance Criteria:**
  - [x] Given the user is in control of W1, when the brain sends W1 a message, then nothing appears in the user's terminal, and after hand-back the worker receives that message.
  - [x] Given the user is in control of W1, when another worker finishes, then that worker is merged as usual.

### 2.4. Handing back

- The tab has a **Hand back** button while the user is in control.
- Clicking Hand back returns the tab to watch-only, the card leaves "You're in control", and the worker continues its original task, taking into account what the user said and changed. The brain is told the user handed back, with a short summary of what changed.
- The event log records "You handed W1 api-retry back".
- **Acceptance Criteria:**
  - [x] Given the user is in control of a worker, when they click Hand back, then the tab becomes watch-only again, the card shows the worker working, and the worker continues its task.
  - [x] Given the user told the worker "use 5 retries, not 3" before handing back, when the worker carries on, then its later work uses 5 retries.
  - [x] When the user hands a worker back, then the event log shows "You handed" followed by the worker's name and "back".

### 2.5. Leaving while in control

- Closing the worker's tab while in control asks: "Hand W1 · api-retry back to the brain?" with **Hand back**, **Keep it paused** and **Cancel**.
  - Hand back acts like the Hand back button.
  - Keep it paused closes the tab. The worker stays paused and "You're in control" stays on its card until the user reopens the tab and hands it back or carries on.
  - Cancel leaves the tab open.
- If Arc quits or the session is closed while the user is in control, the worker stays paused. When the session reopens, its card shows "You're in control (paused)" and opening its tab lets the user carry on or hand it back.
- **Acceptance Criteria:**
  - [x] Given the user is in control of W1, when they close its tab, then they see "Hand W1 · api-retry back to the brain?" with Hand back, Keep it paused and Cancel.
  - [x] Given that question, when the user picks Keep it paused, then the tab closes and the card still shows "You're in control".
  - [x] Given the user quit Arc while in control of W1, when they reopen the session, then W1's card shows "You're in control (paused)" and its tab offers Hand back.

---

## 3. Scope and Boundaries

### In-Scope

- Step in and Hand back for in-progress workers, in the worker's terminal tab in Arc.
- Typing to the worker with its full history, in its own working copy.
- Arc's approval rules shown in the terminal while the user is in control.
- The brain being told, and holding its messages and actions for that worker until hand-back.
- Closing the tab or quitting while in control.

### Out-of-Scope

These are planned as later specs (see the product definition):

- Stepping in on the brain's own conversation.
- Opening a worker in macOS Terminal instead of Arc.
- Starting a new interactive worker by hand, without the brain.
- A plain command-line shell in a worker's working copy.

---

## Change Log

- 2026-10-19 — user decision during /awos:tech — Step in is not offered for queued workers. Arc has no separate "waiting for another worker's changes" state; a queued worker is waiting for a free worker slot and has nothing running to take over yet.
- 2026-10-19 — user decision after /awos:verify — the event log text is "W1 api-retry" without the middle dot, matching the existing event log convention; the card, tab and close dialog keep "W1 · api-retry".
