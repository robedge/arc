# Functional Specification: Commands and Skills in Sessions

- **Topic:** Letting the user run their Claude Code slash commands and skills (for example the AWOS commands, superpowers and compound engineering) from an Arc session, carried out by workers, started by the user or by the brain, and managing the plugins that provide them from Arc's Settings.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

The user already works with a set of Claude Code commands and skills: AWOS for writing specs and task lists, superpowers for brainstorming and planning, compound engineering for review and learning. In a terminal they type `/awos:spec` or `/awos:implement` and the workflow runs.

Inside Arc none of this works. Arc keeps the user's personal Claude Code setup away from its agents, so Arc's own approvals stay in charge, and typing `/awos:spec` in a session just sends the text to the brain as an ordinary message. The user has to leave Arc to plan, then come back to Arc to build.

This spec lets the user run those commands from a session. Typing `/` in the message box lists what is available; picking one runs it in a worker inside the right repository, so it follows the same working-copy, merge and approval rules as any other worker. The brain can also start a command itself when the user asks for something in plain words that a command does well. Questions a command asks come to the user in Arc. A Plugins page in Settings shows, installs, updates and removes the plugins that provide these commands.

**Success looks like this:**

- The user can start any of their installed commands from a session without opening a terminal.
- A command that writes files (such as `/awos:spec`) produces its files on the session branch, where change review shows them.
- A command's questions reach the user inside Arc and the command continues after they answer.
- Arc's approval rules still apply: pushes, destructive commands and writes outside the working copy still ask the user, whatever the command does.
- The user can install or update a plugin from Arc and use its commands in their next message.

---

## 2. Functional Requirements (The "What")

### 2.1. Finding commands

- Typing `/` at the start of the message box opens a list of available commands, filtered as the user types. Each entry shows the command's name (for example `/awos:spec`), a one-line description, and where it comes from: "Yours" (installed for the user, including commands that come with installed plugins), or the name of a repository (saved in that repository).
- All of the user's installed commands, skills and plugins are offered, plus the commands saved inside each project repository of the group.
- Arrow keys move through the list, Enter or Tab picks the highlighted command and keeps the rest of the line as its arguments, and Escape closes the list.
- If the user types a command that doesn't exist, it is sent to the brain as ordinary text, and the brain says it doesn't know that command.
- **Acceptance Criteria:**
  - [x] When the user types `/aw` in the message box, then a list appears showing the matching commands, such as `/awos:spec`, each with its description and "Yours" or the repository name.
  - [x] Given the command list is open, when the user presses Escape, then the list closes and the typed text stays in the box.
  - [x] Given the command list is open with `/awos:spec` highlighted, when the user presses Enter, then the box contains `/awos:spec ` ready for the arguments they type next.
  - [x] Given the "api" repository has its own saved command `/release-notes`, when the user types `/rel`, then `/release-notes` is listed with "api" as its source.
  - [x] When the user sends `/does-not-exist`, then the brain replies that it doesn't know that command.

### 2.2. Running a command

- Sending a message that starts with a command runs that command with the rest of the message as its arguments. The conversation shows the user's message with the command name highlighted.
- Every command runs in a worker in one of the group's repositories. The brain picks the repository from the request; if it can't tell, it asks the user which repository, with the repository names as choices. A command that only produces an answer finishes without changes, and its answer appears in the worker's report and in the brain's reply.
- The worker is shown like any other worker, labelled with the command, for example "W2 · /awos:spec".
- The session's mode applies: in Plan-first mode the command's worker appears in a plan for approval first; in Autonomous mode it starts directly.
- A command can start helper agents of its own (as `/awos:implement` does). They run inside the command's worker and their activity shows in that worker's terminal; they do not get worker cards of their own.
- Files a command writes go through the normal flow: they are committed in the worker, merged into the session branch, and appear in change review.
- A group with no repositories can't run commands; the brain says so.
- **Acceptance Criteria:**
  - [x] Given a session in Autonomous mode on a group with the "api" repository, when the user sends `/awos:spec for retry settings`, then a worker labelled with `/awos:spec` starts in api and, when it finishes, the new spec files appear in change review for api.
  - [x] Given a session in Plan-first mode, when the user sends a command, then a plan listing that command's worker appears and nothing starts until the user approves it.
  - [x] Given a group with two repositories, when the user sends a command without naming a repository, then the brain asks which repository, offering both names.
  - [x] Given a command that only answers, when its worker finishes, then the brain's reply contains the answer and change review shows no new changes from that worker.
  - [x] Given a running command starts helper agents, when the user opens the command's worker terminal, then the helpers' activity appears there and no extra worker cards appear.

