# Functional Specification: Cursor as a Third Provider

- **Topic:** Arc's brain and workers can run on the user's Cursor subscription through the Cursor command-line tool, next to Claude and Codex, with their tokens and plan usage shown like the others'.
- **Status:** Draft
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

The user pays for Claude, Codex and Cursor. Arc already runs agents on Claude and Codex, so a session can mix them and fall back from one to the other. Cursor is the third subscription, and today Arc can't use it: its models and its plan sit idle while Arc works, and when Claude or Codex limits run low the user has nowhere else to send the work.

This spec adds Cursor as a third provider. The user can choose Cursor for the brain or the workers, in Settings and per session, and the brain can start a worker on Cursor when that suits the task. A Cursor worker behaves like the other workers: it works in its own working copy, its risky actions come to the user, its terminal can be opened, and its tokens count in the usage panel and on the Usage page.

**Success looks like this:**

- With the Cursor command-line tool installed and signed in, the user can start a session whose workers (or brain) run on Cursor, and finish it as they would on Claude or Codex.
- Risky actions by a Cursor agent never run without the user's say, as with the other providers.
- The user sees what Cursor agents cost in tokens, and Cursor's plan usage when Cursor reports it.
- Without Cursor set up, nothing changes: Arc says Cursor isn't available and uses the other providers.

---

## 2. Functional Requirements (The "What")

### 2.1. Setting Cursor up

- Settings > Providers lists Cursor next to Claude and Codex, with its state: **Signed in** (with its version), **Not signed in**, or **Not installed**, and a "Check again" button.
- When Cursor is not installed, the row says how to install the Cursor command-line tool. When it is installed but not signed in, the row says to sign in in a terminal. Arc never handles the sign-in itself.
- **Acceptance Criteria:**
  - [ ] Given the Cursor command-line tool is installed and signed in, when the user opens Settings > Providers, then Cursor shows "Signed in" with its version.
  - [ ] Given it is not installed, when the user opens Providers, then Cursor shows "Not installed" and how to install it.
  - [ ] Given it is installed but not signed in, when the user opens Providers, then Cursor shows "Not signed in" and to sign in in a terminal; after signing in, when the user presses "Check again", then it shows "Signed in".

### 2.2. Choosing Cursor

- The default brain and default workers choices in Settings, and the per-session choices, gain **Cursor** and Cursor's models, next to Auto, Claude and Codex.
- Cursor can be chosen for the brain and for the workers.
- The models offered are every model the user's Cursor account offers, including Cursor's own "Auto", with Cursor's default marked. When Cursor adds a model, it appears the next time Arc opens.
- With **Auto**, the brain may pick Cursor for a worker, as it may pick Codex: for example for a second opinion, or when the other providers' limits are close. The worker card says which provider and model it runs on.
- **Acceptance Criteria:**
  - [ ] Given Cursor is signed in, when the user opens the default workers choice, then Cursor and its models are offered.
  - [ ] Given the session's workers are set to Cursor, when the brain starts a worker, then the worker card shows it runs on Cursor and its model.
  - [ ] Given the user chose Cursor for a session's brain, when they look at the session header, then it shows the brain runs on Cursor and its model.
  - [ ] Given the workers are set to Auto and Cursor is signed in, when the brain starts a worker on Cursor, then the card shows Cursor and its model.
  - [ ] Given Cursor's account offers a model Arc has not seen before, when Arc opens, then that model is offered in the choosers.

### 2.3. Cursor workers work like the others

- A Cursor worker works in its own working copy of the session's projects, reports its progress and result to the brain, and can be merged, reviewed and synced like any worker.
- Its output streams into its terminal tab as it works.
- The user can step in on a Cursor worker (spec 006): ask it something, then hand back.
- **Acceptance Criteria:**
  - [ ] Given a session whose workers run on Cursor, when the user asks for a change, then a Cursor worker makes it in its own working copy and the change can be reviewed and merged.
  - [ ] When the user opens a Cursor worker's terminal while it works, then its output appears as it arrives.
  - [ ] Given a working Cursor worker, when the user steps in, asks it a question and hands back, then it answers and continues its task.

### 2.4. Approvals

