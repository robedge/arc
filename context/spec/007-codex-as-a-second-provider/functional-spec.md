# Functional Specification: Codex as a Second Provider

- **Topic:** Letting the brain and workers run on the user's Codex subscription as well as Claude, with a setting for which provider to use.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

The user pays for both a Claude and a Codex subscription, but Arc only uses Claude today. Every worker and the brain run on Claude models, so the Codex subscription sits idle, and the user can't get a second opinion from a different model family without leaving Arc.

This spec makes Codex a full second provider. The brain can run on Codex, workers can run on Codex, and the brain can choose Codex for a worker when it suits the task, for example a review or a second opinion. A setting lets the user pin a provider instead: always Claude, always Codex, or let the brain choose. Codex workers behave like Claude workers: they work in their own working copy, follow Arc's approval rules, ask questions, run the user's saved Codex prompts, and can be stepped in on.

**Success looks like this:**

- The user can run a whole session, or any single worker, on Codex without leaving Arc.
- Every card, plan and event log line shows which provider a worker runs on.
- Arc's protections apply the same way to Codex workers: risky actions still ask first.
- A missing or signed-out Codex never blocks a session. Work continues on Claude and the user is told why.

---

## 2. Functional Requirements (The "What")

### 2.1. Choosing the provider

- Settings has a **Provider** choice for new sessions, with separate choices for the brain and for workers.
  - **Brain:** a model from either provider, for example "Claude · Sonnet" or a Codex model. Default: Claude · Sonnet.
  - **Workers:** "Auto" (the brain chooses the provider and model per worker), "Claude" (the brain chooses among Claude models), "Codex" (the brain chooses among Codex models), or one specific model. Default: Auto.
- Each session's header shows the current choices, for example "Brain · Sonnet" and "Workers · Auto", and the user can change them for that session only. A change applies from the brain's next reply and to new workers; a reply or worker already running finishes on what it started with.
- The model lists show only the models the user's subscriptions offer.
- **Acceptance Criteria:**
  - [x] Given Settings has Workers set to "Codex", when the user starts a new session, then its header shows "Workers · Codex" and every worker the brain starts runs on a Codex model.
  - [x] Given a session's header has Workers set to "Claude", when the brain starts a worker, then the worker runs on a Claude model, even if Settings says "Codex".
  - [x] When the user opens the brain model choice in the header, then it lists both Claude and Codex models, each marked with its provider.
  - [x] Given the user switches the brain to a Codex model while the brain is replying, when the reply finishes, then the next reply comes from the Codex model.

### 2.2. The brain choosing Codex

- With Workers on "Auto", the brain may pick Codex for a worker when it suits the task, for example a review, a second opinion on another worker's change, or a task the user asks Codex for in chat. It names the provider and says why, in its reply or on the plan.
- In Plan-first mode the plan card shows each worker's provider and model, and the user can change either before approving.
- **Acceptance Criteria:**
  - [x] Given Workers is "Auto" and the user asks "get a second opinion from Codex on W1's change", when the brain starts the work, then the new worker runs on Codex and the brain's reply names Codex.
  - [x] Given a Plan-first plan, when the user changes a worker from Claude to Codex and clicks Approve, then that worker's card shows a Codex model.

### 2.3. Showing the provider

- Worker cards, the plan card, worker details, the terminal tab header and the event log show each worker's provider with its model, for example "Codex · gpt-5" or "Claude · Sonnet". The brain's card shows the brain's provider and model.
- **Acceptance Criteria:**
  - [x] Given a session with one Claude worker and one Codex worker, when the user looks at the worker list, then each card shows its provider and model.
  - [x] When a Codex worker starts, then the event log shows its name with its provider and model, for example "started W2 review · Codex · gpt-5".

### 2.4. Codex workers work like Claude workers

