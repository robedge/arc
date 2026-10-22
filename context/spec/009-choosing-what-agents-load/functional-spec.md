# Functional Specification: Choosing What Arc Agents Load

- **Topic:** A Settings page where the user switches off the MCP servers, plugins, skills and hooks that Arc's brain and workers load, to cut the fixed setup every request carries.
- **Status:** Completed
- **Author:** redgell

---

## 1. Overview and Rationale (The "Why")

Since spec 007, Arc agents load the user's personal Claude Code setup just as the terminal does: their MCP servers, their plugins (with the plugins' hooks, skills, agents and servers), their `~/.claude` skills and their own hooks. Spec 008 made the cost visible: each Arc agent request carries about 40-47k tokens of fixed setup, and the Setup overhead suggestion tells the user that most of it is the CLI's own instructions plus their plugins, skills and MCP servers. Today the only way to shrink it is to change the setup in the terminal too, which the user does not want.

This spec adds a checklist in Settings. Every item Arc agents can load has an on/off switch, with a separate switch for the brain and for the workers, and an estimate of what it adds to every request. Everything starts on, as today; the user switches off what agents don't need. Nothing changes for the terminal.

**Success looks like this:**

- The user can see what Arc agents load and roughly what each item costs per request.
- The user can switch an item off for the brain, the workers or both, and agents started afterwards don't load it.
- The fixed setup Arc measures for those agents goes down.
- Nothing is switched off unless the user did it.

---

## 2. Functional Requirements (The "What")

### 2.1. The checklist

- Settings gets a page **Agent loading**, next to Providers and Plugins. It lists the items in four groups, plus the Codex servers:
  - **MCP servers:** each server Claude agents get: the user's own (user scope and per-project scope), the servers that plugins ship, and the `.mcp.json` of each project Arc knows. A row says where the server comes from.
  - **Plugins:** each plugin Claude Code has enabled for the user.
  - **Skills:** each skill in `~/.claude/skills`, one row per skill.
  - **Hooks:** the user's own hooks in `~/.claude/settings.json`, one row per hook event (for example `SessionStart`, `PreToolUse`).
  - **Codex MCP servers:** each MCP server in the user's Codex configuration (see 2.3).
