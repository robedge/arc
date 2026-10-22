<!--
This document describes HOW to build the feature at an architectural level.
It is NOT a copy-paste implementation guide.
-->

# Technical Specification: Sessions with a Brain and Workers

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Draft
- **Author(s):** redgell, with the agent-orchestration, electron-main, sqlite-database and svelte-frontend specialists

---

## 1. High-Level Technical Approach

Sessions add an **engine** in the main process and a **session screen** in the renderer. Both are built on the existing patterns: zod IPC contract, constructor-injected services, Drizzle repositories, and the HUD `ui/` kit.

- **Agents:**
  - Every agent (the brain and each worker) is one long-lived local `claude` CLI process. It runs headless with stream-json on stdin and stdout. Arc never calls a model API directly and never touches credentials.
  - A single parser module turns the CLI's output into a small, normalized `AgentEvent` union.
- **Coordination:**
  - Agents talk to Arc through a local **MCP bridge**: a streamable-HTTP MCP server on `127.0.0.1` with a random port and per-agent bearer tokens.
  - Brain tools spawn and steer workers; worker tools report progress and ask questions.
  - Worker permission prompts are routed through the bridge as `request_permission`.
- **Rules live in the orchestrator, not in prompts:**
  - the plan-first gate;
  - the worker limit;
  - model overrides;
  - the four never-auto-approve permission categories.
- **Git:**
  - Each session creates one session branch per git project, checked out in the user's own checkout.
  - Each worker works in its own `git worktree`.
  - Merges and conflict resolution happen in a temporary merge worktree. The user's checkout is fast-forwarded only when it is clean.
- **Persistence:**
  - Everything the screen shows lives in new SQLite tables, so a session reopens from the database in milliseconds.
  - Agent processes are respawned with `--resume` lazily, only when the user continues.
  - Worker transcripts are append-only log files.
- **Renderer:**
  - A Sessions tab comes first in the group's section nav.
  - A fixed-height session screen has three independently scrolling areas: conversation, agent cards and event log.
  - The existing attention badge and dialog are wired to live data.

### Affected areas

- **New:**
  - main: `src/main/sessions/`, `src/main/agents/`, `src/main/bridge/`, `src/main/git/`
  - shared: `src/shared/types/session.ts`
  - DB: `0005_sessions_brain_workers`
  - renderer: `lib/components/sessions/`, two new stores
- **Changed:**
  - `src/shared/ipc/contract.ts`
  - `src/main/app/bootstrap.ts` (wiring, quit sequence, startup recovery)
  - `ui.activeSectionId` default
  - `SectionNav`, `GroupView`, `GroupSidebar` (amber dot)
  - `MarkdownPreview` (code Copy button)
  - `RingLogo` (`spinning` prop)
  - `AttentionDialog` (`initialRequestId` prop)
  - the Design Preview
- **New dependency:** `@modelcontextprotocol/sdk`, pinned exactly to a 1.x release. No native modules. node-pty and xterm.js are deferred to the terminal take-over spec.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1. Verified CLI facts (claude 2.1.302)

These were checked with `claude --help`, `claude --version` and `claude auth status`, then confirmed by spike S0 against the real CLI.

| Need | Flag / command | Note |
|---|---|---|
| Headless streaming | `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages` | `--verbose` is required with `-p --output-format stream-json` (confirmed in S0: claude exits 1 without it). |
| Model | `--model <alias\|name>` | Aliases `opus`, `sonnet` and `haiku`, plus the full names reported in the `init` event |
| Project access | `--add-dir <dirs...>` | **There is no `--cwd` flag.** The working directory is the spawn `cwd`. |
| Group context | `--append-system-prompt` | `--system-prompt-snapshot` (on by default) keeps the first prompt on resume. Later context changes are sent as a user message. |
| Resume | `--resume <id>`, `--session-id <uuid>` | The Claude session id is stored as soon as `init` arrives. |
| Bridge | `--mcp-config=<file> --strict-mcp-config` | The flag is variadic, so always use the `=` form. |
| Permission routing | `--permission-prompt-tool mcp__arc__request_permission` | **Not shown in `--help`, but confirmed in S0.** The tool receives `{tool_name, input, tool_use_id}` and returns `{behavior:"allow",updatedInput}` or `{behavior:"deny",message}` as JSON text. |
| Permission modes | `--permission-mode acceptEdits\|plan\|…`, `--allowedTools`, `--disallowedTools` | In `plan` mode MCP tools must declare `readOnlyHint: true` to be callable (S0 item 4). |
| Login check | `claude auth status --json` returns `{loggedIn, authMethod, …}` | Uses no quota. Parse the JSON and ignore the exit code. |

**Spike S0 results (done, claude 2.1.302, `--model haiku`).** Ten short real haiku `-p` runs plus one not-logged-in run (no model call). Fixtures are in `tests/fixtures/claude/2.1.302/` (see its README for the capture commands).

1. **`--permission-prompt-tool` works as designed.** With `--permission-prompt-tool mcp__arc__request_permission`, claude calls the MCP tool with arguments `{tool_name, input, tool_use_id}` (for example `{tool_name:"Bash", input:{command, description}, tool_use_id:"toolu_..."}`). The tool returns one text content block whose text is the JSON decision. `{behavior:"allow", updatedInput:<input>}` runs the tool (`out.txt` was written). `{behavior:"deny", message}` produces a `tool_result` with `is_error:true` and the message as content, the file is not written, and the final `result` lists the call in `permission_denials`. The tool must be a normal MCP tool: the arguments schema should accept `tool_name`, `input` and `tool_use_id`. Fixtures: `permission-prompt.jsonl`, `permission-deny.jsonl`.
2. **Interrupt works and keeps the process alive.** Writing `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}` to stdin mid-reply stops the stream. claude answers with `{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"still_queued":[]}}}`, emits a user event `[Request interrupted by user]`, keeps the partial assistant text, and ends the turn with a `result` with `subtype:"error_during_execution"`, `is_error:true`, `terminal_reason:"aborted_streaming"`. The process stays up, and the next user message on stdin was answered normally (`terminal_reason:"completed"`). The adapter must not treat that interrupt `result` as a crash. Fixture: `interrupt.jsonl` plus `interrupt.stdin.jsonl`.
3. **`MCP_TOOL_TIMEOUT` is honored** (milliseconds, passed in the spawn env). With `10000` and a 70 s tool, claude returned `MCP server "arc" tool "slow" timed out after 10s` after about 10 s. With `300000` the same tool completed after 73 s (past the SDK 60 s default), so long-poll tools work if the env value is large. Fixture: `mcp-timeout.jsonl`.
4. **`--permission-mode plan` blocks MCP tools unless they declare `annotations.readOnlyHint: true`.** With `--allowedTools "Read Grep Glob mcp__arc__*"` and `--disallowedTools "Edit Write NotebookEdit Bash"`, calling a plain `mcp__arc__ping` failed with `Cannot call mcp__arc__ping while in plan mode.`. The same run with a tool registered with `readOnlyHint: true` succeeded (`pong-ro`). `--allowedTools` does not override this. So in plan mode only bridge tools annotated read-only are callable; non-read-only bridge tools (such as `spawn_worker`) need either that annotation or a different permission mode for the brain. **Decision (user, 2026-10-17):** the brain does not use plan mode. It runs in the default mode with an allowlist instead (see §2.3). Fixtures: `plan-blocked.jsonl`, `tool-turn.jsonl`.
5. **`--verbose` is required** with `-p --output-format stream-json`. Without it claude exits 1 immediately with `Error: When using --print, --output-format=stream-json requires --verbose` (no model call). Keep passing it.
6. **Auth failure is in-stream, not on stderr.** With an empty `HOME` the stream is `system/init`, one synthetic `assistant` message (`model:"<synthetic>"`, text `Not logged in · Please run /login`), then a `result` with `subtype:"success"`, `is_error:true`, `terminal_reason:"api_error"`, `result:"Not logged in · Please run /login"`. Exit code 1, stderr empty. Detect it by `is_error` plus that text, and keep `claude auth status --json` as the primary check. Fixture: `auth-failure.jsonl`.
7. **Other observations.** MCP tools are deferred in 2.1.302: the model first calls `ToolSearch` (`select:mcp__arc__...`) before the first MCP call, so the first bridge call costs an extra step. The `init` event lists `mcp_servers` with `status:"connected"` and `permissionMode`. A `rate_limit_event` appears before the final `result`. SessionStart hooks from user settings show up as `system/hook_started` and `hook_response` events (the parser must ignore them); `--setting-sources project` suppresses them. The MCP server is probed with `server/discover`, `initialize`, `notifications/initialized`, a GET stream and `tools/list`, so a stateless streamable-HTTP bridge works.

