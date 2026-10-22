# Functional Specification: Sessions with a Brain and Workers

- **Topic:** The session screen, where the user chats with a brain agent that plans the work, starts worker agents across the group's projects, and brings their results back together.
- **Status:** Draft
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Today, Arc can hold a group's projects and knowledge, but the user can't do anything with an agent yet. To ask a question or fix a bug across several repositories, the user still opens one terminal per repository and re-explains the context in each.

Sessions fix that. The user opens a session on a group and writes one request. A "brain" agent reads the group's projects and knowledge, splits the work into tasks, and starts worker agents for them. Each worker gets its own separate working copy of the code, so workers never step on each other or on the user's own work. The brain watches the workers and answers their questions when it can. It brings their finished work together on one session branch per project, and only interrupts the user when it has to.

**Success looks like this:**

- A request that touches several repositories is typed once, and the user never has to paste context from another folder.
- The user can always see what every worker is doing, without opening a terminal.
- Anything that needs the user shows up as "Needs attention" and is never lost, even if the app is closed and reopened.
- A previous session reopens with its conversation, workers and pending requests intact within 10 seconds.

This spec covers the core loop:

- starting a session and chatting with the brain;
- plan-first and autonomous workers, with live worker cards;
- Needs attention;
- merging into the session branch;
- watching a worker's terminal;
- resuming a session.

Each of these comes later in a spec of its own:

- automatic model choice driven by usage, with usage gauges;
- Codex as a second provider;
- stepping into a worker's terminal;
- reviewing the combined changes;
- the brain's suggestions for notes after a session.

---

## 2. Functional Requirements (The "What")

### 2.1. Sessions in a group

- Each group has a **Sessions** tab, placed before Projects, Notes and Docs in the section navigation. It opens by default when the user picks a group. The tab lists the group's sessions, newest first. Each entry shows:
  - the session's name;
  - when it was last active;
  - a status: Working, Needs attention, Idle, or Stopped.
- The user starts a session with a "New Session" button. The dialog asks for:
  - **Request:** the first message to the brain. This is required.
  - **Mode:** Plan-first or Autonomous. The default is Plan-first.
  - **Worker limit:** how many workers may run at once in Autonomous mode, from 1 to 6. The default is 3.
- The brain names the session from the request in a few words, for example "Fix order sync retries". The user can rename it.
- A group with no projects can still have a session, for questions about its knowledge only. In that case the brain explains that it can't start workers that change code.
- **Acceptance Criteria:**
  - [ ] When the user selects a group, then the Sessions tab is the first tab and is already open.
  - [ ] When the user opens the New Session dialog and clicks Start with an empty request, then "Enter a request for the brain." appears in red under the request box and no session is created.
  - [ ] When the user starts a session in the "Storefront" group with the request "Why is the orders report slow?", then the session screen opens, the request appears as the first message, and the session appears at the top of Storefront's Sessions tab.
  - [ ] Given a session has started, when the brain has replied, then the session has a short name of a few words based on the request instead of "New session".
  - [ ] Given a session exists, when the user renames it to "Orders report", then the new name shows in the session header and in the session list.

### 2.2. The session branch

- Starting a session creates a new session branch in each project of the group that is a git repository. The branch is named after the session, for example "arc/fix-order-sync", and starts from "dev", or from the repository's main branch if it has no "dev" branch.
- The session branch is checked out in the user's own copy of each repository, so the user can look at the combined work in their own editor.
- Before switching a repository to the session branch, Arc checks for unsaved changes in it. If there are any, Arc asks the user what to do:
  - **Set aside:** put the changes away, so they can be brought back later.
  - **Commit them first:** save them as a commit on the current branch.
  - **Bring them along:** keep them on the session branch.
  - **Cancel:** don't start the session.

  Arc never throws the user's changes away.
