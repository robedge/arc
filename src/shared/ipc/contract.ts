import { z } from 'zod'
import type {
  ReviewFileDiff,
  ReviewNote,
  ReviewPushPreview,
  ReviewPushResult,
  ReviewSnapshot,
  ReviewUndoPreview
} from '../types/review'
import { PROVIDER_IDS } from '../types/provider'
import type {
  AppSettings,
  BypassReport,
  ProviderModels,
  ProviderStatusMap
} from '../types/provider'
import { agentLoadOffSchema, modelRefSchema, workersPrefSchema } from '../provider-schemas'
import type { CodexLoadData, CursorLoadData, LoadCatalogueData } from '../types/agent-load'
import type { CommandInfo } from '../types/commands'
import type { PluginProgress, PluginRow } from '../types/plugins'
import type { PlanSnapshot, SessionUsage, UsageReport } from '../types/usage'
import type { Group } from '../types/group'
import type { Section } from '../types/section'
import type { ImportReport, ItemContent, ItemSummary } from '../types/item'
import type { AddProjectsResult, Project } from '../types/project'
import type {
  BrainState,
  AttentionView,
  CreateSessionResult,
  NeedsDirtyChoice,
  OpenSessionResult,
  ResolveDirtyResult,
  SessionEventEntry,
  PlanView,
  SessionHeader,
  SessionMessage,
  SessionSummary,
  WorkerDetails,
  WorkerView
} from '../types/session'
import type {
  StorageExportPickResult,
  StorageExportResult,
  StorageLocateResult,
  StoragePickResult,
  StorageProgressPhase,
  StorageState
} from '../types/storage'

/** The longest line `workers:send-input` accepts. */
export const WORKER_INPUT_MAX_CHARS = 20_000

/**
 * Request schemas, one entry per channel. Adding a channel is one entry here
 * plus one entry in `ChannelResponses`; main validates with these schemas and
 * the preload derives its allowlist from the keys.
 */
