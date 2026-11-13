# Product Definition: Arc

- **Version:** 1.0
- **Status:** Proposed

> Items marked _(assumption)_ were drafted from best-practice defaults and still need confirmation. Everything else reflects answers from the product interview.

---

## 1. The Big Picture (The "Why")

### 1.1. Project Vision & Purpose

A personal macOS desktop agent harness that lets a developer point their existing Claude, Codex and Cursor subscriptions at a whole _group_ of related projects at once, with lasting knowledge (notes, docs, schemas, playbooks, links) attached to that group. The goal is to ask a question or fix an issue across a multi-repo system as easily as working in a single folder, without paying for separate API usage and without re-explaining context every session.

### 1.2. Target Audience

A single developer (the author) who already pays for Claude, Codex and Cursor subscriptions and works on systems that span several repositories and a database. v1 is local-first and single-user: no accounts, sharing, or sync.

### 1.3. User Personas

- **Persona 1: "Dana the Full-Stack Developer"**
  - **Role:** Developer maintaining a product made of 3-6 repositories plus a production database.
  - **Goal:** Ask "why is this query slow?" or "fix the checkout bug" once and have the agent see every relevant repo and the database structure without copy-pasting schemas or switching terminals.
  - **Frustration:** CLI agents only see one folder; context about other repos and the database has to be re-explained every time, long sessions are lost when the terminal closes, and it's hard to tell how much subscription quota is left.

### 1.4. Success Metrics

- A question that touches multiple repos can be asked once from a group, with no manual pasting of context from other folders.
- A previous session can be resumed with its history and worker results intact in under 10 seconds. _(assumption)_
- The brain's automatic model choice is accepted without override in most tasks (target: 80%). _(assumption)_
- Sessions rarely hit a subscription rate limit unexpectedly, because usage is visible and the brain picks models with it in mind.
- All AI usage runs through the user's existing Claude, Codex and Cursor subscriptions; no separate API key or billing is required.

---

## 2. The Product Experience (The "What")

### 2.1. Core Features

- **Groups of folders and knowledge:** Pick local folders and organize them into named groups. Each group has built-in sections plus any custom sections the user creates:
  - **Projects** - code repositories the agent can read and modify.
  - **Notes** - free-form notes the user writes for the agent to reference.
  - **Docs** - reference material such as database schemas (structure only, no data), API specs, and architecture write-ups.
  - **Prompts / Playbooks** - reusable instructions such as "how we write migrations" or a release checklist.
  - **Links** - URLs to internal wikis or external docs that the agent can fetch.
  - **Custom sections** - user-named sections for anything else.
  - Notes, Docs, and other knowledge are stored by default in the app's own data folder as plain files; any group can instead be linked to a folder the user chooses (e.g. a git repo) so the knowledge can be versioned and backed up.
- **Group sessions:** Each session belongs to exactly one group. Asking a question or fixing an issue gives the agent access to every project folder in that group, plus all of its knowledge sections.
- **Brain and workers:** Each session has a "brain" agent that plans the work, spawns worker agents for sub-tasks (e.g. one per repo), and collects their reports into a single answer or set of changes. Independent parts of a request go to separate workers that run at the same time; work that has to happen in order stays with one worker, and questions the brain can answer by reading don't need a worker at all.
  - **Spawn mode toggle:** _Plan-first_ - the brain shows a plan listing the workers it intends to start and the model for each, and nothing runs until the user approves (and can change models). _Autonomous_ - the brain spawns workers on its own, up to a worker cap the user sets.
  - **Change policy:** Once a plan is approved (or in autonomous mode), workers edit files and run commands freely; the user reviews the resulting diffs at the end.