- Projects that are not git repositories can be read by the brain and workers, but no workers will change them. The session header shows them as "Read only".
- Reopening a session switches its repositories back to its session branch, with the same check for unsaved changes.
- Arc never pushes a branch, opens a pull request or merge request, or merges into "dev" on its own. A worker may push or open a merge request only when the user approves that exact command in Needs attention (see 2.7). The brain can never approve it.
- **Acceptance Criteria:**
  - [ ] Given the group's "api" repository has a "dev" branch, when the user starts a session named "Fix order sync", then the session header shows "arc/fix-order-sync ← dev" and the user's own api folder is on that branch.
  - [ ] Given a repository has no "dev" branch, when a session starts, then its session branch starts from the repository's main branch and the header shows that branch's name after the arrow.
  - [ ] Given the user's web repository has unsaved changes, when they start a session, then a dialog names the web repository and offers Set aside, Commit them first, Bring them along, and Cancel.
  - [ ] Given that dialog is open, when the user clicks Cancel, then no session is created and every repository stays on the branch it was on, with the changes still in place.
  - [ ] Given a group has a project folder that is not a git repository, when a session starts, then that project shows as "Read only" in the session header.

### 2.3. The session screen

- The screen fits the window and never grows taller. Each panel scrolls on its own. It has these parts:
  - **Header:**
    - the group's name and the session's name;
    - the session branch;
    - the "Needs attention" badge, shown only when something is waiting;
    - the mode and worker limit, for example "Autonomous · Limit 3";
    - the brain model: "Brain · Sonnet" by default, changeable to another Claude model (see 2.5);
    - the worker model: "Workers · Auto" or a specific model (see 2.5).
  - **Conversation:** the chat with the brain, with a message box at the bottom. It takes the left and center of the screen.
  - **Agents:** on the right, a card for the brain and one card per worker.
  - **Event log:** a running, time-stamped list of what happened, for example "14:03 started W1 api-retry". It is under the agent cards.
- Every element uses the Arc HUD look from the design-system spec. The brain is shown as the ring logo, which turns while the brain is thinking and holds still when it is idle. Reduce Motion turns that movement off.
- **Acceptance Criteria:**
  - [ ] When the user opens a session, then the header, conversation, agent cards, and event log are all visible at once in a 1100 by 720 window.
  - [ ] Given a conversation longer than the screen, when the user scrolls it, then only the conversation moves and the header, agent cards, and event log stay in place.
  - [ ] Given 6 workers, when the user scrolls the agent cards, then only the agent cards move.
  - [ ] Given the brain is replying, when the user looks at the brain card, then it says "Thinking" and its ring turns, and given Reduce Motion is on, the ring holds still while "Thinking" still shows.

### 2.4. Chatting with the brain

- The user types in the message box. Enter sends the message, and Shift+Enter starts a new line.
- The brain's reply appears word by word as it is written.
- While the brain is replying, a Stop button replaces Send. Stop ends the reply and keeps what was written so far, marked "Stopped".
- File names, paths, and code in messages show in the monospace font. Code blocks have a Copy button.
- The user can keep chatting while workers run. Messages are sent to the brain, not to the workers.
- The brain reads freely: it can read files, search the web, and run read-only shell commands in the group's projects, such as `git -C <path> diff`, including on the user's uncommitted changes. It never edits files itself. A command that changes files or git state in the user's checkouts goes to the user for approval (see 2.7). For real changes the brain starts a worker, which works in a separate working copy created from the session branch and does not see the user's uncommitted edits.
- If Claude Code is not installed or not signed in, the conversation shows a banner that says exactly what to do. For example: "Claude Code isn't signed in. Open Terminal, run claude, and sign in, then click Retry."
- **Acceptance Criteria:**
  - [ ] When the user types a message and presses Enter, then it appears in the conversation and the brain card changes to "Thinking".
  - [ ] When the user presses Shift+Enter in the message box, then a new line starts and nothing is sent.
  - [ ] Given the brain is replying, when the user clicks Stop, then the reply stops growing, is marked "Stopped", and Send comes back.
  - [ ] Given Claude Code is not signed in, when the user sends a message, then the banner explains how to sign in and offers Retry, and the message is kept so it can be sent again.
  - [ ] When the brain's reply contains a code block, then the block is in the monospace font with a Copy button, and when the user clicks Copy, then "Copied" shows briefly.

### 2.5. Plans (Plan-first mode)

- In Plan-first mode, before any worker starts, the brain posts a plan card in the conversation. For each worker it intends to start, the card shows:
  - its short name, for example "api-retry";
  - what it will do, in one or two sentences;
  - which projects it will work in;
  - the model chosen for it.