- Each row has two switches, **Brain** and **Workers**. The workers column also applies to conflict resolvers. Probes and the launch plan check are not affected.
- **Default is everything on.** A server, plugin, skill or hook that appears later starts on. Arc stores only what the user switched off. An item that disappears stays harmlessly in that list.
- Each row shows "about N tokens per request" when Arc can work it out, otherwise "size unknown":
  - a skill: its name and description (the characters Claude lists per request, divided by 4, rounded up);
  - a plugin: the names and descriptions of its skills, commands and agents, same rule;
  - an MCP server: its tool names, when an agent of this Arc run has reported them; otherwise unknown;
  - a hook or a Codex server: unknown. The page says that the text a hook adds (for example a `SessionStart` hook's output) can't be estimated before it runs.
- Each column shows a total for the items that are on, for example "Workers: about 8.4k tokens per request, plus 3 items of unknown size".
- The page says:
  - changes apply to agents started afterwards, including a resumed agent on its next start;
  - switching off a plugin or a skill for workers removes its commands from Arc's `/` list;
  - Arc's own tools are always loaded;
  - the `~/.claude/agents` folder and `~/.claude/commands` are not part of the list: Arc agents don't load the former, and the latter is always loaded.
- **Acceptance Criteria:**
  - [x] When the user opens Settings, then "Agent loading" is in the page list, and opening it shows the groups MCP servers, Plugins, Skills, Hooks, with a Brain and a Workers switch on every row.
  - [x] Given nothing was ever switched off, when the user opens the page, then every switch is on and Arc has stored nothing.
  - [x] Given a plugin is installed after the user switched another item off, when the user opens the page, then the plugin's switches are on and the other item is still off.
  - [x] When the user switches an item off for Workers and reopens Arc, then it is still off for Workers and on for the Brain.
  - [x] When a row has a known size, it reads "about N tokens per request"; otherwise it reads "size unknown". Hook rows say their output can't be estimated.
  - [x] When the user switches an item off, then that column's total drops by the item's estimate, and the other column's total does not change.
  - [x] Every switch has an accessible name that names the item and the column, and the page can be used with the keyboard alone, row by row, Brain then Workers.
  - [x] The page states that changes apply to agents started afterwards (resumed agents on their next start), that switching off a plugin or skill removes its commands from the `/` list, and that Arc's own tools are always loaded.

### 2.2. What the agents load

- A Claude agent is started without the items that are off for its role:
  - an MCP server that is off is not in the agent's MCP configuration;
  - a plugin that is off is not in the agent's plugin folder, and neither are its commands, skills, hooks and servers;
  - a skill that is off is not in the agent's skills;
  - a hook event that is off is not in the hooks the agent gets.
- A Codex agent is started with each server that is off disabled for that thread. The servers that are on keep asking Arc for approval as before.
- Arc's own `arc` server is never switchable.
- The brain uses the Brain column; workers and conflict resolvers use the Workers column.
- **Acceptance Criteria:**
  - [x] Given an MCP server is off for Workers only, when a worker starts, then its MCP configuration lacks the server; the brain started afterwards still has it.
  - [x] Given a server is off for Brain only, when the brain starts, then its MCP configuration lacks the server and a worker still has it.
  - [x] Given a plugin is off for Workers, when a worker starts, then its plugin folder lacks the plugin, and the brain's folder still has it.
  - [x] Given a skill is off for Workers, when a worker starts, then its skills lack it and keep the others.
  - [x] Given one hook event is off for Workers, when a worker starts, then its hooks file lacks that event and keeps the other events; with every event off, the worker gets no hooks file.
  - [x] Given a plugin is off and a project's own settings enable that plugin, when an agent starts, then the plugin still does not load.
  - [x] Given an item is off, when the user switches it on again, then agents started afterwards load it.
  - [x] Given a Codex server is off for Workers, when a Codex worker starts, then that server is disabled for its thread, and a server that is on is still covered by Arc's approvals.
  - [x] The `arc` server is present in every agent's MCP configuration whatever is switched off.

### 2.3. Codex

Arc keeps the user's real Codex home, so their Codex MCP servers load as in the terminal. The installed Codex supports turning a server off for one thread, so the Codex servers are in the checklist with the same Brain and Workers switches. If Codex is not set up, the group says that its servers can't be listed. Codex plugins, skills and hooks are not part of this spec.

### 2.4. Commands

- Commands run in workers, so the Workers column decides which commands exist in Arc. A plugin or skill switched off for Workers drops out of the `/` list in the message box, and the brain no longer offers it or starts it.
- **Acceptance Criteria:**
  - [x] Given a plugin with a command is off for Workers, when the user types `/`, then its command is not in the list, while it still is when the plugin is on.
  - [x] Given a plugin is off for Brain only, then its commands are still in the `/` list.
  - [x] Given the user switches a plugin off for Workers while a session is open, then the list updates without restarting Arc.
  - [x] Given a command's plugin is off for Workers, when the user sends that command, then Arc treats it as an ordinary message and does not start a worker with it.

### 2.5. Approvals and bypass

- The user's hooks can skip Arc's approvals (spec 007). Settings already warns about the hook events that can say "allow". That warning follows the selection: hooks that are off for a role are not reported for that role. When the roles differ, the warning shows the events for Brain and for Workers separately.
- **Acceptance Criteria:**
  - [x] Given the user's `PreToolUse` hook is off for Workers and on for Brain, when the user opens Providers, then the warning lists `PreToolUse` under Brain and none under Workers.
  - [x] Given the hook is off for both, then the warning no longer lists it, and with no other bypass the warning is gone.

### 2.6. Usage tie-in

- The Setup overhead suggestion's advice for a setup that is mostly the CLI's (the "Most of it is the CLI's own instructions plus your plugins, skills and MCP servers" text) gets a button **Choose what agents load** that opens this page. The Arc-heavy advice has no button.
- The fixed setup Arc measures (spec 008) comes from the first request of a new agent, so agents started after a change show a smaller number without further work.
- **Acceptance Criteria:**
  - [x] When the user opens a session's usage panel or the Usage page and the Setup overhead suggestion shows the CLI-heavy advice, then it has a "Choose what agents load" button that opens Settings on the Agent loading page.
  - [x] When the advice is the Arc-heavy one, there is no such button.
  - [x] Given an MCP server is switched off for Workers, when a new worker's first request is measured, then its total fixed setup is lower than that of an earlier worker.

---

## 3. Scope and Boundaries

### In-Scope

- The Agent loading page with Brain and Workers switches, estimates and column totals.
- Filtering of MCP servers, plugins, `~/.claude` skills, the user's hooks and Codex MCP servers per role.
- The `/` list, the command probe, the brain's command routing and the bypass warning following the selection.
- The link from the Setup overhead suggestion.

### Out-of-Scope

- Terminal behaviour: nothing in `~/.claude`, `~/.claude.json` or `~/.codex` is changed.
- `~/.claude/agents` (Arc agents don't load it, verified) and `~/.claude/commands` (always loaded; not asked for).
- Codex plugins, skills, hooks and rules; the repositories' own hooks and settings.
- Per-session or per-group selections, "All on" / "All off" buttons, and a measured per-item cost (the page estimates).
- Probes and the launch plan check, which keep their own flags.

---

## Change Log

- 2026-10-20 — decisions made by the user before drafting — a checklist per item in Settings; everything on by default with only the off items stored; separate Brain and Workers columns; the spec is written in one pass.
- 2026-10-21 — verified — all 26 criteria. Evidence: `tests/e2e/agent-load.spec.ts` (18 passed) and the screenshots `docs/screenshots/009-choosing-what-agents-load-*.png` (look-and-feel confirmed by the user). The "Arc-heavy advice has no button" criterion is verified by `tests/renderer/suggestions-list.test.ts`, accepted by the user.