- **Change review:** A "Review changes" screen in each session shows every file the session changed, per repository, compared with where the session branch started, and which worker changed each file. The user can view each file's changes (single-column or side-by-side), see their own uncommitted edits separately, undo a file's changes, mark files as reviewed, and leave notes on specific lines that are sent to the brain together. When the user is happy, a "Push branch" button pushes the session branch, but only after the user clicks Push in a dialog that shows the exact command.
- **Commands and skills in sessions:** The user's own Claude Code slash commands, skills and plugins (for example AWOS, superpowers, compound engineering) work inside Arc.
  - **Finding commands:** typing `/` in the message box lists the user's commands and those saved in each project repository, filtered as they type, each marked "Yours" or with the repository's name.
  - **Running commands:** a command always runs in a worker, in the right repository, labelled with the command (for example "W2 · /awos:spec"), and follows the session's mode. Plan-first shows it in a plan to approve first. Helper agents a command starts stay inside that worker. Files it writes reach the session branch and change review like any other worker's.
  - **The brain starting commands:** when the user asks in plain words for something a command does well, the brain may run that command, naming it and saying why, or listing it in the plan.
  - **Questions from commands:** they appear in Needs attention with their choices as buttons, a box for a typed answer, and Decline. Only the user answers them; neither the brain nor Auto-approve can.
  - **Arc stays in charge:** agents load the user's own and their plugins' MCP servers and hooks, for Claude and Codex alike, but not personal permission rules, so Arc's approvals still apply to whatever a command does; MCP tools that change something go through Arc's approvals.
  - **Plugins in Settings:** a Plugins page lists installed Claude Code plugins (version, source, number of commands and skills) and lets the user install, update and remove them. These are the same plugins Claude Code uses in the terminal, so changes apply in both places. _(planned, later spec)_ A matching page for managing the user's Codex prompts and plugins.
- **Approvals and questions bubble up:** When a worker needs a permission it doesn't already have (e.g. a command outside the change policy) or asks a question, it pauses and the request goes to the brain first. The brain answers whatever it can from the plan, the group's knowledge, or other workers' results. Anything it can't, or isn't allowed to decide, is escalated to the user as an alert.
  - **Alerts:** each alert shows which worker raised it, what it wants, and why. The user can approve, deny, or type an answer, which goes back to the worker; the worker then resumes.
  - **Getting the user's attention:** a pulsing amber "Needs attention" badge with a count appears in the session header, and the worker that is waiting shows as an amber card. Clicking either opens a "Needs attention" dialog listing the pending alerts: permission requests with Approve and Deny, and questions with an answer box. Alerts never pile up as a column in the session view. A badge also appears on the session and its group, and a macOS notification is sent when the app isn't in front.
  - **Session screen layout:** the session screen fits the window. The brain, worker, and conversation panels each scroll on their own, so a long conversation or many workers never push the rest of the screen out of view.
  - **Questions from the brain:** the brain can ask the user questions the same way.
  - **Persistence:** pending requests survive closing and resuming the session.
  - **Skip all approvals** _(planned, later spec)_**:** an opt-in switch that makes the brain and workers approve everything, like running Claude Code with `--dangerously-skip-permissions` or the matching "bypass approvals and sandbox" mode in Codex and other providers. It is off by default, clearly marked as dangerous, can be turned on for one session or as a default, and is shown in the session header while it is on. While it is on, nothing waits in Needs attention for permission; questions from workers and commands still reach the user.