### 2.2. Architecture Changes

```
Renderer (session screen) ──IPC──> SessionService ──> Orchestrator ──> AgentAdapter (claude) ──> ProcessSupervisor ──> claude CLI
        ^                               |                 |  ^                                                         |
        └────── push events (batched) ──┘                 |  └── BridgeServer (MCP, 127.0.0.1) <── tool calls ─────────┘
                                                          ├── PolicyClassifier
                                                          ├── GitService (branches, worktrees, merge queue)
                                                          └── AttentionService ──> NotificationService
```

| Module (path) | Responsibility |
|---|---|
| `src/main/sessions/session-service.ts` | Session lifecycle: create, list, rename, delete and open (snapshot). Runs the dirty-tree flow and config changes. Emits push events. |
| `src/main/sessions/orchestrator.ts` | One instance per open session. Owns the brain and the workers. Enforces the plan gate, the worker limit and the queue drain, and resolves the effective model. Routes attention and handles exits and resume. |
| `src/main/sessions/attention-service.ts` | Persists requests, computes counts per session and per group, settles waiting bridge calls, and fires notifications. |
| `src/main/sessions/notification-service.ts` | Electron `Notification` when no window is focused. A click focuses Arc and sends `session:open-attention`. Has an e2e stub. |
| `src/main/sessions/terminal-log.ts` | Per-worker transcript, written as human-readable plain text with ANSI stripped, to `userData/sessions/<sid>/workers/<wid>.log`. Keeps a 1 MB in-memory tail and caps each file at 20 MB by trimming the head. |
| `src/main/sessions/batcher.ts` | `createBatcher(flushMs, maxBytes, flush)` for deltas, terminal chunks and event-log entries |
| `src/main/agents/agent-adapter.ts` | `AgentAdapter` interface and `AgentHandle` (`send`, `interrupt`, `stop`, `events`, `pid`) |
| `src/main/agents/claude-adapter.ts` | Builds the arguments for each role, spawns through the supervisor, and handles the interrupt ladder |
| `src/main/agents/claude-parser.ts` | stream-json line to `AgentEvent \| null`. Uses permissive zod schemas. An unknown type becomes `unknown` and never throws. |
| `src/main/agents/process-supervisor.ts` | Spawns with `detached:true` (process group), sanitizes env, splits NDJSON lines, keeps a stderr ring, classifies exits, keeps the pid ledger and sweeps orphans |
| `src/main/agents/cli-resolver.ts` | Login-shell PATH resolution, `HARNESS_CLAUDE_BIN` override, and the `checkClaude()` states |
| `src/main/bridge/bridge-server.ts` | MCP server: `StreamableHTTPServerTransport` in stateless mode, loopback `Host` check, token-to-agent map, tool sets per role |
| `src/main/bridge/tools/*.ts` | One file per tool, with a zod input schema |
| `src/main/policy/classify.ts` | `classify(toolName, input, ctx)` returns `{category, mustEscalate}` (see 2.6) |
| `src/main/git/git.ts` | Typed wrapper over the system `git`, using the `ExecFn` pattern. It allows only an allowlist of subcommands. `push`, `fetch`, `pull`, `remote` and `reset --hard` do not exist in the wrapper. |
| `src/main/git/session-git.ts` | Session-branch creation, base-branch detection, dirty check, worktrees, the per-repo merge queue, sync and cleanup |

**Wiring.** A `createSessions(deps)` factory is called from `bootstrap.ts` after the DB, project service and availability service are created. It returns `{service, attention, shutdown, recover}`. The `handle()` registrations go in `register.ts`. Each of these is injected so unit tests can use fakes: `emit`, `exec`, `spawn`, `env`, `now`, `newId`, `notify`.

### 2.3. Agent process model

| Agent | cwd | Key flags | Tool access |
|---|---|---|---|
| Brain | The group's knowledge directory | `--add-dir` for every project's main checkout (on the session branch), `--permission-prompt-tool mcp__arc__request_permission` | Default permission mode. `--allowedTools` Read, Grep, Glob, WebFetch, WebSearch, ToolSearch and the exact `mcp__arc__*` brain tools. `--disallowedTools` Edit, Write, NotebookEdit. **Bash is neither allowed nor disallowed**, so every Bash call reaches `request_permission`, where the brain policy (§2.6) lets read-only commands through and escalates the rest to the user (**user decision 2026-10-17, "read freely, ask for changes"**). Any tool other than Bash reaching the permission tool is denied. Without the bridge there is no permission tool and Bash is refused in `-p` mode, as before. The brain never edits code. Don't use plan mode: per S0 it blocks bridge tools that aren't marked read-only. |
| Worker | Its own worktree | `--add-dir` for the knowledge directory and the other session repositories' main checkouts (read) | `--permission-mode acceptEdits`. `--permission-prompt-tool mcp__arc__request_permission`. Writes outside the worktree reach the permission tool and are escalated. |
| Conflict resolver | A temporary merge worktree | Same as a worker | Same as a worker. It is a short-lived worker the orchestrator starts for a conflicting merge. |

- **Stop a reply:**
  1. Send the stream-json interrupt.
  2. If there is no `result` within 3 s, send SIGINT.
  3. If it still hasn't stopped, kill the process and respawn later with `--resume`.

  The text already streamed is kept and marked `stopped`.
- **Stop a worker:**
  1. Send the interrupt.
  2. After 5 s, send SIGTERM to the process group.
  3. After 5 s more, send SIGKILL.
- **Exit classification:**
  - **Done:** exit code 0 after a `result` and `report_done`.
  - **Stopped:** a kill started by the supervisor.
  - **Failed:** anything else. The reason comes from the signal or code and the last stderr lines.