- Risky actions (leaving the working copy, pushing or opening a merge request, destructive commands, global installs) never run without the user's say, as with Claude and Codex.
- Cursor asks before commands and tool calls but not before editing files. Arc therefore blocks Cursor workers from editing the user's project folders, the knowledge folder and other workers' copies (and confines them further with Cursor's own sandbox if it can), and notes any other edit outside the working copy in the session.
- Where Cursor can pause and ask before a risky action, the request goes to Needs attention like the other providers'. Where it can't, Arc blocks the action for Cursor agents: the agent is told it isn't allowed and to ask the brain instead, and the user sees a note in the session saying which action was blocked. The user can then rerun that step on a Claude or Codex worker.
- **Acceptance Criteria:**
  - [ ] Given a Cursor worker tries to push, when the action comes up, then it does not run unless the user approves it in Needs attention, or, where Cursor can't ask, it is blocked and the session shows a note naming the worker and the blocked action.
  - [ ] Given a Cursor worker tries to change a file in the user's project folders, the knowledge folder or another worker's copy, when it tries, then the change is blocked; and when it changes any other file outside its working copy, then the session shows a note naming the worker and the file.
  - [ ] When a Cursor worker runs an ordinary command in its working copy, then it runs without asking.

### 2.5. Tokens and plan usage

- A Cursor agent's tokens count in its card, the session's usage panel, the header chip and the Usage page, split by provider, as for Claude and Codex, including the live count during a turn when Cursor reports it.
- The plan meters show Cursor's usage when Cursor reports it; otherwise the Cursor meter reads "Not reported".
- If Cursor doesn't report token counts, Cursor agents' rows read "Not reported" instead of a number, and Cursor is left out of the token totals.
- The suggestions (spec 008) cover Cursor agents too.
- **Acceptance Criteria:**
  - [ ] Given a Cursor worker finished a turn, when the user opens the usage panel, then the worker's row shows its tokens and the Cursor total is listed.
  - [ ] When the user opens the Usage page, then Cursor appears as a provider in the totals and the daily chart.
  - [ ] Given Cursor reports no plan usage, when the user looks at the plan meters, then Cursor reads "Not reported".

### 2.6. When Cursor isn't available

- If Cursor is chosen but not installed, not signed in, or out of its limit, Arc uses Claude, then Codex, whichever is available first, and says so on the card, as it does for Codex today. The same applies to the brain.
- **Acceptance Criteria:**
  - [ ] Given the workers are set to Cursor and Cursor is not signed in, when the brain starts a worker, then it runs on Claude and its card says "Cursor isn't signed in, so W2 runs on Claude. Run agent login in Terminal to use Cursor." (with the worker's own name).
  - [ ] Given a Cursor worker hits its plan limit, when that happens, then the user sees the same pause and retry message as for the other providers.

### 2.7. The user's own Cursor setup

- Cursor agents load the user's own Cursor setup as the terminal does: their Cursor MCP servers, rules and skills.
- A tool from one of those servers that changes things goes through Arc's approvals (or is blocked, per 2.4); a read-only one runs unasked.
- The Agent loading page (spec 009) gets a **Cursor MCP servers** group with Brain and Workers switches, like the Codex servers. A server that is off is not loaded by Cursor agents in that role.
- Arc never changes the user's Cursor settings.
- **Acceptance Criteria:**
  - [ ] Given the user has a Cursor MCP server set up, when a Cursor worker starts, then it can use that server's tools.
  - [ ] Given that server is off for Workers on the Agent loading page, when a Cursor worker starts, then it does not have the server, and a Cursor brain still does.
  - [ ] Given Cursor isn't set up, when the user opens Agent loading, then the Cursor group says its servers can't be listed.
  - [ ] When a Cursor agent has run, then nothing in the user's own Cursor settings has changed.

### 2.8. Cursor commands in the / list

- Typing `/` in the message box also lists the user's Cursor commands (their own and those of the session's projects), each marked "Cursor", next to the Claude Code commands and Codex skills and prompts.
- A Cursor command always runs in a Cursor worker labelled with the command, for example "W3 · /review", whatever the Workers setting says. The brain can offer and start Cursor commands as it does the others, following the session's mode.
- If Cursor isn't available, Cursor commands are not listed. Like Codex skills and prompts, Cursor commands have no switches on the Agent loading page; only Cursor MCP servers do.
- **Acceptance Criteria:**
  - [ ] Given the user has a Cursor command named "review", when they type "/rev" in the message box, then the list shows "/review" marked "Cursor".
  - [ ] Given the session's Workers setting is "Claude", when the user runs a Cursor command, then it runs in a Cursor worker labelled with the command's name.
  - [ ] Given Cursor is not signed in, when the user types "/", then no Cursor commands are listed.
  - [ ] Given a session in Autonomous mode and a request that matches a Cursor command, when the brain picks that command, then it starts a Cursor worker labelled with it.

---

## 3. Scope and Boundaries

### In-Scope

- Cursor in Settings > Providers, in the default and per-session choices, and on worker cards.
- Cursor brains and workers with working copies, terminals, stepping in, approvals (or blocking) and merge.
- The user's Cursor MCP servers, rules and skills, with the servers on the Agent loading page.
- Cursor commands in the "/" list.
- Cursor tokens and plan usage in the panel, chip, plan meters, Usage page and suggestions.
- Falling back from Cursor when it isn't available.

### Out-of-Scope

- Signing in to Cursor from inside Arc.
- The Cursor editor app itself; only the command-line tool is used.

---

## Change Log

- 2026-10-21 — first draft; decisions by the user: Cursor for the brain and workers; Auto may pick Cursor; every model the account offers; risky actions that can't be asked about are blocked with a note; the user's Cursor setup loads, its servers switchable on Agent loading; Cursor commands in the "/" list; fallback Claude, then Codex; Cursor commands have no switches on Agent loading, like Codex's.
- 2026-10-21 — after the technical spec: the fallback card keeps the existing wording (why and how to fix); token rows read "Not reported" if Cursor doesn't report tokens.
- 2026-10-21 — after the first recorded Cursor run: Cursor doesn't ask before file edits, so edits outside the working copy are blocked for known folders and noted otherwise, instead of waiting for approval; decided by the user, who also approved one extra recorded run to test Cursor's sandbox.
- 2026-10-21 — decided by the user: Arc expands a Cursor command itself (the command file's text with the arguments, sent as the worker's first message) instead of relying on Cursor reading `/name args`; what the user sees is unchanged, the command still runs on a Cursor worker labelled with it, and a command file that can't be read fails the worker with a reason.
