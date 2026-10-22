import type { FileReadsRepo } from '../db/repositories/file-reads-repo'
import type { UsageRepo } from '../db/repositories/usage-repo'
import { localDay } from '../db/repositories/usage-repo'
import type { UsageSuggestionsRepo } from '../db/repositories/usage-suggestions-repo'
import type { UsageSuggestionKind } from '../db/schema'
import type { ModelRegistry } from '../models/model-registry'
import { shownModel } from '../../shared/provider-label'
import { providerReportsTokens } from '../../shared/provider-traits'
import type { ProviderId } from '../../shared/types/provider'
import type { AgentUsage, Suggestion } from '../../shared/types/usage'

/** A worker that used fewer tokens than this in total did a small task. */
export const SMALL_TASK_TOKENS = 50_000
/** Setup overhead appears once an agent's measured fixed setup is this many tokens per request. */
export const SETUP_PER_REQUEST_TOKENS = 30_000
/** From this share (25%) of the setup being Arc's additions, the advice is about what Arc adds. */
export const ARC_SHARE_PERCENT = 25
/** Reads of one file in one session that make it repeated work. */
export const REPEATED_READS = 3
/** A turn whose largest request has more input tokens than this makes its agent long-running. */
export const LONG_CONTEXT_TOKENS = 200_000

export interface SuggestionServiceDeps {
  repo: Pick<UsageSuggestionsRepo, 'upsert' | 'dismiss' | 'sessionOf' | 'forSession'>
  fileReads: Pick<FileReadsRepo, 'bump' | 'repeated' | 'distinctFiles'>
  usage: Pick<UsageRepo, 'sessionPanel' | 'agentLabels'>
  /** The session's agents with their setup, for their current provider: `UsageRecorder.snapshot().agents`. */
  agents: (sessionId: string) => readonly SetupAgent[]
  models: Pick<ModelRegistry, 'tierOf' | 'defaultFor'>
  /** A suggestion was created or refreshed for the session: push its snapshot and `usage:changed`. */
  onChanged: (sessionId: string) => void
  now: () => number
  newId: () => string
  log?: { warn: (message: string, error?: unknown) => void }
}

/** What the setup check reads of an agent of the session snapshot. */
export type SetupAgent = Pick<AgentUsage, 'agentKey' | 'role' | 'label' | 'setup'> &
  Partial<Pick<AgentUsage, 'recording'>>

/** The agent a check is about. `label` is "W2" for a worker and "the brain" for the brain. */
export interface SuggestionAgent {
  sessionId: string
  /** `brain`, a worker id or `resolver:<id>`. */
  agentKey: string
  label: string
}

export interface WorkerFinished extends SuggestionAgent {
  workerId: string
  provider: ProviderId
  model: string
  /** Files the worker changed; null when its working copies are gone and nothing can be said. */
  changedFiles: number | null
}

export interface TurnRecorded extends SuggestionAgent {
  /** The turn's largest single request (input plus cache). */
  maxCallInput: number
  contextWindow: number | null
}

interface Draft {
  kind: UsageSuggestionKind
  sessionId: string
  agentKey?: string | null
  workerId?: string | null
  dedupeKey: string
  text: string
  advice: string
  params: Record<string, unknown>
}

