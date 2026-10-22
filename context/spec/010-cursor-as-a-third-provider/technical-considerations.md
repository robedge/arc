# Technical Specification: Cursor as a Third Provider

- **Functional Specification:** `context/spec/010-cursor-as-a-third-provider/functional-spec.md`
- **Status:** Draft
- **Author(s):** redgell

---

## 1. High-Level Technical Approach

Cursor joins Claude and Codex as a third `ProviderId`. Each Cursor agent (brain, worker, conflict resolver) runs its own long-lived `agent acp` process: the Cursor CLI's Agent Client Protocol server, JSON-RPC 2.0 over stdio. This has the same shape as the Codex adapter's `codex app-server`. ACP gives Arc everything the functional spec needs:
- `session/request_permission` routes risky actions into Arc's existing approvals and Needs attention.
- `session/cancel` interrupts a turn.
- `session/load` resumes a session.
- `session/new.mcpServers` hands Arc's MCP bridge to the agent over HTTP for each session.
- Model and mode are set per session.
- `available_commands_update` supplies the commands for the "/" list.

The work comes in two layers:
1. **Generalisation first, with no behaviour change.** Add `'cursor'` to `PROVIDER_IDS` and introduce `PROVIDER_TRAITS`. Replace every two-way `codex ? … : claude` ternary with a trait lookup or an exhaustive switch, so the compiler flags every place a provider is handled.
2. **The Cursor provider.** This covers:
   - an adapter in `src/main/agents/cursor/`;
   - status, models and commands probes;
   - approval normalisation;
   - per-role MCP handling;
   - usage parsing;
   - a "Cursor MCP servers" group on Agent loading;
   - the renderer changes;
   - a scripted `fake-cursor.mjs` for e2e.

ACP is a hidden command and only partly documented, so the design relies on recorded fixtures, a version gate and tolerant schemas. A short list of spikes settles the open points. Most need no model call. Five need one recorded real turn each, and each needs the user's approval.

No database migration: provider columns are plain `text` with no CHECK.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 Facts checked before designing

Probes ran on CLI `2026.10.19-6bbf2c4` (`~/.local/bin/agent`, also `cursor-agent`), with no model call.

**Commands:**
- `agent --version` prints `2026.10.19-6bbf2c4`.
- `agent status` prints `Not logged in` or `✓ Logged in as <email>`.
- `agent about` shows the version, the latest version and the subscription tier.
- Spike N7 (recorded in `tests/fixtures/cursor/2026.10.19-6bbf2c4/`, email scrubbed):
  - `agent status --format json` prints `{status:"authenticated", isAuthenticated, hasAccessToken, hasRefreshToken, userInfo:{email,userId,createdAt}}`. The signed-out shape was not observed (assumed `isAuthenticated:false`), so the check also reads the text `Not logged in` / `Logged in as`.
  - `agent about --format json` prints `{cliVersion, latestStatus:"up_to_date", latestVersion, model, subscriptionTier, osPlatform, osArch, userEmail, terminalProgram, shell, lastRequestId}`. The text form has a `Latest <version> (up to date)` line.
  - **Both `--format json` forms stop at a "Workspace Trust Required" prompt (exit 1) when run in a folder Cursor does not trust; the text forms (`status`, `about`) never do.** The check therefore tries JSON and falls back to the text form.
  - A version is `<year>.<month>.<day>-<hash>`; only the date part is compared (the hash is not a prerelease).
- `agent models` prints `<id> - <label>` lines, about 100 ids including Auto. Effort and `-fast` variants of Claude, GPT/Codex, Grok, Gemini and Composer models are separate ids.

**ACP (`agent acp`):**
- `initialize` (protocol 1) returns `loadSession: true`, `mcpCapabilities: {http, sse}`, `promptCapabilities.image`, `sessionCapabilities.list` and auth method `cursor_login`.
- Without sign-in, `session/new` fails with -32000 "Authentication required". After `authenticate`, it returns:
  - `sessionId`;
  - `modes`: `agent`, `plan` (read-only), `ask` (no edits or commands);
  - `models`: 46 parameterised ids such as `grok-4.7[context=256k,reasoning_effort=high,fast=true]`, with `default[]` as Auto;
  - `configOptions` for mode and model.