export const channelSchemas = {
  'app:ping': z.object({}).strict(),
  // The renderer finished flushing unsaved work after `app:before-close`.
  'app:close-ready': z.object({}).strict(),
  'groups:list': z.object({}).strict(),
  // Shape only; GroupService owns the name rules so callers get specific error codes.
  'groups:create': z.object({ name: z.string() }).strict(),
  'groups:rename': z.object({ groupId: z.string(), name: z.string() }).strict(),
  // `exportTo` is a token from `storage:pickExportFolder`: the knowledge is exported and verified first; if that fails nothing is deleted.
  'groups:delete': z.object({ groupId: z.string(), exportTo: z.string().optional() }).strict(),
  // The renderer calls this when the user selects a group; drives availability checks.
  'groups:open': z.object({ groupId: z.string() }).strict(),
  'projects:list': z.object({ groupId: z.string() }).strict(),
  'projects:pick': z.object({ groupId: z.string() }).strict(),
  'projects:add': z.object({ groupId: z.string(), paths: z.array(z.string()) }).strict(),
  'projects:remove': z.object({ groupId: z.string(), projectId: z.string() }).strict(),
  'projects:relocate': z.object({ groupId: z.string(), projectId: z.string() }).strict(),
  'sections:list': z.object({ groupId: z.string() }).strict(),
  // Shape only; SectionService owns the name rules.
  'sections:create': z.object({ groupId: z.string(), name: z.string() }).strict(),
  'sections:rename': z.object({ sectionId: z.string(), name: z.string() }).strict(),
  'sections:delete': z.object({ sectionId: z.string() }).strict(),
  // Shape only; KnowledgeService owns the title/description rules.
  'items:list': z.object({ sectionId: z.string() }).strict(),
  'items:read': z.object({ itemId: z.string() }).strict(),
  'items:create': z
    .object({ sectionId: z.string(), title: z.string(), description: z.string().optional() })
    .strict(),
  'items:save': z
    .object({ itemId: z.string(), content: z.string(), baseRevision: z.string() })
    .strict(),
  'items:rename': z.object({ itemId: z.string(), title: z.string() }).strict(),
  'items:setDescription': z.object({ itemId: z.string(), description: z.string() }).strict(),
  'items:delete': z.object({ itemId: z.string() }).strict(),
  'items:pickImport': z.object({ sectionId: z.string() }).strict(),
  'items:import': z
    .object({
      sectionId: z.string(),
      paths: z.array(z.string()),
      onConflict: z.record(z.string(), z.enum(['replace', 'keepBoth', 'skip'])).optional()
    })
    .strict(),
  // Shape only; KnowledgeService owns the url/title/description rules.
  'links:upsert': z
    .object({
      sectionId: z.string(),
      itemId: z.string().optional(),
      url: z.string(),
      title: z.string().optional(),
      description: z.string().optional()
    })
    .strict(),
  'shell:openLink': z.object({ itemId: z.string() }).strict(),
  'shell:openUrl': z.object({ url: z.string() }).strict(),
  // Ids only: main resolves the path itself (itemId > sectionId > the group's knowledge root).
  'shell:reveal': z
    .object({
      groupId: z.string(),
      sectionId: z.string().optional(),
      itemId: z.string().optional()
    })
    .strict(),
  'storage:get': z.object({ groupId: z.string() }).strict(),
  // Opens the native folder picker in main and preflights the choice; the path never comes from the renderer.
  'storage:pickFolder': z.object({ groupId: z.string() }).strict(),
  // `token` is the one returned by `storage:pickFolder` for this group.
  'storage:link': z
    .object({
      groupId: z.string(),
      token: z.string(),
      choice: z.enum(['move', 'folder-only'])
    })
    .strict(),
  // Linked groups only. The linked folder is never modified. `restore-kept` needs earlier in-app
  // knowledge kept aside; `keep-current` needs the linked folder to be available.
  'storage:unlink': z
    .object({ groupId: z.string(), choice: z.enum(['keep-current', 'restore-kept']) })
    .strict(),
  // Opens the native folder picker in main; relinks the group to the chosen folder.
  'storage:locate': z.object({ groupId: z.string() }).strict(),
  // The linked folder is missing: switch to app storage (restores kept-aside knowledge, else starts empty).
  'storage:useAppStorage': z.object({ groupId: z.string() }).strict(),
  // Opens the native folder picker in main for an export destination; the path never comes from the renderer.
  'storage:pickExportFolder': z.object({ groupId: z.string() }).strict(),
  // Copies the whole knowledge root (including .arc/) to `<chosen>/<group name>-knowledge/` and verifies it.
  'storage:export': z.object({ groupId: z.string(), token: z.string() }).strict(),
  'providers:get': z.object({}).strict(),
  // Re-runs the login-shell PATH resolve and the check for one provider, or for all of them.
  'providers:check': z.object({ provider: z.enum(PROVIDER_IDS).optional() }).strict(),
  // The user dismissed the one-time update notice for this version (`providers.update_dismissed.<provider>`).
  // Pushes `providers:changed`; the Providers page still shows the update.
  'providers:dismiss-update': z
    .object({ provider: z.enum(PROVIDER_IDS), version: z.string().min(1) })
    .strict(),
  // Restart Arc (the "Restart Arc to finish updating" modal): `app.relaunch()`, then the normal quit path.
  'app:relaunch': z.object({}).strict(),
  // The models each provider offers, for the pickers. Tech spec 2.8 folds them into `providers:get`; they
  // are a separate channel because the status map is keyed by provider id. Codex lists nothing unless its
  // status is ok; the Codex list is loaded here when it is missing or older than 24 hours.
  'providers:models': z.object({}).strict(),
  // What can skip Arc's approvals (the user's allow-capable Claude hook events and the Codex allow
  // rules Arc's own rules do not cover), for the warning in Settings. Read from disk on each call.
  'providers:bypass': z.object({}).strict(),
  // The defaults that new sessions copy. Existing sessions never change when these do.
  'settings:get': z.object({}).strict(),
  // Any subset of the keys; returns every key and pushes `settings:changed`.
  'settings:set': z
    .object({
      'providers.brain': modelRefSchema.optional(),
      'providers.workers': workersPrefSchema.optional(),
      'usage.checkClaudePlanOnLaunch': z.boolean().optional(),
      'agents.loadOff': agentLoadOffSchema.optional()
    })
    .strict(),
  'sessions:list': z.object({ groupId: z.string() }).strict(),
  'sessions:attention-summary': z.object({}).strict(),
  // The user's answer: approve or deny a permission request, or text, structured answers or a decline for a question.
  'attention:answer': z.union([
    // `always` (only with approve: true) also stores a rule that approves matching requests for the rest of the session.
    z
      .object({ requestId: z.string(), approve: z.boolean(), always: z.boolean().optional() })
      .strict()
      .refine((v) => v.always !== true || v.approve),
    z.object({ requestId: z.string(), text: z.string().min(1) }).strict(),
    // A structured question (`AttentionView.questions`): per question text, the chosen labels, or one
    // typed string. Several questions of one call are answered together.
    z
      .object({
        requestId: z.string(),
        answers: z.record(z.string(), z.array(z.string().min(1).max(4000)).min(1).max(50))
      })
      .strict(),
    // Dismissing a command's question: the command is told "The user declined to answer."
    z.object({ requestId: z.string(), decline: z.literal(true) }).strict()
  ]),
  'sessions:create': z
    .object({
      groupId: z.string(),
      request: z.string().min(1),
      mode: z.enum(['plan_first', 'autonomous']),
      workerLimit: z.number().int().min(1).max(6),
      // The brain picked in the dialog; saved as the Settings brain default.
      brainModel: modelRefSchema.optional()
    })
    .strict(),
  'sessions:open': z.object({ sessionId: z.string() }).strict(),
  'commands:list': z.object({ sessionId: z.string() }).strict(),
  'commands:refresh': z.object({ sessionId: z.string() }).strict(),
  // What Arc agents can load, with size estimates (spec 009); the switches themselves are the `agents.loadOff` setting.
  'agent-load:get': z.object({}).strict(),
  // The user's Codex MCP servers for the same page; asked apart because Codex has to start to list them.
  'agent-load:codex': z.object({}).strict(),
  // The user's Cursor MCP servers (their mcp.json files), asked apart so a slow Cursor check never holds the page.
  'agent-load:cursor': z.object({}).strict(),
  'plugins:list': z.object({}).strict(),
  'plugins:install': z
    .object({
      name: z.string().trim().min(1).max(200),
      marketplace: z.string().trim().min(1).max(200).optional()
    })
    .strict(),
  'plugins:update': z.object({ id: z.string().min(1).max(400) }).strict(),
  'plugins:uninstall': z.object({ id: z.string().min(1).max(400) }).strict(),
  'plugins:check-updates': z.object({}).strict(),
  'review:get': z.object({ sessionId: z.string() }).strict(),
  'review:set-reviewed': z
    .object({
      sessionId: z.string(),
      projectId: z.string(),
      path: z.string().min(1),
      reviewed: z.boolean()
    })
    .strict(),
  'review:undo-preview': z
    .object({ sessionId: z.string(), projectId: z.string(), path: z.string().min(1) })
    .strict(),
  'review:undo': z
    .object({ sessionId: z.string(), projectId: z.string(), path: z.string().min(1) })
    .strict(),
  'review:push-preview': z.object({ sessionId: z.string(), projectId: z.string() }).strict(),
  'review:push': z
    .object({ sessionId: z.string(), projectId: z.string(), confirm: z.literal(true) })
    .strict(),
  'review:note-create': z
    .object({
      sessionId: z.string(),
      projectId: z.string(),
      path: z.string().min(1),
      side: z.enum(['old', 'new']),
      line: z.number().int().min(1),
      lineText: z.string(),
      body: z.string()
    })
    .strict(),
  'review:note-update': z.object({ noteId: z.string(), body: z.string() }).strict(),
  'review:note-delete': z.object({ noteId: z.string() }).strict(),
  'review:send-notes': z.object({ sessionId: z.string() }).strict(),
  'review:file': z
    .object({
      sessionId: z.string(),
      projectId: z.string(),
      path: z.string().min(1),
      source: z.enum(['session', 'uncommitted']).optional(),
      showAnyway: z.boolean().optional()
    })
    .strict(),
  // `token` comes from a `needsDirtyChoice` result. A missing choice for a dirty repo counts as 'cancel'.
  'sessions:resolve-dirty': z
    .object({
      token: z.string(),
      choices: z.record(z.string(), z.enum(['stash', 'commit', 'carry', 'cancel']))
    })
    .strict(),
  'sessions:rename': z.object({ sessionId: z.string(), name: z.string() }).strict(),
  // Any subset; a `brainModel` change applies from the brain's next turn, `workers` from the next worker.
  // `brainModel` must be a Claude model until the brain can run on Codex (Slice 4); a Codex one is refused.
  'sessions:set-config': z
    .object({
      sessionId: z.string(),
      mode: z.enum(['plan_first', 'autonomous']).optional(),
      workerLimit: z.number().int().min(1).max(6).optional(),
      workers: workersPrefSchema.optional(),
      brainModel: modelRefSchema.optional(),
      // Approve every protected request automatically, except pushes and merge/pull requests.
      autoApprove: z.boolean().optional()
    })
    .strict(),
  // Removes one "Always allow this in this session" rule; returns the updated header.
  'sessions:remove-allow-rule': z.object({ sessionId: z.string(), ruleId: z.string() }).strict(),
  'sessions:send-message': z.object({ sessionId: z.string(), text: z.string().min(1) }).strict(),
  'sessions:stop-reply': z.object({ sessionId: z.string() }).strict(),
  'sessions:delete': z.object({ sessionId: z.string() }).strict(),
  // `models` maps a proposed worker's name to the provider and model picked on the plan card.
  'sessions:plan-decision': z
    .object({
      sessionId: z.string(),
      planId: z.string(),
      decision: z.enum(['approve', 'ask-changes', 'reject']),
      models: z.record(z.string(), modelRefSchema).optional()
    })
    .strict(),
  'workers:get': z.object({ workerId: z.string() }).strict(),
  // The session's token usage: total and one entry per agent. Kept live by `usage:session-changed`.
  'usage:get-session': z.object({ sessionId: z.string() }).strict(),
  // The Usage page's data for a range. Kept fresh by the `usage:changed` invalidation push.
  'usage:get-report': z.object({ range: z.enum(['today', '7d', '30d', 'all']) }).strict(),
  // Dismisses a suggestion for good; the session's snapshot and `usage:changed` follow as pushes.
  'usage:dismiss-suggestion': z.object({ id: z.string() }).strict(),
  // The plan meters per set-up provider and the open plan notices. Kept live by `plan:changed`.
  'plan:get': z.object({}).strict(),
  // Reads the Codex limits now (Claude's come from the agents' own events); answers like `plan:get`.
  'plan:refresh': z.object({}).strict(),
  // Dismisses one plan notice by its key and pushes `plan:changed`.
  'plan:dismiss-notice': z.object({ key: z.string() }).strict(),
  'workers:open-terminal': z.object({ workerId: z.string() }).strict(),
  'workers:stop': z.object({ workerId: z.string() }).strict(),
  'workers:remove': z.object({ workerId: z.string() }).strict(),
  'workers:step-in': z.object({ workerId: z.string() }).strict(),
  'workers:hand-back': z.object({ workerId: z.string() }).strict(),
  'workers:send-input': z
    .object({ workerId: z.string(), text: z.string().min(1).max(WORKER_INPUT_MAX_CHARS) })
    .strict(),
  'workers:interrupt': z.object({ workerId: z.string() }).strict(),
  // One worker, or every worker of the session that can be continued.
  'workers:continue': z.union([
    z.object({ workerId: z.string() }).strict(),
    z.object({ sessionId: z.string(), all: z.literal(true) }).strict()
  ]),
  // "Not now" on a prompt message (`SessionMessage.prompt`).
  'sessions:dismiss-prompt': z
    .object({ sessionId: z.string(), messageId: z.number().int() })
    .strict(),
  'sessions:page': z
    .object({
      sessionId: z.string(),
      kind: z.enum(['messages', 'events']),
      beforeId: z.number().int(),
      limit: z.number().int().min(1).max(200)
    })
    .strict()
}