- A Codex worker gets its own working copy of the session branch, its changes are merged back by the brain and appear in Review changes with the worker's name, exactly as for a Claude worker.
- Arc's approval rules apply unchanged. Pushing, opening merge requests, destructive commands, global installs and writing outside the working copy still ask before running, and go to the brain and then to the user in Needs attention as today.
- A Codex worker can ask the brain a question, which reaches Needs attention when the brain can't answer it.
- The user can step in on a Codex worker and hand it back, as described in spec 006.
- Codex sessions can be closed and resumed later with their history, like Claude sessions.
- **Acceptance Criteria:**
  - [x] Given a Codex worker changes a file, when it finishes, then the brain merges it and Review changes lists the file with that worker's name.
  - [x] Given a Codex worker tries to push a branch, when it asks, then Needs attention shows the exact push command with Approve and Deny, and the push does not run until the user approves.
  - [x] Given a Codex worker asks a question the brain can't answer, when it asks, then the question appears in Needs attention with an answer box, and the worker continues after the user answers.
  - [x] Given a Codex worker is working, when the user clicks Step in, types a message and then clicks Hand back, then the worker answers in its tab and afterwards continues its task.
  - [x] Given a session with a Codex brain and a Codex worker, when the user closes Arc and reopens the session, then the brain's conversation and the worker's history are still there and the user can continue.

### 2.5. Codex skills and prompts in the / list

- Typing `/` in the message box also lists the user's Codex skills and saved Codex prompts, each marked "Codex", next to the Claude Code commands from spec 005 (marked "Yours" or with the repository's name).
- A Codex skill or prompt always runs in a Codex worker, and a Claude Code command always runs in a Claude worker, whatever the Workers setting says. The worker is labelled with the command, for example "W2 · /review".
- If Codex isn't available, Codex skills and prompts are not listed.
- **Acceptance Criteria:**
  - [x] Given the user has a Codex skill named "publish-release", when they type "/pub" in the message box, then the list shows "/publish-release" marked "Codex".
  - [x] Given the user has a saved Codex prompt named "review", when they type "/rev" in the message box, then the list shows "/review" marked "Codex".
  - [x] Given the session's Workers setting is "Claude", when the user runs a Codex prompt, then it runs in a worker on a Codex model labelled with the prompt's name.

### 2.6. Personal MCP servers and hooks

- Claude and Codex agents in Arc load the MCP servers and hooks the user has set up for Claude Code and Codex in the terminal, both their own and those their installed plugins bring. A worker can use, for example, the user's Figma tools.
- The user's own permission rules ("always allow" or "always deny" lists) are not loaded. Arc's approval rules decide instead, so pushes, destructive commands, global installs and writing outside the working copy still ask.
- When an agent uses a tool from one of these MCP servers: tools that only read run without asking; tools that change something go through Arc's approvals, to the brain first and then to Needs attention, showing the server, the tool and what it will do.
- This changes spec 005, where these were kept out of agents.
- **Acceptance Criteria:**
  - [x] Given the user has a Figma MCP server set up for Claude Code, when a Claude worker is asked to read a Figma file, then it uses the Figma tool and the result appears in its terminal.
  - [x] Given the user has an MCP server set up for Codex, when a Codex worker uses one of its read-only tools, then it runs without anything appearing in Needs attention.
  - [x] Given a worker calls an MCP tool that changes something and the brain can't approve it, when it asks, then Needs attention shows the server, the tool and its details with Approve and Deny, and the tool doesn't run until the user approves.
  - [x] Given the user's own Claude Code settings always allow "git push", when a worker tries to push, then Needs attention still asks before the push runs.

### 2.7. When Codex isn't available

- If Codex isn't installed or isn't signed in when a worker or the brain should run on Codex, Arc runs it on Claude instead, using a comparable Claude model (the brain uses Claude · Sonnet), so the session keeps going.
- The worker's card shows "Claude (Codex unavailable)" and the event log explains why and what to do, for example: "Codex isn't signed in, so W2 runs on Claude. Run codex login in Terminal to use Codex." For the brain, the brain's card shows the same note.
- Settings shows whether Codex is ready: "Codex · signed in", "Codex · not signed in" or "Codex · not installed". When it isn't ready, it shows the exact command to run in Terminal, for example "Run codex login in Terminal", and a **Check again** button that refreshes the status.
- **Acceptance Criteria:**
  - [x] Given Codex is not signed in and Workers is "Codex", when the brain starts a worker, then the worker runs on Claude, its card shows "Claude (Codex unavailable)", and the event log says Codex isn't signed in and to run codex login.
  - [x] Given Codex is not installed, when the user opens Settings, then the provider section shows "Codex · not installed".
  - [x] Given Codex is not installed, when the user opens the brain model choice, then Codex models are not offered.
  - [x] Given the brain is set to a Codex model and Codex is not signed in, when the brain replies, then the reply comes from Claude · Sonnet and the brain's card shows "Claude (Codex unavailable)".
  - [x] Given Settings shows "Codex · not signed in", when the user signs in to Codex in Terminal and clicks Check again, then Settings shows "Codex · signed in".