- A `session/update` `available_commands_update` follows. It lists the user's commands and skills, including Claude and Codex skills that Cursor also loads.
  - It arrives about half a second after the `session/new` answer, around the `session/set_model` reply (M5), so a probe that stays open for a moment sees it.
  - An entry is `{name, description}` with no source, path or input hint. Cursor appends `(project)`, `(user)` or `(global)` to the description (a file's first line when it has no front matter); its own built-ins (`copy-request-id`) carry no suffix. A project command (`.cursor/commands/shout.md`) is listed only when the agent process runs in that project's folder, so Arc's probe (an empty folder of its own) never lists project commands.

**The user's config:**
- `~/.cursor/cli-config.json` has `approvalMode: allowlist` and `permissions.allow: ['Shell(ls)']`.
- MCP config lives in `~/.cursor/mcp.json` and project `.cursor/mcp.json`; the user has none today.

**From the docs and changelog** (cursor.com/docs/cli):
- Print mode (`-p --output-format stream-json`) cannot ask: without `--force` it silently denies anything not on the allow list.
- Per-turn token totals exist in stream-json.
- Plan usage is only shown in interactive `/usage`.
- Rules come from `.cursor/rules`, `AGENTS.md` and `CLAUDE.md`. Skills come from `.cursor/skills`, `~/.cursor/skills` and the `.claude`/`.codex` skill folders.
- Project `.cursor/cli.json` permissions, where deny beats allow.

**Spike results (2026-10-21)** (fixtures in `tests/fixtures/cursor/2026.10.19-6bbf2c4/`, scrubbed):
- **N1, `jsonrpc` field (`n1-no-jsonrpc-field.jsonl`):** not required. `initialize`, `authenticate` and `session/new` all succeed without `"jsonrpc":"2.0"` in the request, and replies always carry it. The peer still sends it.
- **N1, mode and model methods (`n1-session-methods.jsonl`):**
  - `session/set_mode {sessionId, modeId}` returns `{}` and the agent emits a `current_mode_update` notification.
  - `session/set_model {sessionId, modelId}` exists. An id that isn't in `availableModels` fails with -32602 `Invalid params`, `data.message` "Invalid model value: …". A valid id returns `{}` and no notification.
  - `session/set_config_option {sessionId, configId: 'mode'|'model', value}` also works. It returns the full `configOptions` array, and the same -32602 for a bad model.
  - The adapter uses `set_mode` / `set_model` (smaller reply, nothing to parse).
  - The model id is the whole bracketed string (`gpt-5.4-mini[reasoning=medium]`) and must match exactly.
  - `session/new` returned 46 models and 3 modes (`agent`, `plan`, `ask`) in a fresh folder.
- **N1, extra roots:** `session/new` takes `additionalDirectories`, `roots` and `workspaceFolders` without any error and `session/list` shows only `cwd`. So unknown params are ignored silently; there is no documented extra-roots option, and whether Cursor refuses paths outside `cwd` was not observed (M1 step 6, see below). §2.3's assumption stands: one `cwd` per session.
- **N1, workspace trust:** `session/new` in a fresh `git init` folder (no trust given) succeeds and neither prompts nor fails. ACP needs no `--trust`.
- **N1, other:** `session/new` takes about 2.3 s when `mcpServers` has an http entry, because Cursor connects it before replying. An unknown method fails with -32601 `"Method not found": <method>`. `session/list` returns `{sessions:[{sessionId, cwd, updatedAt}]}` for sessions of the running process. Cursor writes `~/.cursor/acp-sessions/<id>/meta.json` even for an empty session.
- **N4, `session/load` (`n4-load.jsonl`):** an empty session (created, never prompted) can't be loaded in a new process: `-32602 Invalid params`, `data.message` `Session "<id>" not found`, with no replayed updates. The same error comes back for an unknown id. So a missing session is a normal "resume failed" case (start fresh, tell the user). The replay behaviour is M4's (below).
- **M3, `session/cancel` with a permission pending (2026-10-21, `m3-cancel-turn.jsonl`, model `default[]` (Auto), agent mode, empty project allow and deny, two prompts):**
  - Prompt 1 asked for `git status` then `git log -1`. Cursor streamed its thinking and text, then a `tool_call` (`pending`, then `in_progress`) and a `session/request_permission` (id 0, `kind execute`, options `allow-once`, `allow-always`, `reject-once`, `content` "Shell allowlist is empty") about 2 s later. The recorder did not answer it and sent `session/cancel` as a **notification** (no id).
  - **The prompt answered `{stopReason: "cancelled"}` 2 ms later.** The notification form works; the request form and the 15 s escalation were never needed. Cursor sent nothing for the held permission request (no withdrawal, no error, no further tool update), and the second command never started.
  - **The same session took a new prompt** ("Reply with the word ok."): thinking, `ok`, `end_turn`. So an interrupt does not end or poison the session.
  - Unobserved: what Cursor does with a `cancelled` answer to a request it has already forgotten. Arc still answers it (ACP says the client should), and the adapter ignores any reply.
- **M4, `session/load` in a new process (2026-10-21, `m4-load-turn.jsonl`, model `default[]`, `proc` marks A and B):**
  - Process A: `session/new`, one prompt ("Remember the word kiwi. Reply ok."), `end_turn`, a clean exit (code 0) after stdin closed. Process B: `initialize`, `authenticate`, `session/load {sessionId, cwd, mcpServers: []}`.
  - **The history is replayed as three `session/update` notifications sent before the load response** (same millisecond): `user_message_chunk` (the old prompt, whole), `agent_thought_chunk` and `agent_message_chunk` (whole, not word by word). The response carries `modes` and `models` (with `currentModelId`) and no `sessionId`. So dropping updates until the load answers drops exactly the history; nothing replayed arrives after it.
  - `available_commands_update` came after the load response (after `session/set_model`), so it is not part of the replay.
  - **Memory survived the new process:** the prompt "What word did I ask you to remember?" was answered `kiwi`, `end_turn`. The id was the one `session/new` returned; no id mapping is needed.
- **N9, parallel processes:** three parallel `agent acp` processes (initialize, authenticate, `session/new`, no prompt) all succeed. `~/.cursor/mcp.json` and `~/.cursor/hooks.json` don't exist, before or after. `~/.cursor/cli-config.json` changed (sha256 `ba3f971b…` to `3088bc5f…`, and again to `82ed3f7b…` on a second run), and the diff of the second run is exactly one line: `privacyCache.updatedAt` (a millisecond timestamp equal to the run time). `permissions`, `approvalMode` and the rest are byte-identical. A single process run in between did not touch the file, so Cursor refreshes the field at most about once a minute. Consequence: the "user files unchanged" checks (§4, and the e2e) compare everything except `privacyCache.updatedAt`, not raw bytes.
- **N6, project `.cursor/cli.json` and `.cursor/mcp.json` (2026-10-21, no model; `agent acp` handshake in scratch repos, and `agent mcp list`):**
  - **The project `cli.json` is read, validated strictly, and only `permissions` is accepted.** A top-level `sandbox`, `approvalMode` or `version` key makes `agent acp` print `Invalid project config at <path>: schema validation failed ... Unrecognized key` and **exit 1** before `initialize` answers. So the deny file carries `permissions` only, and **Cursor's sandbox cannot be switched on from a project file**; the switch is the global CLI option `--sandbox <enabled|disabled>` ("overrides config") placed before the subcommand: `agent --sandbox enabled acp` (accepted at the handshake, no model call). The user's own `~/.cursor/cli-config.json` has `sandbox: {mode: 'disabled', networkAccess: 'user_config_with_defaults'}`, which Arc never edits.
  - A file with 193 `Shell(...)` entries (every protected command Arc denies) plus a `Write(<abs>/**)` entry loads fine. An entry of an unknown kind (`Foo(x)`) is accepted at the handshake (not validated eagerly). An entry in both `allow` and `deny` loads.
  - `agent mcp list` run in a folder with a project `.cursor/mcp.json` lists its server (`n6-shadow: not loaded (needs approval)`); the same command elsewhere says `No MCP servers configured`. So project `mcp.json` is read from `cwd`, and a project server needs the user's approval (Arc never runs `mcp enable`).
  - **Project deny against user allow was not separated without a model.** The M1 run showed a project deny blocking silently; the M1 `ls` (user allow `Shell(ls)`, project `allow: []`) still asked. Still unknown: whether a project deny beats a user allow of the same command, and whether `allow: []` in a project file replaces the user's allow list.
- **N2, session `mcpServers` (2026-10-21, no model; `n2-session-mcp-unapproved-file-server.jsonl`, `n2-session-mcp-approved-file-server.jsonl`, `n2-null-noop-same-name.jsonl`, `n2-source-evidence.txt`, `n2-acp-sessions-token-check.txt`; a local fake http MCP server logged every request):**
  - **(a) Connect and header, re-confirmed.** `session/new` with `mcpServers [{type:'http', name:'arc', url, headers:[{name:'Authorization', value:'Bearer <token>'}]}]` makes Cursor call the server before it answers (`POST initialize`, `POST notifications/initialized`, `GET /mcp` for the standalone stream), every request with `Authorization: Bearer <token>` and `User-Agent: Cursor/1.0.0`. `session/new` took 1.2 to 2.1 s. No `tools/list` (lazy, at the first prompt, as M1 showed).
  - **(b) Process cwd decides when an approved file server connects (found by the M7 dry run, `m7-mcp-off-dry-run.jsonl`).** With the `agent acp` process started in a folder other than the project (all the N2 runs), the approved file server received nothing during `session/new`. **With the process started with its cwd in the project (the recorder, and what the app does for a worktree), Cursor connects the approved project server when the process starts, before `session/new`** (`initialize`, `initialized`, `GET`, `tools/list`, about 4 ms after the handshake), whatever `mcpServers` holds. The session entry's own connect comes later. So a wire check must look at the requests during the prompt, not at `tools/list` seen at all. What follows is from the N2 runs (cwd elsewhere):
  - **(b) File servers did not connect at `session/new`, even when approved.** A project `.cursor/mcp.json` server `shadowme` -> fake server 2 never received a request in any of the six cases, with or without approval (`agent mcp list` showed `shadowme: not loaded (needs approval)` until approved, then `ready`). Only `agent mcp list` and `agent mcp list-tools` connect it. So the winner of a same-name clash is decided when the tools are listed, and that happens only at the first prompt (no model was allowed here).
  - **(b) Override, from the CLI source (`n2-source-evidence.txt`).** The ACP server builds `clients = {...fileClients}`, then for each session entry loads a client and sets `clients[name] = client`: **a same-name session entry replaces the file entry.** If loading the session entry throws, Cursor logs `Failed to load ACP session MCP server: {serverName, error}` and **keeps the file entry.** Measured: an entry with an unreachable http url (`error: fetch failed`) and a stdio `/usr/bin/true` (`error: MCP error -32000: Connection closed`) both logged that line (debug log under `$TMPDIR/cursor-agent-logs-<uid>/`), so neither is a usable no-op. An entry that **connects and lists zero tools** (fake server answering `initialize` with `capabilities.tools` and an empty `tools/list`) loaded cleanly (three `MCP HTTP exchange completed`, no `Failed to load`) while the approved file server stayed unconnected. Duplicate names inside `mcpServers`: the last wins. The session loader also applies the project's `mcp-disabled.json` and team settings. **Not observed on the wire:** the `tools/list` after a prompt (needs a model run).
  - **Project approval:** a project `mcp.json` server is `unapproved` until `<data dir>/projects/<slug of the git root>/mcp-approvals.json` (a JSON array) holds `<name>-<first 16 hex of sha256(JSON.stringify({path: projectRoot, server: <entry as written>}))>`. A hand-written file in a scratch `CURSOR_DATA_DIR` flipped the state to `ready`; the user's `~/.cursor` was never written. Arc never writes it.
  - **N3 (information):** `CURSOR_CONFIG_DIR` keeps the login (it is not in that folder) and moves `cli-config.json` only; **`mcp.json` stays in `~/.cursor`** and a scratch config dir's `mcp.json` is ignored. `CURSOR_DATA_DIR` moves `projects/` (approvals, `mcp-disabled.json`, `mcp-auth.json`); `acp-sessions` stay in `~/.cursor`. Arc sets neither.
  - **(c) The token is not in `acp-sessions`.** The 13 sessions the runs created hold only `meta.json` (`{schemaVersion:1, cwd}`); a read-only `grep -rlaF <token>` over each found nothing. The five older prompted sessions (`store.db`, `-wal`, `-shm`, including M1 whose session carried the bridge url and bearer header) contain none of `Bearer `, `Authorization` or `127.0.0.1:`. The binary store could still hold an encoded form, but nothing in clear.
- **N8, `agent mcp list-tools` (`n8-mcp-list-tools.txt`, `n8-mcp-list-states.txt`, `n8-models-vs-acp.txt`):** for an approved project server it printed only `Tools for shadowme (3):` then `- bare ()`, `- peek (text)`, `- poke (target)`: **names and argument names, sorted, with no annotations** (`readOnlyHint` and `destructiveHint` were set on the fake server's tools), no descriptions and no types. So it cannot say read-only versus changing. `agent models` ids (`grok-4.7-high`, `auto`) differ from ACP model ids (`grok-4.7[context=256k,reasoning_effort=high,fast=true]`, `default[]`); the adapter uses the ACP ids.
- **N2/N6 decision (switch-off strategy):** option 1 of §2.5, with one rule: **the no-op entry must connect and list no tools**. Details and fallbacks are in §2.5.
- **M6, sandbox and Write deny (2026-10-21, `m6-sandbox-turn.jsonl`, model Auto, `agent --sandbox enabled acp`, project `cli.json` with Arc's deny list plus `Write(<work>/known/**)`, one prompt, `end_turn`):**
  - **The sandbox flag did not confine writes.** The edit of `../outside.txt` (outside the repo, outside every deny) ran: `tool_call` `kind: edit`, `title` "Edit File" with `rawInput {}`, then an update with `rawInput {path}` and `locations [{path}]`, `in_progress`, and `completed` about 130 ms later with `content [{type:'diff', path, oldText:'-- /dev/null', newText:'++ b/<path>\noutside.'}]` and no `rawOutput`. The file exists afterwards. No permission request.
  - **The `Write(<abs>/**)` deny blocked the edit of `../known/denied.txt`.** Same shape up to `in_progress`, then `completed` about 106 ms later with **no `content` and no `rawOutput`**, no permission request, and the file does not exist. The agent was told, and quoted: `Write permission denied: ... Blocked by permissions configuration`. So a blocked edit is `completed` with no diff, and timing does not tell it apart from a real one.
  - The write inside the repo ran the same way as the outside one (diff, no ask). Only `ls ..` asked ("Not in allowlist: ls"). It was allowed and completed with `rawOutput {exitCode:0, stdout, stderr}`; the listing showed `outside.txt`.
  - Consequence: the sandbox is not used (`CURSOR_SANDBOX_ENABLED` stays `false`). The controls for edits are the `Write` denies for known folders, and the after-the-fact note for the rest. `cursor-unasked.ts` already classifies these shapes: an edit outside the working copy with a diff is `outside-edit`, one with no diff and no output is `blocked`.
- **M1, first attempt (Free account, `gpt-5.4-mini[reasoning=medium]`):** the prompt was accepted but the model never ran. It got one `agent_message_chunk` `\n\nUpgrade your plan to continue`, then `{"stopReason":"end_turn"}` 0.5 s later, with no error, tool call or usage. `agent about` says tier Free. Plan or entitlement limits therefore arrive as assistant text with `end_turn`, not as a JSON-RPC error. (`m1-plan-blocked-turn.jsonl` is reconstructed by hand from the console output, because the original file was deleted by mistake.)
- **M1, the real turn (`m1-agent-turn.jsonl`, model Auto `default[]`, agent mode, 99 s, one prompt):** `stopReason: end_turn` although two steps did not succeed. 162 lines: 8 `tool_call`, 19 `tool_call_update`, 71 `agent_thought_chunk`, 35 `agent_message_chunk`, one `session_info_update` (`{title}`, after the prompt starts), 4 `session/request_permission`, and no `fs/*` or `terminal/*` requests. Results by step:

  | Step | Asked? | What happened |
  |---|---|---|
  | 1 read `README.md` | no | `kind: read`, `rawInput {path}`, `locations [{path}]`, `rawOutput {content}` |
  | 2 write `notes.txt` | **no** | `kind: edit`, runs unasked in agent mode. The first `tool_call` has title "Edit File" and `rawInput {}`; a `tool_call_update` then adds the title ``Edit `<path>` ``, `rawInput {path}` and `locations`; completion carries `content [{type:'diff', path, oldText, newText}]` |
  | 3 `git status` | yes | `kind: execute`, `rawInput {command}` |
  | 4 `ls` | **yes** | Asked ("Not in allowlist: ls") although `~/.cursor/cli-config.json` allows `Shell(ls)`. The scratch repo's project `.cursor/cli.json` had `allow: []`, so a project file may replace the user's allow list rather than add to it. Not separated from the other explanation (the ACP server ignores the allow list); needs a run without the project file |
  | 5 `git push origin HEAD` | no | **Blocked silently by the project deny `Shell(git push)`.** No permission request. The `tool_call` went `pending`, `in_progress`, `completed` in 62 ms with **no `rawOutput` and no error**. A real command completion always has `rawOutput {exitCode, stdout, stderr}`. The remote never got a branch. The model saw a refusal and wrote "git push refused by permissions." |
  | 6 read `/etc/hosts` | **no** | Outside `cwd`, ran unasked, the content came back. Reads are not gated |
  | 7 `arc` `echo` | yes | MCP call, see below. Completed with `rawOutput {success:true}` |
  | 8 `arc` `slow` | yes | Allowed, then **failed after 60 s**: Cursor sent `notifications/cancelled` to the bridge 60.0 s after the call arrived, and the call completed with `rawOutput {error:"MCP error -32001: Request timed out"}`. The model reported "slow tool timed out" |

- **M1, permission request shape:** a server-to-client request `session/request_permission` with `id` starting at 0 (0, 1, 2, 3: never test it for truthiness) and `params`:
  - `sessionId`;
  - `toolCall {toolCallId, title, kind, status:'pending', content:[{type:'content', content:{type:'text', text}}]}`: **no `rawInput` and no `locations`**. For a command, `title` is the command in backticks and `text` is "Not in allowlist: <command>"; for an MCP call, `title` is `<server>-<tool>: <tool>` (`arc-echo: echo`) and `text` is the arguments as a fenced JSON block;
  - `options`, always `[{optionId:'allow-once', kind:'allow_once'}, {optionId:'allow-always', kind:'allow_always'}, {optionId:'reject-once', kind:'reject_once'}]`.
  - The answer is `{outcome:{outcome:'selected', optionId}}`, which worked. The command, cwd and paths must come from the preceding `tool_call` with the same `toolCallId` (`rawInput.command`), which always arrives first. The reject flow was **not** exercised (the push was denied before it could ask), so what the agent sees after `reject-once` is still unobserved.
- **M1, MCP tool identification:** the `tool_call` is `title: "MCP: tool"`, `kind: other`, `rawInput {}`. A `tool_call_update` then gives `title: "arc: echo"` and `rawInput {providerIdentifier:'arc', toolName:'echo', args:{text:'hi'}}`. So the server and tool come from `rawInput.providerIdentifier` and `toolName` (not from `kind`, which is `other` for everything that isn't read, edit or execute). There is no `mcp__arc__` prefix: the model addresses it as "the `echo` tool of the MCP server named `arc`". The bridge saw `Authorization: Bearer <token>` on every call, and `tools/list` only after the prompt (lazy).
- **M1, no progress token, 60 s limit:** Cursor's `tools/call` requests carry **no `progressToken`**, so the bridge's 15 s progress keepalive sends nothing. Cursor's own per-call timeout is 60 s and was not extended. Any bridge tool that blocks longer than about 55 s (`ask_brain`, `propose_plan`, merges) fails for Cursor agents (see §2.5).
- **M1, usage:** none. No `usage` or `_meta` key appears anywhere in the 162 lines; the prompt response is exactly `{stopReason:'end_turn'}` and there is no `usage_update` notification. This ACP version reports no tokens, so the "Not reported" path of §2.10 and §5 is the real one.
- **M1, other:** `agent_thought_chunk` and `agent_message_chunk` carry `content {type:'text', text}` in word-sized pieces with no message id, so the parser assembles messages itself (a new message starts after any tool call). Tool statuses seen: `pending`, `in_progress`, `completed`; no `failed`. A failed or blocked call still ends `completed`. The run left `notes.txt` in the scratch repo (the edit really ran) and no commit on the remote. The fixture omits the contents of `/etc/hosts` (machine-specific).

- **M2, `ask` mode (`m2-ask-mode-turn.jsonl`, Auto, one prompt, every permission request answered allow-once, no project deny):**
  - `session/set_mode ask` returned `{}` and a `current_mode_update`. Both replies and the `session/new` answer list the mode as "Q&A mode - no edits or command execution".
  - **Arc's MCP tools work in `ask`.** `arc` `echo` asked permission (`arc-echo: echo`, `kind: other`, the usual three options), then ran: the bridge saw `echo` with "hi" and the call completed with `rawOutput {success:true}`.
  - **Reads run unasked**, as in agent mode: `README.md` came back with no permission request.
  - **Shell is not blocked, it asks.** `git status` produced a `session/request_permission` ("Not in allowlist: git status"). It was allowed once, ran, and completed with `rawOutput {exitCode:0, stdout, stderr}`. So `ask` mode does not stop a command by itself: the answer to the request does. The model had been told it could not run commands but still tried.
  - **Edits are not offered.** The write step produced no `tool_call` and no permission request at all; the model wrote "Step 4 refused: Ask mode — cannot create or edit files." `notes.txt` does not exist afterwards (`repo after: {"notesTxt":false,"echoCalls":1,"gitStatus":""}`). The deny file is therefore a second layer, not what stops the edit.
  - The turn ended `end_turn`; there were two permission requests (the MCP call and the command), no `usage`.
  - **Decision (§2.3):** the brain runs in `ask`, and every request it sends goes through `classifyBrainAction`, which allows `arc` tools and read-only commands and refuses edits and everything else.

**Still unknown (spikes, §2.12):**
- the reject flow (what the agent sees after `reject-once`), whether a project `allow: []` replaces the user's allow list, and whether a project deny beats a user allow of the same command (N6 could not tell without a model);
- whether an edit outside `cwd` asks (an edit inside `cwd` did not);
- whether the override shows up in the first prompt's `tools/list` (N2 proved the code path and the connect behaviour, not the wire; one approved real turn, or Slice 7's real-run check, settles it);
- `session/load` with real history (M4, done);

- **M7 (2026-10-21, one real turn on Auto, `m7-mcp-off-turn.jsonl`):** with an approved project server `shadowme` and a same-name session entry pointing at an empty `/off/shadowme` endpoint, the model reported "There is no MCP server named `shadowme` in this session" and made no shadowme tool call. The real server received no request during the prompt (it is still connected at process start, before `session/new`); the off endpoint answered the `tools/list`. The switch-off strategy (option 1) is confirmed end to end.

### 2.2 Generalisation (first slice, no behaviour change)

- **`src/shared/types/provider.ts`:** `PROVIDER_IDS = ['claude','codex','cursor']`, and `MIN_CURSOR_VERSION`. The minimum is assumed to be `2026.07.06`, the release that fixed concurrent processes corrupting the config.
- **`src/shared/provider-traits.ts` (new):** `PROVIDER_TRAITS: Record<ProviderId, {name, loginCommand, installHint, fallbackOrder, hasNativeSystemPrompt, liveModelSwitch, planSource}>`.
- **Replace the two-way ternaries** with trait lookups or exhaustive `switch` plus `assertNever`. Sites:
  - `usage-recorder.ts` (375, 384)
  - `plan-coordinator.ts:34`
  - `rate-limit-gate.ts:68`
  - `usage-weights.ts`
  - `orchestrator.ts` (320, 1325, 1554, 1690, 1759–1834, 1854, 2007–2017)
  - `worker-manager.ts` (≈597, 790, 811, 1309, 1355, 2080, 2141, 2325, `fallbackColumns`)
  - `cli-resolver.ts:295`
  - `provider-status-service.ts` (113, 201)
  - `provider-resolution.ts:124`
  - `command-prompt.ts:23`
  - `command-probe.ts:346`
  - `session-prefs.ts` (13, 49)
  - `brain-providers.ts` (`unavailableReason` reads `status.codex` for any non-Claude provider)
  - `session-service.ts:1970`
  - `plan-usage-service.ts:188`
  - `mcp-tool-catalogue.ts:210`
  - `model-registry.ts` (`list`, `all`, `tierOf`)
  - renderer: `usage/labels.ts`, `model-options.ts`, `DailyChart.svelte`
- **Typed tables that fail to compile on the new id** get Cursor entries: `NAMERS`, `ProviderModels`, `USAGE_WEIGHTS`, `REGISTRY_URLS`, `BREW_NAMES`, `PROVIDER_NAMES`.
- **Duplicated provider lists:**
  - Hard-coded `['claude','codex']` lists in `spawn-worker.ts`, `propose-plan.ts`, `command-routing.ts`, `plan-gate.ts` and the e2e rigs use `PROVIDER_IDS`.
  - The renderer's duplicate name tables in `RestartPrompt`, `UpdateNotices` and `ProviderStatusRow` use `providerName()`.
- **Lint:** turn on `@typescript-eslint/switch-exhaustiveness-check`.
- **Test:** a table-driven test runs the provider helpers over `PROVIDER_IDS`.

### 2.3 Transport and adapter

| File | Responsibility |
|---|---|
| `src/main/agents/rpc/json-rpc-peer.ts` | Extracted from `codex/codex-rpc.ts` (`CodexRpc` becomes a thin wrapper); sends `"jsonrpc":"2.0"` when asked; Cursor does not require it (N1), so the Cursor client sends it anyway, as it is harmless |
| `src/main/agents/cursor/acp-client.ts` | Typed calls: `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/set_model` (spike N1; `session/set_config_option` also works) |
| `cursor/cursor-types.ts` | Loose zod schemas for the subset Arc reads; unknown notifications are ignored and unknown server requests are answered -32601 |
| `cursor/cursor-adapter.ts` | `CursorAdapter` and `CursorHandle` (start, resume, send, interrupt, setModel, stop) |
| `cursor/cursor-parser.ts` | Turns `session/update` into `AgentEvent` (text deltas, tool calls, assistant message, usage, turn result, errors) |
| `cursor/cursor-normalize.ts` | Turns `session/request_permission` into a `NormalizedAction` |
| `cursor/cursor-config.ts` | Session params, child env, Arc's project deny file |
| `cursor/cursor-user-config.ts` | Read-only parse of `~/.cursor/{cli-config,mcp,hooks}.json` and project equivalents |
| `cursor/cursor-probe.ts` | Models, status and commands (one ACP session in an Arc-owned empty folder, no prompt) |
| `cursor/cursor-commands.ts` | The Cursor command list and runner |
| `agents/agent-adapter.ts` | `CursorStartOptions` and `CursorStartRequest` in the `StartOptions` union |
| `app/bootstrap.ts`, `provider-registry.ts` | Register `cursor` |

**Handshake.** `initialize` advertises no `fs` or `terminal` client capabilities, so Cursor uses its own tools and every action reaches the permission request. Then `authenticate cursor_login`, then `session/new` or `session/load`, then set the mode and model, then emit a `session` event carrying the ACP session id. A -32000 auth error becomes `ProviderUnavailableError('signed_out')`. During `session/load`, replayed history is dropped until the load response arrives. A `session/load` that fails with -32602 "Session … not found" (what an empty or unknown session returns, spike N4) is a resume failure: the adapter starts a fresh session and the worker is told it has no memory of the earlier turns.

**Child process environment:**
- Built by `buildAgentEnv`.
- `CURSOR_API_KEY` and other `CURSOR_*` variables are stripped, so only the subscription login is used.
- `FAKE_CURSOR_*` passes only under `HARNESS_E2E=1`.

**Capabilities:** `interruptCancelsApprovals: true`, `queuesSendsWhileBusy: true`, `midTurnSteer: false`.
- `setModel` applies the model option before the next prompt, with no restart.
- **Stepping in** (spec 006) uses `send`, `interrupt` and `discardQueuedSends`; the worker manager's step-in, hand-back and pause paths already work through the handle. A typed `/command` goes to Cursor as text. A resume whose session Cursor no longer has (`-32602` not found) is a `ProviderHistoryMissingError`: the brain starts fresh from the recent messages, a worker fails with "The Cursor history for W1 is gone." (the Codex behaviour, with the provider's name).
- **`interrupt`:**
  1. Send `session/cancel` as a notification (M3: the prompt answers `cancelled` within milliseconds and the session stays usable).
  2. Answer pending permission requests `cancelled` (M3: Cursor itself sends nothing for the request it was holding).
  3. Wait 3 s for `stopReason: cancelled`.
  4. Escalate SIGINT, then SIGTERM, then SIGKILL, as the Codex handle does.

**Instructions.** ACP has no system prompt. The adapter puts Arc's instructions in an `<arc-instructions>` block before the first prompt of every start and resume, as Codex re-sends its developer instructions. The "Updated instructions" note path (`queuePromptNote`) covers providers whose `hasNativeSystemPrompt` is false. The brain prompt version goes to 6, with a Cursor line in `PROMPT_UPDATE_NOTE`.

**The brain is read-only.** The brain runs in Arc's brain folder, as the Codex brain does.
- **Mode:** ACP mode `ask`. Spike M2: Arc's MCP tools work there and no edit tool is offered, but a shell command still asks and runs once allowed, so `ask` alone does not make the brain read-only. Mode `agent` was not needed.
- **Approvals:** the brain's `CursorApprovalHandler` feeds `requestAction`, whose brain path runs `classifyBrainAction`: `arc` tools are answered at once, read-only commands (`classifyBrainBash`) are allowed, edits and anything else are refused or go to the user.
- **Deny file:** Arc writes `<brain folder>/.cursor/cli.json` with `permissions.deny: ['Write(**)']` before every start (`writeCursorBrainDeny`). The brain folder is the Arc-owned folder the Codex brain uses (not a git repository, so nothing is excluded).
- **Session id and model:** the `session` event stores the Cursor session id in `brain_threads`; a model change goes through `setModel` (`session/set_model` before the next prompt) with no restart, as `PROVIDER_TRAITS.cursor.liveModelSwitch` says.

**Workers:**
- `cwd` is the worker's first worktree.
- Other worktrees, the knowledge folder and the projects are named by absolute path in the instructions. The classifier keeps the existing roots and refuses edits outside them.
- **Spike N1:** ACP has no extra-roots option (`additionalDirectories`, `roots` and `workspaceFolders` are silently ignored). Whether Cursor refuses paths outside `cwd` is still unobserved (M1 step 6 didn't run). If Cursor refuses paths outside `cwd`, the fallback is an Arc-owned parent folder with links to the worktrees.

### 2.4 Approvals

`cursor-normalize.ts` maps a permission request as follows:

| ACP tool kind | NormalizedAction | Notes |
|---|---|---|
| `execute` | `bash {command, cwd}` | The request has no `rawInput`: the command comes from the preceding `tool_call` with the same `toolCallId` (spike M1) |
| `edit` / `delete` / `move` | `edit {paths}` | **Spike M1: edits and reads run in agent mode without any permission request**, so this row is classified from the `tool_call` (its `rawInput.path` / `locations`), after the fact. Missing paths fail closed (`unknownPaths`) |
| `read` / `search` / `think` | `other` | Never asked (a read outside `cwd` ran unasked) |
| `fetch` | `other` (WebFetch) | |
| MCP call (`kind: other`) | `mcp {server, tool, readOnly}` | Server and tool come from the preceding `tool_call_update`'s `rawInput.providerIdentifier` and `toolName` (spike M1; no `_meta`). The request title reads `<server>-<tool>: <tool>`. If the call can't be identified, it is `unknown`, which asks |

**Answers:**
- `sessions/cursor-approvals.ts` (`createCursorApprovalHandler`, next to `codex-approvals.ts`) feeds `requestAction`, so the attention coordinator, allow rules and Auto-approve are unchanged.
- Allow answers the option of kind `allow_once`; deny answers `reject_once`. Options are chosen by kind, never by id text (spike M1: ids are `allow-once`, `allow-always`, `reject-once`), and Arc never answers `allow_always`.
- Ordinary commands inside the worktree, and calls to the `arc` server, are answered without an attention item.
- **Assumption (spike M1 did not reach the reject flow):** a reject carries no reason text. So the worker instructions say "if an action is rejected, don't work around it; use `ask_brain`", and the adapter puts the decline reason in front of the next prompt.

**Actions that would run without asking.** Cursor runs an action silently if it is on the user's `permissions.allow` list, or if `approvalMode` is `unrestricted`. **Spike M1 adds that in agent mode file reads (also outside `cwd`) and file edits never ask at all**; only `execute` and MCP calls do. So Arc cannot gate edits through approvals: the deny file (`Write(...)` entries) and the after-the-fact `tool_call` classification are the only controls, and a worker's edit outside its worktree can only be noticed, not prevented, unless a `Write` deny covers it. Arc never edits `~/.cursor`, so it handles this in three layers:
1. **Deny layer.** Arc writes `<worktree>/.cursor/cli.json` with `permissions.deny` for the protected actions: push, `gh`, destructive commands, global installs, ssh/scp/rsync/curl. The file is hidden with the repository's `info/exclude`, as `codex-rules.ts` does. If the repository commits its own `.cursor/cli.json`, Arc leaves it alone and relies on layer 2. The `Shell` entries come from the same prefixes as `codex-rules.ts`, minus the ones whose danger depends on the arguments (`rm`, `git reset|checkout|restore|branch|tag|stash|rebase|worktree|config`, `chmod|chown|chgrp|truncate`): a deny cannot look at arguments and a worker uses those inside its own working copy all the time, so they stay under the approvals. **Spike M1:** a project deny blocks silently and without asking (`Shell(git push)` stopped `git push origin HEAD`), so the deny layer works for commands. That a project deny beats a *user allow* of the same command is still untested (the user's only allow entry, `ls`, did not apply, see §2.1); spike N6 or a later run settles it.
2. **Blocked note.** A tool call that reaches `in_progress` with no permission request, or that fails as denied, is classified anyway. A denied command is recognisable by `completed` with **no `rawOutput`** (spike M1); the same shape marks any blocked execute. A protected action adds an event-log row of kind `cursor-blocked`, for example "W3 couldn't push: Cursor can't ask, so Arc blocked it. Rerun this step on a Claude or Codex worker." If it actually ran unasked, the row says so instead. This is the functional spec's "blocked with a note".
3. **Bypass report.** `BypassDetector` reads the user's and the projects' Cursor permission files (never writes them). It reports:
   - `Shell`, `Write` and `Mcp` allow entries;
   - an `approvalMode` other than `allowlist`;
   - hook events that can answer "allow".

   `BypassReport` gains a `cursor` block, and the Providers warning lists it.

**Rejected for v1:** pointing `CURSOR_CONFIG_DIR` at an Arc-owned copy. It would hide or fork the user's login, the same reason the Codex overlay was rejected. Spike N3 only looks at it. Arc never runs `agent mcp enable|disable`, which would write the user's approved list.

**Edits outside the working copy (decided 2026-10-21).** Cursor's agent mode never asks before edits or reads (spike M1). Arc's worker deny file therefore also carries `Write(<abs path>/**)` for each of the group's project checkouts, the knowledge folder and the other workers' worktrees (deny beats allow, and the worker's own worktree is not listed). An edit seen in a `tool_call` (kind `edit`, or a write location) outside the worker's worktree that wasn't blocked adds a `cursor-blocked`-style event-log note ("W3 (Cursor) changed <path> outside its working copy"). Spike M6 (one extra real run, done) showed that Cursor's sandbox (`agent --sandbox enabled acp`; a project `cli.json` cannot enable it, spike N6) does **not** confine writes to the workspace: a write to a sibling folder went through. The `Write(<abs>/**)` denies do block (the edit completes with no diff, and the agent is told "Write permission denied"). So the sandbox stays off (`CURSOR_SANDBOX_ENABLED = false` in `cursor-config.ts`), edits to known folders are denied, and any other edit outside the working copy is only noted.

### 2.5 MCP

**Arc's bridge** goes in `session/new.mcpServers` as `{type:'http', name:'arc', url, headers:[Authorization]}`.
- The token travels in the ACP pipe, not in argv, and is renewed on every load.
- Bridge tool names get a `cursor` entry in `BridgeToolNamer`. Spike M1 pinned it: bare tool names with the server named separately (`arc` / `echo`), no `mcp__arc__` prefix; instructions say "the `ask_brain` tool of the MCP server named `arc`". The Claude-only `request_permission` bridge tool is not registered for Cursor.
- **Spike N1/M1:** Cursor sends `Authorization: Bearer <token>` from `mcpServers[].headers` on every request, connects the server during `session/new` (adding about 2 s), opens a standalone `GET /mcp` stream and calls `tools/list` lazily at the first prompt. Arc's bridge returns 405 to that `GET`; the adapter e2e confirms Cursor copes.
- **Spike M1 contradicts the keepalive plan:** Cursor sends no `progressToken` with `tools/call`, so the 15 s progress notifications cannot be sent, and Cursor times a call out at **60 s** (`MCP error -32001: Request timed out`, `notifications/cancelled` to the bridge). A 130 s call failed. For Cursor agents every bridge tool must return in under about 55 s. Blocking tools (`ask_brain`, `propose_plan`, merges) therefore need a polling shape for Cursor: return a "pending, call again" result after about 50 s and let the agent call a status tool, or the equivalent. This is a design change for Slice 2 to settle before the adapter registers the long tools; until then Cursor workers get only the short tools.
- **Risk (closed by spike N2):** Cursor does not store session `mcpServers` (url, headers or token) in `~/.cursor/acp-sessions` in clear; the token is also revoked when the agent ends.

**The user's Cursor servers** load the way Cursor loads them itself, from `~/.cursor/mcp.json` and project `.cursor/mcp.json`. Listing them for Agent loading means parsing those files read-only.

**Switching a server off per role** (spec 009). **Decision (spikes N2/N6, 2026-10-21): option 1, a same-name no-op session entry.**
1. **Chosen.** Pass an entry named like the switched-off server in `session/new.mcpServers` (and `session/load`). Cursor replaces the file client with the session client by name (§2.1 N2), so the file server is never connected and its tools never reach the model. **The no-op must load successfully and list no tools.** An unreachable url or a stdio `true` fails to load, and then Cursor keeps the file server. So the entry is `{type:'http', name:<server>, url:<bridge>/off/<server>, headers:[Authorization]}` and the Arc bridge serves, at that path, an MCP endpoint that answers `initialize`, `tools/list` (empty) and nothing else, under the same session token. It costs one extra loopback connect at `session/new` per switched-off server (session entries are loaded one after another; the null-entry run took 1.2 s in total, no slower than the single-entry runs).
   - Works for user servers (`~/.cursor/mcp.json`) and for approved project servers alike; an unapproved project server is not loaded anyway.
   - Arc does not rely on the entry alone: the deny layer also adds `Mcp(<server>:*)` and the permission handler rejects any request for that server, so a failed load degrades to option 3 instead of exposing the server.
   - If the bridge is unavailable (it is Arc's own, so only in a startup failure), the row falls back to option 3.
2. *Not used.* An Arc-written shadow entry in the worktree's `.cursor/mcp.json`. It would dirty the worktree, would be merged by accident, and a project server needs approval (`mcp-approvals.json`, which Arc never writes), so the shadow would not load at all.
3. *Fallback only.* Reject the server's permission requests (the deny layer adds `Mcp(<server>:*)`). The row then reads "blocked, not unloaded", because the server's tools still cost tokens and the model can still see them.
- **Open check, not blocking the design:** the wire-level proof needs a model turn (`record-cursor.mjs --scenario mcp-off`, spike M7). Cursor already connects an approved project server at process start (§2.1 N2), so a `tools/list` on the real server proves nothing; the verdict is that the agent lists no shadowme tools and the real server sees no `tools/call`. The Slice 7 e2e asserts it against `fake-cursor`, and the unit tests pin the session entries; the first real run with a user server should confirm it and, if it fails, the row says "blocked, not unloaded" (option 3 stays on).

**Read-only versus changing.** `McpToolCatalogue.cursorAction` decides whether a Cursor MCP tool is read-only or changing. Sources, in order:
1. annotations carried in the request;
2. ~~`agent mcp list-tools <id>`~~ (spike N8: it prints names and argument names only, no annotations, so it is not a source);
3. Arc's own MCP SDK `tools/list` against the server (stdio and http, 10 s timeout, 1 h cache). This is the real source. The permission request carries no annotations either (M1: only `title` and the arguments as text), so source 1 is a hint when present, not something to count on.

If none of these answers, the tool asks.

### 2.6 Models

- `ModelRegistry.list('cursor')` comes from the probe session's `models.availableModels`. `ModelRef.model` is the ACP `modelId`, for example `default[]` or `grok-4.7[…]`, not an `agent models` id.
- Labels are `name` plus the parsed bracket parameters ("grok-4.7 · high · fast"). `default[]` is labelled Auto and is the default.
- The list is cached for 24 h in `provider-cache.json`, and listed only while Cursor is `ok`. The registry's cache becomes per provider: `cacheSchema` gains an optional `cursor` entry, and old files still parse.
- **`ModelInfo` gains optional fields:**
  - `group`, the maker: Claude, GPT/Codex, Grok, Gemini, Cursor.
  - `base` and `variant`, so the renderer can collapse effort and fast variants.
- `models/cursor-tiers.ts` maps names to tiers, used to pick the Claude stand-in.
- The brain prompt lists at most 15 Cursor models as `label (id)`. The resolver accepts an id or a label in any case.

### 2.7 Status, install, versions

**`cli-resolver.ts` gains `cursorBinary()` and `checkCursor()`.**
- **Finding the binary:** `HARNESS_CURSOR_BIN` (dev and e2e only), then `cursor-agent`, then `agent`. A bare `agent` is accepted only when `--version` matches `^\d{4}\.\d+\.\d+`, because the name is generic.
- **The status check:**
  - missing binary: `missing`;
  - version below the minimum: `unsupported`;
  - otherwise `agent status --format json`, parsed tolerantly (spike N7), giving `ok` or `signed_out`;
  - a timeout: `error`.
- `CLI_MESSAGES.cursor` carries the install line (`curl https://cursor.com/install -fsS | bash`) and the sign-in line (`agent login`).

**Update notices.** Cursor isn't on npm.
- `LatestVersions` becomes a per-provider source. Cursor's source is `agent about --format json` "Latest" (6 h cache, 5 s timeout).
- `updateCommandFor('cursor')` is `agent update`.
- Because the CLI updates itself, a notice shows only when `about` reports a newer version.
- A version change marks the brain stale through the existing path.

### 2.8 Provider choice and fallback

**Fallback chain.** The Codex-only availability step in `provider-resolution.ts`, `worker-manager.ts` and `session-prefs.effectiveBrain` becomes provider-neutral.
- The first available provider in `fallbackOrder` (Claude, then Codex) other than the one asked for stands in.
- The Claude stand-in model comes from `claudeStandIn(tier)`; the Codex stand-in is Codex's default or fast model.
- `workers.requested_provider` stores the provider actually asked for.

**Fallback text.** `fallback-text.ts` takes the provider name, login command and install line from `PROVIDER_TRAITS`. The card keeps the existing form, for example "Cursor isn't signed in, so W2 runs on Claude. Run agent login in Terminal to use Cursor." See §5 for the wording decision.

**Commands that can't fall back.** A Cursor command, like a Codex one, is blocked with a message rather than run on another provider.

**Brain prompt.** It lists three providers. The Auto guidance:
- Default to Claude.
- Choose Cursor when the user asks, for a model only Cursor offers, or for a third opinion.
- Prefer Cursor or Codex when Claude's plan meter is at 80% or more, read from `PlanUsageService`.

**Tool parameters.** The `spawn_worker` and `propose_plan` provider enums and the `provider-schemas.ts` zod use `PROVIDER_IDS`. `splitCommandRef` accepts `cursor:<name>`.

### 2.9 Commands

**Sources.** Cursor's own command and skill folders, read-only: `~/.cursor/commands`, `<repo>/.cursor/commands`, `~/.cursor/skills` and `<repo>/.cursor/skills`.
- The launch and Check again probe reads `available_commands_update` and fills in descriptions.
- Probe entries with no Cursor-owned file are dropped (the probe's list carries no source field, so the file match is the rule; the `(user)`/`(global)` suffix is stripped from the description it supplies). They are the Claude and Codex skills Cursor also loads, which Arc already lists under those providers.

**Listing:**
- `CommandInfo.source` and `provider` gain `'cursor'`, and the renderer's `CommandMenu` shows a "Cursor" badge.
- Cursor commands are listed only while Cursor is `ok`.
- They have no Agent loading switches, as with Codex.

**Running.** A Cursor command always runs in a Cursor worker labelled with the command, and `spawn_worker`'s `command` accepts `cursor:name`. Arc expands the command itself (decision of the user, 2026-10-21; §5): spike M5 proved only that a bare `/shout banana` prompt runs the command file (reply `SHOUT: BANANA`), but a worker's first prompt starts with Arc's `<arc-instructions>` block (`cursor-config.ts`), so the slash would no longer begin the text.
- `CursorCommands.resolve(name, args, cwds)` finds the Cursor-owned file (`commands/<name>.md` or `skills/<dir>/SKILL.md`, project before user), reads it again at run time and strips the front matter.
- The arguments are applied as for Codex prompts (`expandCodexPrompt`): `$1`..`$9`, `$ARGUMENTS`, `KEY=value` for `$KEY`. If the body has no placeholder, the arguments are appended as `Arguments: …`.
- The first message is `Running the Cursor command /name.`, a blank line, then the expanded body. It is sent after the instructions block, so the transcript reads well.
- `WorkerManager.sendFirst` uses it for a Cursor worker's command. A file that can no longer be read (or a missing `KEY=value`) fails the worker start with that reason; a bare slash command is never sent.
- A `/name` typed while stepping in on a Cursor worker is unchanged.

### 2.10 Usage

**Tokens.** **Spike M1: ACP in CLI 2026.10.19 reports no tokens.** The prompt response is `{stopReason}` only, with no `usage`, no `_meta` and no `usage_update` notification. The parser still reads `PromptResponse.usage` / `_meta.usage` and `usage_update` if a later version adds them, mapped to the four buckets (input uncached, cache write, cache read, output), with a running count for `usage-progress`. Today the Cursor rows read "Not reported" for tokens.
- Where ACP reports no tokens, the Cursor rows read "Not reported" for tokens. This needs a "provider reports no tokens" state in the recorder and the panel (§5).

**Weights.** `USAGE_WEIGHTS: Record<ProviderId, …>` with Cursor at Claude's ratios `{1, 1.25, 0.1, 5}`. **Assumption:** Cursor passes the underlying model's pricing through. `WEIGHTED_EXPLANATION` is updated.

**Plan meter.** While Cursor is `ok`, `PlanUsageService.ingest('cursor', [], 'probe', tier)` runs at launch and on focus. That gives the meter its `not-reported` state with the subscription tier from `agent about`. `ingest` keeps `planType` for empty windows.

**Limits.** `isCursorLimitError` matches JSON-RPC errors, stderr, stop reasons and assistant message text against limit wording (usage limit, rate limit, quota, 429, out of credits, "Upgrade your plan"). Spike M1 recorded a real plan block on a Free account: one `agent_message_chunk` "Upgrade your plan to continue" and `stopReason: end_turn`, with no error. The turn must therefore count as a limit when it ends this way with no tool call and no other text. It emits `error{kind:'rate-limit'}` with no reset time, so the gate retries once after 5 minutes, and then the fallback applies. The plan-block fixture is real (`m1-plan-blocked-turn.jsonl`); a rate-limit fixture is synthetic, since that can't be recorded on demand.

**Downstream.** Suggestions and the Usage page already work by provider. Only the ternaries in §2.2 change.

### 2.11 Agent loading

- `LoadKind` gains `'cursor-mcp'`, and `loadKey.cursorMcp(name)` returns `cursor-mcp:<name>`. Stored `agents.loadOff` keys are free strings, so there's no schema change.
- `LoadCatalogue.listCursor()` returns `{items, state}`. `state` is `ok`, `unavailable` or `unreadable`, from the mcp.json parse, and is `unavailable` while Cursor isn't `ok`. A separate IPC channel `agent-load:cursor` keeps the page from waiting on Cursor.
- `PersonalConfigService.cursorMcp(cwd, role)` returns `{servers, disabled, degraded}` from `LoadSelection`. `applyCursorMcp` builds the session entries of §2.5: the bridge entry plus one connecting no-op entry (`/off/<server>`, empty tool list) for each server that is switched off in the role. Stored keys are unchanged; the bridge gains the `/off/<server>` route.

### 2.12 Spikes

**No model call** (run any time; the CLI is installed and signed in):

| Id | Question |
|---|---|
| N1 | Is the `jsonrpc` field required? Method names for mode and model; extra roots; workspace trust for a fresh worktree |
| N2 (done, §2.1) | Does `session/new.mcpServers` with a local fake http MCP server connect and send `Authorization`? Does a session entry override a same-name file entry? Is the token stored in `acp-sessions`? Result: yes, yes (by name, if the session entry loads), no |
| N3 | `CURSOR_CONFIG_DIR`: does it keep the login, and does it move mcp.json? (Information only) |
| N4 | `session/load` of an empty session in a new process |
| N6 | Project `.cursor/mcp.json` shadow and `.cursor/cli.json` deny, checked with `agent mcp list` |
| N7 | Schemas of `status --format json` and `about --format json` |
| N8 (done, §2.1) | `agent mcp list-tools` output; `models` ids versus ACP model ids. Result: names and argument names only; the ids differ |
| N9 | Three parallel `agent acp` processes leave the user's config files byte-identical |

**One real turn each** on the cheapest model, recorded with `scripts/record-cursor.mjs --confirm-real-run` into `tests/fixtures/cursor/<version>/`. Fixtures are scrubbed of email, paths and ids. Each run needs the user's explicit approval at the time.

| Id | Records |
|---|---|
| M1 (done, §2.1) | Agent mode against a scratch repo: read a file, write a file, `git status`, an allow-listed command, `git push` to a local bare remote, a read outside `cwd`, the fake bridge's `echo` and a 130 s `slow` tool. Captures permission shapes, option kinds, usage fields, tool names, stop reasons, and project deny versus user allow |
| M2 (done, §2.1) | `ask` mode (`scripts/record-cursor.mjs --scenario ask-mode`): `session/set_mode ask`, then one prompt: the `arc` `echo` tool, a read, `git status`, a file write; every permission request answered allow-once, no project deny. Result: MCP tools work, reads run, `git status` asks and then runs, the write is never offered |
| M3 (done, §2.1) | `session/cancel` with a permission pending, then a new prompt (`--scenario cancel`) |
| M4 (done, §2.1) | `session/load` in a new process, including the history replay, then a prompt that checks memory (`--scenario load`) |
| M5 (done, §2.1, §2.9) | `/name args` against a scratch `.cursor/commands/shout.md` (`scripts/record-cursor.mjs --scenario command`): the `available_commands_update` after `session/new`, then one prompt `/shout banana`. Result: `shout` is listed as `<first line> (project)`, and the reply is `SHOUT: BANANA` (stop reason `end_turn`, `m5-command-turn.jsonl`): the command file ran from the plain prompt text |
| M6 (done, §2.1) | Sandbox: `agent --sandbox enabled acp` in a scratch repo (N6: a project `cli.json` cannot enable it) whose project `cli.json` holds Arc's deny list; ask the agent to write a file inside the repo, `../outside.txt` and `../known/denied.txt` (a folder under a `Write` deny), then `ls ..`; record whether each write is refused and how (tool_call status, rawOutput, message), and what a `Write`-denied edit looks like. Run with `scripts/record-cursor.mjs --scenario sandbox` |

### 2.13 Renderer

All paths are under `src/renderer/src/lib/`.

**Names and labels:**
- `src/shared/provider-label.ts` holds the only name table, and adds `providerIds` and `isProviderId`.
- `RestartPrompt`, `UpdateNotices`, `ProviderStatusRow` and `usage/labels.ts` use it.

**Stores:**
- `stores/providers.svelte.ts`: `busy` is built from `providerIds`.
- `stores/models.svelte.ts`: accepts any provider keys and treats a missing `cursor` key as empty.

**Providers page:**
- `settings/ProvidersSettings.svelte` gets a third row, and its intro reads "Claude, Codex and Cursor tools".
- `ProviderStatusRow` shows Cursor as Signed in (version), Not signed in (with `agent login`), Not installed (with the install line), Unsupported or Error.
- Check again is labelled "Check Cursor again".
- The update notice shows only when there's an `updateCommand`.

**Model chooser** (`model-options.ts`, `cursorGroups`):
- Rows are base models, grouped by maker under titles like "Cursor · Claude", with Auto (default) first.
- Effort and fast variants collapse into a paired "Effort" control (Default, Low, Medium, High, Extra high, Max, plus Fast where offered). On commit it resolves to the full id, so the stored `ModelRef` stays one id.
- A pick the account no longer offers stays, marked "(unavailable)".
- Used in `DefaultPickers` (native select with optgroups and type-ahead), `SessionHeader`'s `HeaderMenu` (scrolling, Home/End, type-ahead) and `PlanCard`.
- `brainText` and `workersText` take a readiness map instead of `codexReady`.

**Cards and notes:**
- `ProviderTag` already renders the provider, so `WorkerCard`, `BrainCard`, `SessionHeader` and `UsagePanel` pick Cursor up.
- `CodexNote.svelte` becomes `ProviderNote.svelte`, covering every non-Claude provider, with dismissal per session and provider.

**Event log.** `sessions/event-kinds.ts` gains `cursor-blocked` (warning icon, attention tone, label "Blocked"). The row names the worker and the action, and the worker chip links to the card.

**Usage:**
- `styles/tokens.css` adds `--color-chart-cursor` (light and dark, distinct from Codex's attention hue, at least 3:1 contrast). The chart gets a dot or vertical hatch, so colour isn't the only cue.
- `DailyChart` order is Claude, Codex, Cursor.
- `PlanMeters` shows "Not reported" for Cursor.

**Agent loading:**
- `stores/agent-load.svelte.ts` adds `loadCursor()`.
- `settings/AgentLoadSettings.svelte` adds a "Cursor MCP servers" group with loading, can't-be-listed, unreadable and empty states.
- `LoadRow` adds the kind label "Cursor MCP server".

**Commands.** `sessions/CommandMenu.svelte` shows the "Cursor" badge.

**Design preview.** `preview/DesignPreview.svelte` gets Cursor fixtures.

### 2.14 Persistence

There is no migration: the SQLite provider columns are plain `text` with no CHECK (confirmed against `0023_codex_provider.sql`).
- The Drizzle `enum`s on `sessions.brain_provider`, `brain_threads.provider`, `workers.provider` and `workers.requested_provider` are widened, derived from `PROVIDER_IDS`. Run `drizzle-kit generate` once to confirm it produces nothing.
- `brain_threads` holds the Cursor ACP session id for each session, and `workers.provider_session_id` holds a worker's.
- `workers_pref_json`, the `app_settings` defaults and the plan JSON pick up `cursor` through `PROVIDER_IDS`.
- The usage tables already use free-text provider.
- `provider-cache.json` gains a `cursor` key.

**Downgrade.** An older build reading `'cursor'` in an enum column would hit lookup tables with an unknown id. This is accepted for a single-user app and noted in the release notes.

---

## 3. Impact and Risk Analysis

**System dependencies:**
- The provider registry, status service, model registry, resolution and fallback.
- The orchestrator and worker manager start paths.
- The attention coordinator, through a new approval handler.
- Personal config and Agent loading.
- The command catalogue.
- Usage recording and plan usage.
- The Settings and session UI.

The generalisation slice touches many files, but it changes no behaviour and is guarded by the exhaustive-switch lint and the table test.

| Risk | Mitigation |
|---|---|
| ACP is hidden and changes between CLI versions | Version gate, loose schemas, recorded fixtures per version, the probe at launch and on Check again; an unsupported version shows as Unsupported on the Providers page |
| The user's allow list or `approvalMode` lets Cursor run risky actions without asking | Arc's project deny file, classification of tool calls that never asked (blocked note), the Cursor block in the bypass warning |
| A reject carries no reason, so the agent may retry | Worker instruction rule, and the decline reason in front of the next prompt |
| Tokens or plan usage not reported over ACP (confirmed by M1) | "Not reported" states; plan meter already designed for it |
| Cursor times a bridge call out at 60 s and sends no progress token (M1) | Blocking bridge tools need a polling shape for Cursor (§2.5) |
| Edits and reads never ask in agent mode (M1) | Deny file `Write(...)` entries, after-the-fact classification and the "blocked or ran unasked" note; the brain stays in `ask` mode |
| Switching a Cursor server off may only block it, not unload it | Ranked strategies (§2.5); the row says "blocked, not unloaded" when that's the case |
| The bridge token stored by Cursor in `acp-sessions` | Token revoked at agent end, renewed per load; spike N2 checks |
| `agent` is a generic binary name | Prefer `cursor-agent`; accept `agent` only with a Cursor-style version string |
| Many models (46 in ACP, ~100 in `agent models`) | Grouped by maker, variants collapsed, type-ahead |
| The CLI updates itself mid-session | The running process keeps its version; a version change marks the brain stale on next start, as for Codex |
| Concurrent `agent acp` processes | Fixed upstream in 2026.07.06 (minimum version); spike N9: three parallel processes left permissions, `mcp.json` and `hooks.json` unchanged. Cursor only rewrites `privacyCache.updatedAt` in `cli-config.json`, so file-unchanged checks ignore that field |
| Arc writes `.cursor/cli.json` / `.cursor/mcp.json` in worktrees | Only in Arc's worktrees, hidden by `info/exclude`, never when the repository commits its own; never in the user's checkouts |

---

## 4. Testing Strategy

- **Fakes only.**
  - **`tests/e2e/fixtures/fake-cursor.mjs`:** mirrors `fake-codex.mjs` and is selected by `HARNESS_CURSOR_BIN`.
    - Subcommands: `--version`, `status --format json`, `about --format json`, `models`, `update`, and a scripted `acp`.
    - Script steps: `emit`, `request` (permission, then wait), `expect` (prompt or cancel), `sleep`, `exit`, and `mcp`, which makes real calls to Arc's bridge using the `session/new` params.
    - Env: `FAKE_CURSOR_VERSION`, `FAKE_CURSOR_AUTH`, `FAKE_CURSOR_MODELS`, `FAKE_CURSOR_COMMANDS`, `FAKE_CURSOR_SCRIPT_DIR`, `FAKE_CURSOR_LOG`, `FAKE_CURSOR_SESSION_ID`, `FAKE_CURSOR_RESUME_FAIL`, `FAKE_CURSOR_USAGE` (none / prompt / update), `FAKE_CURSOR_ABOUT_LATEST`.
  - **`tests/e2e/cursor-rig.ts`:** builds on `codex-rig.ts`.
  - Never run the real `agent` with a model turn in tests, never touch `~/.cursor`, no network.
- **Unit tests:**
  - JSON-RPC peer, ACP client, parser (against the recorded fixtures once M1 to M5 exist; synthetic until then), normalize, approvals handler, config and deny file, user-config parse, probe parsers;
  - `checkCursor`, model registry Cursor list and cache, `cursor-tiers`;
  - provider-neutral resolution and fallback text, `effectiveBrain`, command catalogue and routing;
  - usage weights and limit-error detection, load catalogue `listCursor` and `cursorMcp`, bypass detector Cursor block;
  - a test that hashes `~/.cursor` files of a temp HOME before and after an agent run (ignoring `cli-config.json`'s `privacyCache.updatedAt`, which Cursor refreshes itself);
  - the table test over `PROVIDER_IDS`.
- **Renderer (jsdom):**
  - `provider-label`, `model-options` `cursorGroups` (grouping, variant collapse, Auto first, unavailable pick), the providers and models stores;
  - `ProviderStatusRow` states, `ProviderNote`, the Agent loading Cursor group states, `CommandMenu` badge;
  - `DailyChart` three providers, `PlanMeters` "Not reported", `EventLog` `cursor-blocked`.
- **E2E (Playwright, tagged `@spec: 010-cursor-as-a-third-provider`):** one or more tests per acceptance criterion:
  - Providers states;
  - choosing Cursor for the brain and workers;
  - Auto picking Cursor;
  - a new model appearing;
  - a Cursor worker's change merged;
  - live terminal;
  - step in;
  - push asked about in Needs attention, and the blocked-note path;
  - usage panel, Usage page and plan meter;
  - fallback to Claude, and limit pause;
  - Cursor MCP server use and switching;
  - user files unchanged;
  - "/" list, routing and the brain starting a Cursor command.
- **Screenshots** in `docs/screenshots/010-cursor-as-a-third-provider-*.png`:
  - Providers page;
  - the grouped model chooser with the Effort control;
  - a Cursor worker card and its fallback line;
  - the blocked-action row;
  - the Usage page with three providers (light and dark);
  - the Cursor plan meter;
  - the Agent loading Cursor group;
  - the "/" list with a Cursor badge.
- **Gates** as in specs 008 and 009: targeted tests per slice, then the full unit and e2e suites once at the end.

---

## 5. Decisions

- **Transport:** ACP (`agent acp`) over print mode, because only ACP can ask before an action. The fallback, if spike M1 shows ACP never asks, is a print-mode adapter with Arc's deny file and blocked notes only (not built now).
- **No `CURSOR_CONFIG_DIR` overlay** in v1; Arc never edits `~/.cursor`.
- **No migration.**
- **Confirmed by the user (2026-10-21):**
  - The fallback card keeps the existing wording (the functional spec was updated to match).
  - If ACP reports no tokens, Cursor rows read "Not reported" and Cursor is left out of token totals.
  - Cursor commands are expanded by Arc, not left to Cursor (2026-10-21). Why: Arc's instructions block is prefixed to the first prompt, so the slash is no longer at the start, and M5 only proved a bare `/shout banana` works. The command file's body is sent with the arguments applied (as for Codex prompts), and an unreadable file fails the worker with a clear reason.
  - Spikes M1 to M5 are approved: one real turn each on the cheapest Cursor model, against a scratch repo, as described in §2.12. Any further real run needs a new approval.
