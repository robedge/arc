import { ProviderHistoryMissingError, ProviderUnavailableError } from '../agents/agent-adapter'
import type { LoadRole } from '../../shared/types/agent-load'
import type {
  AgentHandle,
  ClaudeStartOptions,
  CodexStartOptions,
  CursorStartOptions,
  InterruptOutcome,
  ProviderUnavailableReason,
  StartOptions
} from '../agents/agent-adapter'
import type { ProviderRegistry } from '../agents/provider-registry'
import type { AgentEvent } from '../agents/agent-events'
import { PERMISSION_PROMPT_TOOL } from '../agents/claude-adapter'
import type { BridgeRegistry } from '../bridge/bridge-server'
import {
  applyCodexMcp,
  applyCursorMcp,
  type PersonalLaunchConfig
} from '../personal/personal-config'
import {
  BYPASS_EVENT_KIND,
  BYPASS_NOTE,
  DEGRADED_MCP_NOTE,
  reportHasBypass
} from '../personal/personal-notes'
import { toolsForRole } from '../bridge/tools/registry'
import { BridgeToolError, MCP_SERVER_NAME } from '../bridge/types'
import type {
  BridgeAgent,
  BridgeServices,
  SpawnWorkerInput,
  SpawnWorkerResult
} from '../bridge/types'
import type { AllowRulesRepo } from '../db/repositories/allow-rules-repo'
import type { AttentionRepo } from '../db/repositories/attention-repo'
import type { MergesRepo } from '../db/repositories/merges-repo'
import type { MergeGit } from '../git/merge'
import type { MergeQueue } from '../git/merge-queue'
import type { CommitsRepo } from '../db/repositories/commits-repo'
import type { EventsRepo, EventRow } from '../db/repositories/events-repo'
import type { MessagesRepo } from '../db/repositories/messages-repo'
import type { PlansRepo } from '../db/repositories/plans-repo'
import type { SessionProjectsRepo } from '../db/repositories/session-projects-repo'
import type { BrainThreadsRepo } from '../db/repositories/brain-threads-repo'
import type { SessionsRepo } from '../db/repositories/sessions-repo'
import type { WorkersRepo } from '../db/repositories/workers-repo'
import type { HeldMessagesRepo } from '../db/repositories/held-messages-repo'
import type { WorktreesRepo } from '../db/repositories/worktrees-repo'
import type { WorktreeGit } from '../git/worktrees'
import { ulid } from '../db/ids'
import type { ClassifyContext } from '../policy/classify'
import type { IpcEvents } from '@shared/ipc/contract'
import { AppErrorException } from '@shared/errors'
import { providerName } from '@shared/provider-label'
import { PLACEHOLDER_SESSION_NAME } from '@shared/types/session'
import type { CommandInfo } from '@shared/types/commands'
import type {
  BrainState,
  MessagePrompt,
  SessionMode,
  PlanView,
  SessionEventEntry,
  SessionHeader,
  SessionMessage,
  WorkerView
} from '@shared/types/session'
import { AttentionCoordinator, BRAIN_ANSWER_TIMEOUT_MS } from './attention-coordinator'
import type { ReviewService } from '../review/review-service'
import { MergeCoordinator } from './merge-coordinator'
import { RateLimitGate } from './rate-limit-gate'
import type { UsageRecorder } from '../usage/usage-recorder'
import { forwardRateLimit } from '../usage/plan-usage-service'
import type { PlanUsageService } from '../usage/plan-usage-service'
import { continuePromptText, messageRowDto } from './message-prompt'
import type { AttentionAnswer, AttentionState } from './attention-coordinator'
import { DeltaBatcher, IntervalBatcher } from './batcher'
import type { DeltaBatcherOptions } from './batcher'
import { matchApprovedEntry } from './plan-gate'
import {
  ambiguousCommandInstruction,
  commandInstruction,
  commandNameOf,
  isCommandAvailable,
  matchCommand,
  splitCommandRef
} from './command-routing'
import { commandsSection } from './command-prompt'
import { PlanCoordinator } from './plan-coordinator'
import type { PlanDecision } from './plan-coordinator'
import { WorkerManager, safeDirName } from './worker-manager'
import type { WorkerManagerDeps } from './worker-manager'
import { createCodexApprovalHandler, McpCoverage } from './codex-approvals'
import { createCursorApprovalHandler } from './cursor-approvals'
import type { TerminalBacklog } from './terminal-log'
import { effectiveBrain } from './session-prefs'
import { LOST_HISTORY_HEADER, buildHandoffPreamble } from './brain-handoff'
import { reasonOf } from '../models/provider-resolution'
import { brainFallbackText } from '../providers/fallback-text'
import { providersSection } from './brain-providers'
import type { ProvidersPromptInput } from './brain-providers'
import type { ModelRegistry } from '../models/model-registry'
import type { CodexCommandRunner } from '../agents/codex/codex-commands'
import type { CursorCommandRunner } from '../agents/cursor/cursor-commands'
import { writeArcRules } from '../agents/codex/codex-rules'
import { writeCursorBrainDeny } from '../agents/cursor/cursor-deny'
import { CURSOR_WAIT_FOR_LINE } from '../agents/cursor/cursor-instructions'
import { bridgeToolNamer } from '../agents/tool-namer'
import type { BridgeToolNamer } from '../agents/tool-namer'
import type { ModelRef, ProviderId, ProviderState } from '@shared/types/provider'
import { PROVIDER_IDS } from '@shared/types/provider'
import { PROVIDER_TRAITS } from '@shared/provider-traits'
import { assertNever } from '@shared/assert-never'

/** `propose_plan` blocks for as long as the user takes; the CLI must not time the call out. */
export const BRAIN_MCP_TOOL_TIMEOUT_MS = '43200000'

/** Brain content is written to the database at most this often, or after this many bytes. */
export const DB_FLUSH_MS = 1000
export const DB_FLUSH_BYTES = 2048
/** The title line is short; past this many characters without a newline the reply has no title. */
const TITLE_LOOKAHEAD = 120
const TITLE_MAX = 60
const NAME_WORDS = 6

export type SessionPushEvent =
  | 'session:brain-delta'
  | 'session:message'
  | 'session:event-logged'
  | 'session:brain-state'
  | 'session:summary'
  | 'session:header'
  | 'session:dirty-question'
  | 'session:plan'
  | 'session:worker-changed'
  | 'session:review-changed'
  | 'worker:terminal'
export type SessionEmit = <E extends SessionPushEvent>(event: E, payload: IpcEvents[E]) => void

export interface BrainLaunch {
  /** The folder the brain was first started in (the knowledge folder at that time). */
  cwd: string
  /** Every existing project of the group, read only, and the knowledge folder when it is not `cwd`. */
  addDirs: string[]
  /** The brain's system prompt addition. */
  instructions: string
  /** What runs the brain: the session's choice, or Claude when it chose an unavailable Codex. */
  provider: ProviderId
  /** The brain model of `provider`: an alias or a model id (not the worker `model`). */
  brainModel: string
  /** The session asked for `requestedProvider` but it is not ready (or at its limit), so `provider` runs the brain. */
  unavailable?: ProviderState | 'unknown' | 'limit'
  /** The provider the session asked for; set together with `unavailable`. */
  requestedProvider?: ProviderId
  /** The stored thread id of `provider`; set after a reopen, a restart or a switch back, so the brain resumes. */
  resumeThreadId?: string | null
  /** The "Providers and models" block, repeated in the upgrade note an older session gets once. */
  providersSection?: string
}

/**
 * What a group change alters in a launch: the working folder (knowledge) and the project folders.
 * The prompt is left out on purpose: mode and limit changes reach the brain as a note, not a restart.
 */
export function launchKey(launch: Pick<BrainLaunch, 'cwd' | 'addDirs'>): string {
  return JSON.stringify([launch.cwd, [...launch.addDirs].sort()])
}

/** How many of the latest messages the hand-off reads; it keeps what fits in its cap. */
const HANDOFF_SCAN_MESSAGES = 60

/** The brain runs on `sessions.brain_model`; the worker `model` ('auto' or forced) is separate. */
export function resolveBrainModel(brainModel: string): string {
  const trimmed = brainModel.trim()
  return trimmed === '' ? 'sonnet' : trimmed
}

export interface BrainPromptInput {
  groupName: string
  knowledgePath: string
  /** The brain's working directory when it is not the knowledge folder (after the knowledge folder moved). */
  workingDir?: string
  projects: readonly { name: string; path: string }[]
  /** The Arc tools are connected, so the prompt explains how to use workers. */
  workersEnabled?: boolean
  /** The session's current mode and worker limit; the prompt tells the brain how spawning behaves. */
  mode?: SessionMode
  workerLimit?: number
  /**
   * The command catalogue read at launch (only with workers and repositories): a list adds the
   * "Commands available" block, null says it was unavailable, undefined leaves commands out.
   */
  commands?: readonly CommandInfo[] | null
  /** What runs the brain; default Claude. Decides the tool wording (Claude's tools, or shell reads in a read-only sandbox). */
  brainProvider?: ProviderId
  /** With workers: the models, availability and Workers choice behind the "Providers and models" block. */
  providers?: ProvidersPromptInput
}

export function modeLabel(mode: SessionMode): string {
  return mode === 'autonomous' ? 'Autonomous' : 'Plan-first'
}

/** The "[Arc] Mode is now ..." note sent to a running brain after the user changes mode or limit. */
export function modeNote(mode: SessionMode, workerLimit: number): string {
  return `[Arc] Mode is now ${modeLabel(mode)}, limit ${workerLimit}.`
}

/** The note after the user installed, updated or removed plugins: the command list as it is now. */
export function commandsChangedNote(commands: readonly CommandInfo[]): string {
  return `[Arc] The user changed their plugins, so the commands you can start changed.\n${commandsSection(commands)}`
}

/**
 * The "[Arc] The user undid ..." note put in front of the brain's next message after Undo changes. `files` are
 * "<repo>/<path>"; several undos between two messages make one note.
 */
export function undoNote(files: readonly string[]): string {
  if (files.length === 1) {
    return `[Arc] The user undid the session's changes to ${files[0]}. Don't make that change again without asking.`
  }
  return `[Arc] The user undid the session's changes to these files: ${files.join(', ')}. Don't make those changes again without asking.`
}

/**
 * Bump when the brain's capabilities or the prompt text that describes them change. A session whose
 * stored `brain_prompt_version` is lower keeps its snapshotted old prompt on resume, so its next
 * message carries the notes from `promptUpdateNote` once.
 */
export const BRAIN_PROMPT_VERSION = 6

const CAPABILITIES: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: [
    'What you can do:',
    "- You can read files in the group's projects and knowledge folder (Read, Grep, Glob), search the web (WebSearch) and fetch web pages (WebFetch), including the links saved for the group."
  ],
  codex: [
    'What you can do:',
    "- You can read files in the group's projects and knowledge folder with shell commands (for example `cat`, `ls`, `rg`). Your sandbox is read-only. You have only the tools you were given: search the web or fetch a page only if one of them does that."
  ],
  cursor: [
    'What you can do:',
    "- You can read files in the group's projects and knowledge folder. You are in a read-only mode and have only the tools you were given: search the web or fetch a page only if one of them does that."
  ]
}

/** Without workers there is no Arc bridge, so the brain has no shell either. */
const NO_SHELL_CAPABILITIES: readonly string[] = [
  '- You cannot edit files or run shell commands. When something needs either, start a worker for it.'
]

const NO_EDITS: Readonly<Record<ProviderId, string>> = {
  claude: '- You cannot edit files. When something needs edits, start a worker for it.',
  codex:
    '- You cannot edit files: your sandbox is read-only and Arc declines every edit. When something needs edits, start a worker for it.',
  cursor:
    '- You cannot edit files: you are in a read-only mode and Arc declines every edit. When something needs edits, start a worker for it.'
}

const SHELL_CAPABILITIES: readonly string[] = [
  "- You can run read-only shell commands in the group's projects, for example `git -C <path> diff`, `git -C <path> log` or `git -C <path> status`. This includes the user's uncommitted changes, so use it to answer what changed in their checkout. Read-only commands run without anyone approving them.",
  "- A command that changes files or git state in the user's checkouts (commit, checkout, merge, stash, add, install, and the like) goes to the user for approval through Arc, and you wait for the answer. Prefer read-only commands, and start a worker for real changes. Workers work in separate working copies created from the session branch, so they do not see the user's uncommitted edits."
]

