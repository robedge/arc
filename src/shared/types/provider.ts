import type { AgentLoadOff } from './agent-load'
export const PROVIDER_IDS = ['claude', 'codex', 'cursor'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export type ProviderState = 'ok' | 'missing' | 'signed_out' | 'error' | 'unsupported'

/** Which kind of login a ready provider uses. `api_key` is not the user's subscription. */
export interface ProviderAccount {
  kind: 'chatgpt' | 'api_key' | 'unknown'
}

/** Result of one provider check. Later slices add optional fields (models, update info). */
export interface ProviderStatus {
  provider: ProviderId
  state: ProviderState
  /** Present when `<cli> --version` succeeded. */
  version?: string
  /** Banner or Settings text for a non-ok state; empty when ok. */
  message: string
  /** The command to run in Terminal to fix a signed-out state. */
  loginCommand?: string
  account?: ProviderAccount
  /** Epoch milliseconds when the check finished. */
  checkedAt: number
  /** The newest published version, when the registry lookup succeeded (cached for 6 hours). */
  latestVersion?: string
  /** True when `latestVersion` is newer than `version`. Absent counts as false. */
  updateAvailable?: boolean
  /** What to run in Terminal to update (`claude update`, `codex update` or a brew command). */
  updateCommand?: string
  /** True when the user dismissed the notice for exactly `latestVersion`; the Providers page still shows the update. */
  updateDismissed?: boolean
  /** Arc can't move to the changed tool without a restart (the binary is gone or fell below the minimum while agents run). */
  restartRequired?: boolean
  restartReason?: string
}

/** A provider is absent until its first check has finished. */
export type ProviderStatusMap = Partial<Record<ProviderId, ProviderStatus>>

/** Oldest Codex the app-server protocol work targets. */
export const MIN_CODEX_VERSION = '0.162.0'

/** Oldest Cursor CLI Arc supports (the release that stopped concurrent processes corrupting its config). */
export const MIN_CURSOR_VERSION = '2026.07.06'

/** Time a cached status stays fresh. */
export const PROVIDER_STATUS_TTL_MS = 30_000

/** A model together with the provider it belongs to. */
export interface ModelRef {
  provider: ProviderId
  model: string
}

/**
 * How a session (or the default) chooses workers: the brain picks (`auto`), the brain picks among
 * one provider's models (`provider`, the header's "Workers · Codex"), or one model is pinned.
 */
export type WorkersPref =
  { mode: 'auto' } | { mode: 'provider'; provider: ProviderId } | { mode: 'model'; model: ModelRef }

/** How capable a model is, used to pick the Claude model that stands in for an unavailable Codex one. */
export type ModelTier = 'deep' | 'balanced' | 'fast'

/** One model a provider offers, as the pickers list it. */
export interface ModelInfo {
  ref: ModelRef
  /** What the picker shows for the model. */
  label: string
  tier: ModelTier
  /** The provider's default model. */
  isDefault: boolean
  /** Cursor only: the maker the picker groups the model under (Claude, GPT/Codex, Grok, Gemini, Cursor, Other). */
  group?: string
  /** Cursor only: the model's name without its parameters, so the picker can collapse its variants. */
  base?: string
  /** Cursor only: the parameters of this variant (`reasoning=medium,fast=false`); absent when it has none. */
  variant?: string
}

/** Every provider's offered models. Codex is empty unless its status is `ok`. */
export type ProviderModels = Record<ProviderId, ModelInfo[]>

/** The defaults new sessions copy (`app_settings`, keys as stored). */
export interface AppSettings {
  'providers.brain': ModelRef
  'providers.workers': WorkersPref
  /** Send one tiny Claude request when Arc opens so the plan meter has a value (default true). */
  'usage.checkClaudePlanOnLaunch': boolean
  /** What Arc agents do not load, per role (spec 009). Everything is on by default. */
  'agents.loadOff': AgentLoadOff
}

/**
 * What actually runs an agent, as the views carry it. Filled by the main process from the stored
 * columns (`workers.provider` and `model`, `sessions.brain_provider` and `brain_model`). When the
 * worker fell back (Codex unavailable), `requestedProvider` and `fallbackReason` say what was asked for.
 */
export interface RunningOn {
  provider: ProviderId
  model: string
  requestedProvider?: ProviderId
  fallbackReason?: string
}

/**
 * What can skip Arc's approvals (spec 007 section 2.6, "Approval bypass"). Arc does not remove
 * these; Settings lists them and the event log notes it once per session. Only event names and
 * command prefixes are carried, never the contents of a hook or a rule.
 */
export interface BypassReport {
  /** Hook events of the user's Claude settings and enabled plugins that can answer "allow" (`PreToolUse`, `PermissionRequest`). */
  claudeHookEvents: string[]
  /** The same events per role, after the user's Agent loading choices (spec 009). The union above is what either role can still hit. */
  claudeHookEventsByRole?: { brain: string[]; workers: string[] }
  /** Codex `rules/*.rules` allow prefixes that Arc's own rules do not make Codex ask about, as `git commit` or `curl -L`. */
  codexAllowPrefixes: string[]
  /** How many of the user's Codex allow prefixes Arc's rules do cover (they ask Arc again). */
  codexRulesCovered: number
  /** What in the user's Cursor setup can answer "allow" without Arc (tech spec 2.4). Absent in reports from before Cursor. */
  cursor?: CursorBypass
}

/** The Cursor part of a `BypassReport`. Only entry texts and event names are carried, never a hook's contents. */
export interface CursorBypass {
  /** `Shell(...)`, `Write(...)` and `Mcp(...)` entries of the user's and the projects' Cursor `permissions.allow`. */
  allowEntries: string[]
  /** An `approvalMode` other than `allowlist` (for example `unrestricted`), when a Cursor config sets one. */
  approvalMode?: string
  /** Hook events of the user's and the projects' Cursor `hooks.json` that can answer "allow". */
  hookEvents: string[]
}
