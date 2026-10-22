# Technical Specification: Codex as a Second Provider

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Completed
- **Author(s):** redgell, with the agent-orchestration, sqlite-database and svelte-frontend specialists

---

## 1. High-Level Technical Approach

Arc drives Codex through **`codex app-server`**: JSON-RPC 2.0 over stdio, one process per agent (the brain and each worker), mirroring "one `claude -p` per agent". `codex exec --json` was rejected. It is one-shot, has no approval channel, and the only way to interrupt it is to kill it. app-server gives long-lived threads, multiple turns, `turn/interrupt`, `thread/resume`, streaming items and server-to-client approval requests. The research was done on codex-cli 0.162.1. The verified findings and the generated protocol schema are in the session scratchpad and will be copied into `tests/fixtures/codex/` during implementation.

The work splits into six parts:

- **A provider-neutral agent layer:**
  - `StartOptions` splits into common options plus a `claude` or `codex` block.
  - A `ProviderRegistry` selects the adapter.
  - A new `CodexAdapter` sits next to `ClaudeAdapter`, and both feed the same normalized event union.
- **Provider-neutral approvals:**
  - Every risky action becomes a `NormalizedAction` (`bash | edit | mcp | permission | other`) that one classifier and one `AttentionCoordinator.requestAction` decide.
  - For Claude the action arrives through the existing `request_permission` tool.
  - For Codex it arrives as an app-server server request that the adapter answers.
  - Codex runs with `approvalPolicy: "untrusted"`, so every command that isn't trusted read-only reaches Arc (the user's decision).
- **Provider and model choice as data:**
  - `ModelRef = {provider, model}`, a model registry per provider, and Settings defaults with per-session overrides.
  - One pure resolver decides each worker's provider and model, covering the Workers setting, commands, plan edits, the brain's proposal and the Claude fallback.