/** Response payload (the `data` of the Result) per channel. */
export interface ChannelResponses {
  'app:ping': { version: string }
  'app:close-ready': void
  'groups:list': Group[]
  'groups:create': Group
  'groups:rename': Group
  'groups:delete': void
  'groups:open': void
  'projects:list': Project[]
  'projects:pick': AddProjectsResult
  'projects:add': AddProjectsResult
  'projects:remove': void
  'projects:relocate': Project
  'sections:list': Section[]
  'sections:create': Section
  'sections:rename': Section
  'sections:delete': { removed: number }
  'items:list': ItemSummary[]
  'items:read': ItemContent
  'items:create': ItemSummary
  'items:save': { revision: string }
  'items:rename': ItemSummary
  'items:setDescription': void
  'items:delete': void
  'items:pickImport': ImportReport
  'items:import': ImportReport
  'links:upsert': ItemSummary
  'shell:openLink': void
  'shell:openUrl': void
  'shell:reveal': void
  'storage:get': StorageState
  'storage:pickFolder': StoragePickResult
  'storage:link': StorageState
  'storage:unlink': StorageState
  'storage:locate': StorageLocateResult
  'storage:useAppStorage': StorageState
  'storage:pickExportFolder': StorageExportPickResult
  'storage:export': StorageExportResult
  'providers:get': ProviderStatusMap
  'providers:check': ProviderStatusMap
  'providers:dismiss-update': ProviderStatusMap
  'app:relaunch': void
  'providers:models': ProviderModels
  'providers:bypass': BypassReport
  'settings:get': AppSettings
  'settings:set': AppSettings
  'sessions:list': SessionSummary[]
  /** Pending requests with the user per group, for the sidebar dots at startup. */
  'sessions:attention-summary': { byGroup: Record<string, number> }
  'attention:answer': void
  'sessions:create': CreateSessionResult
  /** The snapshot, or `needsDirtyChoice` when a repo with unsaved changes is not on the session branch yet; nothing is switched until `sessions:resolve-dirty`. */
  'sessions:open': OpenSessionResult
  /** The `/` list of a session: user and plugin commands plus its repositories' saved commands. Error `SESSION_NOT_FOUND`, `INTERNAL` when every probe failed. */
  'commands:list': CommandInfo[]
  /** Rebuilds the plugin view and probes again, ignoring the cache. Same errors as `commands:list`. */
  'commands:refresh': CommandInfo[]
  /** The user's installed plugins (user scope) with description, counts and flags. Error `PLUGIN_FAILED` (`details.reason` is the CLI's message). */
  'agent-load:get': LoadCatalogueData
  'agent-load:codex': CodexLoadData
  'agent-load:cursor': CursorLoadData
  'plugins:list': PluginRow[]
  /** Starts `claude plugin install`; progress arrives as `plugins:progress`. Error `PLUGIN_BUSY` while another change runs. */
  'plugins:install': { opId: string }
  /** Starts `claude plugin update <id>`. Same errors and progress. */
  'plugins:update': { opId: string }
  /** Starts `claude plugin uninstall <id>`. Same errors and progress. */
  'plugins:uninstall': { opId: string }
  /** Starts `claude plugin marketplace update` (refreshes what the Update badges compare with). Same errors and progress. */
  'plugins:check-updates': { opId: string }
  /** What the session changed per repository since its branch started. Error `SESSION_NOT_FOUND` for an unknown session. */
  'review:get': ReviewSnapshot
  /** One file's change, parsed into hunks. Errors `SESSION_NOT_FOUND`, `REVIEW_FILE_NOT_FOUND` (not a changed file of that project). */
  'review:file': ReviewFileDiff
  /** Ticks (`reviewed: true`) or unticks a changed session file. Errors `SESSION_NOT_FOUND`, `REVIEW_FILE_NOT_FOUND` (not a changed file of that project). */
  'review:set-reviewed': void
  /** Labels ("W2") of running workers that changed the file since their base. Errors `SESSION_NOT_FOUND`, `REVIEW_FILE_NOT_FOUND`. */
  'review:undo-preview': ReviewUndoPreview
  /** Puts the file back as it was when the session started, as a new commit on the session branch. Errors `SESSION_NOT_FOUND`, `REVIEW_FILE_NOT_FOUND`, `BRANCH_DIVERGED`, `IO_FAILED`. */
  'review:undo': void
  /** The exact command Push branch will run. Errors `SESSION_NOT_FOUND`, `NO_REMOTE`, `WAITING_FOR_CHECKOUT`. */
  'review:push-preview': ReviewPushPreview
  /** Pushes the session branch to its remote (`confirm: true` only). Errors `SESSION_NOT_FOUND`, `NO_REMOTE`, `WAITING_FOR_CHECKOUT`, `PUSH_FAILED` (`details.reason` is git's message). */
  'review:push': ReviewPushResult
  /** Saves a draft note on a line of the diff. Errors `SESSION_NOT_FOUND`, `REVIEW_FILE_NOT_FOUND`, `VALIDATION_FAILED` (empty or over-long body, or the line is not in the current diff), `TOO_MANY_NOTES` (50 drafts). */
  'review:note-create': ReviewNote
  /** Errors `NOTE_NOT_FOUND`, `NOT_DRAFT` (already sent), `VALIDATION_FAILED` (empty or over-long body). */
  'review:note-update': ReviewNote
  /** Errors `NOTE_NOT_FOUND`, `NOT_DRAFT`. */
  'review:note-delete': void
  /** Posts every draft as one conversation message and marks them sent. Errors `SESSION_NOT_FOUND`, `VALIDATION_FAILED` (no drafts), `CLI_UNAVAILABLE`. */
  'review:send-notes': { messageId: number; count: number }
  'sessions:resolve-dirty': ResolveDirtyResult
  'sessions:rename': SessionSummary
  /** Error `VALIDATION_FAILED` for a model that is neither an alias (opus, sonnet, haiku), 'auto' (workers) nor a model id a run reported. Pushes `session:header`. */
  'sessions:set-config': SessionHeader
  'sessions:remove-allow-rule': SessionHeader
  /** Error `CLI_UNAVAILABLE` (nothing persisted) when Claude Code is missing or signed out; the renderer keeps the draft. */
  'sessions:send-message': { messageId: number }
  'sessions:stop-reply': void
  /** Stops the session's processes, deletes its rows and `userData/sessions/<id>/`. */
  'sessions:delete': void
  /** Error `VALIDATION_FAILED` for a model the provider does not offer (not a Claude alias, a listed Codex model or a reported model id). `approve` starts each worker on its provider and model. */
  'sessions:plan-decision': void
  /** Error `VALIDATION_FAILED` for an unknown worker. */
  'workers:get': WorkerDetails
  'usage:get-session': SessionUsage
  'usage:get-report': UsageReport
  'usage:dismiss-suggestion': void
  'plan:get': PlanSnapshot
  'plan:refresh': PlanSnapshot
  'plan:dismiss-notice': void
  /**
   * The worker's terminal transcript. `backlog` is the last 1 MB for a running worker, or the
   * whole log file (up to the 20 MB cap) for a finished one; `seq` is the last chunk it contains,
   * so the renderer drops `worker:terminal` chunks with `seq <= backlog seq`. `truncated` means
   * older output was cut. Error `VALIDATION_FAILED` for an unknown worker.
   */
  'workers:open-terminal': { backlog: string; seq: number; truncated: boolean }
  /**
   * Stops the worker (stopped by the user) and removes its working copies; commits not in the session
   * branch are discarded, so a user-stopped worker cannot be continued (quit and crash stops keep the
   * working copy). A queued worker is just taken out of the queue. A worker that is not running is left as it is.
   */
  'workers:stop': void
  /**
   * The user takes over a worker: it stops its current step, is marked under the user's control and
   * the brain is told. Error `VALIDATION_FAILED` when the worker is not eligible (queued, finished,
   * a resolver, or already controlled).
   */
  'workers:step-in': { ok: true }
  /** The worker carries on with its task by itself. Error `VALIDATION_FAILED` when the user is not in control. */
  'workers:hand-back': { ok: true }
  /** One line to the worker, verbatim (1 to 20,000 characters). Error `VALIDATION_FAILED` when the user is not in control or the worker has no process. */
  'workers:send-input': { ok: true }
  /** Escape: stops the current reply and nothing else. */
  'workers:interrupt': { outcome: 'idle' | 'acked' | 'sigint' | 'killed' }
  /**
   * Removes a finished worker (done, merged, failed or stopped) from the session: its row is hidden
   * (soft delete, the event log keeps its entries), any working copy left is force-removed and
   * "Removed W1 api-retry" is logged. A Done worker that is not merged loses its commits. Error
   * `VALIDATION_FAILED` for an unknown worker or one that is queued or running ("Stop the worker first").
   * No push: the UI drops the worker when the call returns; snapshots no longer list it.
   */
  'workers:remove': void
  /**
   * Continues stopped workers: respawns each with `--resume <claude session id>` in its existing working
   * copy and sends "You were interrupted. Continue the task." (plus any answers it never received).
   * Only workers stopped by a quit or a crash that still have a working copy qualify; with `workerId`,
   * any other worker is refused with `VALIDATION_FAILED` and `details.reason` ("Stopped by you" workers
   * lost their working copy; removed, running and finished workers cannot be continued). With `all`,
   * the workers that do not qualify are skipped. Workers go starting -> working via `session:worker-changed`;
   * the open "continue-workers" prompt of the session becomes `continued`.
   */
  'workers:continue': void
  /** Marks a prompt message `dismissed` (Not now) and pushes the updated `session:message`. Error `VALIDATION_FAILED` for an unknown or already answered prompt. */
  'sessions:dismiss-prompt': void
  /** Up to `limit` rows older than `beforeId`, ascending; the kind picks which list. */
  'sessions:page': SessionMessage[] | SessionEventEntry[]
}