const WORKER_CAPABILITIES: readonly string[] = [
  "- Workers run ordinary commands on their own, without anyone approving them. A small set of risky actions goes to the user for approval through Arc automatically: anything outside the worker's working copy, anything that leaves the machine (such as pushing or opening a merge request), destructive commands, and installing software globally. You never approve these and do not need to. Arc's notes about requests it passed to the user are for your information only: do not narrate or repeat them to the user, who sees them in Needs attention. Mention them only if the user asks or if something blocks the plan.",
  '- For a worker question you can answer, use resolve_request; otherwise call escalate_to_user. To ask the user something yourself, use ask_user.'
]

/** What version 2 added (web tools, read-only shell, approvals). Sent to resumed sessions older than version 2. */
export const PROMPT_UPDATE_NOTE_V2 =
  "[Arc] Updated instructions: you can fetch web pages and search the web (WebFetch, WebSearch), including the group's saved links. You still cannot edit files; start a worker for that. You can now run read-only shell commands in the group's projects (for example git -C <path> diff, log or status), including on the user's uncommitted changes, without approval. A command that changes files or git state in the user's checkouts (commit, checkout, merge, stash, add, install) goes to the user for approval through Arc and you wait for the answer, so prefer read-only commands and start a worker for real changes; workers work in separate working copies created from the session branch and do not see the user's uncommitted edits. Workers run ordinary commands without approval; risky actions (outside the working copy, leaving the machine such as pushing or opening a merge request, destructive commands, global installs) go to the user through Arc automatically, so you never approve those. Notes about requests passed to the user are for your information only: do not narrate or repeat them, since the user sees them in Needs attention; mention them only if asked or if something blocks the plan. Answer worker questions you can with resolve_request, otherwise use escalate_to_user; to ask the user yourself, use ask_user."

/** What version 3 added (when to use several workers). Sent to resumed sessions older than version 3. */
export const PROMPT_UPDATE_NOTE_V3 =
  "[Arc] Updated instructions: split work across several workers when its parts are independent, typically one worker per repository or per sub-task that does not need another's result. Start independent workers together (in Plan-first, list them all in one plan), up to the worker limit; Arc queues the extras. Keep tightly coupled, sequential work in one worker; when a worker needs another's change, use dependsOn and sync_worker. For questions, answer directly from files, the knowledge folder and read-only shell when that is enough; start workers only for running code, builds, tests or edits, and run independent investigations in parallel. Use the fewest workers that lets independent parts run at the same time; do not split a small single-file change."

/** What version 4 added (starting commands); the guidance and the current list follow it. */
export const PROMPT_UPDATE_NOTE_V4 =
  "[Arc] Updated instructions: you can start the user's commands."

/** What version 5 added (Codex as a second provider); the current models and guidance follow it. */
export const PROMPT_UPDATE_NOTE_V5 =
  '[Arc] Updated instructions: workers can now run on Codex as well as Claude, and spawn_worker and propose_plan take an optional provider and model.'

/** What version 6 added (Cursor as a third provider); the current models and guidance follow it. */
export const PROMPT_UPDATE_NOTE_V6 =
  "[Arc] Updated instructions: workers can now also run on Cursor; spawn_worker and propose_plan take provider 'cursor' and a Cursor model id."

/**
 * The note a resumed session gets once, in front of its next message: everything added after the
 * version it was stamped with, oldest first. Undefined when the session is current.
 * `commands` is the catalogue read now, added to the version 4 note: a list, null when it is
 * unavailable, or undefined (no workers or repositories) to leave version 4 out.
 * `providers` is the "Providers and models" block as it is now, added to the version 5 and 6 notes;
 * undefined (no workers) leaves them out. A session from before version 5 gets the block once, with the version 5 note.
 */
export function promptUpdateNote(
  storedVersion: number,
  commands?: readonly CommandInfo[] | null,
  providers?: string
): string | undefined {
  const notes: string[] = []
  if (storedVersion < 2) notes.push(PROMPT_UPDATE_NOTE_V2)
  if (storedVersion < 3) notes.push(PROMPT_UPDATE_NOTE_V3)
  if (storedVersion < 4 && commands !== undefined) {
    notes.push(`${PROMPT_UPDATE_NOTE_V4}\n${commandsSection(commands)}`)
  }
  if (storedVersion < 5 && providers !== undefined) {
    notes.push(`${PROMPT_UPDATE_NOTE_V5}\n${providers}`)
  }
  if (storedVersion < 6 && providers !== undefined) {
    // A session older than version 5 already got the block with the version 5 note.
    notes.push(storedVersion < 5 ? PROMPT_UPDATE_NOTE_V6 : `${PROMPT_UPDATE_NOTE_V6}\n${providers}`)
  }
  return notes.length === 0 ? undefined : notes.join('\n\n')
}

function modeInstructions(mode: SessionMode, limit: number): string[] {
  const queue = `At most ${limit} worker${limit === 1 ? '' : 's'} run at once; spawn_worker returns status "queued" for the extra ones, and Arc starts them in order as running workers finish. Do not wait for queued workers to start before continuing.`
  return [
    mode === 'autonomous'
      ? `Current mode: Autonomous (worker limit ${limit}). spawn_worker starts workers directly; do not call propose_plan first. ${queue}`
      : `Current mode: Plan-first (worker limit ${limit}). Call propose_plan and wait for approval before spawn_worker. ${queue}`,
    'The user can change the mode and the limit while the session runs. Arc tells you with a message that starts with "[Arc] Mode is now"; Arc enforces the mode on every spawn_worker call. Workers that are already running carry on.'
  ]
}

const PARALLEL_INSTRUCTIONS: readonly string[] = [
  "- When to use several workers: split work into separate workers when its parts are independent, typically one worker per repository or per sub-task that does not need another's result. Start independent workers together (in Plan-first mode list them all in one plan), up to the worker limit; Arc queues the extras. Keep tightly coupled, sequential work in one worker; when a worker needs another's change, pass dependsOn to spawn_worker and use sync_worker. Prefer the fewest workers that lets independent parts run at the same time, and do not split a small single-file change.",
  '- For questions, answer directly from reading files, the knowledge folder and read-only shell when that is enough. Start workers only for things that need running code, builds, tests or edits, and run independent investigations in parallel (for example one worker checks the api logs path while another reproduces the problem in web).',
  '- Example plan for a change that spans two repositories: propose_plan {workers: [{name: "api-retry", task: "Add retry with backoff to the order client", repos: ["api"], rationale: "The API change is independent of the UI."}, {name: "web-retry-banner", task: "Show a retry banner in the order screen", repos: ["web"], rationale: "The web change can start at the same time."}]}. A third worker for end-to-end tests would wait for both, so start it later with dependsOn.'
]

const BRAIN_TOOLS: readonly string[] = [
  'propose_plan',
  'spawn_worker',
  'message_worker',
  'get_worker_status',
  'merge_worker',
  'sync_worker',
  'resolve_request',
  'escalate_to_user',
  'ask_user'
]

/** How the brain is told to reach the bridge tools: Claude defers them behind ToolSearch, Codex lists them. */
function toolIntro(provider: ProviderId, namer: BridgeToolNamer): string {
  switch (provider) {
    case 'claude':
      return `Workers do the coding. Arc gives you tools for them, named ${namer.name('<tool>')}. They are deferred: call ToolSearch with "select:${BRAIN_TOOLS.map((t) => namer.name(t)).join(',')}" before the first use.`
    case 'codex':
      return `Workers do the coding. Arc gives you tools for them, from the \`${MCP_SERVER_NAME}\` MCP server: ${BRAIN_TOOLS.join(', ')}. They are in your tool list; call them directly.`
    case 'cursor':
      return `Workers do the coding. Arc gives you tools for them, from the \`${MCP_SERVER_NAME}\` MCP server: ${BRAIN_TOOLS.join(', ')}. They are in your tool list; call them directly. ${CURSOR_WAIT_FOR_LINE.replace(/^- /, '')}`
    default:
      return assertNever(provider)
  }
}

const WORKER_INSTRUCTIONS_AFTER_INTRO: readonly string[] = [
  '- propose_plan: shows the user a plan and WAITS for their decision. Use the project names above as `repos`.',
  '- spawn_worker: starts a worker in its own working copy, or queues it when the worker limit is reached. Call it once per worker; independent workers can run at the same time. In Plan-first mode it only accepts workers that an approved plan lists (same name and repos); on plan_not_approved, call propose_plan.',
  '- message_worker and get_worker_status: steer and check workers.',
  ...PARALLEL_INSTRUCTIONS,
  '- Arc merges a worker into the session branch by itself as soon as it is Done, then tells you with "[Arc] Merged W1 api-retry into <branch> automatically." (or the conflict outcome). It merges one worker at a time per repository, resolves conflicts with a resolver worker of its own, removes the worker\'s working copy and turns its card to Merged. You do not need to merge. merge_worker only retries a merge that failed; it answers already_merged for a worker that is merged. A result "needs_user" means the resolver asked the user and the merge finishes after the answer (Arc tells you). You never edit code or resolve conflicts yourself.',
  "- sync_worker: when a worker needs a change another worker made, merge the other worker first, then call sync_worker {workerId, fromWorkerId, note}. Arc brings the change into the waiting worker's working copy and messages it; note says what changed.",
  '- When every worker is merged, failed or stopped, Arc sends "[Arc] All workers finished" with the commits per repository. Then post the final summary: what changed per repository, the commits on the session branch, and anything left undone.',
  '- A worker that needs a permission or has a question pauses, and Arc sends you a message with "(request <id>)". Answer what you can from the plan, the group knowledge and other workers\' results with resolve_request (decision approve, deny or answer, plus a short note). You cannot approve anything that leaves the machine, is destructive, installs software for the whole machine or changes files outside the worker\'s working copy: Arc passes those to the user (resolve_request then returns policy_requires_user). When you cannot decide, call escalate_to_user with a one-sentence reason; Arc also passes a request on after 60 seconds.',
  '- ask_user: ask the user a question only they can answer. It waits for the answer. Pass choices (2 to 6 labels) to offer buttons.',
  'If propose_plan returns changes_requested, revise the plan using the comment and propose again. If it returns rejected, start no workers and ask the user what they want instead.',
  'When a worker finishes or fails, Arc sends you a message that starts with "[Arc]". Then tell the user what happened and what comes next.'
]

function workerInstructions(provider: ProviderId, namer: BridgeToolNamer): string[] {
  return [toolIntro(provider, namer), ...WORKER_INSTRUCTIONS_AFTER_INTRO]
}

/** The group-context prompt appended to the brain's system prompt. `[arc-role:brain]` is read by the fake CLI. */
export function buildBrainPrompt(input: BrainPromptInput): string {
  const provider = input.brainProvider ?? 'claude'
  const namer = bridgeToolNamer(provider)
  const projects =
    input.projects.length === 0
      ? '- (none yet)'
      : input.projects.map((p) => `- ${p.name}: ${p.path}`).join('\n')
  return [
    '[arc-role:brain]',
    `You are the brain of an Arc session for the group "${input.groupName}". You talk with the user, read the group's knowledge and projects, and help them decide what to do. You never edit files yourself.`,
    '',
    ...CAPABILITIES[provider],
    ...(input.workersEnabled ? [NO_EDITS[provider], ...SHELL_CAPABILITIES] : NO_SHELL_CAPABILITIES),
    ...(input.workersEnabled ? WORKER_CAPABILITIES : []),
    '',
    'Projects in this group (read only):',
    projects,
    '',
    input.workingDir !== undefined && input.workingDir !== input.knowledgePath
      ? `The group's knowledge folder is ${input.knowledgePath}; it is one of your readable folders. Your working directory is ${input.workingDir}; use absolute paths for notes.`
      : `The group's knowledge folder is ${input.knowledgePath}. It is your working directory.`,
    '',
    'Start your FIRST reply with one line of exactly this form, then a blank line, then your answer:',
    'Title: <3-6 word title for this session>',
    'Do not mention the title line again.',
    ...(input.workersEnabled ? ['', ...workerInstructions(provider, namer)] : []),
    ...(input.workersEnabled && input.providers ? ['', providersSection(input.providers)] : []),
    ...(input.workersEnabled && input.mode !== undefined && input.workerLimit !== undefined
      ? ['', ...modeInstructions(input.mode, input.workerLimit)]
      : []),
    ...(input.workersEnabled && input.commands !== undefined
      ? ['', commandsSection(input.commands)]
      : [])
  ].join('\n')
}

