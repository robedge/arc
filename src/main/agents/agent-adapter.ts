import type { AttachmentKind } from '../../shared/attachments'
import type { ProviderId, ProviderState } from '../../shared/types/provider'
import type { AgentEvent } from './agent-events'
import type { CodexApprovalHandler, CodexInput } from './codex/codex-types'
import type { CursorApprovalHandler, CursorToolCall } from './cursor/cursor-types'

export type AgentRole = 'brain' | 'worker'

/** A sent attachment as an agent is given it: the stored copy's absolute path and what it is. */
export interface AttachmentRef {
  id: string
  name: string
  kind: AttachmentKind
  mime: string
  size: number
  /** Absolute path of the stored copy. */
  path: string
}

/** Where an agent reaches Arc's MCP bridge. Each adapter renders its own MCP config from it. */
export interface BridgeEndpoint {
  url: string
  token: string
}

/** What every provider needs to start an agent. */
export interface CommonStartOptions {
  agentId: string
  role: AgentRole
  /** Brain: the group's knowledge directory. Worker: its worktree. */
  cwd: string
  /** Provider-local model id: an alias or full id for Claude. */
  model: string
  /** Extra readable directories. */
  addDirs?: readonly string[]
  /** The agent's system prompt addition (Claude `--append-system-prompt`). */
  instructions?: string
  /** The bridge this agent talks to; left unset, the agent runs without Arc tools (unit tests). */
  bridge?: BridgeEndpoint
  /** Bare bridge tool names (`spawn_worker`); each provider's `BridgeToolNamer` spells them for its CLI. */
  bridgeTools?: readonly string[]
  /** Worker only: absolute directories in which edits are refused. */
  readOnlyDirs?: readonly string[]
  /** What the agent may do: the brain reads, a worker writes in its working copies. */
  access: 'brain-readonly' | 'worker-write'
  /** Resume this provider thread (Claude `--resume <id>`, Codex `thread/resume`). */
  resume?: { threadId: string }
  /** Extra env set last (bridge token, test switches). Not filtered. */
  extraEnv?: Readonly<Record<string, string>>
}

/** What only the Claude CLI needs. */
export interface ClaudeStartOptions {
  /**
   * `--mcp-config=<path> --strict-mcp-config`. The one merged file: Arc's bridge, the user's, their
   * plugins' and the repositories' servers (`PersonalConfigService`).
   */
  mcpConfigPath?: string
  /** `--settings <path>`: a file with only the user's `hooks` (never permissions or env). Left unset when the user has none. */
  hooksSettingsPath?: string
  /**
   * The tool that routes permission prompts to Arc (`--permission-prompt-tool`). Left unset, a tool
   * outside the allowlist is refused automatically in `-p` mode.
   */
  permissionPromptTool?: string
  /** The sanitized plugin view (`--plugin-dir`); left unset when it could not be built. */
  pluginViewDir?: string
  /**
   * Skip all approvals was on at launch (spec 015): the edit denies for the read-only folders are left
   * out, except the one for `attachmentsDir`. `--disallowedTools` is fixed for the process, so a toggle
   * relaunches the worker at a turn boundary.
   */
  skipApprovals?: boolean
  /** The folder whose edit deny is kept under `skipApprovals` (the session's sent attachments). */
  attachmentsDir?: string
}

/** What only the Codex adapter needs. */
export interface CodexStartOptions {
  /**
   * Decides the approval requests the app-server sends (Claude's prompts arrive through the bridge's
   * `request_permission` tool instead). Left unset, Codex requests are declined.
   */
  approvals?: CodexApprovalHandler
  /**
   * `CODEX_HOME` for this agent. Left unset, the user's own `CODEX_HOME` (if their env sets one) is
   * passed through. Never an Arc-private home: a separate home drops the user's login.
   */
  codexHome?: string
  /**
   * The names of the user's own MCP servers. Each gets `default_tools_approval_mode: "prompt"` on the
   * thread (spike S10: overrides merge with the user's entry), so every call reaches Arc to decide.
   */
  personalMcpServers?: readonly string[]
  /**
   * Tools of those servers that the user's config gives an explicit approval mode (typically
   * `approve`). A tool's own mode beats the server's default (spike S8b), so each one is set to
   * `prompt` too. Server name -> tool names.
   */
  personalMcpApprovalTools?: Readonly<Record<string, readonly string[]>>
  /**
   * The names of the user's MCP servers they switched off for this role (spec 009). Each gets
   * `enabled: false` on the thread, so it does not start; the override merges with the user's entry (spike S10).
   */
  disabledMcpServers?: readonly string[]
  /**
   * Skip all approvals is on for the session when the thread starts or resumes (spec 015): the thread
   * runs with `danger-full-access` instead of the role's sandbox. Approvals still reach Arc.
   */
  skipApprovals?: boolean
}

/** One of the user's Codex MCP servers, as far as Arc reads it: the name and the tools with their own approval mode. */
export interface CodexPersonalServer {
  name: string
  approvalTools: string[]
}

/** What only the Cursor adapter needs. */
export interface CursorStartOptions {
  /**
   * Decides the `session/request_permission` requests Cursor sends. Left unset, every request is
   * rejected (reject-once), so only what Cursor runs without asking (Arc's auto-allow rules) happens.
   */
  approvals?: CursorApprovalHandler
  /**
   * Called for each tool call that completed without a permission request naming it (a command a
   * project deny blocked, one the user's allow list let through, an edit). The caller classifies it.
   */
  onUnasked?: (call: CursorToolCall) => void
  /**
   * User Cursor MCP servers switched off for this role (spec 009). Each gets a same-name `session/new`
   * entry that points at the bridge's `/off/<server>` route (an empty tool list), so Cursor does not
   * connect the real server (tech spec 2.5).
   */
  offMcpServers?: string[]
}