- **Model choice:** the brain picks a Claude model for each worker based on how hard its task is. For example, it uses a lighter model to look things up and a stronger one for complex changes.
  - The user can change the model for any worker on the plan card. The choices are the Claude models the user's subscription offers.
  - The user can also set one model for all workers from the header. "Auto" leaves the choice to the brain, and a specific model overrides it for every new worker.
  - The brain itself runs on Sonnet by default. The user can switch it to another Claude model from the header, for example Opus when the planning is hard. The new brain model applies from the brain's next reply; a reply in progress finishes on the old model.
  - The user's choice always wins over the brain's.
- The plan card has three buttons:
  - **Approve:** starts the workers.
  - **Ask for changes:** puts the cursor in the message box, so the user can tell the brain what to change. The brain then posts a revised plan.
  - **Reject:** tells the brain to stop with no workers.
- Nothing runs and no project files change until the user approves.
- After approval, workers change files and run commands freely, except for what still needs permission (see 2.7).
- The user can switch the session between Plan-first and Autonomous from the header. The new mode applies to the brain's next set of workers.
- **Acceptance Criteria:**
  - [ ] Given a Plan-first session, when the brain proposes work, then a plan card lists each worker's name, task, projects, and model, and no worker card appears yet.
  - [ ] Given a plan card, when the user changes one worker's model and clicks Approve, then that worker's card shows the chosen model.
  - [ ] Given a plan card, when the user clicks Ask for changes and writes "Use one worker, not two", then the brain posts a new plan, and the old card is marked "Replaced" with its buttons disabled.
  - [ ] Given the brain is replying, when the user changes "Brain · Sonnet" to Opus in the header, then the current reply finishes, the header shows "Brain · Opus", and the brain's next reply comes from Opus with the earlier conversation remembered.
  - [ ] Given the worker model is set to a specific model in the header, when the brain proposes a plan, then every worker on the plan card uses that model.
  - [ ] Given a running session in Plan-first mode, when the user switches it to Autonomous in the header, then the header shows "Autonomous", running workers carry on, and the brain's next workers start without a plan card.
  - [ ] Given a plan card, when the user clicks Reject, then no workers start and the card is marked "Rejected".

### 2.6. Workers

- In Autonomous mode, the brain starts workers on its own, up to the worker limit. Extra workers wait as "Queued" cards and start when a running one finishes.
- Each worker card shows:
  - an ID and name, for example "W1 · api-retry";
  - its model;
  - its status, with the status word always shown next to its color.
- The statuses are:
  - **Queued** (dim)
  - **Starting** (cyan)
  - **Working** (cyan), with a one-line note of what it is doing right now, for example "Running tests in api"
  - **Needs approval** (amber)
  - **Has a question** (amber)
  - **Done** (green)
  - **Merged** (green)
  - **Failed** (red), with a short reason
  - **Stopped** (dim)
- A worker card's Details button opens its details:
  - the task it was given;
  - its latest progress report;
  - the files it has changed so far;
  - its working-copy location;
  - a Stop button while the worker runs, and a Remove button once it has finished.

  Stopping a worker asks for confirmation and ends it. Arc removes its working copy, so any commits that are not yet in the session branch are discarded. When there are such commits, the confirmation says how many. A worker the user stopped cannot be continued. A worker that stopped because Arc quit or crashed keeps its working copy and can be continued (2.10).
- A finished worker (Done, Merged, Failed or Stopped) can be removed from the session with its Remove button. The card disappears, any working copy it still has is deleted, and the event log keeps its history. Removing a Done worker that is not merged yet asks for confirmation first, because its commits are discarded. A Queued or running worker cannot be removed; it is stopped first.
- When a worker finishes, it reports a short summary, and the brain posts that summary in the conversation.
- If a worker crashes or exits unexpectedly, its card turns Failed. The brain is told, and it says in the conversation what it will do, for example retry or carry on without that work.
- **Acceptance Criteria:**
  - [ ] Given an Autonomous session with a limit of 2, when the brain wants 3 workers, then 2 cards show Working and the third shows Queued until one of the first two finishes.
  - [ ] When the user looks at any worker card, then its status is shown as a word, not just a color.
  - [ ] When the user clicks a worker card's Details button, then its details show the task, latest report, changed files, and a Stop button.
  - [ ] Given a running worker, when the user clicks Stop and confirms, then its card shows Stopped, its working copy is deleted, and the event log records "Stopped by you; working copy removed".
  - [ ] Given a running worker with commits that are not in the session branch, when the user clicks Stop, then the confirmation states how many commits will be discarded, and the event log records "(N unmerged commits discarded)".
  - [ ] Given a worker is Done, Merged, Failed or Stopped, when the user clicks Remove (and confirms, if it is Done but not merged), then its card disappears and the event log records "Removed W1 api-retry".
  - [ ] Given a worker is Queued or running, when the user looks at its card, then there is no Remove button, and Stop is offered instead.
  - [ ] Given a worker exits unexpectedly, when the user looks at its card, then it shows Failed with a reason, and the brain posts what it will do next.