- **Personal MCP servers and hooks for both providers** (functional spec 2.6, the user's decision):
  - Agents (brain and workers) load the user's own and their plugins' MCP servers and hooks, but never their permission rules.
  - MCP tools that change something go through Arc's approvals.
- **Codex skills and prompts** in the `/` list. A command forces its own provider.
- **Renderer:**
  - a Settings "Providers" page;
  - grouped Claude and Codex pickers;
  - a provider select on the plan card;
  - one shared provider label;
  - a non-blocking Codex note.

Affected areas:
- **main:** agents, policy, attention, orchestrator, worker manager, bridge tools, plugins, CLI status, a new `personal/`, `models/`, `providers/` and `settings/`;
- **db:** migration 0023;
- **renderer:** settings, session header, plan card, worker and brain views, command menu and banner;
- **tests:** a new `fake-codex.mjs` and `fake-mcp.mjs`.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1. Agent layer

- **Shared types:** `src/shared/types/provider.ts` (new) holds:
  - `ProviderId = 'claude' | 'codex'`;
  - `ModelRef`;
  - `WorkersPref = {mode:'auto'} | {mode:'provider', provider} | {mode:'model', model: ModelRef}`;
  - `ProviderStatus`.
- **Adapter contract** (`src/main/agents/agent-adapter.ts`):
  - `CommonStartOptions` holds:
    - `agentId`, `role`, `cwd`, `model`, `addDirs`, `instructions` (formerly `appendSystemPrompt`);
    - `bridge {url, token}` (replaces `mcpConfigPath`; each adapter renders its own MCP config);
    - `bridgeTools` (bare names), `readOnlyDirs`, `access: 'brain-readonly' | 'worker-write'`, `personal?: PersonalConfig`;
    - `resume?: {threadId}`, `approvals: ApprovalHandler`, `extraEnv`.
  - Provider blocks:
    - `claude: {mcpConfigPath, settingsPath?, pluginViewDir?, permissionPromptTool}`;
    - `codex: {codexHome?}`.
  - `AgentHandle` gains:
    - `provider`;
    - `capabilities {interruptCancelsApprovals, queuesSendsWhileBusy, midTurnSteer}`.
- **Registry:** `ProviderRegistry` (`src/main/agents/provider-registry.ts`, new) exposes `adapter(p)`, `status(p)`, `refreshStatus`, `models(p)` and `toolNamer(p)`.
  - `bootstrap.ts` builds both adapters.
  - The Orchestrator, WorkerManager and command probe take the registry, not one adapter.
- **Event changes** (`agent-events.ts`):
  - `session` gains `provider`.
  - `turn-result` gains `turnId` and `status`.
  - `usage.costUsd` becomes optional; Codex reports tokens only, so a missing cost means unknown, not zero.
  - `rate-limit` gains `provider`.
  - New variants: `turn-started`, `approval` (informational), `plan-updated`, `model-rerouted`, `mcp-status`, `user-input-request`.
  - Codex items map to the existing events:

| Codex item                  | Arc event                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `agentMessage` (and deltas) | `assistant-message` / `text-delta`                                                    |
| `reasoning` summary         | `thinking-delta`                                                                      |
| `commandExecution`          | `tool-use` `Bash` (shell wrapper unwrapped) / `tool-result` (output capped)           |
| `fileChange`                | `tool-use` `Edit` with the file list / `tool-result`                                  |
| `mcpToolCall`               | `tool-use` `mcp:<server>.<tool>` / `tool-result`                                      |
| `turn/completed`            | `turn-result` (`completed`, `interrupted` or `failed`)                                |
| `thread/tokenUsage/updated` | `usage`                                                                               |
| `error.codexErrorInfo`      | `error` kinds `auth`, `rate-limit`, `api`; a spawn ENOENT becomes `not-installed`     |

- **`CodexAdapter`** lives in `src/main/agents/codex/`: `codex-adapter`, `codex-rpc`, `codex-parser`, `codex-normalize`, `codex-config`, `codex-types` (hand-written subset; the generated schema is not imported), `codex-probe` and `codex-commands`.
  - **Process:** spawns `codex app-server` through `ProcessSupervisor`, with the same kill ladder, pid ledger and stderr tail.
    - The env allowlist passes `CODEX_HOME` only if the user's env sets it. It never passes `OPENAI_*` or other `CODEX_*`, so the subscription login is used.
    - The per-agent bridge token travels in `ARC_BRIDGE_TOKEN`.
    - Agents also get `ARC_AGENT=1`, `ARC_AGENT_ROLE` and `ARC_PROVIDER`, so the user's hooks can tell they are inside Arc.
  - **Handshake:**
    1. `initialize {clientInfo, capabilities:{experimentalApi:true}}`, then `initialized`.
    2. Version check against `MIN_CODEX_VERSION` (0.162.0).
    3. `account/read`. Signed out means `start()` rejects with `ProviderUnavailableError`, which drives the fallback.
    4. `thread/start` or `thread/resume` with:
       - `cwd`, `model`, `modelProvider:'openai'` (beats the user's LM Studio default);
       - `approvalPolicy:'untrusted'`, `approvalsReviewer:'user'`;
       - `sandbox` (see below), `developerInstructions` (never `baseInstructions`);
       - `config.mcp_servers`.
       Instructions and MCP config are re-sent on every resume.
    5. Wait for the required `arc` MCP server to report ready.
  - **Sandbox:**
    - The brain uses `read-only`.
    - Workers use `workspace-write`, with roots set to the worktrees plus each repo's git common dir.
    - Spike S3 confirmed workers can commit under `workspace-write` with explicit roots: the worktree, `<common>/worktrees/<id>`, `objects`, `refs` and `logs` (derived from the worktree's `.git` file), with the default `/tmp` and `$TMPDIR` roots off. No `danger-full-access` fallback.
  - **Turns:**
    - `send` calls `turn/start` when idle. While a turn is active or starting, it queues one-at-a-time, so each send yields its own `turn-result`, matching Claude.
    - Commands can pass `[{type:'skill',name,path},{type:'text',text}]`.
    - A Codex brain model change uses `turn/start.model`, so no restart is needed.
  - **`interrupt`:**
    - If a turn is starting, wait for it to start first.
    - Then send `turn/interrupt` and wait for `interrupted`: the result is `acked`.
    - Otherwise escalate to SIGINT, then kill, as Claude does.
  - **Crashes:** a non-zero exit is a crash, which is relaunched with `thread/resume`.

### 2.2. Approvals

- **`NormalizedAction`** (`src/main/policy/normalized-action.ts`, new):
  - `normalizeClaudeCall(tool, input)` converts a Claude call.
  - `toStoredCall(action)` keeps `attention_requests.tool_name` and `tool_input_json` Claude-shaped (`Bash`, `Edit`, `mcp__server__tool`, `CodexPermissions`). This keeps allow rules, the cards and existing rows working.
- **Classifier** (`policy/classify.ts`):
  - `classifyAction(action, ctx)`, with `classify()` kept as a wrapper so every existing case passes unchanged.
  - New categories:
    - `mcp_write`: the brain may approve it.
    - `extra_permissions`: the user only.
  - MCP calls:
    - Read-only means `readOnlyHint === true` and not destructive, and those run.
    - Anything else asks.
  - Brain actions (`brain-policy.ts`, `classifyBrainAction`):
    - Bash keeps today's rules.
    - Edits are always denied.
    - Personal MCP write tools ask the user.
- **Coordinator:** `AttentionCoordinator.requestAction(agent, action, meta, signal) → {allow} | {allow:false, message?, cancelTurn?}`.
  - `requestPermission` and `brainRequestPermission` become normalize-then-call wrappers.
  - The AskUserQuestion branch stays Claude-only.
  - Coverage, allow rules, Auto-approve, `route='terminal'` while controlled (spec 006) and the brain-then-user escalation are all unchanged.
- **Codex server requests,** answered by the adapter through the injected `ApprovalHandler`:

| Request                                  | Normalized as                                                                   | Answer                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval`  | `bash {command: unwrapShell(command), cwd}`                                     | `accept`, `decline` (with the denial message sent after as a best-effort `turn/steer`), or `cancel`                               |
| `item/fileChange/requestApproval`        | `edit {paths}` from the earlier `fileChange` item, else `grantRoot` (fail closed) | `accept` / `decline`; the brain always gets `decline`                                                                             |
| `item/permissions/requestApproval`       | `permission`                                                                    | the requested profile with `scope:'turn'`, or an empty one                                                                        |
| `mcpServer/elicitation/request` (tool approval) | `mcp {server, tool, readOnly}`                                           | `accept` / `decline`. Non-approval elicitations get `cancel` and are logged                                                       |
| `item/tool/requestUserInput`             | not used in v1 (S5: unavailable outside Plan mode); answered with cancel if it ever arrives | `ask_brain` is the only question path |

- **Never grant more than one action.** Arc never answers with `acceptForSession`, an execpolicy amendment or `scope:'session'`. "Always allow" stays an Arc allow rule, scoped to an exact command prefix or an exact `mcp__server__tool`.
- **Restart:** a quit kills the app-server and its open requests. Rows stay pending. On resume, the existing undelivered-answer note is sent as the first turn after `thread/resume`.
- **Interrupt:** `turn/interrupt` cancels pending Codex approvals (spike S6). Their rows become `cancelled`. Step-in on a Codex worker therefore has nothing to re-route. Approvals from typed turns get `route='terminal'` as today.

### 2.3. MCP bridge and personal MCP and hooks

- **Arc's own server for Codex** (`codex-config.ts`): `url`, `bearer_token_env_var:'ARC_BRIDGE_TOKEN'`, `required:true`, `startup_timeout_sec:20`, `tool_timeout_sec:86400`, `default_tools_approval_mode:'approve'` and `enabled_tools`.
  - The bridge sends MCP progress keepalives on long calls (spike S7).
  - `ask_brain` is idempotent per worker and question for 10 minutes, so a timed-out re-call gets the same answer.
  - `request_permission` is registered for Claude only (`defineTool.providers`).
- **Tool names:** `BridgeToolNamer` (`src/main/agents/tool-namer.ts`) maps a bare name to `mcp__arc__<name>` for Claude. The Codex form is pinned after spike S1.
- **Personal configuration:** `PersonalConfigService` (`src/main/personal/`, new) resolves each provider's user and plugin MCP servers and hooks per agent start. The output is written to `userData/agent-config/<hash>/`.
  - **Claude:**
    - Keep `--setting-sources project`. This is what keeps the user's permission rules, `env` and other settings out; `claude --help` offers no way to take user settings without their permissions.
    - Hooks go in through a generated `--settings` file that contains only `hooks`.
    - MCP goes in through one generated `--mcp-config`, still with `--strict-mcp-config`, merging `arc` (which wins name clashes), the user's servers (`~/.claude.json`, user and local scope), the plugins' servers (namespaced the way Claude does, with `${CLAUDE_PLUGIN_ROOT}` expanded) and the repo's `.mcp.json`.
    - The spec 005 plugin view stops stripping `hooks/`, `.mcp.json` and those manifest keys. It keeps the `user` wrapper, the per-repo copies, the shadowing and the hash and prune logic. It still strips LSP servers and plugin `settings`.
    - Spike S8 checks the flag set with the no-model command probe.
  - **Codex:**
    - Keep the real `CODEX_HOME`; a separate home drops auth.
    - Personal MCP servers, `notify`, hooks, skills and AGENTS.md load as in the terminal. Per-thread overrides enforce the model, provider, approval policy, sandbox and reviewer.
    - Personal servers get only `{default_tools_approval_mode:'prompt'}` per server name (S10: overrides merge), so every personal tool call reaches Arc to decide. The tool name and `readOnlyHint` come from the preceding `item/started mcpToolCall`.
- **MCP tool catalogue** (`mcp-tool-catalogue.ts`): finds out whether a tool is read-only.
  - Codex: from `mcpServerStatus/list` annotations.
  - Claude: from an Arc-side MCP client running `tools/list` (`@modelcontextprotocol/sdk`), lazily, with a 10-second timeout and a 1-hour cache.
  - Unknown, unreachable or unauthenticated means ask.
- **Brain and workers both** load personal MCP and hooks (the user's decision). The brain stays read-only for files (Claude allowed tools, Codex `read-only` sandbox). Its personal MCP write tools ask the user.
- **Bypass warning:** a user hook that answers "allow", or a Codex `rules/*.rules` allow entry, can skip Arc's approvals. Arc allows this but shows a warning (the user's decision): Settings lists the hook events and Codex allow prefixes that can bypass approvals, and the event log notes it once per session. A strict mode is a later spec.

### 2.4. Provider status

- **`ProviderStatusService`** (`src/main/providers/`, new) caches a `ProviderStatusMap`. Its TTL is 30 seconds, plus a lazy re-check before a Codex spawn when the status isn't ok.
- **Codex checks:**
  - `codex --version`: ENOENT means `missing`; below 0.162.0 means `unsupported`.
  - `codex login status`: exit 0 with ChatGPT means `ok`. An API key means `ok` with `account.kind='api_key'`, which Settings shows as "Codex · API key (not your subscription)" (the user's decision). Exit 1 means `signed_out`.
- **Test override:** `HARNESS_CODEX_BIN` mirrors `HARNESS_CLAUDE_BIN`.
- **Messages:** `CLI_MESSAGES` splits per provider, with the Codex texts from functional spec 2.7.
- **Blocking:** Claude missing still blocks sessions. Codex never blocks.

### 2.5. Models, settings and resolution

- **Model registry** (`src/main/models/model-registry.ts`):
  - Claude: the static aliases plus full ids learned from `init`.
  - Codex: `model/list` through a short-lived probe app-server (no model call), cached in memory and in `userData/provider-cache.json` for 24 hours, and listed only while Codex is `ok`. Spike S11 checks subscription filtering.
  - Each model gets a tier (deep, balanced or fast) for picking the fallback.
- **Resolver:** `resolveWorkerTarget` (`src/main/models/provider-resolution.ts`, pure) returns `{ref, source, notes, fallback?}`.
  - **Provider order:** a command's provider, then the session's pinned model or provider, then the plan edit, then the brain's proposal, then Claude.
  - **Model order:** the pinned model, then the plan edit, then the proposal, then the provider default.
  - **Codex not ok:** fall back to Claude by tier (fast becomes `haiku`, otherwise `sonnet`).
    - A worker that runs a Codex command can't fall back; it fails with an explanatory event line.
    - A stopped Codex worker is never moved to Claude.
  - `spawn_worker` echoes `{provider, model, note}` to the brain.
- **Bridge tools:** `spawn_worker` and `propose_plan` gain an optional `provider`. Plan workers gain `provider` and `approvedProvider`.
- **Brain prompt v5:**
  - A dynamic "Providers and models" block: the available models per provider, which are unavailable and why, and whether Workers is pinned.
  - Guidance when on Auto: default to Claude; pick Codex for reviews, second opinions or when asked; say which and why.
  - Provider-specific tool wording.
- **Brain fallback:** applies to one reply only. The brain runs on Claude · Sonnet and the stored preference is unchanged.
- **Event log texts:**
  - "started W2 review · Codex · gpt-5.5";
  - "Codex isn't signed in, so W2 runs on Claude. Run codex login in Terminal to use Codex.";
  - the brain variant of that message.
- **Shared formatter:** `src/shared/provider-label.ts`, used by main and the renderer.

### 2.6. Data model (migration `0023_codex_provider`, one transaction)

| Table / column                              | Change                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `app_settings(key PK, value_json, updated_at)` | New. Keys `providers.brain` (`ModelRef`, default `claude:sonnet`) and `providers.workers` (`WorkersPref`, default `auto`). A missing row means the default. |
| `sessions.brain_provider`                   | New, default `claude`; `brain_model` stays as the model                                  |
| `sessions.workers_pref_json`                | New; backfilled from `sessions.model` (`auto` becomes `{mode:'auto'}`, an alias becomes a Claude model). `model` stays, read-only |
| `brain_threads(session_id, provider, thread_id, updated_at, PK(session_id, provider))` | New; backfilled from `sessions.brain_claude_session_id` as `claude`. That old column stays unused, so downgrades are safe |
| `workers.provider`                          | New, default `claude`                                                                   |
| `workers.requested_provider`, `workers.fallback_reason` | New, nullable; set together only on a fallback                              |
| `workers.claude_session_id` → `provider_session_id` | `RENAME COLUMN`                                                                 |

- **No CHECK constraints** on `sessions` or `workers`. drizzle-kit would rebuild the table, and the cascade would delete worktrees and held messages. Enums are enforced in TypeScript and the repos.
- **Renames:** after generating the migration, verify the SQL contains `RENAME COLUMN`, not drop and add.
- **Plan JSON:** read through `parsePlanWorkers`, where a missing `provider` becomes `claude`. Stored JSON is never rewritten.
- **Repos:**
  - New `AppSettingsRepo`: `get`, `set`, `setMany`, `getProviderDefaults`.
  - New brain-thread repo.
  - Workers repo: provider and fallback setters, and `setProviderSessionId`.
- New sessions copy the Settings defaults at creation. Changing Settings later doesn't touch existing sessions.
- **Brain provider switch** (header or setting): resume that provider's row in `brain_threads` if present. Otherwise start fresh with a hand-off preamble of recent messages, capped at about 6,000 characters (assumption).

### 2.7. Commands, skills and step-in

- **Catalogue entries** gain `provider` and `kind` (`command`, `skill` or `prompt`), and new sources `codex-skill` and `codex-prompt`. Ids are `${provider}:${name}`.
  - Codex skills come from `skills/list {cwds}` (no model call).
  - Codex prompts come from `$CODEX_HOME/prompts/*.md`, with front matter parsed and expanded by Arc (`$1..$9`, `$ARGUMENTS`, `KEY=value`, `$$`).
  - Both are listed only while Codex is `ok`.
  - A command forces its provider, and an ambiguous `/name` returns both ids.
- **Step-in** (spec 006): goes through `handle.interrupt()` and `handle.send()`, which become `turn/interrupt` and `turn/start` for Codex.
  - A typed `/skill` that matches a Codex skill becomes a skill input.
  - Other slash text gets an explanatory terminal line.
  - Hand-back composition is unchanged.
  - Pause and relaunch use `thread/resume`.

### 2.8. IPC contract (`src/shared/ipc/contract.ts`)

- **New:**
  - `providers:get → ProviderStatusMap & models`;
  - `providers:check {provider?} → ProviderStatusMap`;
  - `settings:get`, `settings:set {providers.brain?, providers.workers?}`;
  - pushes `providers:changed` and `settings:changed`.
- **Changed:**
  - `sessions:set-config` takes `brainModel: ModelRef` and `workers: WorkersPref`.
  - Plan approve takes a per-worker `ModelRef` map.
  - Worker, brain and plan views gain `runningOn {provider, model, requestedProvider?, fallbackReason?}`.
  - `CommandInfo.source` gains `codex`.
- **Removed:** `cli:status` and `cli:retry-check`, replaced by `providers:*` in one change.

### 2.9. Renderer

- **Settings "Providers" page:** first in the Settings nav, and the default page.
  - One status row per provider: "Codex · signed in" or not, the message, the command with a copy button, and **Check again**.
  - Default Brain and Workers pickers.
  - A saved Codex default stays in place, flagged as unavailable when Codex is down.
- **Header:**
  - `HeaderMenu` and `Select` gain option groups.
  - Brain: models grouped by provider.
  - Workers: Auto, Claude, Codex, then grouped models.
  - Codex is hidden when unavailable, unless it is the current pick (then shown as "(unavailable)").
  - Labels: "Brain · Sonnet", "Brain · Codex gpt-5.5" (assumption: Claude models stay bare), "Workers · Codex".
- **Plan card:** a provider select plus a model select per worker. Changing the provider resets the model, and a pinned header disables them.
- **Labels everywhere:** a `ProviderTag` component on WorkerCard, WorkerDetails, the ConversationTabs header, BrainCard, PlanCard and EventLog, built on the shared formatter. A fallback shows "Claude (Codex unavailable)", with the reason in the title and in details.
- **`/` menu:** a "Codex" badge for skills and prompts. Same-named entries from both providers each show their own badge.
- **Banner:** `CliBanner` stays blocking for Claude. A new dismissible `CodexNote` shows only when the session uses Codex and Codex isn't ready. It has Check again and a Settings link, never disables the Composer, and its dismissal is kept in memory only.
- **Stores:** `providers.svelte.ts` replaces `cli.svelte.ts`. The model list refreshes on each check and on window focus, debounced.

---

### 2.10. New models and provider updates (functional spec 2.8)

- **When:** `ProviderStatusService` runs a full check at launch (after the window shows, not blocking it), on Check again, and on window focus when the last check is older than 10 minutes.
- **Models:** each check refreshes `ModelRegistry` (Claude aliases plus ids from `init`; Codex `model/list` through `codex-probe`) and diffs against the cached list in `userData/provider-cache.json`. Changes push `providers:changed`, so the renderer pickers update live. The brain prompt's "Providers and models" block is rebuilt per reply (§2.5), so the brain sees new models from its next reply.
- **Latest version:** a no-model lookup of the newest published version per provider. The npm registry is used (`@anthropic-ai/claude-code`, `@openai/codex`) with a 5-second timeout, cached for 6 hours in `provider-cache.json`, and failures are silent (no update shown). _(assumption: the npm version tracks both the native installer and npm installs closely enough; a provider can override the source later)_
- **Update command:** derived from the install, shown verbatim: `claude update` and `codex update`, both verified in each CLI's `--help`. If the binary path shows a Homebrew install, show `brew upgrade <formula>` instead.
- **Status shape:** `ProviderStatus` gains `latestVersion?`, `updateCommand?`, `updateAvailable: boolean`. The one-time notice keys on `providers.update_dismissed.<provider>` in `app_settings` (value: the dismissed version).
- **Picking up an update without a restart:** every spawn resolves the binary and re-reads `--version`, so new workers use the updated tool automatically. When the detected version changes, the brain is flagged stale like a model change (§2.5): it is stopped between replies and the next reply starts on the new binary with `--resume` / `thread/resume`, so the conversation is kept. Running workers are not touched. The minimum-version gate re-runs.
- **Restart prompt:** shown only when a live switch isn't possible: the binary moved to a path Arc can't resolve without the login shell PATH captured at launch, or the new version changes the protocol in a way the version gate rejects for running agents. The renderer shows a `Modal` "Restart Arc to finish updating <Provider>" with Restart now (`app:relaunch` IPC, which uses `app.relaunch()` + `app.quit()` after the existing close gate) and Later. Sessions resume through the existing startup recovery.
- **IPC:** `providers:dismiss-update {provider, version}`, `app:relaunch`. The `providers:changed` payload carries the update fields.

---

## 3. Impact and Risk Analysis

- **System dependencies:**
  - spec 003: orchestration, model choice and attention;
  - spec 005: commands and the plugin view, both changed by 2.6;
  - spec 006: step-in, which goes through the adapter contract;
  - the Codex CLI (0.162.x, app-server marked experimental);
  - `@modelcontextprotocol/sdk` (already a dependency) for the Claude annotation lookup.
- **Risks and mitigations:**
  - **Experimental protocol:** field names may change between releases. Mitigation: hand-written minimal types, a minimum-version gate, per-version fixtures, and unknown notifications become `unknown` events that never throw.
  - **Sandbox versus linked worktrees:** resolved by S3 (explicit writable roots).
  - **Approval bypass by user hooks or Codex allow rules:** allowed with a warning (decided).
  - **Long-blocking MCP calls versus Codex tool timeouts (S7):** mitigated by a 24-hour timeout, keepalives and an idempotent `ask_brain`.
  - **Decline carries no message:** a denial with a message sends `turn/steer` first, then `decline` (S6).
  - **MCP annotation coverage is patchy:** reads may ask until the user chooses Always allow. Noisy, but in the safe direction.
  - **Arc's MCP client starts the user's servers:** only `tools/list`, time-boxed, and a failure means ask.
  - **The thread-id rename touches every session's resume path:** covered by a migration backfill test and an e2e resume of a database from before the migration.
  - **The user's Codex `notify` hook** fires for every Arc Codex agent. Documented, and `ARC_AGENT` lets them gate it.
  - **Process count:** one app-server per Codex agent, the same order as Claude today.
- **Update checks:** the npm registry can be slow or offline, so lookups are time-boxed, cached and silent on failure; nothing is ever installed by Arc.
- **Spikes to run first** (no model calls, except where they use the one recording run):
  - S1: tool-name prefix;
  - S2: does `untrusted` ask for `cat`/`ls`, and do user allow rules bypass it;
  - S3: sandbox roots and committing in a worktree;
  - S4: the elicitation shape;
  - S5: `requestUserInput` without a chat window;
  - S6: interrupt cancels approvals, and steer after decline;
  - S7: long tool-call timeout;
  - S8: the Claude flag set loads MCP and hooks but not permissions;
  - S10: MCP override merge versus replace;
  - S11: `model/list` filtering when signed in.

---

## 4. Testing Strategy

- **The one real recording** (pre-approved by the user):
  - At the very start of implementation, one small real Codex turn is captured by a dev-only `scripts/record-codex.mjs`. The turn reads a file, makes one patch, runs one command that needs approval, and calls one MCP tool against a local fake bridge.
  - The output is scrubbed and saved to `tests/fixtures/codex/0.162.1/real-turn.jsonl`.
  - It answers S1, S2, S4 and S5.
  - No other real model call is made.
- **Fakes:**
  - `tests/e2e/fixtures/fake-codex.mjs`, selected by `HARNESS_CODEX_BIN`, with `FAKE_CODEX_*` env passed only under `HARNESS_E2E`:
    - answers `--version` and `login status`;
    - plays a scripted app-server from NDJSON scenarios (`emit`, `request` and wait, `expect`, `sleep`, `exit`), written from the recording;
    - makes real MCP calls to the bridge with `ARC_BRIDGE_TOKEN`.
  - `tests/e2e/fixtures/fake-mcp.mjs`: a stdio MCP server with a read-only tool and a writing tool.
  - `fake-claude.mjs` gains personal MCP scenarios and an argv assertion: `--settings`, `--strict-mcp-config`, `--setting-sources project`, and no `user`.
- **Unit tests:**
  - `codex-parser`, against the fixtures;
  - `codex-rpc`: framing, correlation and server requests;
  - `codex-adapter`, against the fake: handshake, queueing, the interrupt race, the stop ladder;
  - `codex-normalize`: the shell-unwrap forms;
  - `classify-action`: a parity table, so every existing `classify` case is unchanged, plus the MCP and permission cases;
  - `provider-resolution`: the full matrix;
  - `personal-config`: hooks kept, permissions dropped, MCP merged;
  - `plugin-view`: tests inverted;
  - `prompt-expand`;
  - `migration-0023`: backfill, an upgrade from a 0022 database, and worktrees survive;
  - app-settings and brain-thread repos;
  - a source scan proving API-key env vars never reach a child process.
- **Renderer jsdom tests:**
  - the provider label formatter;
  - the Providers page;
  - header groups;
  - the plan card's provider select;
  - cards with the fallback text;
  - the `/` menu Codex badge;
  - `CodexNote`;
  - the a11y sweep.
- **E2E tests** (Playwright with the fake CLIs):
  - "Workers · Codex" from Settings, and a header override;
  - plan card provider edit;
  - a Codex push approval in Needs attention;
  - a Codex question;
  - step in and hand back on a Codex worker;
  - the fallback card and log line;
  - Settings status and Check again;
  - Codex skills in the `/` list;
  - personal MCP: a read-only call creates no attention item, and a write call creates one with the server and tool;
  - a resume across restart for a Codex brain and worker.

---

## 5. Decisions Confirmed

- **Protocol:** `codex app-server`, one process per agent.
- **Approvals:** `approvalPolicy: "untrusted"`, so every command that isn't trusted read-only reaches Arc's classifier.
- **Personal MCP and hooks:** the user's own and their plugins' MCP servers and hooks load for Claude and Codex, for the brain and workers. Personal permission rules never load. MCP tools that only read run; those that change something ask.
- **Bypass:** user hooks or Codex allow rules that can skip Arc's approvals are allowed, with a warning in Settings and the event log.
- **Sandbox:** if Codex's sandbox can't commit in a linked worktree, Codex workers run without it, guarded by Arc's approvals.
- **API key:** a Codex API-key login is used, and labelled "Codex · API key (not your subscription)".
- **The `/` list:** shows Codex skills and prompts.
- **Recording:** one real Codex recording run is pre-approved for building the fake (done).
- **The user's Codex allow rules:** S2 showed `~/.codex/rules/*.rules` allow entries (the user has 34, including `git push`, `git commit`, `gh pr create`) skip both Arc's approvals and the sandbox. Decision: Arc writes `<worktree>/.codex/rules/arc.rules` in each Codex worker's working copy with `prompt` rules for its protected prefixes (push, merge-request tools, destructive commands, global installs, network tools such as `ssh`, `scp`, `rsync` and `curl`), and excludes it from commits through the worktree's `info/exclude`. Prompt rules beat allow rules and load without project trust. The user's global rules are untouched. Cases that prefix rules can't express (for example `cp` to a path outside the working copy) rely on the sandbox and Arc's classifier, and the Settings bypass warning lists the remaining allow prefixes.

**Assumptions still open** (recommended defaults, easy to change):

- "Always allow" exists for Codex commands and MCP tools, using the same exact rules as Claude.
- A brain provider switch starts the new provider with a capped hand-off preamble of recent messages.
- A Codex-command worker fails rather than falling back when Codex is unavailable.
- No reasoning-effort control in v1.
- Minimum Codex version 0.162.0, with "update Codex" shown below it.
- The header shows Codex brain models as "Brain · Codex gpt-5.5"; Claude models stay bare.

---

## 6. Spike results

Run on 2026-10-19 with codex-cli 0.162.1 and Claude Code 2.1.302. The scripts are not kept in the repo, except `scripts/record-codex.mjs`.

**How the no-model spikes were run.** Most Codex behaviour (approvals, sandbox, MCP, interrupt) is decided by the app-server and does not depend on the model. So the spikes drove a real `codex app-server` against a throwaway `CODEX_HOME` whose `model_provider` points at a local scripted server that speaks the Responses API. That is not a model call: no request leaves the machine. `command/exec`, `mcpServer/*` and `model/list` need no model either. The one real call is the recording, and it confirms S2, S3 and S1 against the user's real config.

| Spike | Result                                     |
| ----- | ------------------------------------------ |
| S1    | Answered                                   |
| S2    | Answered, with a major consequence         |
| S3    | Answered: the sandbox works, with roots    |
| S4    | Answered                                   |
| S5    | Answered: not usable in Default mode       |
| S6    | Answered                                   |
| S7    | Answered                                   |
| S8    | Answered                                   |
| S10   | Answered: merge                            |
| S11   | Answered: filtered per account             |

### S1. Tool-name prefix (answered)

- **Evidence:** the scripted provider logs the `tools` array Codex sends to the model. With a server named `arc` it holds one entry `{"type":"namespace","name":"mcp__arc","tools":[{"name":"echo"},{"name":"note"},{"name":"slow"}]}`. The tools inside are the bare names. A model call carries `namespace:"mcp__arc"` plus `name:"echo"`. In the real recording the model called it: `item/started` `{"type":"mcpToolCall","server":"arc","tool":"echo","readOnlyHint":true}`.
- **Consequence:** the Codex model sees the same prefix as Claude, `mcp__arc`, with bare tool names. Prompts can say "the `spawn_worker` tool of the `arc` server" for both providers. `BridgeToolNamer` for Codex is `n => n` with namespace `mcp__arc`; pin it with a fixture test. The parser keeps using `server` and `tool` from the item.

### S2. Does `untrusted` ask for `cat`/`ls`, and do user allow rules bypass it (answered)

- **Reads ask.** In the real recording `cat hello.txt` raised `item/commandExecution/requestApproval` with `commandActions:[{"type":"read",...}]` and `availableDecisions:["accept",{"acceptWithExecpolicyAmendment":...},"cancel"]`. The scripted run showed the same for `ls`, `git status` and `echo hi > f`. Every command asks.
- **`commandActions` classifies reads for free.** Types seen: `read`, `listFiles`, `unknown`. Arc's classifier can accept `read` and `listFiles` without parsing the shell.
- **The command string is the shell wrapper:** `/bin/zsh -lc 'cat hello.txt'`. `unwrapShell` must handle an absolute shell path and the user's shell (zsh here).
- **User execpolicy rules bypass Arc, and run unsandboxed.** With `rules/default.rules` containing `prefix_rule(pattern=["git","push"], decision="allow")`, `cp` and `curl`, none of them reached the client. A `git push` to a bare repo outside the writable roots succeeded, `cp` wrote outside the roots, and `curl https://example.com` returned 200 with the network off. An allow rule skips both the approval and the sandbox.
- **This user is affected today.** `~/.codex/rules/default.rules` holds 34 allow rules, including `git push`, `git commit`, `git add`, `git merge`, `gh pr create`, `ssh`, `rsync`, `curl`, `cp`, `pkill -f` and `npm install`. A Codex worker in Arc would push or merge without Arc seeing it. This breaks functional spec 2.4 ("Codex worker tries to push: Needs attention asks").
- **Forbidden and prompt rules are honoured, and the strictest wins.** In the scripted runs, `forbidden` blocked the command with no request, and `prompt` made an allowed command ask. A `.codex/rules/arc.rules` file inside the worktree is loaded without the project being trusted. The recording used it: `prefix_rule(pattern=["git","commit"], decision="prompt")` made `git commit -am record` ask (`"reason":"... requires approval by policy"`) although the user's own rules allow `git commit`.
- **There is no app-server switch to ignore rules** (`--ignore-rules` exists on `codex exec` only).
- **Consequence for the design (decision needed).** "Allow with a warning" is not enough for this user. Recommended: Arc writes `<worktree>/.codex/rules/arc.rules` for each Codex worker with `prompt` rules for the prefixes its classifier treats as protected (`git push`, `git merge`, `gh`, `ssh`, `scp`, `rsync`, `curl`, `wget`, `rm`, `sudo`, `npm publish`, global installs). The brain's cwd gets the same. Anything the rules cannot express, such as `cp` or a redirect to a path outside the working copy, stays covered only by the sandbox and Arc's classifier, and a rule-allowed `cp` still runs outside it. Keep the Settings warning, but list the user's allow prefixes that Arc's rules override and the ones it cannot (`cp`, `mkdir -p`, `npx tsx`, `node -e`). An overlay `CODEX_HOME` is still rejected: token refresh would rewrite `auth.json` and risk the user's real login.

### S3. Sandbox roots and committing in a linked worktree (answered: the sandbox works, with explicit roots)

- **Field names.** For a thread, roots go in `thread/start.config.sandbox_workspace_write.writable_roots` (plus `network_access`, `exclude_slash_tmp`, `exclude_tmpdir_env_var`). The thread response echoes the effective `sandbox` object. For `command/exec` and `turn/start` the policy is `{type:"workspaceWrite", writableRoots, networkAccess, excludeSlashTmp, excludeTmpdirEnvVar}`.
- **Default roots include `/tmp` and `$TMPDIR`.** A test repo under either looks writable for the wrong reason. Arc should set `exclude_slash_tmp` and `exclude_tmpdir_env_var` to true for workers.
- **Results (`command/exec`, `git add -A && git commit`, repo and worktree outside `/tmp`):**

| Writable roots                                              | Result                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| worktree only                                               | fails: `Unable to create '<repo>/.git/worktrees/wt/index.lock': Operation not permitted` |
| worktree + `<repo>/.git`                                    | fails, same error                                                                   |
| worktree + the repo root                                    | fails, same error                                                                   |
| worktree + `<repo>/.git` + `<repo>/.git/worktrees/wt`       | commits                                                                             |
| worktree + `worktrees/wt` + `objects` + `refs`              | fails: `unable to append to '.git/logs/refs/heads/w5'`                              |
| worktree + `worktrees/wt` + `objects` + `refs` + `logs`     | commits                                                                             |

- **Why.** Codex carves `.git` out as read-only, and it follows the worktree's `.git` file to its admin dir (`<common>/worktrees/<id>`). Listing the repo root or the common dir does not undo that. Listing the admin dir itself does.
- **With the four narrow roots the rest stays protected:** writing `<repo>/.git/hooks/pre-commit`, `<repo>/.git/config`, a file in the main checkout, or a path outside all roots each failed with `Operation not permitted`. The worktree's own `.git` file is protected too.
- **Confirmed on the thread path by the real recording.** With `writable_roots = [<repo>/.git/worktrees/wt, <repo>/.git/objects, <repo>/.git/refs, <repo>/.git/logs]` the model's `git commit -am record` ran after approval and ended `[record 5f083c5] record  1 file changed, 1 insertion(+)`, exit 0. The recorder's `command/exec` pre-check also showed the main checkout write denied.
- **Noise, not failure:** the Xcode git shim prints `xcrun_db` cache errors and a post-commit `packed-refs.lock` error (maintenance) under the sandbox. Exit code stays 0. The classifier and the UI must not read stderr text as failure.
- **Consequence:** Workers use `workspace-write`; the `danger-full-access` fallback is NOT needed. Roots per worker: the worktree, `<common>/worktrees/<id>`, `<common>/objects`, `<common>/refs`, `<common>/logs`, for each repo the worker has a worktree in. Compute `<id>` by reading the worktree's `.git` file (`gitdir:`), not from the folder name. Network stays off unless an approval allows it; installs then ask. This also means a `git gc` or `git config` from a worker is denied, which is wanted.

### S4. Elicitation shape for an MCP tool approval (answered)

- **Source:** the fields below were captured against the scripted provider. The recording hit the same request (`serverRequest/resolved` for it is in the real file, and the tool call completed), but the recorder's first version dropped its two wire lines (a client id and a server id collided; fixed in `scripts/record-codex.mjs`). They are kept in `tests/fixtures/codex/0.162.1/mcp-elicitation.jsonl`, labelled as scripted. The real turn is not re-run.
- **Request** `mcpServer/elicitation/request` params: `threadId`, `turnId`, `serverName` (`"arc"`), `mode:"form"`, `message:"Allow the arc MCP server to run tool \"echo\"?"`, `requestedSchema:{"type":"object","properties":{}}` and
  `_meta:{"codex_approval_kind":"mcp_tool_call","tool_description":"...","tool_params":{...},"tool_params_display":[{"name","value","display_name"}]}`.
- **The tool name is only in `message`.** There is no `tool` field. Two ways to get it: parse `Allow the <server> MCP server to run tool "<tool>"?`, or (preferred) take it from the `item/started` `mcpToolCall` that arrives just before the request (same thread and turn, `status:"inProgress"`), which has `server`, `tool`, `arguments` and `readOnlyHint`. Use the item for the name and annotation; use `codex_approval_kind === "mcp_tool_call"` to tell a tool approval from another elicitation.
- **Response:** `{action:"accept"|"decline"|"cancel", content:null}`.
- **Modes seen:** the personal server in `default_tools_approval_mode:"prompt"` asked for both its read-only and its changing tool. An `approve` server (Arc's own) asked for neither. `readOnlyHint` is on the item for both servers (true or false), so Codex passes the annotation through.
- **Consequence:** `codex-normalize` builds `mcp {server, tool, readOnly}` from the item, with the message regex as a fallback. The MCP tool catalogue can read Codex annotations from `item/started.readOnlyHint` and does not need `mcpServerStatus/list`.

### S5. `requestUserInput` without a chat window (answered: not usable in Default mode)

- **Evidence:** Codex advertises `request_user_input` ("only available in Plan mode") to the model. When the scripted model called it in a normal thread, the tool result was `request_user_input is unavailable in Default mode` and no `item/tool/requestUserInput` server request was sent. The real model never called it during the recording.
- **Consequence:** drop `item/tool/requestUserInput` handling from v1 scope (keep a defensive answer of cancel if one ever arrives). `ask_brain` is the only question path. A model that tries `request_user_input` gets an error and should fall back; the instructions should name `ask_brain`.

### S6. Interrupt cancels approvals, and steer after decline (answered)

- **Interrupt.** With a command approval pending, `turn/interrupt` returned `{}`, then `turn/completed` with `status:"interrupted"` arrived 58 ms later, then `serverRequest/resolved` for the request. The command never ran. A late response to the dead request id was ignored without an error. The next `turn/start` on the thread worked. So `interruptCancelsApprovals = true` is correct. The resolved notification comes after `turn/completed`, so the adapter must cancel its pending handlers on `turn/completed(interrupted)` and not wait for it.
- **Decline.** `decision:"decline"` is accepted although `availableDecisions` lists only `accept`, the amendment and `cancel`. The command item ends `status:"declined"`, the model sees the tool result `exec_command failed: CreateProcess { message: "Rejected(\"rejected by user\")" }`, and the turn continues.
- **Steer after decline works.** `turn/steer {expectedTurnId, input:[{type:"text",text:"[Arc] do not push; tell me instead"}]}` returned `{turnId}` and the text reached the model as a user message in its next request. Because the model answers the decline first, send the steer BEFORE the decline response when the deny carries a message, so the model's next step already includes it.
- **Cancel.** `decision:"cancel"` ends the turn as `interrupted`; a steer afterwards fails with `no active turn to steer`.
- **Consequence:** design confirmed. Deny with a message = steer, then `decline`. `cancelTurn` = `cancel`.

### S7. Long tool-call timeout (answered)

- **Method:** a fake streamable-HTTP bridge with a `slow` tool, called through the full tool path by the scripted provider.
- **Results:**

| `tool_timeout_sec`  | Call length | Progress notifications | Result                                                       |
| ------------------- | ----------- | ---------------------- | ------------------------------------------------------------ |
| not set             | 75 s        | no                     | completed                                                    |
| not set             | 90 s        | every 5 s              | completed                                                    |
| not set             | 150 s       | no                     | completed                                                    |
| 86400               | 200 s       | no                     | completed                                                    |
| 86400               | 600 s       | every 5 s              | completed                                                    |
| 10                  | 25 s        | no                     | `failed`, `timed out awaiting tools/call after 10s` at 10 s |

- **Findings:** the timeout is enforced when set, so setting 86400 is required for calls that can wait on a human. A call of 10 minutes with 86400 set survived, so there is no hidden idle limit in the HTTP client up to that length (a 30-minute call was not run). Codex sends `progressToken: 1` in `tools/call._meta`, so keepalives are possible. The unset default did not time out by 150 s, so it is longer than the 60 s in the docs; do not rely on it.
- **Consequence:** keep `tool_timeout_sec: 86400`. Keepalives are optional insurance, not required; keep the idempotent `ask_brain`. Add them only if a long-call failure shows up.

### S8. Claude flag set: MCP and hooks load, permissions do not (answered)

- **Method:** the command-probe pattern (`claude -p --input-format stream-json ...`, `control_request initialize`, no user message, so no model call) with `HOME` set to a temp folder. The temp `~/.claude/settings.json` held `permissions.allow: ["Bash(git push:*)"]`, `permissions.deny`, `env`, and a `SessionStart` hook that touches a marker. The temp `~/.claude.json` held an MCP server. Arc's generated files held a hooks-only settings file and an `mcp.json`. Then `get_settings`, `get_hooks_listing` and `mcp_status` control requests read the result.
- **Flags:** `-p --input-format stream-json --output-format stream-json --verbose --setting-sources project --settings <hooks-only.json> --mcp-config=<mcp.json> --strict-mcp-config`.
- **Results:**
  - `get_settings` `effective` was only the generated hooks (`sources:[{"source":"flagSettings"}]`). No `permissions`, no `env`: the user's permission rules and env stay out.
  - The user's `SessionStart` hook did not run; the generated one did (marker file created), and `get_hooks_listing` shows it with `source:"flagSettings"`.
  - `mcp_status` lists only the `mcp.json` server (`status:"connected"`); the server in the temp `~/.claude.json` is absent. `--strict-mcp-config` works as designed.
  - With `--plugin-dir`: the plugin's `hooks/hooks.json` hook ran (`source:"pluginHook"`) with or without strict. The plugin's `.mcp.json` was ignored under strict (`mcpServers:[]`) and, without strict, appeared as `plugin:<plugin>:<server>`.
- **Consequence:** the §2.3 design is confirmed as written, and no `--plugin-dir` "personal hooks" fallback is needed. Plugin MCP servers must still be imported by hand into `mcp.json`.
- **A cheaper annotation lookup for Claude.** `mcp_status` returns each server's tools with annotations (`{"name":"read_thing","annotations":{"readOnly":true}}`, `{}` for a tool with `readOnlyHint:false`). Arc can ask the running agent with a `control_request mcp_status` instead of running its own MCP client with `tools/list`. That removes the second connection to the user's servers and the 10-second timeout path. It only exists while the agent is running, which is when an approval is asked. Verify that `destructiveHint` is reported before relying on it; until then treat `readOnly:true` as read-only and everything else as ask.

### S10. MCP override: merge or replace (answered: merge)

- **Method:** a temp `config.toml` with `[mcp_servers.userfake]` (stdio command, args, env). `thread/start` with a partial `config.mcp_servers.userfake`.
- **Results:** `{default_tools_approval_mode:"prompt"}` alone kept the command and the server started and listed both tools. `{enabled:false}` alone stopped it from starting (no `mcpServer/startupStatus/updated` for it). A full re-emission also worked. In the recording, `config.mcp_servers.<name> = {enabled:false}` disabled all nine of this user's servers, and only `arc` and the built-in `codex_apps` started. `default_tools_approval_mode:"prompt"` set this way took effect (S4).
- **Caveats:** `config/read` shows the file config, not the thread overrides. `mcpServerStatus/list` lists servers from the file config even when the thread disabled them, so do not use it to see what the thread runs. `config/read` returns the whole user config including secret `env` values (tokens). Never log it or store it.
- **Consequence:** Arc does not need to re-emit personal servers. It needs only the server names (from `config/read`, held in memory) and sends `{default_tools_approval_mode:"prompt"}` per name. This removes the "parse and re-send whole entries" step in §2.3 and the risk of mis-copying their env.

### S11. `model/list` when signed in (answered: filtered per account)

- **Method:** `model/list` and `account/read` on the user's real `CODEX_HOME` (read only), compared with an empty `CODEX_HOME`.
- **Signed in (ChatGPT, Pro):** seven visible models: `gpt-6.1-sol` (default), `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. With `includeHidden`: also `gpt-reserve` and `codex-auto-review`.
- **Signed out:** eight visible, including `gpt-5.5`, which the signed-in list does not have; the hidden set differs too. So the list depends on the account and must only be shown while signed in.
- **Each entry has:** `id`, `model`, `displayName`, `description`, `hidden`, `isDefault`, `supportedReasoningEfforts`, `defaultReasoningEffort`, `inputModalities`, `serviceTiers`, `upgrade`. The descriptions mark the tier: "Fast and affordable model for easier tasks" (`gpt-6-luna`), "Older fast and efficient model" (`gpt-5.6-luna`), "Older balanced model" (`gpt-5.6-terra`), "Frontier intelligence for the most demanding work" (`gpt-6-astra`).
- **Consequence:** confirms "list models only while the status is `ok`". The tier mapping needs a rule, since the API has no tier field: treat ids containing `luna` as fast, `terra` as balanced, `sol` and `astra` as deep, and fall back to deep for unknown names. The recording used `gpt-6-luna` at effort `low`. The model ids in the spec examples ("gpt-5.5") are out of date; do not hard-code any.

### The recording

- **Command:** `node scripts/record-codex.mjs --confirm-real-run --model gpt-6-luna --effort low --out tests/fixtures/codex/0.162.1/real-turn.jsonl`. One real model call, 14.3 s, 105,248 tokens in total (about 17,000 input tokens per step, most of it Codex's own prompt and tool definitions). The script refuses to run without `--confirm-real-run`.
- **File:** `tests/fixtures/codex/0.162.1/real-turn.jsonl`, 89 lines. The first line is `meta`; the rest are `{dir:"c2s"|"s2c", t, msg}` for every JSON-RPC line. It holds the initialize handshake, the sandbox pre-check, `thread/start`, the turn with `cat`, an `apply_patch` file change, `git commit` and an MCP call, and `turn/completed`.
- **Scrubbed:** the temp root (61 hits, `<TMP>`), `CODEX_HOME` (4, `<CODEX_HOME>`), the host name (`<HOST>`), the account email (`user@example.com`), `installationId` and `chatgptAccountId` (placeholders). A search for the user name, the host name, `@gmail`, `sk-` and `eyJ` finds nothing. `config/read` is excluded from the recording because it contains the user's tokens.
- **New facts from it:** `turn/moderationMetadata` is a notification the design did not list (the parser must ignore it); `thread/settings/updated` arrives after `turn/start` and echoes the effective sandbox; `item/started` precedes every approval, for `fileChange` with the full `changes[]` and diff; `turn/diff/updated` streams the cumulative diff; the file-change approval has `reason:null, grantRoot:null`, so file paths must come from the earlier item; an `account/updated` notification follows `initialize`.
- **Known gap:** the elicitation lines are missing from the real file (see S4).

### Design changes forced by the results

1. **Workers keep the sandbox** (S3). Drop the `danger-full-access` fallback. Add the five writable roots per worker, derived from the worktree's `.git` file, and turn off the `/tmp` and `$TMPDIR` roots.
2. **User allow rules bypass Arc and the sandbox** (S2). Add per-worktree `.codex/rules/arc.rules` with `prompt` rules for protected prefixes. This needs a decision, because the user's own rules already allow `git push`, `git merge`, `gh pr create`, `ssh`, `curl` and `rsync`. The "allow with a warning" decision does not meet functional spec 2.4 for Codex.
3. **Personal MCP** (S10): send only `{default_tools_approval_mode:"prompt"}` per server name; no re-emission. Read the names from `config/read` and never persist the response.
4. **MCP tool name and annotation** (S4): take them from the preceding `item/started mcpToolCall`. `mcpServerStatus/list` is not needed for Codex.
5. **Questions** (S5): no `item/tool/requestUserInput` in v1; `ask_brain` only.
6. **Tool names** (S1): Codex uses `mcp__arc` with bare names, the same as Claude; the Codex namer is the identity on the bare name.
7. **Deny with a message** (S6): steer first, then `decline`.
8. **Claude annotations** (S8): use `control_request mcp_status` instead of an Arc-side MCP client, after checking `destructiveHint`.
9. **Model tiers** (S11): derive from the model name; no hard-coded ids.
10. **Parser:** ignore `turn/moderationMetadata`, `thread/settings/updated`, `account/updated`, `remoteControl/status/changed` and other unknown notifications without throwing.