export type ClaudeStartRequest = CommonStartOptions & {
  provider: 'claude'
  claude: ClaudeStartOptions
}
export type CodexStartRequest = CommonStartOptions & { provider: 'codex'; codex: CodexStartOptions }
export type CursorStartRequest = CommonStartOptions & {
  provider: 'cursor'
  cursor: CursorStartOptions
}

/** A start for one provider's adapter. */
export type StartOptions = ClaudeStartRequest | CodexStartRequest | CursorStartRequest

/** Why a provider could not start an agent. The caller falls back to another provider. */
export type ProviderUnavailableReason = Exclude<ProviderState, 'ok'>

/** `start()` rejects with this when the provider's CLI is missing, too old or signed out. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly reason: ProviderUnavailableReason,
    message: string
  ) {
    super(message)
    this.name = 'ProviderUnavailableError'
  }
}

/** `resume()` rejects with this when the provider no longer has the conversation (a Codex thread that is gone). */
export class ProviderHistoryMissingError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly threadId: string,
    message: string
  ) {
    super(message)
    this.name = 'ProviderHistoryMissingError'
  }
}

/**
 * How an interrupt ended:
 * - `idle`: no turn was running.
 * - `acked`: the turn ended after the provider's interrupt or cancel request; the process is still alive.
 * - `sigint`: it needed SIGINT; the process survived and the turn ended.
 * - `killed`: the process had to be killed. Resume it later with the provider's thread id.
 */
export type InterruptOutcome = 'idle' | 'acked' | 'sigint' | 'killed'

/** What differs between providers in how a running agent behaves. */
export interface HandleCapabilities {
  /** An interrupt also cancels the approvals the agent is waiting on. */
  interruptCancelsApprovals: boolean
  /** A send while a turn runs is queued (by the adapter or the CLI) and gets its own turn result. */
  queuesSendsWhileBusy: boolean
  /** A message can be steered into the turn that is running. */
  midTurnSteer: boolean
}

/** One tool of an MCP server, as the running agent reports it. Only the two hints that decide "read-only" are kept. */
export interface McpToolInfo {
  name: string
  /** `annotations.readOnlyHint === true`. */
  readOnly: boolean
  /** `annotations.destructiveHint === true`. */
  destructive: boolean
}

/** One MCP server of a running agent and the tools it lists. A server that is not connected lists none. */
export interface McpServerTools {
  name: string
  connected: boolean
  tools: McpToolInfo[]
}

export interface AgentHandle {
  readonly provider: ProviderId
  readonly capabilities: HandleCapabilities
  readonly agentId: string
  /** Process group leader pid, undefined if the process never started. */
  readonly pid: number | undefined
  /** Every event, ending with one `exit` event. Read it once. */
  readonly events: AsyncIterable<AgentEvent>
  /**
   * Sends a user message, with the files attached to it. Resolves false if the process is gone.
   * Each adapter decides how the files reach the model (tech spec 2.8).
   */
  send(text: string, attachments?: readonly AttachmentRef[]): Promise<boolean>
  /**
   * Starts a turn with structured input (a skill plus its arguments). Present when the provider
   * takes input items (Codex `turn/start.input`); a Claude command is plain text.
   */
  sendInput?(input: CodexInput[]): Promise<boolean>
  interrupt(): Promise<InterruptOutcome>
  /**
   * Changes the model for the turns that start from now on, without a restart. Present when the
   * provider switches models live (Codex `turn/start.model`, Cursor's next prompt); a Claude model
   * change restarts the process.
   */
  setModel?(model: string): void
  /**
   * Skip all approvals was turned on or off (spec 015). Present when the provider's sandbox can change
   * between turns (Codex `turn/start.sandboxPolicy`); it applies from the next turn, never to the
   * one running. Cursor and Claude change their limits through files and a relaunch instead.
   */
  setSkipApprovals?(on: boolean): void
  /**
   * True while the agent is between turns: no turn running and no send waiting behind one. Present
   * when Arc may replace the process at a turn boundary (a live Cursor or Claude worker relaunched
   * after Skip all approvals changed, spec 015); a handle without it is never replaced.
   */
  isIdle?(): boolean
  /**
   * The agent's own view of its MCP servers and their tool annotations (Claude `control_request`
   * `mcp_status`, Codex `mcpServerStatus/list`). Arc asks it when a tool of a personal server needs a
   * decision, so it never runs a second connection to the user's servers. Rejects when the agent
   * cannot answer in time; the caller then treats every tool as "not known to be read-only".
   */
  mcpTools?(): Promise<McpServerTools[]>
  /**
   * Drops the sends that wait behind the running turn and returns them, oldest first. Present
   * when the adapter queues sends itself (Codex, Cursor). Step-in uses it so what was queued before the
   * user took control does not start a turn in their hands.
   */
  discardQueuedSends?(): string[]
  /** Interrupts, then closes stdin, then SIGTERM, then SIGKILL. Resolves after exit. */
  stop(): Promise<void>
}

export interface AgentAdapter {
  readonly provider: ProviderId
  start(options: StartOptions): Promise<AgentHandle>
  /** Same as `start` with `resume` required. */
  resume(options: StartOptions & { resume: { threadId: string } }): Promise<AgentHandle>
}