### 2.3. The brain starting commands

- When the user asks in plain words for something one of their commands does well (for example "write a spec for retry settings"), the brain may run that command instead of doing the work another way. It follows the session's mode: in Plan-first the command's worker appears in the plan for approval, naming the command; in Autonomous it starts the worker and tells the user which command it started and why, in one sentence.
- The brain only uses commands from the same list the user sees in 2.1.
- **Acceptance Criteria:**
  - [x] Given a session in Plan-first mode, when the user writes "write a spec for retry settings", then the brain's plan lists a worker that runs `/awos:spec`, and nothing starts until the user approves.
  - [x] Given a session in Autonomous mode, when the brain starts a command itself, then its message names the command and gives the reason, and the worker card is labelled with the command.

### 2.4. Questions from commands

- Many commands ask the user questions while they run, often with choices. When a command asks a question, it appears in Needs attention as a question card with the same choices as buttons and a box for a typed answer.
- The command waits until the user answers, then continues with that answer.
- Questions asked by commands are never answered by the brain on the user's behalf.
- **Acceptance Criteria:**
  - [x] Given a running command asks "Where should the review open?" with two choices, when the user opens Needs attention, then they see the question, both choices as buttons, and a box for their own answer.
  - [x] Given that question is waiting, when the user picks the first choice, then the command continues and its next output reflects that choice.
  - [x] Given a command asks a question, when the brain is told about it, then the brain passes it to the user instead of answering it.

### 2.5. Keeping Arc in charge

- The user's own commands, skills and plugins are available, but their personal hooks and personal permission rules are not loaded. Arc's approvals stay in charge: pushing, opening merge requests, destructive commands, global installs and writing outside the working copy still go to the user in Needs attention, whichever command asked for them.
- The brain still can't edit files; commands always run in workers.
- **Acceptance Criteria:**
  - [x] Given a command tries to push a branch, when it runs, then Needs attention asks the user to approve the exact push command, as for any worker.
  - [x] Given the user has a personal hook that would run after every edit, when a command edits a file in Arc, then that hook does not run.

### 2.6. Managing plugins in Settings

- Settings gets a **Plugins** page listing the user's installed Claude Code plugins: name, version, a one-line description, where it was installed from, and how many commands and skills it provides.
- The user can:
  - **Install** a plugin by entering its name (and, when needed, the marketplace it comes from), then clicking Install. Progress shows while it installs; when it finishes the plugin appears in the list.
  - **Update** a plugin that has a newer version (the row shows "Update available").
  - **Remove** a plugin, after confirming: "Remove superpowers? Its commands stop working in Arc and in Claude Code."
- These are the same plugins Claude Code uses in the terminal, so changes made in Arc apply there too, and the page says so.
- Changes apply to agents started afterwards. Workers already running keep what they started with; the command list in the message box refreshes right away.
- If an install, update or removal fails, the page shows the error message Claude Code gave, and nothing else changes.
- If Claude Code isn't installed or signed in, the page shows the same notice as the Sessions tab.
- **Acceptance Criteria:**
  - [x] When the user opens Settings › Plugins, then they see their installed plugins with name, version, description, source and number of commands.
  - [x] When the user installs a plugin by name, then progress shows and, when it finishes, the plugin is listed and its commands appear in the `/` list.
  - [x] Given a plugin shows "Update available", when the user clicks Update, then the row shows the new version when it finishes.
  - [x] When the user clicks Remove on a plugin and confirms, then it leaves the list and its commands leave the `/` list; Cancel leaves it installed.
  - [x] Given an install fails, when it finishes, then the page shows Claude Code's error message and the list is unchanged.

---

## 3. Scope and Boundaries

### In-Scope

- The `/` command list in the message box, with the user's installed commands, skills and plugins and each repository's saved commands.
- Running commands in workers in the right repository, following the session's mode, with helper agents inside the worker.
- The brain starting commands itself, following the mode.
- Questions from commands answered through Needs attention.
- Commands' files going through the normal merge and change review flow.
- Keeping personal hooks and permission rules out, with Arc's approvals unchanged.
- A Plugins page in Settings to list, install, update and remove Claude Code plugins.

### Out-of-Scope

- Writing new commands or skills inside Arc.

---

## Change Log

_Dated amendments made after the spec was first written. Leave empty until the first amendment._
- 2026-10-19 — spec 007 (Codex as a second provider) — agents now load the user's own and their plugins' MCP servers and hooks; personal permission rules stay out and Arc's approvals still apply. The parts of this spec that kept hooks and MCP servers out of agents are superseded by spec 007 section 2.6.