- **Env:** built from an allowlist: `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `PATH` (merged), `SSH_AUTH_SOCK`, `TERM=dumb`, and `MCP_TOOL_TIMEOUT`. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are dropped so usage always runs on the subscription. `ELECTRON_*`, `NODE_OPTIONS`, `CLAUDECODE`, `CLAUDE_CODE_*` and `HARNESS_*` are dropped too.
- **PATH:** resolved once at startup in the background with `$SHELL -ilc` (output between sentinel markers, 3 s timeout). The result is merged with `process.env.PATH` plus `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`. It is re-run on Retry. This fixes apps launched from Finder, which get `PATH=/usr/bin:/bin`. This was confirmed: `claude` was not found with that PATH.

**Normalized `AgentEvent` union** (each carries `agentId` and `ts`):
- `session {providerSessionId, model}`
- `text-delta {messageId, text}`
- `assistant-message {messageId, text}`
- `tool-use {toolUseId, name, summary}`
- `tool-result {toolUseId, isError}`
- `turn-result {ok, interrupted, durationMs}`
- `usage {...}` (recorded but not displayed)
- `rate-limit {resetsAt?}`
- `error {kind: auth|not-installed|rate-limit|api|parse|unknown, message}`
- `exit {code, signal, expected}`
- `unknown {raw}`

### 2.4. MCP bridge contract

- **Transport and identity:**
  - Binds `127.0.0.1:0` and rejects any `Host` other than the loopback.
  - A random bearer token is minted per agent and mapped to `{sessionId, agentId, role}`. `tools/list` is filtered by role. Tokens are revoked on exit.
  - The config file is `userData/mcp/<agentId>.json` (mode 0600). It is rewritten on every spawn, because the port changes, and deleted on exit.
- **Blocking tools** write an `attention_requests` row or a plan row first, then wait on a promise keyed by request id. They send MCP progress notifications every 20 s. If the call dies because of a timeout, quit or crash, the request stays pending in SQLite, and the answer is delivered later as a user message to the resumed agent.

| Tool | Role | Input | Result | Blocks |
|---|---|---|---|---|
| `propose_plan` | brain | `{workers:[{name, task, repos[], model, rationale}]}` | `{planId, decision: approved\|changes_requested\|rejected, models?, comment?}` | yes, until the user acts |
| `spawn_worker` | brain | `{name, task, repos[], model?, dependsOn?[]}` | `{workerId, status: started\|queued}` or error `plan_not_approved` / `unknown_repo` | no |
| `message_worker` | brain | `{workerId, text}` | `{delivered}` | no |
| `get_worker_status` | brain | `{workerId?}` | `[{id, status, note, files[], lastReport}]` | no |
| `merge_worker` | brain | `{workerId}` | `{merged, result: clean\|resolved\|needs_user, files[], pendingFastForward?[], note?}` | waits for the repo's merge queue (and for the resolver) |
| `sync_worker` | brain | `{workerId, fromWorkerId, note?}` | `{synced, conflicts?, files[], notified}` | waits for the merge queue |
| `resolve_request` | brain | `{requestId, decision: approve\|deny\|answer, answer?, note}` | `{ok}` or error `policy_requires_user` | no |
| `escalate_to_user` | brain | `{requestId, reason}` | `{ok}` | no |
| `ask_user` | brain | `{question}` | `{answer}` | yes |
| `report_progress` | worker | `{note, filesChanged?[]}` | `{ok}` | no |
| `report_done` | worker | `{summary, commits[]}` | `{ok}` | no |
| `ask_brain` | worker | `{question}` | `{answer}` | yes |
| `request_permission` | worker | `{tool_name, input, tool_use_id?}` | `{behavior:"allow", updatedInput}` or `{behavior:"deny", message}` | yes |

If the brain doesn't act on a request addressed to it within 60 s, it is escalated to the user automatically.

### 2.5. Orchestrator rules

- **Plan-first gate:** while the mode is `plan_first`, `spawn_worker` is rejected unless the call matches an approved plan entry (by name and repositories).
  - **Ask for changes** returns `changes_requested` with the user's next message. The old plan becomes `replaced` when the new one arrives.
  - **Reject** returns `rejected`.
  - Switching the mode applies to the next `spawn_worker` call.
- **Automatic merge:** when a worker (not a merge resolver) becomes `done`, the orchestrator runs the same path as `merge_worker` through the merge coordinator and the repository queue (`MergeCoordinator.autoMerge`). The brain gets "[Arc] Merged W1 api-retry into arc/<slug> automatically." (with a note when a resolver settled a conflict), "[Arc] W1 … is done. Merging it into … hit a conflict: …" when the user must decide (the later "is merged now" message follows), or the error when the merge failed; it is not sent the "finished" message in that case. `merge_worker` on a merged worker returns `already_merged` and remains the retry for a failed merge. `OrchestratorDeps.engine.autoMerge` (default true) lets tests merge by hand.
- **Stop and Remove:** `workers:stop` (user) ends the worker and, once the process has exited and its HEAD is recorded, counts `git rev-list --count <branch>..<head_sha>` per working copy (the pending merge ref counts as merged), then runs `git worktree remove --force` through the wrapper, deletes the folder, runs `git worktree prune` and removes empty parent folders. The row is marked `removed_at` on `worker_worktrees`; the event is "Stopped by you; working copy removed" plus " (N unmerged commits discarded)" when N > 0. Stops with `stopped_by` `quit` or `crash` and a queued worker's stop never remove anything, so Slice 10's Continue only applies to those. `workers:remove` accepts `done`, `merged`, `failed` and `stopped` workers (not queued, running or being merged), force-removes any working copy left, sets `workers.removed_at`, and logs "Removed W1 api-retry". Removed workers are left out of the snapshot, `session:worker-changed`, `get_worker_status` and the final-summary count; the row stays for event and merge history, and the worker number is not reused.
- **Worker limit:** these statuses count as running: starting, working, needs_approval, has_question. At or over the limit, a new worker is stored as `queued`. The queue drains whenever a worker leaves those states.
- **Effective model:** the first of these that is set wins:
  1. a specific session model, set in the header;
  2. the model the user picked on the plan card;
  3. the brain's proposal;
  4. the default (`sonnet`).

  The value is validated against the known aliases and the `init` models. An unknown value falls back to the default, with an event-log note.
- **Session name:** the brain is asked, in its system prompt, to start its first reply with a short title. The orchestrator also has a fallback, `deriveName(request)`. The branch slug is created from the name before any branch is made, so the branch waits for the first reply. Fallback slug: `session-<shortid>`.

### 2.6. Policy classifier (never auto-approved)

`classify` reads the **structured** tool name and input, never model text. Bash commands are split with a real shell-word tokenizer on `;`, `&&`, `||`, `|`, `$()` and backticks, and each segment is classified. Anything that can't be parsed (`eval`, `bash -c`, here-strings, encoded payloads) counts as destructive.

| Category | Examples detected |
|---|---|
| Outside worktree | **Changing** files outside the worker's worktree: Edit, Write or NotebookEdit paths, Bash redirect, `cp`, `mv`, `rm`, `mkdir`, `touch`, `tee` or `sed -i` targets that resolve (via realpath) outside it. This includes the user's main checkout, and any project checkout of the worker's, even one inside the temp folder. Reading is never flagged: `grep`, `rg`, `cat`, `head`, `tail`, `less`, `wc`, `ls`, `find` without `-delete`, `file`, `stat`, `diff`, `jq`, `sed` without `-i`, `awk`, `cd`, and the Read, Grep and Glob tools. `cd` only moves the working directory used to resolve later writes. |
| Leaves the machine | `git push`, `git remote add`, `gh`, `glab`, `curl` or `wget` with `-X POST\|PUT\|DELETE`, `-d`, `-F` or `--upload-file`, `scp`, remote `rsync`, `ssh`, `npm publish`, `docker push` |
| Destructive | `rm -r` or `-f`, `git reset --hard`, `git clean`, `git branch -D`, any force push, `git checkout -- .`, `git stash drop` or `clear`, `git rebase`, `git worktree remove`, `dd`, `mkfs`, `chmod -R`, `chown -R`, `find … -delete`, `truncate` |
| Global install | `brew install`, `npm i -g`, `pnpm add -g`, `yarn global`, `pip install` outside a venv, `gem install`, `cargo install`, `go install`, `sudo`, `apt` |

**Temp folder.** A write strictly inside `os.tmpdir()`, its realpath (`/private/var/folders/...` on macOS) or `/tmp` (realpath `/private/tmp`) is allowed without asking (`ClassifyContext.tempDirs` overrides the list in tests). The check runs after the worktree and read-only-directory checks, on the realpath, so a symlink or `..` that leaves the temp folder is still flagged. `rm -rf /tmp/x` stays destructive.

**Brain policy** (`src/main/policy/brain-policy.ts`, `classifyBrainBash`, used by `AttentionCoordinator.brainRequestPermission`). The brain has no working copies and may write only in the system temp folder, so the default is inverted: a command is allowed without a row only if it is read-only. The worker rules run first (`classifyBashCommand` with no worktree roots), so a push, a deletion or a global install keep their own categories. A write outside the temp folder maps to `changes_checkout`. Then every segment (after wrappers such as `env` and `xargs`) must be read-only, or the whole command is `changes_checkout` ("`git commit` may change files or git state in your checkouts"). Read-only means: `git` with `diff`, `log`, `status`, `show`, `blame`, `rev-parse`, `ls-files`, `ls-tree`, `cat-file`, `rev-list`, `describe`, `shortlog`, `grep`, `merge-base` and similar; `branch`, `tag`, `remote`, `config` and `reflog` only in their listing forms; `stash list` and `stash show`; `worktree list`; never with `-c`, `--output` or `git grep -O`. Also `grep`, `rg` (not `--pre`), `ls`, `cat`, `head`, `tail`, `wc`, `find` (no `-delete`, `-exec`, `-ok`, `-fprint*`), `jq`, `sort` (not `-o`), `uniq` (one operand), `cut`, `tr`, `diff`, `stat`, `file`, `du`, `df`, `tree`, `echo`, `printf`, `cd`, and `npm`, `pnpm`, `yarn` or `bun` with `ls`, `list`, `view`, `info`, `outdated`, `why` and similar. `mkdir`, `touch`, `tee`, `cp`, `mv`, `ln`, `rm` and `rmdir` pass only when the worker rules found every target inside the temp folder. Interpreters with code strings (`node -e`, `python -c`), test runners, `curl`, `sed` and `awk` are not read-only. `git rebase` stays `destructive` (the worker rule) for the brain. Every brain verdict has `mustEscalate`, and `resolve_request` refuses a brain row (`not_resolvable`).

| Category (brain only) | Examples |
|---|---|
| Changes checkout (`changes_checkout`) | `git commit`, `checkout`, `switch`, `merge`, `cherry-pick`, `stash` (not list or show), `reset` (not `--hard`), `restore`, `add`, `rm`, `mv`, `branch <name>`, `tag <name>`, `worktree add`, `pull`, `fetch`, `npm install`, `npm test`, `node -e`, `echo x > file`, `mkdir` outside the temp folder |

**Where `changes_checkout` fits.** It is stored like the other categories (`attention_requests.category` and `session_allow_rules.category`, a TypeScript enum with no SQL constraint, so no migration). Auto-approve covers it (only `isPublishAction` requests are excluded, so `git push` and merge or pull requests still ask), and an Always-allow rule works for it: category, tool and prefix must match (`git commit`), with no folder. Brain rows have `source: 'brain'`, `kind: 'permission'`, `escalated: true`, `workerId: null` and show "Brain" as the sender; the brain state is `waiting` while one is outstanding (the same counter as `ask_user`); the CLI call continues with `{behavior:'allow', updatedInput}` or `{behavior:'deny', message}` (S0). A rule or Auto-approve turned on later releases a waiting brain request through `resolveCovered()`.

A match sets `mustEscalate`: the request goes straight to the user, and `resolve_request(approve)` on it fails with `policy_requires_user`. Anything else (category null) is allowed at once, with no row and no brain turn. The brain path is used for worker `ask_brain` questions. `Classification.paths` holds the real outside paths a request changes (outside-worktree only).

**Allow rules and Auto-approve** (`src/main/policy/allow-rules.ts`, applied by `AttentionCoordinator.requestPermission` after `classify` and before a row is created).
- `attention:answer {requestId, approve: true, always: true}` derives a rule from the stored request: `{category, tool, prefix, folder}`. `prefix` is `commandPrefix(command)`: the command word plus its subcommand (`git push`, `gh pr create`, `curl`; for `gh` and `glab` two words), a leading `cd` ignored, every distinct part of a compound command joined with ` && `, and the exact command text for `bash -c`, `eval`, a command from a variable or anything unreadable. `folder` is set only for outside-worktree requests: the deepest common parent folder of the targets (no rule is made when it is `/`).
- A request matches a rule when the category, tool and prefix are equal and, with a folder, every target is inside it. A match returns `allow` with no row, no brain turn and the event `Allowed by your rule: <text>` (kind `allow-rule`). Rules apply even to pushes, because the user chose them.
- `sessions.auto_approve` (`sessions:set-config {autoApprove}`) approves every classified request that is not a publish action, with the event `Auto-approved: <command>` (kind `auto-approved`). `isPublishAction` is true for `git push` (any form, so force pushes too), `gh pr …`, `glab mr …`, any `gh` or `glab` command with a `create` or `merge` word, `gh api` with a non-GET method or fields, and, as plain text, any `git … push`, `gh pr` or `glab mr` inside a shell string Arc cannot parse. Other leaves-the-machine commands (`curl -d`, `npm publish`, `scp`) are covered by Auto-approve.
- When a rule is added or Auto-approve is turned on, `resolveCovered()` re-classifies every pending permission request and approves the covered ones, logging as above.

### 2.7. Git workflow

| Step | Design |
|---|---|
| Base branch | Local `dev`. If there isn't one: `git symbolic-ref --short refs/remotes/origin/HEAD` (with `origin/` stripped), then `init.defaultBranch` if it exists, then `main` or `master`, then the current HEAD. The result is stored per repository. |
| Session branch | `arc/<slug>` (kebab-case ASCII, at most 40 characters). A name collision gets `-2`, `-3` and so on. It is checked out in the user's main checkout. |
| Dirty check | `git status --porcelain=v1 -z` on every git project before any switch. Untracked files count. The choices are returned to the renderer as `needsDirtyChoice`. |
| Dirty choices | **Set aside:** `git stash push --include-untracked -m "arc:<session>"`, with the stash ref recorded. **Commit first:** `git add -A` and a WIP commit on the current branch. **Bring along:** `git checkout -b arc/<slug> <base>` carrying the working tree. If that fails, the user is told and offered the other choices. **Cancel:** any repositories already switched go back to their previous branch, and no session is created. |
| Worker worktree | `git worktree add --detach userData/worktrees/<sessionId>/<workerId>/<repo> arc/<slug>`. The worktree **has no branch of its own**. It starts at the session-branch tip, and the worker commits on a detached HEAD. `arc/<slug>` itself can't be used, because it is already checked out in the user's main checkout. Git keeps the worker's commits reachable through the worktree's HEAD for as long as the worktree exists, and Arc records the HEAD sha after every commit. Only `arc/<slug>` ever appears in the user's branch list. This **replaces the `arc/<slug>/<worker-slug>` worker branches named in architecture.md.** |
| Merge | One promise queue per repository path (shared by every session). 1. Make a detached temporary worktree `…/<sessionId>/_merge/<repo>` at the session tip: the pending merge if there is one, else the `arc/<slug>` tip. 2. Run `git merge --no-ff --no-edit --no-verify -m "Merge W<n> <slug>" <worker HEAD sha>` (the sha is the recorded `head_sha`). 3. Publish the new commit, **corrected design**: `arc/<slug>` is checked out in the user's checkout, so moving only its ref would make their index and files look as if the merge were undone. (a) Checkout on `arc/<slug>` and clean: `git merge --ff-only <merge sha>` there moves the ref and the files together. (b) Checkout on `arc/<slug>` and dirty: **nothing is moved.** The merge commit is kept under `refs/arc/pending/<slug>` ("pending fast-forward"), the event log says "Session branch update waiting: your checkout of <repo> has unsaved changes" (once), and `merge_worker` returns `pendingFastForward: [repo]`. The next merge builds on the pending tip; the fast-forward is retried on every next merge, when the session is opened, and before the final summary. If the user committed on the branch meanwhile (branch tip is no longer an ancestor of the pending tip), the merge fails with `branch_diverged` and nothing is lost. (c) Checkout on another branch (the user switched away): `arc/<slug>` is checked out nowhere, so `git update-ref refs/heads/arc/<slug> <new> <old>` is safe. In (a) and (c) a failed old-value check (the branch moved while merging) discards the merge worktree and redoes the merge (up to 3 times). 4. Remove the `_merge` worktree (forced; it is Arc's own) after every attempt. |
| Conflict | A short-lived resolver worker is started in the merge worktree (a `workers` row with slug `merge-conflict`, marked `depends_on_json = ["arc:merge-resolver"]`, and a `worker_worktrees` row for the merge path; it ignores the worker limit, is hidden from the final-summary count and never notifies the brain). Its task lists the conflicting files; it runs `git add` and `git commit --no-edit`. If it only staged, Arc commits the finished merge. Arc checks that the result contains both parents and has no unmerged files. The merge counts as `resolved` and is listed in the final summary; the event log gets "Resolved conflict in <project>/<file>". If the resolver is not confident it calls `ask_brain`; Arc prefixes the question with the files and merge ("Conflict in api/README.md while merging W2 …") so the user's question always names the file. When that question is passed on to the user, `merge_worker` returns `{merged:false, result:'needs_user'}` at once while the repository's queue stays held; the merge finishes after the answer, is recorded as `needs_user`, and the brain is told with "[Arc] W2 … is merged now …". A resolver that fails, is stopped or ends without finishing the merge makes the merge fail (`merge_failed`, merge aborted, session branch unchanged, merges row `failed`). |
| Sync between workers | `sync_worker {workerId, fromWorkerId, note?}`, inside the repository's queue, for each project both workers have. In the dependent worker's worktree: `git merge --no-edit --no-verify <sha>`, where `<sha>` is the session tip (pending-aware) when the source is Merged, or the source's recorded head when it is Done and not merged yet. Then `message_worker`-style note to the receiving worker (the brain's `note`, or the default "W1 api-retry's changes to <files> are now in your working copy."), and the event "Shared W1 → W3: <note or files>". Conflicts are left in the receiving worker's working copy, listed in the result (`conflicts`) and in the message; that worker resolves them. |
| Cleanup | After a merge: `git worktree remove` (without `--force`; if it refuses, the worktree is kept and logged). A user Stop and `workers:remove` use `--force` and delete the folder (2.5). There is no worker branch to delete. `git worktree prune` and removal of leftover `_merge` directories run at launch. Session branches are never deleted. |
| Never | The wrapper can't push, fetch, pull, add remotes, or touch `dev` beyond reading it. |

### 2.8. Data Model / Database Changes

The migration is `pnpm db:generate --name sessions_brain_workers`, producing `0005_sessions_brain_workers`. It is additive, with new tables only, and the existing pre-migration backup applies. Ids are ULIDs, except the two append-only logs, which use `integer primary key autoincrement` for exact keyset paging. Timestamps are epoch ms. Foreign keys are `ON DELETE CASCADE` unless noted.

| Table | Key columns | Relationships and indexes |
|---|---|---|
| `sessions` | `id`, `group_id`, `name`, `slug`, `mode` (plan_first\|autonomous), `worker_limit` (CHECK 1–6), `model` ('auto'\|id; workers only), `brain_model` (default 'sonnet'), `auto_approve` (default false), `status` (active\|stopped), `brain_claude_session_id`, `created_at`, `last_active_at` | → groups; index `(group_id, last_active_at DESC)` |
| `session_projects` | `id` (autoinc PK), unique `(session_id, project_id)`, `branch_name`, `previous_branch`, `base_branch`, `read_only`, `dirty_handling` (none\|stashed\|committed\|carried), `stash_ref`, snapshots of the project path and name | → sessions; → projects **SET NULL**, so history survives removing a project |
| `plans` | `id`, `session_id`, `status` (proposed\|approved\|replaced\|rejected), `workers_json`, `replaced_by_id`, `created_at`, `resolved_at` | → sessions |
| `messages` | `id` (autoinc), `session_id`, `role` (user\|brain\|system), `content`, `state` (streaming\|complete\|stopped), `plan_id`, `created_at`, `updated_at` | → sessions; → plans SET NULL; index `(session_id, id)` |
| `workers` | `id`, `session_id`, `number`, `slug`, `task`, `project_ids_json`, `model`, `status` (9 values), `activity`, `failure_reason`, `summary`, `claude_session_id`, `plan_id`, `depends_on_json`, `stopped_by` (user\|quit\|crash), `removed_at` (soft delete, migration `0013_workers_removed_at`), timestamps | → sessions; unique `(session_id, number)`; `(session_id, status)`; `(status)` |
| `worker_worktrees` | `id` (autoinc PK), unique `(worker_id, project_id)`, `path`, `base_sha`, `head_sha` (updated after each worker commit), `removed_at` | → workers |
| `worker_commits` | `id`, `worker_id`, `project_id`, `sha`, `subject`, `committed_at` | → workers |
| `events` | `id` (autoinc), `session_id`, `at`, `kind`, `text`, `worker_id`, `data_json` | → sessions; → workers SET NULL; index `(session_id, id)` |
| `session_allow_rules` | `id`, `session_id`, `category`, `tool`, `prefix`, `folder` (nullable), `text`, `created_at` | → sessions; index `(session_id)`; migration `0012_allow_rules_auto_approve` (also adds `sessions.auto_approve`) |
| `attention_requests` | `id`, `session_id`, `worker_id`, `source` (worker\|brain), `kind` (permission\|question), `action`, `reason`, `question`, `tool_name`, `tool_input_json`, `tool_use_id`, `category`, `must_escalate`, `escalated`, `brain_note`, `status` (pending\|approved\|denied\|answered), `answer`, `delivered`, `created_at`, `resolved_at` | → sessions; partial index `(session_id) WHERE status='pending'` |
| `merges` | `id`, `session_id`, `worker_id`, `project_id`, `result` (clean\|resolved\|needs_user), `files_json`, `merge_sha`, `merged_at` | → sessions |

**How the data is used:**
- **List badge:** the status shown in the session list (Working, Needs attention, Idle, Stopped) is not stored. It is derived per session from pending attention requests, active workers and whether the brain is live.
- **Streaming brain text:** the row is inserted on the first delta (`streaming`). Its content is flushed at most every 1 s or 2 KB. The final write sets `complete` or `stopped`. Arc never writes per delta.
- **Open snapshot** (one read transaction):
  - the session and its `session_projects`;
  - the last 100 messages (`id < cursor` paging for older ones);
  - the last 200 events;
  - all workers and their worktrees;
  - the latest plan;
  - pending attention requests.
- **Startup recovery** (one transaction, before the UI loads):
  - `starting`/`working` workers become `stopped` with `stopped_by='crash'` and an event "Stopped when Arc closed unexpectedly" (a clean quit uses "<label> stopped when Arc quit").
  - `streaming` messages become `stopped`.
  - Workers in `needs_approval`/`has_question` keep their status, because their requests must survive.
- **Delete:**
  1. The service stops the session's processes and reads its worktree rows.
  2. It deletes the session row, and the deletes cascade.
  3. It runs `git worktree remove --force` on those worktrees.
  4. It deletes `userData/sessions/<id>/`.

  Branches are kept. Group delete runs the same cleanup for each session.
- **Repositories** (`src/main/db/repositories/`): `SessionsRepo`, `SessionProjectsRepo`, `PlansRepo`, `MessagesRepo`, `WorkersRepo`, `WorktreesRepo`, `CommitsRepo`, `EventsRepo`, `AttentionRepo`, `AllowRulesRepo`, `MergesRepo`.

### 2.9. IPC Contracts (`src/shared/ipc/contract.ts`)

Every request returns `Result<T>`. Shared types live in `src/shared/types/session.ts`.

| Channel | Request | Response |
|---|---|---|
| `sessions:list` | `{groupId}` | `SessionSummary[]` (id, name, lastActiveAt, status, attentionCount) |
| `sessions:attention-summary` | `{}` | `{byGroup: Record<groupId, number>}` for the sidebar dots at startup |
| `sessions:create` | `{groupId, request, mode, workerLimit}` | `{sessionId}` or `{needsDirtyChoice: {token, repos: DirtyRepo[]}}` |
| `sessions:resolve-dirty` | `{token, choices: Record<projectId, 'stash'\|'commit'\|'carry'\|'cancel'>}` | Same union as `sessions:create` |
| `sessions:open` | `{sessionId}` | `SessionSnapshot` or `{needsDirtyChoice}` |
| `sessions:page` | `{sessionId, kind: 'messages'\|'events', beforeId, limit}` | Older rows |
| `sessions:rename` | `{sessionId, name}` | `SessionSummary` |
| `sessions:delete` | `{sessionId}` | `void` |
| `sessions:send-message` | `{sessionId, text}` | `{messageId}`, or error `CLI_UNAVAILABLE` with the draft kept |
| `sessions:stop-reply` | `{sessionId}` | `void` |
| `sessions:plan-decision` | `{sessionId, planId, decision: 'approve'\|'ask-changes'\|'reject', models?: Record<workerName, model>}` | `void` |
| `sessions:remove-allow-rule` | `{sessionId, ruleId}` | `SessionHeader` without the rule (error `VALIDATION_FAILED` for an unknown rule). Pushes `session:header`. |
| `sessions:set-config` | `{sessionId, mode?, workerLimit?, model?, brainModel?, autoApprove?}` | `SessionHeader` (now with `autoApprove: boolean` and `allowRules: {id, text, category, createdAt}[]`). Turning `autoApprove` on approves the waiting requests it covers. A `brainModel` change takes effect on the next turn: once the current reply ends, the brain is respawned with `--resume <id> --model <new>`. |
| `workers:get` | `{workerId}` | `WorkerDetails` (now with `hasWorkingCopy` and `unmergedCommits`, read from git). `WorkerView` carries the same two fields, with `unmergedCommits` counted from the commits Arc recorded. |
| `workers:stop` | `{workerId}` | `void`. A user stop also removes the working copies and discards unmerged commits. |
| `workers:remove` | `{workerId}` | `void`. Finished workers only (error `VALIDATION_FAILED`: "Stop the worker first" for queued or running ones). Hides the worker and removes any working copy left. |
| `workers:continue` | `{workerId}` or `{sessionId, all: true}` | `void` |
| `workers:open-terminal` | `{workerId}` | `{backlog, seq, truncated}` |
| `attention:answer` | `{requestId, approve, always?}` or `{requestId, text}` | `void`. `always` is allowed only with `approve: true`; it also stores an allow rule (see 2.6). |
| `cli:retry-check` | `{}` | `CliStatus` |

| Push event | Payload | Rate |
|---|---|---|
| `session:brain-delta` | `{sessionId, messageId, seq, text}` | Coalesced, every 50 ms or 4 KB |
| `session:message` | `{sessionId, message}` | Flushes pending deltas first |
| `session:worker-changed` | `{sessionId, worker}` | At most once per 250 ms per worker |
| `session:event-logged` | `{sessionId, entries[]}` | Every 100 ms |
| `session:plan` | `{sessionId, plan}` | On change |
| `session:attention` | `{sessionId, groupId, count, requests}` | On change |
| `session:summary` | `{groupId, summary}` | On a status change, for lists and the sidebar dot |
| `worker:terminal` | `{workerId, seq, text}` | Every 50 ms or 4 KB |
| `cli:status` | `{state: ok\|missing\|signed-out\|error, version?, message}` | On change |
| `session:open-attention` | `{sessionId, requestId?}` | When a notification is clicked |

Every streamed payload carries a `seq`. The renderer drops any chunk whose `seq` is at or below the snapshot's, which covers the race between opening a session and live pushes.

### 2.10. Lifecycle

- **Quit:**
  - The renderer close gate (2 s) is unchanged. `will-quit` runs `sessions.shutdown()` once, with `preventDefault` and a `shuttingDown` flag.
  - The shutdown sequence:
    1. Write Stopped (`stopped_by='quit'`) to the database first.
    2. Settle pending bridge calls as "shutting down", leaving their requests pending.
    3. Send each process an interrupt, then SIGTERM to its group.
    4. After 5 s, send SIGKILL.
    5. Revoke the tokens and delete the MCP configs.
    6. Run the existing cleanup.
    7. Call `app.exit(0)` (a second `app.quit()` is ignored after `will-quit` was prevented).
  - A hard ceiling of 8 s applies. There is no confirm-quit prompt. Closing the window without quitting leaves workers running, which is standard macOS behavior.
- **Open or resume:**
  - The screen renders straight from the snapshot. The dirty check and branch switch run as for create.
  - The brain is respawned with `--resume` only when the user sends a message or clicks Continue.
  - If any workers have `stopped_by` set to quit or crash, a system message offers Continue or Not now. Continue respawns each with `--resume <workerClaudeSessionId>` in its existing worktree and sends "You were interrupted. Continue the task."
  - A worker paused on a request is continued the same way once that request is answered. The answer is delivered as a user turn, which works because its MCP call died with the process.
- **Orphan sweep:**
  - `userData/run/pids.json` records `{pid, pgid, startedAt, agentId, cmdHash}`.
  - At launch, an entry is killed only if `ps -o lstart=,command=` still matches its start time and command, so a reused pid is never killed.
  - Then `git worktree prune` runs and leftover `_merge` worktrees are removed.
- **Rate limits:** a `rate-limit` or `error(rate-limit)` event marks the agent "Waiting for limit" in its activity line. The queue pauses, and Arc retries after `resetsAt` (or after 5 min). It never respawns in a loop, and never shows a rate limit as "signed out".

### 2.11. CLI availability (`cli-resolver.checkClaude()`)

| State | Detection | Banner text |
|---|---|---|
| ok | Binary resolved, `--version` exit 0, `auth status` gives `loggedIn:true` | (none) |
| missing | Binary not found | "Claude Code isn't installed. Install it from claude.com/claude-code, then click Retry." |
| signed-out | `loggedIn !== true`, or an auth error during a session | "Claude Code isn't signed in. Open Terminal, run claude, and sign in, then click Retry." |
| error | Timeout or unparsable output | "Couldn't check Claude Code. Click Retry. Details are in the logs." |

The check runs at startup, on Retry, and lazily before the first spawn. While the state isn't `ok`, a message the user sends is kept as a draft, not lost.

### 2.12. Component Breakdown (renderer)

Paths are under `src/renderer/src/lib/components/sessions/` unless noted.

| Component | Responsibility |
|---|---|
| `SessionsTab` | New Session button, plus a list of `SessionRow`s (name, relative last-active time, status word and tone). Rename and delete are in the row menu. |
| `NewSessionDialog` | Request (required; shows "Enter a request for the brain."), Mode (Plan-first by default), and Worker limit (1–6, default 3) |
| `DirtyTreeDialog` | One row per dirty repository with Set aside, Commit them first, Bring them along. Cancel aborts. |
| `DeleteSessionDialog` | Wording from the functional spec: branches are kept, unmerged working copies are removed |
| `SessionScreen` | `grid h-full min-h-0 grid-rows-[auto_1fr]`. The body is `grid-cols-[minmax(0,1fr)_minmax(300px,380px)]`. The right column is `grid-rows-[minmax(0,1fr)_minmax(120px,32%)]` (agents over event log). Each area is a `Panel scroll` with `min-h-0`. |
| `SessionHeader` | Group and session name (inline rename), `arc/x ← base` and "Read only" chips, `AttentionBadge`, the mode and limit menu, and the model menu ("Model · Auto") |
| `CliBanner` | `Banner` with the text from 2.11 and Retry |
| `Conversation` | Message list. Sticks to the bottom unless the user has scrolled up more than 48px; a "Jump to latest" chip appears when not stuck. "Load earlier" calls `sessions:page`. |
| `MessageBubble` | User, brain or system message. **While streaming it is plain wrapped text; it renders as markdown once complete.** Shows a "Stopped" tag. |
| `PlanCard` | Worker rows with a model `Select`, plus Approve, Ask for changes (focuses the Composer) and Reject. Replaced and Rejected show a tag and disable the buttons. |
| `ContinueWorkersPrompt` | "N workers were stopped when Arc closed. Continue them?" with Continue and Not now |
| `Composer` | Enter sends (unless an IME composition is in progress), Shift+Enter adds a new line. Stop replaces Send while the brain replies. The draft is kept per session. |
| `AgentColumn`, `BrainCard`, `WorkerCard` | The BrainCard's RingLogo spins while the brain is thinking. A WorkerCard shows "W1 · name", the model, the status word and tone, and its activity. Clicking a card in an attention state opens the attention dialog with that request first; otherwise it opens the details. |
| `WorkerDetails` | Task, latest report, changed files, working-copy path, Open terminal, Stop (with a confirmation), and Continue (when Stopped) |
| `EventLog` | Time-stamped rows in fixed-height rows; sticks to the bottom |
| `TerminalPanel` | **Watch-only log view, not xterm.js.** Shows the plain-text transcript from main in a monospace `role="log"` area. It renders only the visible lines (fixed 18px line height), follows the tail, and ignores typed input. |
| `worker-status.ts` | `satisfies Record<WorkerStatus, {label, tone}>`: queued and stopped are faint; starting and working are accent; needs approval and has a question are attention (with glow); done and merged are success; failed is danger. |

**Stores:**
- `stores/sessions-list.svelte.ts` holds summaries per group and attention counts per group. It feeds the amber dot in `GroupSidebar` and is loaded at startup.
- `stores/active-session.svelte.ts` holds the snapshot plus reducers. It uses `$state.raw` arrays that are replaced on each update.
- `stores/stream-buffer.ts` is a pure module that coalesces deltas once per animation frame.
- `App.svelte` routes each push event to `sessionsList.apply` always, and to `activeSession.apply` only when the `sessionId` matches.

**Changes to existing components:**
- **Sessions tab:** `SECTION_SESSIONS = '__sessions__'` is hard-coded first in `SectionNav`, and the `ui.activeSectionId` null fallback becomes Sessions. `storage.missing` still forces Projects.
- **`MarkdownPreview`:** gains `copyCode` (a fence renderer override wraps each block with a Copy button; delegated click; "Copied" for 1.5 s; "Copy failed" on error). DOMPurify must allow `button[data-copy]`.
- **`RingLogo`:** gains `spinning` (default `true`). Reduced motion still wins.
- **`AttentionDialog`:** gains `initialRequestId`.
- **Notification click:** `session:open-attention` triggers `navigateToAttention()`, which selects the group, Sessions and the session, then opens the dialog. If the leave guard refuses, a toast explains why.
- **Design Preview:** gains SessionRow, WorkerCard (every status), BrainCard (idle and thinking), PlanCard (its three states), a code block with Copy, CliBanner, DirtyTreeDialog, the live-wired AttentionDialog, and TerminalPanel.

---

## 3. Impact and Risk Analysis

### System Dependencies

- **Claude Code CLI 2.1.x** on the user's PATH and signed in. Arc depends on its stream-json schema, its flags and `auth status`.
- **System git** (2.50 checked), for worktrees, `update-ref` and stash.
- **Existing parts this builds on:** groups and projects (spec 001), and the HUD kit (spec 002), including AttentionBadge, AttentionDialog, Panel, Modal, Banner and MarkdownPreview.
- **The quit path:** `will-quit` gains an asynchronous shutdown step.
- **Group delete:** must now also clean up session worktrees and log folders.
- **`architecture.md`:** needs two updates. Worker worktrees are detached at the session-branch tip with no worker branch, and merges run in a temporary merge worktree.

### Potential Risks & Mitigations

| Risk | Mitigation |
|---|---|
| CLI flags or the stream-json schema change (`--permission-prompt-tool` is already missing from `--help`) | Spike S0 with recorded fixtures per CLI version. All parsing lives in `claude-parser.ts` with permissive schemas and an `unknown` event. A capability probe at startup shows a banner when a required flag is missing. A manual real-CLI test sits behind an env var and is kept out of CI. |
| Workers escaping their worktree or doing something irreversible | Workers use `acceptEdits` limited to their worktree. Everything else goes through `request_permission`, which goes to the classifier. The git wrapper's allowlist has no push, fetch, pull, remote or hard reset. Unparsable commands are escalated. A unit table of at least 60 commands covers each category and the false positives. |
| The brain writing code | An allowlist of read tools plus bridge tools, with edit and write tools disallowed. Bash goes through the permission tool, which allows only read-only commands and sends the rest to the user. Anything else is refused automatically in `-p` mode, and unit tests assert the brain's arguments and the brain policy table. Conflicts go to a resolver worker. |
| Unmerged worker commits are lost when a worktree is removed (a detached HEAD has no branch keeping them) | Worktrees are removed only after a successful merge, or when the user deletes the session (the confirmation already warns about this). A Stopped or Failed worker keeps its worktree. `head_sha` is recorded, so commits can be recovered from the reflog within git's expiry window. |
| Rewriting the user's checkout while they edit | Merges run in a temporary worktree. The user's checkout is fast-forwarded only when clean; otherwise the event log says so. |
| Long-poll MCP calls timing out, or dying on quit | Requests persist first, progress notifications keep calls alive, `MCP_TOOL_TIMEOUT` is set high, and the fallback delivers the answer as a user turn on resume. |
| "Paused across restart" is really "stopped and resumed" | Workers are stored with a pending request, then resumed with the answer. This is confirmed in S0 and covered by an e2e test. |
| Zombie or orphan processes, or killing a reused pid | Process-group kills, a pid ledger checked against start time and command, a sweep at launch, and a shutdown with a hard deadline. |
| A Finder launch can't find `claude` | Login-shell PATH resolution with a timeout, sentinels, a static fallback and Retry. |
| A stray `ANTHROPIC_API_KEY` billing the API instead of the subscription | The env allowlist drops it. |
| Hitting the rate limit with many parallel workers | Default limit of 3, a "Waiting for limit" state and a paused queue, with no retry loop. Usage-aware choice comes in a later spec. |
| Streaming and log volume (re-renders, database writes, disk) | Batched IPC; animation-frame text flushes; plain text while streaming; message database writes at most once a second; activity throttled to 1 per second; transcripts on disk capped at 20 MB; message pagination. |
| Keychain prompt on first spawn from the GUI app | Manual check on the packaged build, documented in the README. |
| Notifications not appearing in unsigned dev builds | The e2e stub covers the logic, plus a manual check on the packaged DMG. |
| A bridge token leaking | Loopback only, a `Host` check, 0600 config files, per-agent tokens revoked on exit. |

---

## 4. Testing Strategy

- **Unit (main, Vitest node project):**
  - **`claude-parser`:** against the S0 fixtures (text turn, tool turn, interrupt, auth failure, permission prompt) and malformed lines.
  - **`classify`:** the table of at least 60 commands across all four categories, plus the false positives.
  - **Orchestrator with a fake adapter and fake bridge:**
    - plan gate approve, ask-for-changes and reject;
    - worker limit and queue drain;
    - effective-model precedence;
    - auto-escalation after 60 s;
    - `policy_requires_user`;
    - exit classification;
    - resume and continue.
  - **`session-git`:** against real temporary repositories (`git init -b dev`, `GIT_CONFIG_GLOBAL=/dev/null`):
    - base-branch fallbacks;
    - all four dirty choices and the Cancel rollback;
    - worktree create and remove;
    - a clean merge, and a conflict handed to the resolver;
    - fast-forward skipped when the checkout is dirty;
    - sync.
  - **Repositories:** against a real temporary SQLite database with the real migrations (the existing `openDatabase` helper). Covers snapshot queries, paging, startup recovery, and delete cascades.
  - **`process-supervisor`:** against a tiny fake child script, covering the kill ladder, crash classification and the orphan sweep with pid verification.
  - **`cli-resolver`:** the PATH sentinel parsing and each availability state.
- **Renderer (Vitest jsdom, `mockHarness`):**
  - `stream-buffer` coalescing; the `active-session` reducers ignoring other sessions; the sessions-list attention counts and group dot.
  - `NewSessionDialog` validation and defaults; Sessions as the first and default tab (update `section-nav.test.ts`).
  - Composer Enter, Shift+Enter and Stop; Conversation stick-to-bottom and Jump to latest.
  - Copy button; PlanCard states and the models sent on approve; WorkerCard status words and attention-click ordering; `AttentionDialog initialRequestId`.
  - CliBanner Retry; DirtyTreeDialog choices; TerminalPanel windowing and ignoring input; `RingLogo spinning=false`; the notification navigation helper.
- **E2E (Playwright `_electron`):**
  - **Fake CLI:** `HARNESS_CLAUDE_BIN` (only honored with `HARNESS_E2E=1` or in dev) points at `tests/e2e/fixtures/fake-claude.mjs`.
    - It answers `--version` and `auth status` (`FAKE_CLAUDE_AUTH=ok|out`).
    - It replays per-role NDJSON scenario scripts (`delay`, `emit`, `waitForStdin`, MCP tool calls against the real bridge, `exit`, `hang`).
    - It logs its argv and stdin for assertions.
  - **Git fixtures:** temporary repositories, including dirty ones, one without `dev`, and a non-git folder.
  - **Notifications:** `globalThis.__e2e.notifications` and `clickNotification(i)` stand in for real notifications.
  - **Scenarios:**
    - create and validation;
    - branch and dirty dialog;
    - plan approve, revise and reject;
    - autonomous mode with a limit of 2;
    - a worker question the brain answers;
    - `git push` and `brew install` escalated and approved or denied;
    - a crash showing Failed;
    - stop a worker;
    - a conflict resolved, then merged, then the summary;
    - sharing W1 → W3;
    - the watch-only terminal;
    - quit and reopen within 10 s, with the Continue prompt and pending requests still there;
    - delete keeps branches;
    - the signed-out banner with Retry;
    - the 1100×720 layout with independent scrolling.
  - Screenshots go to `docs/screenshots/003-*`.
- **Manual (Open Questions in tasks.md):** spike S0 on the real CLI, a real macOS notification on the packaged build, and the keychain prompt on first spawn.

---

## Change Log

- 2026-10-17 — user request during implementation — Stop removes the working copy (unmerged commits discarded, quit and crash stops keep it), new `workers:remove` with soft delete (`workers.removed_at`), `hasWorkingCopy` and `unmergedCommits` on `WorkerView` and `WorkerDetails`, and Done workers merge automatically with a note to the brain. See 2.5, 2.7, 2.8 and 2.9.
- 2026-10-17 — user request during implementation — The brain gets a shell ("read freely, ask for changes"): `--permission-prompt-tool` and Bash no longer disallowed for the brain; `request_permission` is a tool for both roles (`role: 'any'`, brain routes to `brainRequestPermission`, source `brain`); new category `changes_checkout` and `classifyBrainBash`; `BRAIN_PROMPT_VERSION` 2 with an updated-instructions note. See 2.3 and 2.6.