- **Session branches and worker worktrees:** Starting a session changes no repo. A project repo gets its session branch only when a worker first starts there, and Arc then switches the user's own copy of that repo to it. The branch is created off `dev`, or off the repo's default branch if it has no `dev` branch. If the repo has unsaved changes, Arc asks the user what to do with them in a card in Needs attention, and the worker waits for the answer while other workers go on. The session header lists the repos that have a branch and counts the rest. _(assumption)_ Every worker the brain spawns gets its own git worktree, branched from the session branch, so several workers can change the same codebase at the same time without interfering with each other. When a worker finishes, the brain merges its work back into the session branch, resolves any conflicts with the other workers' changes, and keeps the session branch consistent.
- **Brain-mediated hand-offs between workers:** When one worker needs a change another worker made (e.g. a new API field the frontend worker has to use), the brain merges that change into the session branch, brings it into the waiting worker's worktree, and tells that worker what changed and why.
- **Smart model and provider selection with override:** The brain picks a provider (Claude, Codex or Cursor) and model per worker based on task complexity and current subscription usage, e.g. a lighter model for simple lookups, a stronger one for complex changes, or Codex or Cursor for a second opinion. Cursor workers can use the models included in the user's Cursor plan. When Cursor is added, the token counts, Usage page, plan meters and suggestions from the plan-usage spec (spec 008) must be extended to cover Cursor workers too. The user can override provider and model for the whole session or any single worker.
- **Usage awareness:** The app shows subscription usage and rate-limit status per provider and per session, and the brain switches to lighter models when limits are close.
- **Choosing what agents load:** Arc agents load the user's own MCP servers, plugins, `~/.claude` skills and hooks, which adds tens of thousands of tokens to every request. A Settings page lists each of them with a Brain switch and a Workers switch and an estimate of its size per request (spec 009). Everything is on by default, and only the items the user switches off are stored. The terminal is not affected.
- **Saved, resumable sessions:** Sessions, including the brain's conversation, worker reports, and changes, are saved and can be reopened and continued later.
- **Learning loop:** When the brain finishes a request it can suggest things worth keeping (e.g. "the orders table is partitioned by month"), up to 5 per request, and the user can also ask it for suggestions at any time. A suggestion is either a new note or a change to an existing one, in Notes, Docs, Playbooks or a custom section, never in Projects or Links. The brain does not suggest while workers are still running, and never repeats a suggestion or offers one the user discarded.
  - **Seeing them:** a "Suggestions" chip with the count appears in the session header, and the brain's answer ends with a line such as "I have 2 suggestions for this group's knowledge." that opens the same "Knowledge suggestions" dialog. Each card says what the brain learned and where, and shows the new note's text or the lines the change adds and removes.
  - **Deciding:** Accept, Edit (change the text, and for a new note its name or section, then save) or Discard on each card, and Accept all or Discard all for the whole list. Nothing is written until the user accepts. If a note was changed after the suggestion was made, or a name is already taken, Arc says so, writes nothing and leaves the suggestion waiting.
  - **Control:** a "Suggest knowledge updates" switch in Settings (on by default) stops the brain suggesting on its own; it still answers when asked, and suggestions already waiting stay. Suggestions and what the user did with them are listed in the session's event history.
- **Attachments on messages:** The user can show the brain a screenshot or a file instead of describing it. On the first message of a session or on any later one, they paste an image (for example a screenshot), drop files onto the message box or pick them with an Attach button, see what is attached under the box, and send. A message can be attachments alone, with no text.
  - **What can be attached:** images (PNG, JPEG, GIF, WebP), PDFs and text files, up to 10 per message and 20 MB each. A file of another type, one that is too large, one too many, a folder or one that can't be read is refused with its reason, and the rest stay attached. Attachments can't be sent with a `/` command or as feedback on a waiting plan.
  - **Kept with the session:** Arc copies a file when it is attached, so moving or deleting the original changes nothing. Sent attachments show on the message, images as thumbnails that open full size, and stay until the session is deleted. Attachments that were not sent are dropped when Arc restarts or the New Session dialog is cancelled.
  - **The brain and workers:** the brain is told where each attachment is and, for images, is shown the image where its provider can take one. It opens a file only when the request depends on it. It can pass attachments to a worker it starts or messages; the worker can read them but not change them, and its details list them.
  - **Warning:** when the brain can't read a kind of file (PDFs, on Codex and Cursor), Arc says so under the message box before sending. The file is still sent, as a file the brain may not be able to open.
  - **Deleting old attachments** _(planned, later spec; asked for on 2026-11-12)_**:** today there is no expiry and no total size limit. A later spec deletes attachments from sessions that have not been used for a set time (for example 90 days) and decides what the message shows afterwards.
- **Chat first, terminals on demand:** The main view is a clean chat with the brain and a live list of workers and their status. Any worker's underlying terminal can be opened to watch or step in. Under the hood, the app drives the locally installed Claude Code, Codex and Cursor CLIs so it uses their logged-in subscriptions.
  - **Stepping in on a worker:** take over a worker in its terminal tab, talk to it directly, then hand it back to the brain.
  - **Stepping in on the brain:** take over the brain's own conversation interactively in the same way.
  - **Open in macOS Terminal:** open a worker in Terminal.app instead of inside Arc.
  - **Starting a worker by hand:** open a new, empty interactive worker in a chosen repository, without the brain starting it.
  - **Plain shell:** a normal command-line shell in a worker's working copy, next to its Claude session.