/** First ~6 words of the request, title-cased. */
export function deriveName(request: string): string {
  const words = request
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, NAME_WORDS)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  const name = words.join(' ').replace(/[\s.,;:!?-]+$/, '')
  return name === '' ? PLACEHOLDER_SESSION_NAME : name.slice(0, TITLE_MAX)
}

function cleanTitle(raw: string): string | null {
  const title = raw
    .trim()
    .replace(/^[*_"'`#\s]+|[*_"'`\s.]+$/g, '')
    .slice(0, TITLE_MAX)
    .trim()
  return title === '' ? null : title
}

interface TitleSplit {
  decided: boolean
  title: string | null
  body: string
}

/** Splits a leading `Title: ...` line off the first reply. Undecided until its first line is complete. */
export function splitTitle(raw: string, final: boolean): TitleSplit {
  const nl = raw.indexOf('\n')
  if (nl === -1 && !final && raw.length <= TITLE_LOOKAHEAD) {
    return { decided: false, title: null, body: '' }
  }
  const first = nl === -1 ? raw : raw.slice(0, nl)
  const match = /^\s*Title:[ \t]*(.*)$/i.exec(first)
  if (!match) return { decided: true, title: null, body: raw }
  const rest = nl === -1 ? '' : raw.slice(nl + 1)
  return { decided: true, title: cleanTitle(match[1] ?? ''), body: rest.replace(/^\s+/, '') }
}

export interface OrchestratorLog {
  info: (message: string, ...rest: unknown[]) => void
  warn: (message: string, ...rest: unknown[]) => void
  error: (message: string, ...rest: unknown[]) => void
}

export interface OrchestratorTimings {
  deltaFlushMs?: number
  deltaMaxBytes?: number
  eventFlushMs?: number
  dbFlushMs?: number
  dbFlushBytes?: number
  /** How long the brain has to act on a request before it goes to the user. */
  brainAnswerMs?: number
  /** How long a message that starts with `/` waits for a catalogue that is not loaded yet. */
  commandLookupMs?: number
  /** How long a worker waits for its background helpers before Arc stops waiting (10 minutes). */
  helperCapMs?: number
  /** How long a turn that ended during helpers waits for a follow-up turn once they are over (60 s). */
  helperSettleMs?: number
}

/** What plans and workers need besides the brain's own dependencies. */
export interface EngineDeps {
  plansRepo: PlansRepo
  workersRepo: WorkersRepo
  worktreesRepo: WorktreesRepo
  /** Brain messages held while the user is in control of a worker. */
  heldMessagesRepo: HeldMessagesRepo
  commitsRepo: CommitsRepo
  sessionProjectsRepo: SessionProjectsRepo
  worktreeGit: WorktreeGit
  attentionRepo: AttentionRepo
  /** The session's "Always allow this in this session" rules. */
  allowRulesRepo: AllowRulesRepo
  mergesRepo: MergesRepo
  mergeGit: MergeGit
  /** Counts the changed files for `session:review-changed`. */
  reviewService: Pick<ReviewService, 'changedFileCount'>
  /** Shared by every session: merges of one repository run one at a time. */
  mergeQueue: MergeQueue
  /** Without a bridge the brain runs without Arc tools (unit tests with a fake adapter). */
  bridge?: BridgeRegistry | undefined
  /** `userData/worktrees`. */
  getWorktreesRoot: () => string
  getKnowledgeDir: () => string
  /** `userData/sessions/<sid>/workers`; without it worker terminals stay in memory. */
  getTerminalDir?: (() => string) | undefined
  groupName: () => string
  /** Resolves once the session branches are created (or the attempt failed). */
  branchesReady: () => Promise<void>
  /** The sanitized plugin view for agents of these repositories; undefined when it could not be built. */
  getPluginViewDir?:
    ((repoPaths: readonly string[], role: LoadRole) => Promise<string | undefined>) | undefined
  /** The user's own and their plugins' MCP servers and hooks for agents (spec 007 section 2.6). */
  personal?: PersonalLaunchConfig | undefined
  /** A Done worker is merged by Arc itself (default true; tests turn it off to merge by hand). */
  autoMerge?: boolean
}

export interface OrchestratorDeps {
  sessionId: string
  registry: ProviderRegistry
  /** The models each provider offers; workers resolve their provider and model against it. */
  models: ModelRegistry
  /** Provider statuses; left out (tests), Codex counts as unavailable. */
  providers?: WorkerManagerDeps['providers']
  sessionsRepo: SessionsRepo
  brainThreadsRepo: BrainThreadsRepo
  messagesRepo: MessagesRepo
  eventsRepo: EventsRepo
  engine: EngineDeps
  newId?: (() => string) | undefined
  /** Read when the brain is spawned. */
  /**
   * `forceUnavailable`: the provider refused the start at the handshake, so the launch is the fallback.
   * `limited`: the providers at their usage limit, which the fallback skips.
   */
  getLaunch: (
    commands?: readonly CommandInfo[] | null,
    forceUnavailable?: ProviderUnavailableReason,
    limited?: ReadonlySet<ProviderId>
  ) => BrainLaunch
  /** The first user request, for the fallback name; null when the session is already named. */
  titleRequest: string | null
  emit: SessionEmit
  now: () => number
  log: OrchestratorLog
  /** The brain reported an authentication error. */
  onSignedOut: () => void
  timings?: OrchestratorTimings
  /** The brain's state, name or activity time changed; the service derives the list summary. */
  onChange?: () => void
  /**
   * The first reply settled the session's name (the brain's title, the fallback, or a name the user
   * set meanwhile). Fires once, and only for a session that was still unnamed when the brain started.
   */
  onNamed?: (name: string) => void
  /** The set of requests waiting for the user changed (counts and the pending list). */
  onAttentionChanged?: (state: AttentionState) => void
  /** The header changed outside `sessions:set-config` (a rule was added); the service pushes it. */
  onHeaderChanged?: () => void
  /** The session's command catalogue (cached by the catalogue); used to route and check commands. */
  listCommands?: (refresh: boolean) => Promise<CommandInfo[]>
  /** Runs the user's Codex skills and prompts: checks a command's arguments and builds a worker's first message. */
  codexCommands?: CodexCommandRunner
  /** The user's Cursor commands: a Cursor worker's command becomes the expanded file text. */
  cursorCommands?: CursorCommandRunner
  /**
   * Runs before every Codex brain start on its Arc-owned folder: writes `.codex/rules/arc.rules` there
   * (default `writeArcRules`). It throws when it cannot, and then the brain does not start.
   */
  prepareCodexBrainDir?: (dir: string) => void
  /**
   * Runs before every Cursor brain start on the same folder: writes `.cursor/cli.json` with
   * `permissions.deny: ['Write(**)']` (default `writeCursorBrainDeny`). It throws when it cannot.
   */
  prepareCursorBrainDir?: (dir: string, offMcp: readonly string[]) => void
  /** Records token usage for the brain and, through the worker manager, for workers and resolvers. */
  usage?: UsageRecorder | undefined
  /** Receives the plan windows of `rate-limit` events (brain and workers); left out (tests), nothing is kept. */
  planUsage?: Pick<PlanUsageService, 'ingest'> | undefined
}

interface Slot {
  rowId: number
  providerId: string
  createdAt: number
  raw: string
  /** Text shown so far (what the renderer and the database hold). */
  shown: string
  titleMode: boolean
  lastDbFlush: number
  unflushedBytes: number
}

function messageDto(
  slot: Slot,
  sessionId: string,
  state: 'complete' | 'stopped',
  now: number
): SessionMessage {
  return {
    id: slot.rowId,
    sessionId,
    role: 'brain',
    content: slot.shown,
    state,
    planId: null,
    createdAt: slot.createdAt,
    updatedAt: now
  }
}

export function eventDto(row: EventRow): SessionEventEntry {
  return {
    id: row.id,
    sessionId: row.sessionId,
    at: row.at,
    kind: row.kind,
    text: row.text,
    workerId: row.workerId,
    dataJson: row.dataJson
  }
}

/** One per open session: owns the brain process, turns its events into messages and pushes. */
export class Orchestrator {
  private handle: AgentHandle | undefined
  private starting: Promise<AgentHandle | null> | undefined
  /** Detaches the brain's handle from the MCP tool catalogue. */
  private detachMcp: (() => void) | undefined
  private bypassChecked = false
  private degradedMcpNoted = false
  private slot: Slot | undefined
  /** Provider message ids already finalized; late events for them are ignored. */
  private readonly seen = new Set<string>()
  private state: BrainState = 'idle'
  private seqCounter = 0
  private titlePending: boolean
  private nameResolved: boolean
  private readonly deltas: DeltaBatcher
  private readonly eventBatch: IntervalBatcher<SessionEventEntry>
  private readonly dbFlushMs: number
  private readonly dbFlushBytes: number
  private readonly plans: PlanCoordinator
  private readonly workers: WorkerManager
  private readonly attention: AttentionCoordinator
  private readonly merges: MergeCoordinator
  private readonly rateLimit: RateLimitGate
  private planWaiting = false
  private askWaiting = false
  private closed = false
  /** The `--model` the running brain process was started with (a Codex brain follows changes through `setModel`). */
  private runningModel: string | undefined
  /** The provider of the running brain process. */
  private runningProvider: ProviderId | undefined
  /** The provider CLI's version when the brain started; a different one later means it was updated. */
  private runningCliVersion: string | undefined
  /** The hand-off for a brain that started on a provider with no thread of its own; goes in front of its next message. */
  private pendingHandoff: string | undefined
  private recycling: Promise<void> | undefined
  /** The projects and working folder the running brain process was started with (`launchKey`). */
  private runningLaunch: { key: string; cwd: string } | undefined
  private readonly brainAgentId: string
  /** Set when mode or limit changed while the brain runs; delivered in front of its next message. */
  private pendingModeNote: string | undefined
  private pendingPromptNote: string | undefined
  /** The group's projects or knowledge folder changed; delivered in front of the brain's next message. */
  private pendingGroupNote: string | undefined
  /** The command list after a plugin change; replaced by a later change, so one note covers several. */
  private pendingCommandsNote: string | undefined
  /** "<repo>/<path>" of files the user undid since the brain's last message; one note on its next message. */
  private pendingUndoNotes: string[] = []
  /**
   * Set while the reply to the final summary request is awaited. `row` is the brain's last complete
   * message since the request; the turn's end tags it with the Review changes link (spec 004 2.7).
   */
  private summaryReply: { row: number | undefined } | undefined

  constructor(private readonly deps: OrchestratorDeps) {
    this.brainAgentId = `brain-${deps.sessionId}`
    const newId = deps.newId ?? (() => ulid(deps.now()))
    const engine = deps.engine
    this.plans = new PlanCoordinator(engine.plansRepo, deps.messagesRepo, {
      sessionId: deps.sessionId,
      now: deps.now,
      newId,
      emitPlan: (plan) => this.emitPlan(plan),
      onWaitingChange: (waiting) => this.onPlanWaiting(waiting),
      emitMessage: (message) => {
        this.deltas.flush()
        deps.emit('session:message', {
          sessionId: deps.sessionId,
          seq: this.nextSeq(),
          message
        })
      },
      logEvent: (kind, text, data) => this.logEvent(kind, text, data)
    })
    this.rateLimit = new RateLimitGate({
      now: deps.now,
      logEvent: (kind, text, data, workerId) => this.logEvent(kind, text, data, workerId ?? null),
      onResumed: () => this.workers.drain(),
      log: deps.log
    })
    this.workers = new WorkerManager(
      {
        sessionId: deps.sessionId,
        registry: deps.registry,
        models: deps.models,
        providers: deps.providers,
        sessionsRepo: deps.sessionsRepo,
        workersRepo: engine.workersRepo,
        worktreesRepo: engine.worktreesRepo,
        heldMessagesRepo: engine.heldMessagesRepo,
        commitsRepo: engine.commitsRepo,
        sessionProjectsRepo: engine.sessionProjectsRepo,
        worktreeGit: engine.worktreeGit,
        bridge: engine.bridge,
        services: this.bridgeServices(),
        helperCapMs: deps.timings?.helperCapMs,
        helperSettleMs: deps.timings?.helperSettleMs,
        getWorktreesRoot: engine.getWorktreesRoot,
        getKnowledgeDir: engine.getKnowledgeDir,
        getTerminalDir: engine.getTerminalDir,
        getPluginViewDir: engine.getPluginViewDir,
        personal: engine.personal,
        ...(deps.codexCommands ? { codexCommands: deps.codexCommands } : {}),
        ...(deps.cursorCommands ? { cursorCommands: deps.cursorCommands } : {}),
        groupName: engine.groupName,
        usage: deps.usage,
        planUsage: deps.planUsage,
        now: deps.now,
        newId,
        log: deps.log
      },
      {
        emitWorker: (worker) => this.emitWorker(worker),
        logEvent: (kind, text, data, workerId) => this.logEvent(kind, text, data, workerId),
        notifyBrain: (text) => this.notifyBrain(text),
        learnModel: (ref) => deps.models.learn(ref),
        rateLimit: this.rateLimit,
        undeliveredAnswers: (workerId) => this.attention.undelivered(workerId),
        routeAttentionToTerminal: (workerId) => this.attention.routeToTerminal(workerId),
        routeAttentionBack: (workerId) => this.attention.routeBack(workerId),
        markDelivered: (ids) => this.attention.markDelivered(ids),
        onSignedOut: deps.onSignedOut,
        emitTerminal: (workerId, chunk) =>
          deps.emit('worker:terminal', { workerId, seq: chunk.seq, text: chunk.text }),
        onChange: () => {
          deps.onChange?.()
          this.merges.checkFinished()
        },
        onWorkerDone: (workerId) => {
          if (this.closed || engine.autoMerge === false) return false
          void this.merges.autoMerge(workerId).catch((error: unknown) => {
            deps.log.error('automatic merge failed', error)
          })
          return true
        }
      }
    )
    this.merges = new MergeCoordinator(
      {
        sessionId: deps.sessionId,
        now: deps.now,
        newId,
        workersRepo: engine.workersRepo,
        worktreesRepo: engine.worktreesRepo,
        mergesRepo: engine.mergesRepo,
        sessionProjectsRepo: engine.sessionProjectsRepo,
        mergeGit: engine.mergeGit,
        worktreeGit: engine.worktreeGit,
        queue: engine.mergeQueue,
        getWorktreesRoot: engine.getWorktreesRoot,
        log: deps.log
      },
      {
        logEvent: (kind, text, data, workerId) => this.logEvent(kind, text, data, workerId ?? null),
        notifyBrain: (text) => this.notifyBrain(text),
        notifySummary: (text) => this.notifySummary(text),
        resolveRef: (ref) => this.workers.resolveRef(ref),
        startResolver: (request) => this.workers.startResolver(request),
        syncHeads: (workerId) => this.workers.syncHeads(workerId),
        markMerged: (workerId) => this.workers.markMerged(workerId),
        pushWorker: (workerId) => this.workers.pushWorker(workerId),
        isRunning: (workerId) => this.workers.isRunning(workerId),
        isControlled: (workerId) => this.workers.isControlled(workerId),
        message: (ref, text) => this.workers.message(ref, text),
        hasUserRequest: (workerId) =>
          this.attention.state().requests.some((r) => r.workerId === workerId),
        branchesReady: () => engine.branchesReady(),
        reviewChanged: (projectId, changedPaths) => this.emitReviewChanged(projectId, changedPaths)
      }
    )
    this.attention = new AttentionCoordinator(
      engine.attentionRepo,
      {
        sessionId: deps.sessionId,
        now: deps.now,
        newId,
        logEvent: (kind, text, data, workerId) => this.logEvent(kind, text, data, workerId ?? null),
        notifyBrain: (text) => this.notifyBrain(text),
        workerOf: (agent) => this.workers.workerOf(agent),
        isHelperToolUse: (workerId, toolUseId) => this.workers.isHelperToolUse(workerId, toolUseId),
        workerLabel: (workerId) => this.workers.workerLabel(workerId),
        ...(engine.personal?.mcp
          ? {
              mcpAction: (agent, tool, input) =>
                engine.personal?.mcp?.claudeAction(agent.agentId, tool, input) ??
                Promise.resolve(null)
            }
          : {}),
        policyContext: (workerId) =>
          workerId === null ? this.brainPolicyContext() : this.workers.policyContext(workerId),
        setWorkerStatus: (workerId, status) => this.workers.setAttentionStatus(workerId, status),
        isControlled: (workerId) => this.workers.isControlled(workerId),
        autoApprove: () => deps.sessionsRepo.getById(deps.sessionId)?.autoApprove ?? false,
        allowRules: () => engine.allowRulesRepo.listBySession(deps.sessionId),
        addAllowRule: (rule) => {
          const row = {
            id: newId(),
            sessionId: deps.sessionId,
            category: rule.category,
            tool: rule.tool,
            prefix: rule.prefix,
            folder: rule.folder,
            text: rule.text,
            createdAt: deps.now()
          }
          engine.allowRulesRepo.create(row)
          deps.onHeaderChanged?.()
          return row
        },
        onBrainWaiting: (waiting) => {
          this.askWaiting = waiting
          this.syncBrainWaiting()
        },
        onChanged: () => {
          deps.onChange?.()
          deps.onAttentionChanged?.(this.attention.state())
          this.merges.onAttention()
        }
      },
      { brainAnswerMs: deps.timings?.brainAnswerMs ?? BRAIN_ANSWER_TIMEOUT_MS }
    )
    this.titlePending = deps.titleRequest !== null
    this.nameResolved = deps.titleRequest === null
    const t = deps.timings ?? {}
    this.dbFlushMs = t.dbFlushMs ?? DB_FLUSH_MS
    this.dbFlushBytes = t.dbFlushBytes ?? DB_FLUSH_BYTES
    const deltaOptions: DeltaBatcherOptions = {
      nextSeq: () => this.nextSeq(),
      onFlush: (batch) =>
        deps.emit('session:brain-delta', {
          sessionId: deps.sessionId,
          messageId: batch.messageId,
          seq: batch.seq,
          text: batch.text
        }),
      ...(t.deltaFlushMs !== undefined ? { flushMs: t.deltaFlushMs } : {}),
      ...(t.deltaMaxBytes !== undefined ? { maxBytes: t.deltaMaxBytes } : {})
    }
    this.deltas = new DeltaBatcher(deltaOptions)
    this.eventBatch = new IntervalBatcher<SessionEventEntry>((entries) => {
      deps.emit('session:event-logged', {
        sessionId: deps.sessionId,
        seq: this.nextSeq(),
        entries
      })
    }, t.eventFlushMs)
  }

  private nextSeq(): number {
    this.seqCounter += 1
    return this.seqCounter
  }

  get brainState(): BrainState {
    return this.state
  }

  get isBrainRunning(): boolean {
    return this.handle !== undefined
  }

  /**
   * Pushes everything pending and writes the streaming text to the database, so a snapshot read
   * right after contains exactly what was pushed up to the returned `seq`.
   */
  prepareSnapshot(): { seq: number; brainState: BrainState } {
    this.deltas.flush()
    this.eventBatch.flush()
    if (this.slot) {
      this.writeStreaming(this.slot)
    }
    return { seq: this.seqCounter, brainState: this.state }
  }

  /**
   * Sends the user's message to the brain, starting it first when it is not running. While a plan
   * waits for "Ask for changes", the message is that call's answer instead of a new turn.
   */
  async send(text: string): Promise<boolean> {
    if (this.plans.takeComment(text)) return true
    // Only a message that starts with `/` waits for the catalogue; every other one keeps its timing.
    return this.sendToBrain(commandNameOf(text) === null ? text : await this.routeCommand(text))
  }

  /**
   * A message that starts with a command of the session's catalogue goes to the brain with an
   * instruction to start one worker for it (tech spec 2.4). Anything else, including a name the
   * catalogue does not have or a catalogue that cannot be read in time, is an ordinary message.
   * A group with no repositories has nowhere to run a command: the user is told, and the brain
   * still gets the text as an ordinary message so its context stays complete.
   */
  private async routeCommand(text: string): Promise<string> {
    const name = commandNameOf(text)
    if (name === null) return text
    const entries = await this.lookupCommands()
    if (entries === null) return text
    const match = matchCommand(text, entries)
    if (!match.ok && match.reason === 'unknown') return text
    const repos = this.deps.engine.sessionProjectsRepo
      .listBySession(this.deps.sessionId)
      .filter((r) => r.membership === 'active')
    if (repos.length === 0) {
      this.postSystemMessage('Commands run in a repository, and this group has none.')
      return text
    }
    if (!match.ok) return `${text}\n\n${ambiguousCommandInstruction(text, match.ids)}`
    return `${text}\n\n${commandInstruction(match.text, match.name, match.entries)}`
  }

  /** The catalogue for routing and validation: cached by the catalogue, bounded wait, null on failure. */
  private async lookupCommands(): Promise<CommandInfo[] | null> {
    const list = this.deps.listCommands
    if (!list) return null
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        list(false),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.deps.timings?.commandLookupMs ?? 3000)
        })
      ])
    } catch (error: unknown) {
      this.deps.log.warn('could not read the command list', error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async sendToBrain(text: string): Promise<boolean> {
    if (this.closed) return false
    await this.recycleIfStale()
    const handle = await this.ensureBrain()
    if (!handle) return false
    this.setBrainState('thinking')
    const undone = this.pendingUndoNotes
    const groupNote = this.pendingGroupNote
    const commandsNote = this.pendingCommandsNote
    const handoff = this.pendingHandoff
    this.pendingHandoff = undefined
    const notes = [
      handoff,
      this.pendingPromptNote,
      this.pendingModeNote,
      groupNote,
      commandsNote,
      undone.length > 0 ? undoNote(undone) : undefined
    ].filter((n): n is string => n !== undefined)
    const promptNoteSent = this.pendingPromptNote !== undefined
    this.pendingPromptNote = undefined
    this.pendingModeNote = undefined
    this.pendingGroupNote = undefined
    this.pendingCommandsNote = undefined
    this.pendingUndoNotes = []
    const written = await handle.send([...notes, text].join('\n\n'))
    if (!written) {
      this.pendingHandoff ??= handoff
      this.pendingUndoNotes = [...undone, ...this.pendingUndoNotes]
      this.pendingGroupNote ??= groupNote
      this.pendingCommandsNote ??= commandsNote
    }
    if (written && promptNoteSent) {
      this.deps.sessionsRepo.setBrainPromptVersion(this.deps.sessionId, BRAIN_PROMPT_VERSION)
    }
    if (!written) {
      this.setBrainState('idle')
      this.logEvent('brain-stopped', 'The brain is not running, so the message was not delivered.')
    }
    return written
  }

  /** Interrupts the running turn; the text streamed so far stays, marked stopped. */
  async stopReply(): Promise<void> {
    const handle = this.handle
    if (!handle) return
    await handle.interrupt()
    this.finalizeSlot('stopped')
    this.settleSummaryReply(false)
    this.setBrainState('idle')
    this.settleName()
  }

  /** Quit step 2: pending bridge calls settle as "shutting down"; their requests stay pending. */
  settleForShutdown(): void {
    this.closed = true
    this.plans.releaseAll()
    this.attention.releaseAll()
  }

  /** Providers whose usage-limit retry failed: new work falls back from them for a while. */
  get limitedProviders(): ReadonlySet<ProviderId> {
    return this.rateLimit.limitedProviders()
  }

  /** True while an agent of this session waits for the usage limit. */
  get rateLimitPaused(): boolean {
    return this.rateLimit.paused
  }

  async stop(): Promise<void> {
    this.settleForShutdown()
    this.rateLimit.dispose()
    this.merges.dispose()
    await this.workers.stopAll('quit')
    this.workers.dispose()
    const handle = this.handle
    this.handle = undefined
    this.deps.engine.bridge?.revokeAgent(this.brainAgentId)
    await handle?.stop()
    this.deltas.dispose()
    this.eventBatch.flush()
  }

  logEvent(kind: string, text: string, data?: unknown, workerId: string | null = null): void {
    const row = this.deps.eventsRepo.append({
      sessionId: this.deps.sessionId,
      at: this.deps.now(),
      kind,
      text,
      workerId,
      dataJson: data === undefined ? null : JSON.stringify(data)
    })
    this.eventBatch.add(eventDto(row))
  }

  /**
   * An Undo changes finished (`review:undo`): the event log says so, the brain hears about it with its next
   * message (no turn is started), and the review refreshes.
   */
  recordUndo(result: {
    projectId: string
    repoName: string
    path: string
    oldPath?: string | undefined
    commit: string
  }): void {
    const file = `${result.repoName}/${result.path}`
    this.logEvent('undo', `You undid changes to ${file}`, {
      repo: result.repoName,
      path: result.path,
      commit: result.commit
    })
    if (!this.pendingUndoNotes.includes(file)) this.pendingUndoNotes.push(file)
    this.emitReviewChanged(
      result.projectId,
      result.oldPath !== undefined ? [result.path, result.oldPath] : [result.path]
    )
  }

  /** A push finished (`review:push`): the event log says so and the review refreshes. */
  recordPush(result: { projectId: string; branch: string; remote: string; sha: string }): void {
    this.logEvent('push', `Pushed ${result.branch} to ${result.remote}`, {
      branch: result.branch,
      remote: result.remote,
      sha: result.sha
    })
    this.emitReviewChanged(result.projectId, [])
  }

  // ---- attention ----

  /** Pending requests that are with the user. */
  attentionState(): AttentionState {
    return this.attention.state()
  }

  /**
   * The user's answer to a request (`attention:answer`): approve or deny a permission, or text for a
   * question. Settles the blocked call, or stores the answer undelivered when the call is gone.
   */
  answerAttention(requestId: string, answer: AttentionAnswer): void {
    this.attention.answer(requestId, answer)
  }

  /** Auto-approve was turned on or a rule was added: approve the pending requests they cover. */
  resolveCoveredRequests(): void {
    this.attention.resolveCovered()
  }

  // ---- plans and workers ----

  get latestPlan(): PlanView | null {
    return this.plans.latest()
  }

  get workerViews(): WorkerView[] {
    return this.workers.views()
  }

  /**
   * The user's decision on a plan card (`sessions:plan-decision`). Approve with the per-worker
   * provider and model choices, ask for changes (the user's next message becomes the comment), or
   * reject. When the brain's call is gone (it timed out, or Arc restarted) the brain is told in a
   * message instead.
   */
  decidePlan(planId: string, decision: PlanDecision, models?: Record<string, ModelRef>): void {
    const delivered = this.plans.decide(planId, decision, models)
    if (delivered || decision === 'ask-changes') return
    this.notifyBrain(
      decision === 'approve'
        ? '[Arc] The user approved your plan. You can start its workers now.'
        : '[Arc] The user rejected your plan. Start no workers and ask what they want instead.'
    )
  }

  /**
   * After `sessions:set-config` changed the mode or the limit. A new limit applies to the queue at
   * once; a lower one never stops a running worker. The next `spawn_worker` reads the stored mode.
   * A running brain learns of the change with a short note in front of its next message (no extra
   * turn); a brain that starts later gets the current values in its system prompt.
   */
  configChanged(before: { mode: SessionMode; workerLimit: number }): void {
    const after = this.deps.sessionsRepo.getById(this.deps.sessionId)
    if (!after || this.closed) return
    if (after.workerLimit !== before.workerLimit) this.workers.drain()
    if (after.mode !== before.mode || after.workerLimit !== before.workerLimit) {
      this.logEvent('mode', modeNote(after.mode, after.workerLimit).replace('[Arc] ', ''), {
        mode: after.mode,
        workerLimit: after.workerLimit
      })
      if (this.handle) this.pendingModeNote = modeNote(after.mode, after.workerLimit)
    }
  }

  /**
   * Plugins changed (spec 005 2.7). A resumed brain keeps its old prompt, so it learns the new command
   * list with a note in front of its next message (no extra turn). Running workers keep their plugins.
   */
  commandsChanged(commands: readonly CommandInfo[]): void {
    if (this.closed) return
    this.pendingCommandsNote = commandsChangedNote(commands)
  }

  /** `workers:open-terminal` for a worker of this session. */
  openTerminal(workerId: string): Promise<TerminalBacklog> {
    return this.workers.openTerminal(workerId)
  }

  /** The user's Stop on a worker (`workers:stop`). */
  async stopWorker(workerId: string): Promise<void> {
    const row = this.deps.engine.workersRepo.get(workerId)
    if (row?.sessionId !== this.deps.sessionId) throw new AppErrorException('VALIDATION_FAILED')
    await this.workers.stop(workerId, 'user')
  }

  /** `workers:step-in`. */
  async stepInWorker(workerId: string): Promise<void> {
    this.requireWorkerOfSession(workerId)
    if (this.closed) throw new AppErrorException('VALIDATION_FAILED')
    await this.workers.stepIn(workerId)
  }

  /** `workers:hand-back`. */
  async handBackWorker(workerId: string): Promise<void> {
    this.requireWorkerOfSession(workerId)
    if (this.closed) throw new AppErrorException('VALIDATION_FAILED')
    await this.workers.handBack(workerId)
  }

  /** `workers:send-input`. */
  async sendWorkerInput(workerId: string, text: string): Promise<void> {
    this.requireWorkerOfSession(workerId)
    if (this.closed) throw new AppErrorException('VALIDATION_FAILED')
    await this.workers.sendInput(workerId, text)
  }

  /** `workers:interrupt`. */
  async interruptWorker(workerId: string): Promise<{ outcome: InterruptOutcome }> {
    this.requireWorkerOfSession(workerId)
    if (this.closed) throw new AppErrorException('VALIDATION_FAILED')
    return this.workers.interruptControlled(workerId)
  }

  private requireWorkerOfSession(workerId: string): void {
    const row = this.deps.engine.workersRepo.get(workerId)
    if (row?.sessionId !== this.deps.sessionId) throw new AppErrorException('VALIDATION_FAILED')
  }

  /** `workers:continue` for one worker; refuses (`VALIDATION_FAILED` with a reason) one that cannot be continued. */
  async continueWorker(workerId: string): Promise<void> {
    if (this.closed) throw new AppErrorException('VALIDATION_FAILED')
    await this.workers.continueWorker(workerId)
    this.answerPrompts('continued')
  }

  /** `workers:continue` with `all`: every worker that can be continued; the others are skipped. */
  async continueAllWorkers(): Promise<void> {
    if (this.closed) throw new AppErrorException('VALIDATION_FAILED')
    const rows = this.workers.continuable()
    await Promise.all(
      rows.map((row) =>
        this.workers.continueWorker(row.id).catch((error: unknown) => {
          this.deps.log.warn(`could not continue worker ${row.id}`, error)
        })
      )
    )
    this.answerPrompts('continued')
  }

  /**
   * On session open: when workers were stopped by a quit or a crash and can be continued, the
   * conversation gets a system message with Continue and Not now. Once per occurrence: workers that
   * an earlier prompt (open or answered) already named since they stopped are left out.
   */
  offerContinue(): void {
    if (this.closed) return
    const prompts = this.deps.messagesRepo
      .listPrompts(this.deps.sessionId)
      .map((m) => ({ createdAt: m.createdAt, prompt: messageRowDto(m).prompt }))
    const fresh = this.workers
      .continuable()
      .filter(
        (w) =>
          !prompts.some(
            (p) =>
              p.prompt?.kind === 'continue-workers' &&
              p.prompt.workerIds.includes(w.id) &&
              p.createdAt >= w.updatedAt
          )
      )
    if (fresh.length === 0) return
    this.postSystemMessage(continuePromptText(fresh.length), {
      kind: 'continue-workers',
      workerIds: fresh.map((w) => w.id),
      status: 'open'
    })
  }

  /** "Not now" on a prompt message (`sessions:dismiss-prompt`). */
  dismissPrompt(messageId: number): void {
    const row = this.deps.messagesRepo.get(messageId)
    const prompt = row ? messageRowDto(row).prompt : undefined
    if (
      row?.sessionId !== this.deps.sessionId ||
      prompt?.kind !== 'continue-workers' ||
      prompt.status !== 'open'
    ) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    this.setPromptStatus(row.id, { ...prompt, status: 'dismissed' })
  }

  private answerPrompts(status: 'continued' | 'dismissed'): void {
    for (const row of this.deps.messagesRepo.listPrompts(this.deps.sessionId)) {
      const prompt = messageRowDto(row).prompt
      if (prompt?.kind === 'continue-workers' && prompt.status === 'open')
        this.setPromptStatus(row.id, { ...prompt, status })
    }
  }

  private setPromptStatus(messageId: number, prompt: MessagePrompt): void {
    this.deps.messagesRepo.setPrompt(messageId, JSON.stringify(prompt), this.deps.now())
    const row = this.deps.messagesRepo.get(messageId)
    if (!row) return
    this.deltas.flush()
    this.deps.emit('session:message', {
      sessionId: this.deps.sessionId,
      seq: this.nextSeq(),
      message: messageRowDto(row)
    })
  }

  /** `workers:remove`: hides a finished worker; one that is running, queued or being merged is refused. */
  async removeWorker(workerId: string): Promise<void> {
    const row = this.deps.engine.workersRepo.get(workerId)
    if (row?.sessionId !== this.deps.sessionId || this.merges.isMerging(workerId)) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    await this.workers.remove(workerId)
  }

  /** Spawns after the plan-first gate and model resolution (tech spec 2.5). */
  async spawnWorker(asked: SpawnWorkerInput): Promise<SpawnWorkerResult> {
    const session = this.deps.sessionsRepo.getById(this.deps.sessionId)
    if (!session) throw new BridgeToolError('internal', 'The session no longer exists.')
    // A command forces its provider; its stored text is `/name args` however the brain wrote it.
    const checked = asked.command !== undefined ? await this.checkCommand(asked) : undefined
    const input: SpawnWorkerInput =
      checked === undefined ? asked : { ...asked, command: checked.text }
    let match: ReturnType<typeof matchApprovedEntry> = null
    if (session.mode === 'plan_first') {
      match = matchApprovedEntry(
        this.plans.approvedPlans(),
        input.name,
        input.repos,
        (planId, entry) => this.workers.hasLiveWorkerFor(planId, entry.name),
        input.command
      )
      if (!match) {
        throw new BridgeToolError(
          'plan_not_approved',
          'This session is in Plan-first mode. Call propose_plan and wait for the user to approve a plan that lists this worker (same name and repos), then call spawn_worker.'
        )
      }
    }
    const entry = match?.entry
    const proposedProvider = input.provider ?? entry?.provider
    const target = await this.workers.resolveTarget({
      ...(checked ? { command: { provider: checked.provider, name: `/${checked.name}` } } : {}),
      planChoice: { provider: entry?.approvedProvider, model: entry?.approvedModel },
      proposal: {
        provider: proposedProvider,
        // The plan's model belongs to the plan's provider; the brain naming another provider drops it.
        model:
          input.model ?? (proposedProvider === entry?.provider ? entry?.model : null) ?? undefined
      }
    })
    await this.ensureBranches()
    const spawned = await this.workers.spawn({
      input,
      planId: match?.plan.id ?? null,
      provider: target.ref.provider,
      model: target.ref.model,
      modelNote: target.notes.length > 0 ? target.notes.join(' ') : null,
      fallback: target.fallback,
      blocked: target.blocked
    })
    this.merges.onWorkerSpawned()
    return spawned
  }

  /**
   * `unknown_command`, `ambiguous_command`, `command_args_invalid` and `command_not_in_repo` (tech spec
   * 2.4, 2.7). The command runs in the first repository, on the provider it belongs to.
   */
  private async checkCommand(
    input: SpawnWorkerInput
  ): Promise<{ provider: ProviderId; name: string; text: string }> {
    if (splitCommandRef(input.command ?? '') === null) {
      throw new BridgeToolError('unknown_command', 'A command starts with / and a command name.')
    }
    const entries = await this.lookupCommands()
    const match = entries === null ? null : matchCommand(input.command ?? '', entries)
    const name = splitCommandRef(input.command ?? '')?.ref ?? ''
    if (match?.ok === false && match.reason === 'ambiguous') {
      throw new BridgeToolError(
        'ambiguous_command',
        `/${match.name} exists for both providers (${match.ids.join(' and ')}). Use one of those ids as the command, for example "${match.ids[0] ?? ''}".`
      )
    }
    if (match === null || !match.ok) {
      throw new BridgeToolError(
        'unknown_command',
        entries === null
          ? `Arc could not check /${name}: the command list is not available right now. Start the worker without a command or try again.`
          : `/${name} is not in the command list. Start the worker without a command, or use a command Arc listed.`
      )
    }
    const first = this.workers.resolveRepos(input.repos, false)[0]
    if (first && !isCommandAvailable(match.entries, first.projectName)) {
      throw new BridgeToolError(
        'command_not_in_repo',
        `/${match.name} is saved in ${match.entries.map((c) => c.source.replace(/^repo:/, '')).join(', ')} and not in ${first.projectName}. Pick a repository that has it.`
      )
    }
    if (match.provider === 'codex' && this.deps.codexCommands) {
      // A prompt that lacks a required argument is refused now, not sent half expanded.
      const args = splitCommandRef(match.text)?.args ?? ''
      const cwds = this.workers.resolveRepos(input.repos, false).map((p) => p.projectPath)
      const run = await this.deps.codexCommands.resolve(match.name, args, cwds)
      if (!run.ok) throw new BridgeToolError(run.code, run.message)
    }
    return { provider: match.provider, name: match.name, text: match.text }
  }

  /**
   * Retries the session-branch fast-forwards that waited for a clean checkout (on session open).
   * Repositories with a merge in flight are skipped: the merge queue may be held for as long as the
   * user takes to answer a conflict question.
   */
  retryPendingMerges(): Promise<void> {
    return this.merges.retryPending({ skipBusy: true })
  }

  /**
   * A worker needs the session branch. The branch waits for the session's name, which normally
   * arrives with the first reply; a brain that calls a tool before that reply ends would wait for
   * a branch that waits for it, so the fallback name is used right away.
   */
  private async ensureBranches(): Promise<void> {
    if (!this.nameResolved && this.deps.titleRequest !== null) {
      this.applyName(deriveName(this.deps.titleRequest))
    }
    await this.deps.engine.branchesReady()
  }

  private bridgeServices(): BridgeServices {
    const brainOnly = (agent: BridgeAgent): void => {
      if (agent.role !== 'brain')
        throw new BridgeToolError('forbidden', 'Only the brain can do this.')
    }
    const workerOnly = (agent: BridgeAgent): void => {
      if (agent.role !== 'worker')
        throw new BridgeToolError('forbidden', 'Only a worker can do this.')
    }
    return {
      proposePlan: (agent, input, call) => {
        brainOnly(agent)
        for (const w of input.workers) this.workers.resolveRepos(w.repos, false)
        return this.plans.propose(input, call.signal)
      },
      spawnWorker: (agent, input) => {
        brainOnly(agent)
        return this.spawnWorker(input)
      },
      messageWorker: (agent, input) => {
        brainOnly(agent)
        return this.workers.message(input.workerId, input.text)
      },
      getWorkerStatus: (agent, input) => {
        brainOnly(agent)
        return this.workers.status(input.workerId)
      },
      mergeWorker: (agent, input) => {
        brainOnly(agent)
        return this.merges.mergeWorker(input.workerId)
      },
      syncWorker: (agent, input) => {
        brainOnly(agent)
        return this.merges.syncWorker(input)
      },
      reportProgress: (agent, input) => {
        workerOnly(agent)
        return this.workers.reportProgress(agent, input)
      },
      reportDone: (agent, input) => {
        workerOnly(agent)
        return this.workers.reportDone(agent, input)
      },
      requestPermission: (agent, input, call) => {
        if (agent.role === 'brain') {
          return this.attention.brainRequestPermission(input, call.signal, agent)
        }
        return this.attention.requestPermission(agent, input, call.signal)
      },
      requestAction: (agent, action, meta, call) =>
        agent.role === 'brain'
          ? this.attention.brainRequestAction(action, meta, call.signal)
          : this.attention.requestAction(agent, action, meta, call.signal),
      askBrain: (agent, input, call) => {
        workerOnly(agent)
        const question = this.merges.decorateQuestion(
          this.workers.workerOf(agent).id,
          input.question
        )
        return this.attention.askBrain(agent, { question }, call.signal)
      },
      resolveRequest: (agent, input) => {
        brainOnly(agent)
        return this.attention.resolveRequest(agent, input)
      },
      escalateToUser: (agent, input) => {
        brainOnly(agent)
        return this.attention.escalateToUser(agent, input)
      },
      askUser: (agent, input, call) => {
        brainOnly(agent)
        return this.attention.askUser(input, call.signal)
      }
    }
  }

  /**
   * The brain's shell policy: it works in the knowledge folder and may write only in the temp folder.
   * Relative paths resolve against the folder the running process was started in, which differs from
   * the current launch until the brain is refreshed after a group change.
   */
  private brainPolicyContext(): ClassifyContext {
    return {
      worktreeRoots: [],
      readOnlyDirs: [],
      cwd: this.runningLaunch?.cwd ?? this.deps.getLaunch().cwd
    }
  }

  /** A user-turn message to the brain that is not shown as the user's own message. */
  private notifyBrain(text: string): void {
    if (this.closed) return
    void this.sendToBrain(text)
  }

  /** The final summary request: the brain's reply to it gets the Review changes link, one time only. */
  private notifySummary(text: string): void {
    if (this.closed) return
    this.summaryReply = { row: undefined }
    void this.sendToBrain(text).then((written) => {
      if (!written) this.settleSummaryReply(false)
    })
  }

  /**
   * The summary turn ended. Its last complete reply is tagged `review-link` (stored and pushed again);
   * with no such reply (interrupted, failed, empty) a short system message carries the tag instead.
   */
  private settleSummaryReply(turnCompleted: boolean): void {
    const pending = this.summaryReply
    if (!pending) return
    this.summaryReply = undefined
    if (this.closed) return
    if (turnCompleted && pending.row !== undefined) {
      this.setPromptStatus(pending.row, { kind: 'review-link' })
      return
    }
    this.postSystemMessage('All work is merged.', { kind: 'review-link' })
  }

  /**
   * More work reached a session branch. The count is read off the merge path; if it fails the push is
   * skipped (a later one or the next `review:get` catches up) and merging is not affected.
   */
  private emitReviewChanged(projectId: string, changedPaths: string[]): void {
    const { sessionId } = this.deps
    void this.deps.engine.reviewService
      .changedFileCount(sessionId)
      .then((fileCount) => {
        if (this.closed) return
        this.deps.emit('session:review-changed', {
          sessionId,
          projectId,
          seq: this.nextSeq(),
          changedPaths,
          fileCount
        })
      })
      .catch((error: unknown) => this.deps.log.warn('could not count the changed files', error))
  }

  private emitPlan(plan: PlanView): void {
    this.deps.emit('session:plan', {
      sessionId: this.deps.sessionId,
      seq: this.nextSeq(),
      plan
    })
  }

  private emitWorker(worker: WorkerView): void {
    this.deps.emit('session:worker-changed', {
      sessionId: this.deps.sessionId,
      seq: this.nextSeq(),
      worker
    })
  }

  /**
   * A brain provider or Claude model change waits for the turn to end. Then the process, started
   * with the old `--model` (or on the other provider), is stopped (stdin closed, kill ladder as
   * fallback); the next send starts the right adapter, resuming that provider's thread or starting
   * fresh with a hand-off. A Codex model change needs no restart: the running handle sends the new
   * model with its next `turn/start`.
   */
  private recycleIfStale(): Promise<void> {
    if (this.recycling) return this.recycling
    const handle = this.handle
    if (!handle || this.closed || this.state !== 'idle') return Promise.resolve()
    const drift = this.brainDrift()
    const launchStale = this.launchIsStale() || this.cliWasUpdated()
    if (drift === 'model' && !launchStale) {
      this.followModel(handle)
      return Promise.resolve()
    }
    if (drift === 'none' && !launchStale) return Promise.resolve()
    this.handle = undefined
    this.deps.engine.bridge?.revokeAgent(this.brainAgentId)
    this.recycling = handle
      .stop()
      .catch((error: unknown) =>
        this.deps.log.warn('could not stop the brain to refresh it', error)
      )
      .finally(() => {
        this.recycling = undefined
      })
    return this.recycling
  }

  /**
   * How the session's brain choice differs from the running process: `restart` for another provider
   * or a Claude model change, `model` for a Codex model change that the handle can take on the fly.
   */
  private brainDrift(): 'none' | 'model' | 'restart' {
    const row = this.deps.sessionsRepo.getById(this.deps.sessionId)
    if (!row) return 'none'
    const want = effectiveBrain(row, this.deps.providers?.get() ?? {}, undefined, {
      limited: this.rateLimit.limitedProviders(),
      defaultFor: (p) => this.deps.models.defaultFor(p)
    })
    if (want.provider !== this.runningProvider) return 'restart'
    if (resolveBrainModel(want.model) === this.runningModel) return 'none'
    return PROVIDER_TRAITS[want.provider].liveModelSwitch && this.handle?.setModel !== undefined
      ? 'model'
      : 'restart'
  }

  private followModel(handle: AgentHandle): void {
    const row = this.deps.sessionsRepo.getById(this.deps.sessionId)
    if (!row || !handle.setModel) return
    const model = resolveBrainModel(row.brainModel)
    handle.setModel(model)
    this.runningModel = model
  }

  /**
   * The provider's tool was updated since the brain started (the detected version changed at a
   * check). The brain restarts at its next pause between replies and resumes its thread on the new
   * binary. Workers are not touched. Unknown on either side counts as unchanged.
   */
  private cliWasUpdated(): boolean {
    const started = this.runningCliVersion
    const provider = this.runningProvider
    if (started === undefined || provider === undefined) return false
    const now = this.deps.providers?.get()[provider]?.version
    return now !== undefined && now !== started
  }

  /** The group's projects or knowledge folder differ from what the running process was started with. */
  private launchIsStale(): boolean {
    const running = this.runningLaunch
    if (!running) return false
    try {
      return launchKey(this.deps.getLaunch()) !== running.key
    } catch (error: unknown) {
      this.deps.log.warn('could not read the brain launch', error)
      return false
    }
  }

  /**
   * The group's projects or knowledge folder changed (functional spec 2.11). The brain learns of it
   * with a note in front of its next message and is restarted with the new folders at its next pause
   * between replies, keeping the conversation (`--resume`). A running turn is never interrupted.
   */
  groupChanged(note: string): void {
    if (this.closed) return
    const resumable = Boolean(this.deps.getLaunch().resumeThreadId)
    if (this.handle || this.starting || resumable) this.pendingGroupNote = note
    void this.recycleIfStale()
  }

  /** Only awaited when the dependency exists, so launches without it keep their timing. */
  private async pluginViewDir(repoPaths: readonly string[]): Promise<string | undefined> {
    try {
      return await this.deps.engine.getPluginViewDir?.(repoPaths, 'brain')
    } catch (error: unknown) {
      this.deps.log.warn('plugin view unavailable; starting the brain without it', error)
      return undefined
    }
  }

  /**
   * The merged `--mcp-config` and the hooks-only `--settings` file replace the bridge's own config,
   * so the brain loads the user's MCP servers and hooks too. Without them (or when they cannot be
   * written) the brain starts with the bridge config alone.
   */
  private async applyPersonalClaude(
    claude: ClaudeStartOptions,
    repoPaths: readonly string[],
    arcConfigPath: string
  ): Promise<void> {
    const personal = this.deps.engine.personal
    if (!personal) return
    try {
      const files = await personal.claude({ repoPaths, arcConfigPath, role: 'brain' })
      claude.mcpConfigPath = files.mcpConfigPath
      if (files.hooksSettingsPath) claude.hooksSettingsPath = files.hooksSettingsPath
    } catch (error: unknown) {
      this.deps.log.warn(
        'personal MCP servers and hooks unavailable; starting the brain without them',
        error
      )
    }
  }

  private async applyPersonalCodex(
    codex: CodexStartOptions,
    cwd: string,
    cover: McpCoverage
  ): Promise<void> {
    const mcp = await this.deps.engine.personal?.codexMcp(cwd, 'brain')
    if (!mcp) return
    cover.servers = applyCodexMcp(codex, mcp)
    if (mcp.degraded) this.noteDegradedMcp()
  }

  /** Once per session: the event log says that the user's hooks or Codex rules can skip Arc's approvals. */
  private noteBypassOnce(): void {
    const personal = this.deps.engine.personal
    if (!personal?.bypass || this.bypassChecked) return
    this.bypassChecked = true
    const repoPaths = this.deps.engine.sessionProjectsRepo
      .listBySession(this.deps.sessionId)
      .filter((r) => r.membership === 'active')
      .map((r) => r.projectPath)
    void (async () => {
      try {
        if (this.deps.eventsRepo.hasKind(this.deps.sessionId, BYPASS_EVENT_KIND)) return
        const report = await personal.bypass?.(repoPaths)
        if (report && reportHasBypass(report)) this.logEvent(BYPASS_EVENT_KIND, BYPASS_NOTE)
      } catch (error: unknown) {
        this.deps.log.warn('could not check the hooks and Codex rules for approval bypasses', error)
      }
    })()
  }

  private noteDegradedMcp(): void {
    if (this.degradedMcpNoted) return
    this.degradedMcpNoted = true
    this.logEvent('personal-mcp-unreadable', DEGRADED_MCP_NOTE)
  }

  private ensureBrain(): Promise<AgentHandle | null> {
    if (this.handle) return Promise.resolve(this.handle)
    this.starting ??= this.spawn().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async spawn(): Promise<AgentHandle | null> {
    try {
      // Only a Codex brain waits here: a Claude start keeps its timing.
      const wanted = this.otherBrainProvider()
      if (wanted !== undefined) await this.checkProviderForBrain(wanted)
      const commands = this.wantsCommands() ? await this.lookupCommands() : undefined
      const limited = this.rateLimit.limitedProviders()
      const launch = this.deps.getLaunch(commands, undefined, limited)
      try {
        return await this.startWithHistoryCheck(launch, commands)
      } catch (error: unknown) {
        // Only the provider the session asked for falls back; a stand-in that fails fails the start.
        if (
          !(error instanceof ProviderUnavailableError) ||
          launch.provider === 'claude' ||
          launch.unavailable !== undefined
        ) {
          throw error
        }
        // The status said ok but the handshake found the provider unusable: this reply comes from the next one.
        this.deps.engine.bridge?.revokeAgent(this.brainAgentId)
        if (error.reason === 'signed_out') this.deps.providers?.markSignedOut?.(launch.provider)
        return await this.startWith(this.deps.getLaunch(commands, error.reason, limited), commands)
      }
    } catch (error: unknown) {
      this.deps.log.error('could not start the brain', error)
      this.logEvent('error', "Couldn't start the brain.")
      return null
    }
  }

  /**
   * `startWith`, but a Codex or Cursor thread that is gone (the history was deleted) does not stop the brain:
   * it starts fresh, is handed the recent messages and the event log says so.
   */
  private async startWithHistoryCheck(
    launch: BrainLaunch,
    commands: readonly CommandInfo[] | null | undefined
  ): Promise<AgentHandle> {
    try {
      return await this.startWith(launch, commands)
    } catch (error: unknown) {
      if (!(error instanceof ProviderHistoryMissingError)) throw error
      this.deps.engine.bridge?.revokeAgent(this.brainAgentId)
      const name = providerName(error.provider)
      this.deps.log.warn(`the ${name} thread ${error.threadId} of the brain is gone`)
      this.logEvent(
        'brain-history-lost',
        `The brain's ${name} history is gone, so it starts fresh from the recent messages.`,
        { threadId: error.threadId }
      )
      return await this.startWith({ ...launch, resumeThreadId: null }, commands, true)
    }
  }

  /** Starts the brain process for one launch; rejects with whatever the adapter rejects with. */
  private async startWith(
    launch: BrainLaunch,
    commands: readonly CommandInfo[] | null | undefined,
    historyLost = false
  ): Promise<AgentHandle> {
    const brainAgent: BridgeAgent = {
      sessionId: this.deps.sessionId,
      agentId: this.brainAgentId,
      role: 'brain',
      provider: launch.provider
    }
    // Filled once the user's Codex servers are known; the Codex approval handler reads it.
    const mcpCover = new McpCoverage()
    const common = {
      agentId: this.brainAgentId,
      role: 'brain' as const,
      cwd: launch.cwd,
      model: resolveBrainModel(launch.brainModel),
      addDirs: launch.addDirs,
      instructions: launch.instructions,
      access: 'brain-readonly' as const,
      // Codex asks Arc through this handler; Claude's prompts arrive through the bridge instead.
      approvals: createCodexApprovalHandler({
        agent: brainAgent,
        requestAction: (a, action, meta, call) =>
          this.bridgeServices().requestAction(a, action, meta, call),
        mcp: this.deps.engine.personal?.mcp,
        covered: mcpCover
      })
    }
    const claude: ClaudeStartOptions = {}
    const codex: CodexStartOptions = {}
    // The user's Cursor servers the Brain switch turned off: a no-op session entry each, and a deny entry.
    const cursorStart: CursorStartOptions = {}
    const personalMcp = this.deps.engine.personal?.mcp
    let cursorOff: string[] = []
    if (launch.provider === 'cursor' && this.deps.engine.personal?.cursorMcp) {
      try {
        cursorOff = applyCursorMcp(
          cursorStart,
          await this.deps.engine.personal.cursorMcp(launch.cwd, 'brain')
        )
      } catch (error: unknown) {
        this.deps.log.warn('could not read the Cursor MCP servers; none is switched off', error)
      }
    }
    let options: StartOptions
    switch (launch.provider) {
      case 'claude':
        options = { ...common, provider: 'claude', claude }
        break
      case 'codex':
        options = { ...common, provider: 'codex', codex }
        break
      case 'cursor':
        // Mode `ask` (spike M2): Cursor offers no edit tool there, but a shell command still asks and
        // runs once allowed, so every request goes through the brain's classifier (read-only commands
        // only, edits always refused, `arc` tools answered at once).
        options = {
          ...common,
          provider: 'cursor',
          cursor: {
            ...cursorStart,
            approvals: createCursorApprovalHandler({
              agent: brainAgent,
              requestAction: (a, action, meta, call) =>
                this.bridgeServices().requestAction(a, action, meta, call),
              offServers: () => new Set(cursorOff),
              ...(personalMcp ? { resolveMcp: (a) => personalMcp.cursorAction(a, launch.cwd) } : {})
            })
          }
        }
        break
      default:
        return assertNever(launch.provider)
    }
    if (launch.provider === 'codex') {
      // Codex runs in an Arc-owned folder, never in the user's knowledge folder: a user allow rule
      // would otherwise let it run `git push` outside the sandbox (spike S2), so the rules file goes
      // there. It throws when it cannot be written, and then the brain does not start.
      ;(this.deps.prepareCodexBrainDir ?? writeArcRules)(launch.cwd)
    }
    if (launch.provider === 'cursor') {
      // Cursor runs in the same Arc-owned folder; its deny file (`Write(**)`) goes in before it starts,
      // so a user allow rule cannot let it write. It throws when it cannot, and the brain does not start.
      ;(this.deps.prepareCursorBrainDir ?? writeCursorBrainDeny)(launch.cwd, cursorOff)
    }
    if (launch.unavailable !== undefined) {
      this.logEvent(
        'provider-fallback',
        brainFallbackText(reasonOf(launch.unavailable), launch.requestedProvider, {
          provider: launch.provider,
          model: launch.brainModel
        }),
        { reason: launch.unavailable }
      )
      // The brain card shows "Claude (Codex unavailable)" from this point.
      this.deps.onHeaderChanged?.()
    }
    if (launch.provider === 'claude') {
      const pluginViewDir = this.deps.engine.getPluginViewDir
        ? await this.pluginViewDir(launch.addDirs)
        : undefined
      if (pluginViewDir) claude.pluginViewDir = pluginViewDir
    }
    const bridge = this.deps.engine.bridge
    if (bridge) {
      const registration = bridge.registerAgent(brainAgent, this.bridgeServices())
      options.bridge = { url: registration.url, token: registration.token }
      // The CLI calls request_permission itself; the model is not given it as a tool to call.
      options.bridgeTools = toolsForRole('brain')
        .filter((t) => t.name !== 'request_permission')
        .map((t) => t.name)
      if (options.provider === 'claude') {
        claude.mcpConfigPath = registration.configPath
        // Only awaited when the dependency exists, so launches without it keep their timing.
        if (this.deps.engine.personal) {
          await this.applyPersonalClaude(claude, launch.addDirs, registration.configPath)
        }
        claude.permissionPromptTool = PERMISSION_PROMPT_TOOL
        options.extraEnv = { MCP_TOOL_TIMEOUT: BRAIN_MCP_TOOL_TIMEOUT_MS }
      }
    }
    if (launch.provider === 'codex' && this.deps.engine.personal) {
      await this.applyPersonalCodex(codex, launch.cwd, mcpCover)
    }
    const adapter = this.deps.registry.adapter(launch.provider)
    const handle = launch.resumeThreadId
      ? await adapter.resume({ ...options, resume: { threadId: launch.resumeThreadId } })
      : await adapter.start(options)
    this.handle = handle
    this.detachMcp?.()
    this.detachMcp = this.deps.engine.personal?.mcp?.attachHandle(this.brainAgentId, handle)
    this.noteBypassOnce()
    this.pendingHandoff = launch.resumeThreadId
      ? undefined
      : historyLost
        ? this.handoffForLostHistory()
        : this.handoffForSwitch(launch.provider)
    // Claude keeps its snapshotted system prompt on resume, and Cursor has none: both are told once.
    if (launch.provider === 'claude' || !PROVIDER_TRAITS[launch.provider].hasNativeSystemPrompt) {
      this.queuePromptNote(Boolean(launch.resumeThreadId), commands, launch.providersSection)
    }
    this.runningModel = options.model
    this.runningProvider = launch.provider
    this.runningCliVersion = this.deps.providers?.get()[launch.provider]?.version
    this.runningLaunch = { key: launchKey(launch), cwd: launch.cwd }
    // The Claude brain is pinned to the folder it first started in; the Codex folder is not that.
    if (
      launch.provider === 'claude' &&
      this.deps.sessionsRepo.getById(this.deps.sessionId)?.brainCwd !== launch.cwd
    ) {
      this.deps.sessionsRepo.setBrainCwd(this.deps.sessionId, launch.cwd)
    }
    void this.consume(handle, Boolean(launch.resumeThreadId), launch.instructions)
    return handle
  }

  /** The provider the session's brain is set to when it is not Claude (a Claude start keeps its timing). */
  private otherBrainProvider(): 'codex' | 'cursor' | undefined {
    const provider = this.deps.sessionsRepo.getById(this.deps.sessionId)?.brainProvider
    return provider === 'codex' || provider === 'cursor' ? provider : undefined
  }

  /** A session whose brain is on Codex or Cursor checks that provider again (and its model list) before the start. */
  private async checkProviderForBrain(provider: 'codex' | 'cursor'): Promise<void> {
    if (!this.deps.providers) return
    try {
      await this.deps.providers.ensureFresh(provider)
    } catch (error: unknown) {
      this.deps.log.warn(
        `could not check ${PROVIDER_TRAITS[provider].name} before starting the brain`,
        error
      )
    }
    await this.deps.models.refresh()
  }

  /**
   * The hand-off for a brain that starts on a provider with no thread while the session has one on
   * the other provider: the last messages, capped (tech spec 2.6). The message that starts this brain
   * is the newest user message and is sent as the turn itself, so it is left out here.
   */
  private handoffForSwitch(provider: ProviderId): string | undefined {
    const hasOtherThread = PROVIDER_IDS.some(
      (other) =>
        other !== provider &&
        this.deps.brainThreadsRepo.get(this.deps.sessionId, other) !== undefined
    )
    if (!hasOtherThread) return undefined
    const rows = this.deps.messagesRepo.latest(this.deps.sessionId, HANDOFF_SCAN_MESSAGES)
    const history = rows.at(-1)?.role === 'user' ? rows.slice(0, -1) : rows
    return buildHandoffPreamble(history)
  }

  /** The same recent messages when the brain's own thread is gone; the new user message is sent as the turn itself. */
  private handoffForLostHistory(): string | undefined {
    const rows = this.deps.messagesRepo.latest(this.deps.sessionId, HANDOFF_SCAN_MESSAGES)
    const history = rows.at(-1)?.role === 'user' ? rows.slice(0, -1) : rows
    return buildHandoffPreamble(history, undefined, LOST_HISTORY_HEADER)
  }

  /**
   * The catalogue for the brain's prompt, read once per launch: undefined when the brain has no
   * workers or the session has no repositories (or no catalogue exists), null when it could not be read.
   */
  private wantsCommands(): boolean {
    if (!this.deps.engine.bridge || !this.deps.listCommands) return false
    return this.deps.engine.sessionProjectsRepo
      .listBySession(this.deps.sessionId)
      .some((r) => r.membership === 'active')
  }

  /** A resumed brain keeps its old prompt, so a session from before this version is told once. */
  private queuePromptNote(
    resumed: boolean,
    commands: readonly CommandInfo[] | null | undefined,
    providers: string | undefined
  ): void {
    const stored = this.deps.sessionsRepo.getById(this.deps.sessionId)?.brainPromptVersion
    if (stored === undefined || stored >= BRAIN_PROMPT_VERSION) return
    const note = resumed ? promptUpdateNote(stored, commands, providers) : undefined
    if (note !== undefined) this.pendingPromptNote = note
    else this.deps.sessionsRepo.setBrainPromptVersion(this.deps.sessionId, BRAIN_PROMPT_VERSION)
  }

  private async consume(
    handle: AgentHandle,
    resumed: boolean,
    instructions: string | undefined
  ): Promise<void> {
    const usage = this.deps.usage?.track(
      {
        sessionId: this.deps.sessionId,
        agentKey: 'brain',
        role: 'brain',
        provider: () => this.runningProvider ?? handle.provider,
        model: () => this.runningModel ?? '',
        readContext: () => ({
          cwd: this.runningLaunch?.cwd ?? this.deps.getLaunch().cwd,
          roots: this.deps.engine.sessionProjectsRepo
            .listBySession(this.deps.sessionId)
            .map((p) => ({ path: p.projectPath, name: safeDirName(p.projectName) }))
        })
      },
      { resumed, instructions }
    )
    try {
      for await (const event of handle.events) {
        // Usage of a brain process that was replaced still counts.
        usage?.onEvent(event)
        if (this.handle !== handle && event.type !== 'exit') continue
        this.onEvent(handle, event)
      }
    } catch (error: unknown) {
      this.deps.log.error('brain event loop failed', error)
    }
  }

  private onEvent(handle: AgentHandle, event: AgentEvent): void {
    switch (event.type) {
      case 'session':
        if (event.model) this.deps.models.learn({ provider: event.provider, model: event.model })
        this.deps.brainThreadsRepo.set(
          this.deps.sessionId,
          handle.provider,
          event.providerSessionId,
          this.deps.now()
        )
        this.touch()
        return
      case 'text-delta':
        this.onTextDelta(event.messageId, event.text)
        return
      case 'assistant-message':
        this.onAssistantMessage(event.messageId, event.text)
        return
      case 'turn-result':
        this.finalizeSlot(event.interrupted ? 'stopped' : 'complete')
        this.settleSummaryReply(!event.interrupted)
        this.setBrainState('idle')
        this.settleName()
        this.touch()
        void this.recycleIfStale()
        return
      case 'error':
        this.onError(event.kind, event.message)
        return
      case 'rate-limit':
        forwardRateLimit(this.deps.planUsage, event)
        if (event.status === 'rejected') this.onBrainRateLimit(event.resetsAt, event.provider)
        return
      case 'exit':
        this.onExit(handle, event)
        return
      case 'thinking-delta':
      case 'tool-use':
      case 'tool-result':
      case 'stderr':
      case 'usage':
      case 'usage-progress':
      case 'control-ack':
      case 'task-started':
      case 'task-ended':
      case 'tasks-changed':
      case 'turn-started':
      case 'approval':
      case 'plan-updated':
      case 'model-rerouted':
      case 'mcp-status':
      case 'user-input-request':
      case 'unknown':
        return
      default: {
        const exhaustive: never = event
        void exhaustive
      }
    }
  }

  private onTextDelta(providerId: string, text: string): void {
    if (this.seen.has(providerId)) return
    if (this.slot && this.slot.providerId !== providerId) this.finalizeSlot('complete')
    const slot = this.slot ?? this.openSlot(providerId)
    slot.raw += text
    this.applyVisible(slot, false)
  }

  private onAssistantMessage(providerId: string, text: string): void {
    if (this.seen.has(providerId)) return
    if (this.slot && this.slot.providerId !== providerId) this.finalizeSlot('complete')
    const slot = this.slot ?? this.openSlot(providerId)
    slot.raw = text
    this.finalizeSlot('complete')
  }

  private onError(kind: Extract<AgentEvent, { type: 'error' }>['kind'], message: string): void {
    this.deps.log.warn(`brain error (${kind}): ${message}`)
    switch (kind) {
      case 'auth':
        // A signed-out Codex or Cursor never blocks the session; only Claude's sign-in does.
        if (this.runningProvider !== undefined && this.runningProvider !== 'claude') {
          const traits = PROVIDER_TRAITS[this.runningProvider]
          this.logEvent(
            'error',
            `${traits.name} isn't signed in. Run ${traits.loginCommand} in Terminal to use ${traits.name}.`
          )
          return
        }
        this.logEvent('error', "Claude Code isn't signed in.")
        this.deps.onSignedOut()
        return
      case 'not-installed':
        this.logEvent(
          'error',
          `${PROVIDER_TRAITS[this.runningProvider ?? 'claude'].cliName} isn't installed.`
        )
        return
      case 'rate-limit':
        this.onBrainRateLimit(undefined, this.runningProvider)
        return
      case 'api':
      case 'unknown':
        this.logEvent('error', 'The brain reported an error. Details are in the logs.')
        return
      case 'parse':
        return
    }
  }

  /** The brain hit the usage limit: wait, then send "Continue." (the next send resumes it if it exited). */
  private onBrainRateLimit(resetsAt: number | undefined, provider: ProviderId | undefined): void {
    if (this.closed) return
    this.rateLimit.hit(this.brainAgentId, {
      resetsAt,
      provider,
      retry: async () => {
        if (!this.closed) await this.sendToBrain('Continue.')
      }
    })
  }

  private onExit(handle: AgentHandle, event: Extract<AgentEvent, { type: 'exit' }>): void {
    if (this.handle === handle) {
      this.handle = undefined
      this.deps.engine.bridge?.revokeAgent(this.brainAgentId)
    }
    this.finalizeSlot('stopped')
    this.settleSummaryReply(false)
    this.setBrainState('idle')
    this.settleName()
    if (!event.expected) {
      this.logEvent('brain-stopped', 'Brain stopped unexpectedly', {
        code: event.code,
        signal: event.signal,
        stderrTail: event.stderrTail
      })
    }
  }

  private openSlot(providerId: string): Slot {
    const now = this.deps.now()
    const row = this.deps.messagesRepo.append({
      sessionId: this.deps.sessionId,
      role: 'brain',
      content: '',
      state: 'streaming',
      planId: null,
      createdAt: now,
      updatedAt: now
    })
    const slot: Slot = {
      rowId: row.id,
      providerId,
      createdAt: now,
      raw: '',
      shown: '',
      titleMode: this.titlePending,
      lastDbFlush: now,
      unflushedBytes: 0
    }
    this.titlePending = false
    this.slot = slot
    this.setBrainState('thinking')
    return slot
  }

  /** Recomputes what the user should see and streams the new tail. */
  private applyVisible(slot: Slot, final: boolean): void {
    let visible = slot.raw
    if (slot.titleMode) {
      const split = splitTitle(slot.raw, final)
      if (!split.decided) return
      if (split.title) this.applyName(split.title)
      visible = split.body
    }
    if (!visible.startsWith(slot.shown)) return
    const tail = visible.slice(slot.shown.length)
    if (tail === '') return
    slot.shown = visible
    slot.unflushedBytes += Buffer.byteLength(tail)
    this.deltas.push(slot.rowId, tail)
    const now = this.deps.now()
    if (now - slot.lastDbFlush >= this.dbFlushMs || slot.unflushedBytes >= this.dbFlushBytes) {
      this.writeStreaming(slot)
    }
  }

  private writeStreaming(slot: Slot): void {
    const now = this.deps.now()
    this.deps.messagesRepo.updateStreaming(slot.rowId, slot.shown, now)
    slot.lastDbFlush = now
    slot.unflushedBytes = 0
  }

  private finalizeSlot(state: 'complete' | 'stopped'): void {
    const slot = this.slot
    if (!slot) return
    this.applyVisible(slot, true)
    this.deltas.flush()
    const now = this.deps.now()
    this.deps.messagesRepo.finalize(slot.rowId, slot.shown, state, now)
    this.slot = undefined
    if (this.summaryReply && state === 'complete' && slot.shown.trim() !== '') {
      this.summaryReply.row = slot.rowId
    }
    this.seen.add(slot.providerId)
    this.touch()
    this.deps.emit('session:message', {
      sessionId: this.deps.sessionId,
      seq: this.nextSeq(),
      message: messageDto(slot, this.deps.sessionId, state, now)
    })
  }

  /** The brain is blocked on propose_plan: it waits on the user, not thinking. */
  private onPlanWaiting(waiting: boolean): void {
    this.planWaiting = waiting
    this.syncBrainWaiting()
  }

  /** The brain waits on the user while a plan decision or an ask_user answer is outstanding. */
  private syncBrainWaiting(): void {
    if (this.planWaiting || this.askWaiting) this.setBrainState('waiting')
    else if (this.state === 'waiting' && !this.closed && this.handle) this.setBrainState('thinking')
  }

  private setBrainState(state: BrainState): void {
    if (this.state === state) return
    this.state = state
    this.deps.onChange?.()
    this.deps.emit('session:brain-state', {
      sessionId: this.deps.sessionId,
      seq: this.nextSeq(),
      state
    })
  }

  /** Names the session unless it was already named or renamed by the user. */
  private applyName(name: string): void {
    if (this.nameResolved) return
    this.nameResolved = true
    const row = this.deps.sessionsRepo.getById(this.deps.sessionId)
    if (!row) return
    if (row.name !== PLACEHOLDER_SESSION_NAME) {
      this.deps.onNamed?.(row.name)
      return
    }
    this.deps.sessionsRepo.rename(this.deps.sessionId, name)
    this.deps.onChange?.()
    this.logEvent('renamed', `Session named "${name}"`, { name })
    this.deps.onNamed?.(name)
  }

  /** Appends a system message to the conversation and pushes it. */
  postSystemMessage(text: string, prompt?: MessagePrompt): void {
    const now = this.deps.now()
    const row = this.deps.messagesRepo.append({
      sessionId: this.deps.sessionId,
      role: 'system',
      content: text,
      state: 'complete',
      planId: null,
      promptJson: prompt ? JSON.stringify(prompt) : null,
      createdAt: now,
      updatedAt: now
    })
    this.deltas.flush()
    this.deps.emit('session:message', {
      sessionId: this.deps.sessionId,
      seq: this.nextSeq(),
      message: messageRowDto(row)
    })
  }

  /** Pushes the changed header into the session's `seq` stream. */
  pushHeader(header: SessionHeader): void {
    this.deps.emit('session:header', {
      sessionId: this.deps.sessionId,
      seq: this.nextSeq(),
      header
    })
  }

  /** After the first reply ended without a title line, fall back to the request's first words. */
  private settleName(): void {
    if (this.nameResolved || this.deps.titleRequest === null) return
    this.applyName(deriveName(this.deps.titleRequest))
  }

  private touch(): void {
    this.deps.sessionsRepo.touch(this.deps.sessionId, this.deps.now())
    this.deps.onChange?.()
  }
}