/** 1,234 -> "1.2k", 400,000 -> "400k", 1,500,000 -> "1.5M". */
export function compactTokens(n: number): string {
  const one = (value: number, unit: string): string =>
    `${value >= 100 ? Math.floor(value) : Math.floor(value * 10) / 10}${unit}`
  if (n >= 1_000_000) return one(n / 1_000_000, 'M')
  if (n >= 1000) return one(n / 1000, 'k')
  return String(n)
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** A model as the pickers show it: "Opus" for the Claude alias, "Auto" for Cursor's `default[]`. */
function modelName(provider: ProviderId, model: string): string {
  return shownModel({ provider, model })
}

/** "W2" for a worker (its label is "W2 · docs-update"), "the brain", "the conflict resolver". */
function setupName(agent: SetupAgent): string {
  if (agent.role === 'brain') return 'the brain'
  if (agent.role === 'resolver') return 'the conflict resolver'
  return agent.label.split(' · ')[0] ?? agent.label
}

const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The four saving suggestions (tech spec 2.8). Each check builds a plain-words suggestion from a
 * template and upserts it under its dedupe key: the repository refreshes the numbers while it is open
 * and never touches or recreates a dismissed one. Advice only; nothing here changes a model, a worker
 * or a session.
 */
export class SuggestionService {
  /** Labels of the agents seen reading, by session and agent key (a worker has no usage row mid-turn). */
  private readonly labels = new Map<string, string>()

  constructor(private readonly deps: SuggestionServiceDeps) {}

  /** The session's open suggestions, newest first. */
  forSession(sessionId: string): Suggestion[] {
    return this.deps.repo.forSession(sessionId)
  }

  /** Dismisses one for good and tells the session's views. */
  dismiss(id: string): void {
    const sessionId = this.deps.repo.sessionOf(id)
    this.deps.repo.dismiss(id, this.deps.now())
    if (sessionId !== undefined) this.safely(() => this.deps.onChanged(sessionId))
  }

  /** A worker is done: a deep-tier model on a small task is too strong. Workers only. */
  onWorkerFinished(input: WorkerFinished): void {
    this.safely(() => {
      const tier = this.deps.models.tierOf({ provider: input.provider, model: input.model })
      if (tier !== 'deep') return
      const tokens = this.agentTokens(input.sessionId, input.agentKey)
      const noChanges = input.changedFiles === 0
      // A provider that reports no tokens (Cursor) has no size to call small; only "changed nothing" counts.
      const sizeUnknown = tokens === 0 && !providerReportsTokens(input.provider)
      if (!noChanges && (sizeUnknown || tokens >= SMALL_TASK_TOKENS)) return
      const lighter = this.deps.models.defaultFor(input.provider)
      if (lighter === undefined || lighter.model === input.model) return
      const read = this.deps.fileReads.distinctFiles(input.sessionId, input.agentKey)
      const changed = input.changedFiles
      const did = [
        `read ${plural(read, 'file')}`,
        changed === null ? undefined : changed === 0 ? 'changed none' : `changed ${changed}`
      ]
        .filter((p) => p !== undefined)
        .join(' and ')
      const text = noChanges
        ? `${input.label} used ${modelName(input.provider, input.model)} for a task that ${did}.`
        : `${input.label} used ${modelName(input.provider, input.model)} for a small task (${compactTokens(tokens)} tokens) that ${did}.`
      this.save({
        kind: 'model_too_strong',
        sessionId: input.sessionId,
        agentKey: input.agentKey,
        workerId: input.workerId,
        dedupeKey: `model-too-strong|${input.sessionId}|${input.agentKey}`,
        text,
        advice: `${modelName(input.provider, lighter.model)} would likely do.`,
        params: {
          worker: input.label,
          model: input.model,
          suggestedModel: lighter.model,
          tokens,
          filesRead: read,
          filesChanged: changed
        }
      })
    })
  }

  /** A turn was recorded: checks the session's setup overhead and the agent's conversation size. */
  onTurn(input: TurnRecorded): void {
    this.safely(() => {
      this.checkSetup(input.sessionId)
      this.checkLongRunning(input)
    })
  }

  /** An agent read a file (a normalized path): counts it and checks for repeated work. */
  onRead(agent: SuggestionAgent, path: string): void {
    this.safely(() => {
      this.labels.set(`${agent.sessionId}|${agent.agentKey}`, agent.label)
      this.deps.fileReads.bump(agent.sessionId, agent.agentKey, path, this.deps.now())
      const hit = this.deps.fileReads
        .repeated(agent.sessionId, REPEATED_READS)
        .find((r) => r.path === path)
      if (!hit) return
      const names = hit.agentKeys.map((key) => this.labelOf(agent.sessionId, key))
      const who = joinNames(names)
      const verb = names.length === 1 ? 'read' : 'both read'
      this.save({
        kind: 'repeated_work',
        sessionId: agent.sessionId,
        dedupeKey: `repeated-work|${agent.sessionId}|${path}`,
        text:
          names.length === 1
            ? `${upperFirst(who)} ${verb} ${path} ${hit.count} times.`
            : `${upperFirst(who)} ${names.length === 2 ? verb : 'all read'} ${path} (${hit.count} reads in all).`,
        advice:
          names.length === 1
            ? 'Keeping what it needs from the file in a note, instead of reading it again, would save tokens.'
            : 'Having one agent read it and pass on what the others need would save tokens.',
        params: { path, count: hit.count, agents: names }
      })
    })
  }

  /**
   * One suggestion per session: the agents whose measured fixed setup is 30,000 tokens or more per
   * request, worst first. Arc's share is taken over those agents' setup tokens.
   */
  private checkSetup(sessionId: string): void {
    const heavy = this.deps
      .agents(sessionId)
      .flatMap((a) => {
        const perRequest = a.setup.fixedSetupPerRequest
        // A measured setup only: an agent whose provider reports no tokens has none.
        if (a.recording === 'not-reported') return []
        return perRequest !== null && perRequest >= SETUP_PER_REQUEST_TOKENS
          ? [{ agent: a, perRequest }]
          : []
      })
      .sort((x, y) => y.perRequest - x.perRequest)
    const [worst] = heavy
    if (worst === undefined) return
    const setup = heavy.reduce((n, h) => n + h.agent.setup.setupTokens, 0)
    const arc = heavy.reduce((n, h) => n + h.agent.setup.arcSetupTokens, 0)
    const arcPercent = setup > 0 ? Math.round((arc / setup) * 100) : 0
    const figure = compactTokens(worst.perRequest)
    const same = heavy.every((h) => compactTokens(h.perRequest) === figure)
    const names = heavy.map((h) => setupName(h.agent))
    this.save({
      kind: 'setup_overhead',
      sessionId,
      dedupeKey: `setup-overhead|${sessionId}`,
      text: `Setup is ${same ? 'about' : 'up to'} ${figure} tokens per request for ${joinNames(names)} (Arc's additions about ${arcPercent}% of it).`,
      // Integer arithmetic: 24.99% must not round up to the 25% line.
      advice:
        arc * 100 >= setup * ARC_SHARE_PERCENT && setup > 0
          ? 'Fewer knowledge files, a shorter group context or a shorter task description would reduce it.'
          : "Most of it is the CLI's own instructions plus your plugins, skills and MCP servers, which Arc agents load just as the terminal does. Turning off the ones the agents don't need shrinks every request.",
      params: {
        agents: heavy.map((h, i) => ({
          agentKey: h.agent.agentKey,
          label: names[i],
          setupPerRequest: h.perRequest
        })),
        arcPercent,
        setupTokens: setup,
        arcSetupTokens: arc
      }
    })
  }

  private checkLongRunning(input: TurnRecorded): void {
    if (input.maxCallInput <= LONG_CONTEXT_TOKENS) return
    const size = compactTokens(input.maxCallInput)
    const share =
      input.contextWindow !== null && input.contextWindow > 0
        ? Math.round((input.maxCallInput / input.contextWindow) * 100)
        : null
    const brain = input.agentKey === 'brain'
    const subject = brain ? "The brain's conversation" : `${input.label}'s conversation`
    this.save({
      kind: 'long_running',
      sessionId: input.sessionId,
      agentKey: input.agentKey,
      dedupeKey: `long-running|${input.sessionId}|${input.agentKey}`,
      text: `${subject} is now ${size} tokens${share === null ? '' : ` (${share}% of its context window)`}, so each reply costs more.`,
      advice: brain
        ? 'Starting a new session for unrelated work would reduce it.'
        : 'Splitting the task between fresh workers would reduce it.',
      params: {
        agent: input.label,
        maxCallInput: input.maxCallInput,
        contextWindow: input.contextWindow,
        contextShare: share
      }
    })
  }

  private agentTokens(sessionId: string, agentKey: string): number {
    return this.deps.usage
      .sessionPanel(sessionId, null)
      .rows.filter((r) => r.agentKey === agentKey)
      .reduce((n, r) => n + r.tokens.total, 0)
  }

  private labelOf(sessionId: string, agentKey: string): string {
    if (agentKey === 'brain') return 'the brain'
    const seen = this.labels.get(`${sessionId}|${agentKey}`)
    if (seen !== undefined) return seen
    return this.deps.usage.agentLabels(sessionId).get(agentKey)?.label ?? agentKey
  }

  private save(draft: Draft): void {
    const at = this.deps.now()
    this.deps.repo.upsert({
      id: this.deps.newId(),
      kind: draft.kind,
      sessionId: draft.sessionId,
      agentKey: draft.agentKey ?? null,
      workerId: draft.workerId ?? null,
      dedupeKey: draft.dedupeKey,
      text: draft.text,
      advice: draft.advice,
      params: draft.params,
      usageDay: localDay(at),
      createdAt: at
    })
    this.deps.onChanged(draft.sessionId)
  }

  private safely(run: () => void): void {
    try {
      run()
    } catch (error: unknown) {
      this.deps.log?.warn('could not check suggestions', error)
    }
  }
}