### 2.2. User Journey

Dana opens the app, creates a group called "Storefront", and adds three repos (web, api, infra) under Projects. Under Docs she drops in a schema-only dump of the production database, under Notes she writes how the services talk to each other, and under Playbooks she adds the team's migration checklist. She opens a new session on the group in plan-first mode. No repo is touched yet. She asks, "The orders report query is timing out. Find out why and fix it." The brain reads the schema and notes, then proposes a plan: a Claude worker on a light model to inspect the API's query code, and a Codex worker to review recent infra changes. Dana bumps the first worker to a stronger model and approves. Each worker starts in its own worktree, and the API repo gets its session branch off `dev` when the first worker starts there; web gets its own when the web worker starts, and infra stays as it was. She watches progress in the chat, opening the API worker's terminal briefly to see what it's running. The API worker adds a migration and a new response field. The brain merges that work into the session branch and passes the new field to a web worker, which updates the report page in its own worktree. The brain merges the web worker's changes too, resolving a small conflict, and Dana reviews the combined diff on the session branch. Before closing, the brain suggests a note about the orders table's partitioning, which Dana accepts. The next morning she resumes the same session to ask a follow-up.

---

## 3. Project Boundaries

### 3.1. What's In-Scope for this Version

- macOS desktop app for a single user.
- Creating, editing, and deleting groups; adding and removing local project folders.
- Built-in Projects, Notes, Docs, Prompts/Playbooks, and Links sections, plus user-defined custom sections.
- Knowledge stored in the app's data folder by default, or in a user-chosen folder per group.
- Sessions scoped to one group, with access to all its projects and knowledge.
- Brain-and-worker orchestration with a plan-first / autonomous (with worker cap) toggle.
- Plan approval followed by free editing; change review at the end (per-file diffs with worker attribution, undo a file, reviewed marks, line notes to the brain, and pushing the session branch on the user's click).
- Running the user's Claude Code commands and skills from a session (the `/` list, commands in labelled workers, brain-started commands, command questions in Needs attention), and a Settings page to list, install, update and remove Claude Code plugins.
- Worker approval requests and questions routed to the brain, and escalated to the user as approve / deny / answer alerts (with a badge and a macOS notification) when the brain can't resolve them.
- An opt-in "skip all approvals" mode per session or as a default, using each provider's own bypass mode _(planned, later spec)_.
- A session branch off `dev` in each project repo that a worker works in, created when its first worker starts there.
- One git worktree per worker, merged back into the session branch by the brain, with the brain resolving conflicts.
- The brain passing changes from one worker to another when they depend on each other.
- Mixing Claude Code, Codex and Cursor CLI in one session; automatic provider/model selection with per-session and per-worker override.
- Subscription usage and rate-limit display, factored into model selection.
- Saving and resuming sessions.
- Brain-suggested notes/docs updates that the user approves.
- Images, PDFs and text files attached to messages to the brain (paste, drop or pick), kept with the session and passed on to workers by the brain.
- Chat interface with on-demand access to each worker's raw terminal: stepping in on a worker or on the brain, opening a worker in macOS Terminal, starting an interactive worker by hand, and a plain shell in a worker's working copy.

### 3.2. What's Out-of-Scope (Non-Goals)

- Pay-per-token API keys as a way to run models. _(assumption)_
- Connecting to live databases or querying real data; schemas are provided as static docs.
- Multiple users, team sharing, accounts, or cloud sync.
- Windows and Linux builds.
- Sessions spanning multiple groups, or sessions with no group.
- Remote or cloud-hosted execution; everything runs on the user's machine.
- A built-in code editor or IDE replacement. _(assumption)_
- Writing new slash commands or skills inside Arc; they are created with Claude Code as usual.
- Pushing branches, opening pull requests, or merging the session branch into `dev` automatically. Arc pushes a session branch only when the user clicks Push in the change review; opening pull or merge requests and merging into `dev` stay with the user.