export type Channel = keyof typeof channelSchemas
export type ChannelRequest<C extends Channel> = z.infer<(typeof channelSchemas)[C]>
export type ChannelResponse<C extends Channel> = ChannelResponses[C]

/** Push events (main -> renderer): event name -> payload. */
export interface IpcEvents {
  /** The window is closing; flush unsaved work, then invoke `app:close-ready`. */
  'app:before-close': Record<string, never>
  'availability:changed': {
    groupId: string
    projectId?: string
    /** True when this is the group's linked knowledge folder (no `projectId` then). */
    knowledgeRoot?: boolean
    available: boolean
  }
  'knowledge:changed': KnowledgeChangedPayload
  'storage:progress': StorageProgressPayload
  /** Every provider's status; sent after each check. */
  'providers:changed': ProviderStatusMap
  /** The Settings defaults changed; carries every key. */
  'settings:changed': AppSettings
  /** The plugin view changed; the command lists are stale (call `commands:list` again). */
  'commands:changed': Record<string, never>
  /** State of a plugin change; `message` is Claude Code's own reason when `failed`. */
  'plugins:progress': PluginProgress
  /** A plugin change succeeded: reload the Plugins page. */
  'plugins:changed': Record<string, never>
  /**
   * Streamed brain text for a message that is still being written, coalesced to one push per 50 ms
   * or 4 KB. `messageId` is the message's database id; an unknown id means a new brain bubble.
   */
  'session:brain-delta': { sessionId: string; messageId: number; seq: number; text: string }
  /** A brain message reached its final text (`complete` or `stopped`). Pending deltas are pushed first. */
  'session:message': { sessionId: string; seq: number; message: SessionMessage }
  /** Event-log rows, batched every 100 ms. */
  'session:event-logged': { sessionId: string; seq: number; entries: SessionEventEntry[] }
  /** The brain started or stopped working on a turn. */
  'session:brain-state': { sessionId: string; seq: number; state: BrainState }
  /**
   * A session's derived list status, name or lastActiveAt changed (at most one push per 250 ms per
   * session). Not part of the per-session `seq` stream.
   */
  'session:summary': { groupId: string; summary: SessionSummary }
  /** The header changed (the session branches were created); in the per-session `seq` stream. */
  'session:header': { sessionId: string; seq: number; header: SessionHeader }
  /**
   * A project joined the group and has unsaved changes: the open session asks what to do with them
   * before creating its branch there. Answer with `sessions:resolve-dirty`. Not in the `seq` stream.
   */
  'session:dirty-question': {
    sessionId: string
    needsDirtyChoice: NeedsDirtyChoice['needsDirtyChoice']
  }
  /** A plan was proposed or changed state (approved, replaced, rejected, awaiting a comment). */
  'session:plan': { sessionId: string; seq: number; plan: PlanView }
  /** The requests waiting for the user in a session changed (the badge, the dialog). */
  'session:attention': {
    sessionId: string
    groupId: string
    count: number
    requests: AttentionView[]
  }
  /** A notification was clicked: select the session and open the dialog (first `requestId` if given). */
  'session:open-attention': { sessionId: string; groupId?: string; requestId?: string }
  /**
   * A session's token usage changed: the full snapshot, at most one push per second per session
   * (trailing edge) after rows are recorded. Not part of the per-session `seq` stream.
   */
  'usage:session-changed': SessionUsage
  /** Usage was recorded (any session or the plan check): refetch the report. At most once per 5 s. */
  'usage:changed': Record<string, never>
  /** The plan meters or notices changed: the full snapshot. */
  'plan:changed': PlanSnapshot
  /** A worker changed; at most one push per 250 ms per worker (the last state always goes out). */
  'session:worker-changed': { sessionId: string; seq: number; worker: WorkerView }
  /**
   * More work reached a session branch (a merge was recorded or a waiting one landed). `changedPaths` are
   * repo-relative paths of the merge (empty when a waiting merge landed); `fileCount` is the session-wide
   * changed file count afterwards. In the per-session `seq` stream.
   */
  'session:review-changed': {
    sessionId: string
    projectId: string
    seq: number
    changedPaths: string[]
    fileCount: number
  }
  /** Terminal text of a worker, batched every 50 ms or 4 KB. `seq` rises per worker. */
  'worker:terminal': { workerId: string; seq: number; text: string }
}