### 2.7. Approvals and questions

- Workers run ordinary commands without asking. When a worker has a question, it pauses and the question goes to the brain first. When a worker wants to do one of the things listed below that only the user may approve, it pauses and the request goes straight to the user, and the brain is told.
- The brain answers what it can from the plan, the group's knowledge, or other workers' results. It notes each answer in the event log, for example "W2 question answered by brain".
- The brain must pass these to the user and can't approve them itself:
  - anything that would change files outside the worker's own working copy (reading files outside it, and writing in the system temp folder, is not protected and needs no approval);
  - anything that leaves the user's machine, such as pushing a branch;
  - destructive commands, such as deleting branches, a hard reset, force operations, or deleting folders;
  - installing software for the whole machine, such as with Homebrew or a global package install.
- Requests the brain passes on use the "Needs attention" badge and dialog from the design system. In the dialog:
  - **Permission cards** show the worker, the exact action in monospace, and the brain's reason for passing it on, with Approve and Deny buttons, and an "Always allow this in this session" button. That button approves the request and remembers a rule for the rest of the session: the same kind of action with the same command (such as `git push` or `curl`) and, for a change outside the working copy, the same folder and the folders below it. Later matching requests are approved on their own, with an event "Allowed by your rule: git push" and no card. The session header lists the rules so they can be removed.
  - **Auto-approve** is a toggle in the session header, off by default. While it is on, every protected request is approved without asking and the event log records "Auto-approved: <command>". Pushes and merge or pull requests (`git push`, `gh pr …`, `glab mr …`, and any `gh` or `glab` command that creates or merges) still always ask. Turning it on, or adding a rule, also approves the requests already waiting that it covers.
  - **Question cards** show the question and an answer box with a Send button.
  - The waiting worker's card turns amber. Clicking it opens the dialog with that worker's request first.