### 2.8. New models and provider updates

- Each time Arc opens, it checks every provider for new models and for a newer version of its command-line tool. Check again on the Providers page does the same.
- New models appear in the Settings, header and plan card model lists without restarting Arc. The brain hears about them from its next reply, and new workers can use them straight away.
- When a provider's tool has a newer version, the Providers page shows "Update available: 2.1.302 → 2.1.310" with the command to run in Terminal (for example `claude update` or `codex update`) and a copy button. A dismissible notice also appears once for each new version.
- After the user runs the update, Arc notices the new version the next time it checks (on Check again, or when the user returns to Arc). New workers start on the updated tool, the brain moves to it at its next reply and keeps its conversation, and workers already running finish on the version they started with.
- If Arc can't move to the updated tool without restarting, it shows "Restart Arc to finish updating Codex" with **Restart now** and **Later**. Restart now reopens Arc, and sessions continue where they left off.
- **Acceptance Criteria:**
  - [x] Given a provider offers a model that wasn't there last time, when the user opens Arc, then the new model appears in the brain and worker model lists without restarting.
  - [x] Given the brain is mid-session, when a new model becomes available, then the user can switch the brain to it from the header and the next reply comes from it, with the conversation kept.
  - [x] Given a newer Codex version is available, when the user opens Arc, then the Providers page shows "Update available" with both version numbers and "codex update" with a copy button, and a notice appears once.
  - [x] Given the user dismissed the update notice, when they reopen Arc and the same version is still waiting, then the notice doesn't appear again, while the Providers page still shows the update.
  - [x] Given the user ran the update in Terminal, when they return to Arc, then the Providers page shows the new version, the next worker starts on it, and the brain's next reply uses it without restarting Arc.
  - [x] Given Arc can't switch to an updated tool without restarting, when it notices the update, then it shows "Restart Arc to finish updating" with Restart now and Later, and after Restart now the open session continues where it left off.

---

## 3. Scope and Boundaries

### In-Scope

- Running the brain and workers on Codex, from the user's signed-in Codex subscription.
- A provider setting in Settings with a per-session override in the header, separately for the brain and for workers.
- The brain choosing Codex for a worker when Workers is "Auto", and the plan card showing and changing the provider.
- Codex workers with working copies, merging, Review changes, approvals, questions, step in and hand back, and resuming.
- The user's Codex skills and saved Codex prompts in the / list.
- The user's own and their plugins' MCP servers and hooks loading in Claude and Codex agents, with Arc's approvals still in charge.
- Falling back to Claude when Codex isn't available, with a visible note.
- Checking for new models and provider updates when Arc opens, showing the update command, and picking up both without restarting where possible.

### Out-of-Scope

These are planned as later specs (see the product definition):

- Cursor as a third provider; the provider setting will gain a Cursor option then.
- Choosing models based on how much of each subscription is used, and usage gauges (usage awareness).
- Managing Codex prompts and plugins from Settings, like the Claude Code Plugins page.

---

## Change Log

- 2026-10-19 — user decision during /awos:tech — Codex prompts are deprecated in favour of skills, so the / list shows Codex skills and prompts. Agents now load the user's own and their plugins' MCP servers and hooks for both Claude and Codex (new section 2.6), but not their permission rules; changing MCP tools go through Arc's approvals. This reverses part of spec 005.
- 2026-10-19 — user request during /awos:implement — added section 2.8: checking for new models and newer provider tools when Arc opens, showing the update command, and picking them up without a restart where possible, with a restart prompt otherwise.
- 2026-10-20 — /awos:verify — all 31 criteria verified in the real app with fake Claude and Codex CLIs; screenshots in `docs/screenshots/007-codex-as-a-second-provider-*.png`. Four were accepted by the user on wiring evidence because they depend on real model or OS behaviour: the brain choosing Codex for a second opinion (2.2), a Claude worker choosing the Figma tool (2.6), the real Claude CLI ignoring the user's "always allow git push" rule (2.6) and a true relaunch on Restart now (2.8). See Open Questions in tasks.md.