export interface StorageProgressPayload {
  groupId: string
  phase: StorageProgressPhase
  /** Files handled so far in this phase. */
  done: number
  /** Files in this operation (0 when the phase has no per-file work). */
  total: number
}

/** One item whose indexed state changed. `revision` is null when the item no longer exists. */
export interface KnowledgeChangedItem {
  id: string
  sectionId: string
  /** Same format as `ItemSummary.revision` / the `items:save` result; null = deleted. */
  revision: string | null
}

export interface KnowledgeChangedPayload {
  groupId: string
  /** Sections that need re-listing (includes sections adopted from new folders). */
  sectionIds: string[]
  /** True when the section list itself changed (a folder was adopted); re-run `sections:list`. */
  sectionsChanged?: boolean
  /**
   * Items added, changed or removed. Omitted when the change was too large to enumerate
   * (more than 500 items): re-list `sectionIds` instead.
   */
  items?: KnowledgeChangedItem[]
  reason: 'external' | 'storage'
}

export type IpcEventName = keyof IpcEvents
export const eventNames: readonly IpcEventName[] = [
  'availability:changed',
  'app:before-close',
  'knowledge:changed',
  'storage:progress',
  'providers:changed',
  'settings:changed',
  'commands:changed',
  'plugins:progress',
  'plugins:changed',
  'session:brain-delta',
  'session:message',
  'session:event-logged',
  'session:brain-state',
  'session:summary',
  'session:header',
  'session:dirty-question',
  'session:plan',
  'session:worker-changed',
  'usage:session-changed',
  'usage:changed',
  'plan:changed',
  'session:review-changed',
  'worker:terminal',
  'session:attention',
  'session:open-attention'
]

export const channelNames = Object.keys(channelSchemas) as Channel[]