- The brain can ask the user its own questions the same way.
- **The brain's own shell commands.** "Read freely, ask for changes."
  - Read-only commands run without any request, anywhere: `git diff`, `git log`, `git status`, `git show`, `git blame`, `git branch --list`, `git rev-parse`, `git ls-files`, `grep` and `rg`, `ls`, `cat`, `head`, `tail`, `wc`, `find` (without `-delete` or `-exec`), `jq`, and `npm ls` or `npm view`. Writing in the system temp folder needs no request either.
  - Anything that changes files or git state in the user's checkouts goes to the user: `git commit`, `checkout`, `switch`, `merge`, `rebase`, `cherry-pick`, `stash` (other than `list` or `show`), `reset`, `restore`, `add`, `rm`, `mv`, creating, deleting or renaming a branch or tag, `worktree add` or `remove`, `pull`, `fetch`, a local install such as `npm install`, a test runner (it can write caches), and any command Arc can't read as read-only, such as `node -e`. The card says "may change files or git state in your checkouts". Installs for the whole machine, destructive commands and anything that leaves the machine keep their own reasons, as for workers.
  - These requests show in Needs attention as from "Brain", straight away (the brain can't approve its own), and the brain card shows Waiting until the user answers. Approve lets the command run, Deny tells the brain the user refused, and the brain carries on.
  - Auto-approve covers these requests, like the other protected kinds. Pushes and merge or pull requests still always ask. "Always allow this in this session" works for them too (the rule is the same kind of command, such as `git commit`).
- The user's answer goes back to the worker, which resumes, and the badge count goes down.
- Pending requests are kept when the app is closed, and they show again when the session is reopened. The workers stay paused until they are answered.
- When Arc is not the front app, each new request also shows a macOS notification. Clicking the notification opens the session with the dialog open.
- Sessions with pending requests show "Needs attention" in the session list, and their group shows an amber dot in the sidebar.
- **Acceptance Criteria:**
  - [ ] Given a worker asks a question the brain can answer from the group's notes, when the brain answers it, then the worker continues, the event log records the answer, and the badge doesn't appear.
  - [ ] Given a worker wants to run "git push origin arc/fix-order-sync", when the brain passes it on, then the badge shows "Needs attention 1" and the worker card shows Needs approval in amber.
  - [ ] Given a worker wants to install a tool with Homebrew, when it asks, then the brain passes it to the user instead of approving it, even if the plan mentions that tool.
  - [ ] Given that request, when the user clicks the badge and then Approve, then the dialog closes, the badge disappears, and the worker returns to Working.
  - [ ] Given a pending question, when the user types an answer and clicks Send, then the answer appears in the event log and the worker resumes.
  - [ ] Given a pending request, when the user denies it, then the worker is told it was denied, keeps going without it, and the event log records "Denied by you".
  - [ ] When a worker only reads files outside its working copy (for example `grep` in `/tmp/w1-dl`), then it runs without any request.
  - [ ] When a worker writes a file in the system temp folder, then it runs without any request, and when it writes anywhere else outside its working copy, then the request still goes to the user.
  - [ ] When the user clicks "Always allow this in this session" on a permission card, then the worker resumes and the session header lists a rule for that command.
  - [ ] When a worker later makes a request that matches a rule, then it is approved without a card and the event log shows "Allowed by your rule: <rule>".
  - [ ] When the user removes a rule from the session header, then the next matching request asks again.
  - [ ] When the user turns Auto-approve on, then protected requests are approved on their own and the event log shows "Auto-approved: <command>".
  - [ ] When Auto-approve is on and a worker runs `git push`, `gh pr create` or `glab mr merge`, then the request still goes to the user.
  - [ ] When the user turns Auto-approve on or adds a rule while requests are waiting, then the waiting requests it covers are approved and the badge count goes down.
  - [ ] Given the user asks the brain what changed in a file in their checkout, when the brain runs `git diff`, then the answer arrives without an approval; and when the brain tries to commit, then Needs attention asks the user.
  - [ ] Given the brain asks to run `git commit -am x`, then the request shows as from "Brain" with the brain card on Waiting, and when the user approves, then the command runs and the brain continues; when the user denies, then the brain is told and carries on.
  - [ ] When Auto-approve is on and the brain runs `git commit`, then it runs without a card, and when the brain runs `git push`, then the request still goes to the user.
  - [ ] Given a pending request, when the user quits Arc and opens the session again, then the badge and the request are still there and the worker is still paused.
  - [ ] Given Arc is in the background, when a new request is passed on, then a macOS notification appears, and when the user clicks it, then Arc comes to the front with the Needs attention dialog open.

### 2.8. Bringing work together

- When a worker is Done, Arc merges its work into the session branch by itself, one worker at a time per repository. The card then turns Merged, and Arc tells the brain, for example "Merged W1 api-retry into arc/order-sync automatically." The brain can still ask for a merge again if one failed.
- If two workers changed the same lines, the brain resolves the conflict and notes it in the event log, for example "Resolved conflict in api/src/sync/queue.ts". The brain asks the user through Needs attention only when it isn't confident in its resolution. Every other resolved conflict is listed in the final summary.
- When one worker needs a change another worker made, the brain first merges that change into the session branch. It then brings the change into the waiting worker's working copy and tells that worker what changed. The event log records it, for example "Shared W1 → W3: retry_status column".
- After a worker's work is merged, its separate working copy is removed.
- When all the work is merged, the brain posts a final summary in the conversation:
  - what changed, per repository;
  - the commits on the session branch;
  - anything left undone.
- **Acceptance Criteria:**
  - [ ] Given a worker finishes its task, when it becomes Done, then Arc merges it without being asked, the card shows Merged, and the event log records the merge into the session branch.
  - [ ] Given a worker was merged automatically, when the brain is told, then the message names the worker and the session branch and says the merge was automatic.
  - [ ] Given two workers changed the same file, when the second is merged, then the event log names the file and says the conflict was resolved, and the session branch contains both workers' changes.
  - [ ] Given a conflict the brain can't resolve, when it is reached, then a Needs attention question names the file and describes the two changes.
  - [ ] Given W3 needs a change made by W1, when the brain shares it, then the event log shows "Shared W1 → W3" and W3 continues with the change in place.
  - [ ] Given every worker is Merged, when the brain finishes, then the conversation shows a summary listing the changes and commits per repository.

### 2.9. Watching a worker's terminal

- The conversation area has tabs. The first tab, "Brain", is the conversation with the brain and is always there.
- Clicking a worker card opens that worker's terminal in its own tab next to "Brain", named after the worker (for example "W1 · api-retry"), and switches to it. Clicking the card again switches to the existing tab. Each worker tab has a close button, and closing it returns to "Brain".
- A card that needs the user (amber) still opens Needs attention instead. Each card also has a small Details button that opens the worker's details (task, latest report, changed files, working-copy location, Stop); the terminal tab has the same Details button.
- The terminal tab shows the worker's live output. The user can scroll back through everything the worker has printed since it started.
- In this spec, the terminal is for watching only; typing into it does nothing.
- **Acceptance Criteria:**
  - [ ] Given a working worker, when the user clicks its card, then a "W1 · api-retry" tab opens next to "Brain" showing its live output, and new lines appear as the worker prints them.
  - [ ] Given two worker tabs are open, when the user clicks "Brain", then the conversation shows again, and when the user closes a worker tab, then the conversation shows and the other tab stays.
  - [ ] Given a worker card, when the user clicks its Details button, then the worker's details open and its terminal tab does not open.
  - [ ] Given a terminal tab is open, when the user types, then nothing is sent to the worker.
  - [ ] Given a worker that has finished, when the user opens its terminal, then its full output from start to finish is shown.

### 2.10. Resuming sessions

- Every session is saved as it goes. This includes the conversation, worker cards and their reports, the event log, and pending requests.
- Opening a session from the list shows it as it was left, and the user can keep chatting.
- When Arc quits with workers running, it stops them cleanly and marks them "Stopped" (event "Stopped when Arc quit"). After a crash or a forced kill the event reads "Stopped when Arc closed unexpectedly". It keeps their working copies so they can be continued.
- When the user reopens such a session, the brain asks in the conversation, for example: "2 workers were stopped when Arc closed. Continue them?" It offers Continue and Not now. Not now leaves the workers Stopped, and the user can continue each one later from its card.
- The user can delete a session from the list. The confirmation says that its session branches are kept in the repositories, and that any unmerged worker working copies will be removed.
- **Acceptance Criteria:**
  - [ ] Given a session with a conversation, 3 workers and the event log, when the user quits and reopens Arc and opens the session, then everything shows as it was within 10 seconds.
  - [ ] Given a reopened session, when the user sends a follow-up question, then the brain answers with knowledge of the earlier conversation.
  - [ ] Given workers were running when Arc quit, when the user reopens the session, then those workers show Stopped and the brain asks whether to continue them, and when the user clicks Continue, then they return to Working.
  - [ ] When the user deletes a session and confirms, then it disappears from the list, and its session branches still exist in the repositories.

### 2.11. Group changes reach open sessions

- Changes to the group take effect in its open sessions without restarting Arc:
  - **A project added to the group** joins every open session of that group. Arc creates the session's branch in it (for example "arc/fix-order-sync") with the same check for unsaved changes as at session start, adds it to the session header, and tells the brain it can now read it and start workers in it.
  - **A project removed from the group** shows as "Removed" in the session header. The brain is told, and no new workers can start in it. Work already merged and its review history stay.
  - **A project moved to a new folder** is used at its new location by the brain and by workers started afterwards.
  - **Linking, unlinking or moving the group's knowledge folder** is used by the brain from its next reply, and by workers started afterwards.
- The brain picks up the change at its next pause between replies, keeping the conversation, and its next message reflects the new projects and knowledge folder. Workers already running keep the folders they started with.
- Notes, docs and links added or edited in the knowledge folder are readable by the brain and new workers straight away.
- **Acceptance Criteria:**
  - [ ] Given an open session in the "Storefront" group, when the user adds the "infra" repository to the group, then the session header lists infra with the session branch, without restarting Arc.
  - [ ] Given infra was just added, when the user asks the brain to change something in infra, then the brain starts a worker in infra and the work merges into the session branch there.
  - [ ] Given infra has unsaved changes when it is added, when it joins the open session, then the unsaved-changes dialog names infra and offers Set aside, Commit them first, Bring them along and Cancel; Cancel leaves infra out of the session.
  - [ ] Given an open session, when the user removes the "web" repository from the group, then the session header shows web as "Removed" and asking the brain for a change in web gets a reply that web is no longer part of the group.
  - [ ] Given an open session, when the user links the group's knowledge to an external folder, then the brain's next answer about a note uses the file in the linked folder, without restarting Arc.
  - [ ] Given an open session, when the user adds a note named "Partitioning" and asks the brain about it, then the brain answers from that note.

---

## 3. Scope and Boundaries

### In-Scope

- The Sessions tab in a group, and starting, renaming, reopening and deleting sessions.
- The session branch in each project repository, with the check for unsaved changes.
- The session screen: header, conversation, brain and worker cards, and event log.
- Chatting with the brain using Claude Code.
- Plan-first plans with per-worker model choice, and Autonomous mode with a worker limit.
- Workers in their own working copies, with live status, details and Stop.
- Approvals and questions going to the brain first, then to the user through Needs attention, with macOS notifications.
- Merging finished work into the session branch, resolving conflicts, and sharing changes between workers.
- A watch-only terminal for each worker.
- Saving and resuming sessions.

### Out-of-Scope

- Automatic model choice based on subscription usage, and the usage gauges. The brain picks by task difficulty only.
- Codex as a provider.
- Typing into a worker's terminal to take over.
- A screen for reviewing the combined changes before the user commits or pushes.
- The brain suggesting new notes and docs after a session.
- Pushing branches, opening pull or merge requests, or merging into "dev" without the user's approval. Arc never does these on its own, and a "Push and open merge request" button is not part of this spec.

---

## Change Log

- 2026-10-17 — implementation finding — The brain's Continue prompt now says "stopped when Arc closed", which reads right after a quit and after a crash. The event log says "Stopped when Arc closed unexpectedly" for a crash and keeps "Stopped when Arc quit" for a clean quit. See 2.10.
- 2026-10-17 — user decision during implementation — Pushes and merge requests: a worker may run them only after the user approves that exact command; Arc and the brain never do so on their own. This removes a contradiction between 2.2 and the push approval example in 2.7.
- 2026-10-17 — implementation finding — Ordinary commands run without any approval step, as 2.5 already says. Only the four protected kinds of action stop and ask, and they always go to the user. Worker questions still go to the brain first.
- 2026-10-17 — user decision during implementation — The header gets a separate brain model picker (default Sonnet). The existing header model setting now applies to workers only.
- 2026-10-17 — user decision from real use — Reading files outside the working copy and writing in the system temp folder are no longer protected; a worker kept asking before a read-only `grep` in `/tmp`. Permission cards gain "Always allow this in this session", and the session header gains an Auto-approve toggle that never covers pushes or merge requests. See 2.7.
- 2026-10-17 — user request during implementation — Worker terminals open as tabs next to a "Brain" tab in the conversation area. Clicking a worker card opens its terminal tab; details move to a Details button on the card and the tab.
- 2026-10-17 — user request during implementation (from real use: "once a worker is done it stays around forever") — Stop now ends the worker and deletes its working copy, with a warning about unmerged commits; a worker stopped by quitting or a crash keeps it so Continue still works. Finished workers get a Remove action. Done workers are merged automatically and the brain is told. See 2.6 and 2.8.
- 2026-10-17 — user request during implementation — The brain gets a shell: "Read freely, ask for changes". It runs read-only commands (such as `git diff`) without approval, and commands that change files or git state in the user's checkouts go to the user for approval. The brain's prompt says so, and sessions from before get a one-time updated-instructions note. See 2.4 and 2.7.
- 2026-10-18 — user report from real use ("it is just handing it off to 1 worker") — The brain's instructions now say when to split work: independent parts (usually one per repository or per independent sub-task) go to separate workers started together, up to the worker limit; sequential work stays in one worker; questions are answered directly from reading when possible, with workers only for running code, and independent checks run in parallel. Existing sessions get a one-time note with this guidance. See 2.4–2.6.
- 2026-10-18 — user report from real use ("adding projects, docs, notes, linking to an external knowledgebase, etc all require restarting Arc") — Group changes now reach open sessions: added projects join them (with the unsaved-changes check), removed ones show as Removed, moved projects and relinked knowledge folders are used from the brain's next reply and by new workers. Previously an open session kept the projects and knowledge folder it started with, and a project added later could never get workers in it, even after a restart. See 2.11.
