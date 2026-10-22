import { tmpdir } from 'node:os'
import { z } from 'zod'
import {
  buildAgentEnv,
  type ProcessSupervisor,
  type SupervisedProcess
} from '../process-supervisor'
import type { CodexPersonalServer } from '../agent-adapter'
import { CodexRpc } from './codex-rpc'
import { codexRateLimitWindows, rateLimitsSchema } from './codex-types'
import type { RateLimitWindow } from '../agent-events'

/**
 * Lists the models the signed-in Codex account offers (tech spec 2.5) and the user's skills (2.7).
 * It starts a short-lived `codex app-server`, runs `initialize` and `model/list` or `skills/list`,
 * and ends the process again. Both are plain reads, not turns, so no model call is made and
 * nothing is billed.
 */

/** The whole exchange, from spawn to the last answer. */
export const CODEX_PROBE_TIMEOUT_MS = 15_000
const PAGE_LIMIT = 100
/** A server that keeps returning cursors cannot hold the probe open forever. */
const MAX_PAGES = 10
const STOP_GRACE_MS = 1000
const KILL_STEP_MS = 1500

/** The fields of a `model/list` entry that Arc reads. */
export interface CodexModelInfo {
  /** The value for `thread/start.model`. */
  model: string
  displayName: string
  isDefault: boolean
}

const modelListSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string().optional(),
      model: z.string().optional(),
      displayName: z.string().optional(),
      hidden: z.boolean().optional(),
      isDefault: z.boolean().optional()
    })
  ),
  nextCursor: z.string().nullish()
})

/** The fields of a `skills/list` entry that Arc reads. */
export interface CodexSkillInfo {
  name: string
  description: string
  /** The skill's SKILL.md; the `skill` turn input names it. */
  path: string
  scope: string
}

const skillEntrySchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  shortDescription: z.string().optional(),
  path: z.string(),
  scope: z.string().optional(),
  enabled: z.boolean().optional()
})

/** `skills/list` answers one entry per cwd; a flat `skills` list is accepted too. */
const skillListSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      skills: z.array(skillEntrySchema).optional()
    })
  )
})

/**
 * `config/read`: of `mcp_servers` only the server names and, per server, the names of the tools that
 * carry an `approval_mode` of their own are looked at. No other value is read (`env` and headers hold
 * tokens).
 */
const configReadSchema = z.looseObject({
  config: z.looseObject({ mcp_servers: z.record(z.string(), z.unknown()).nullish() })
})

/** The keys of `tools` in one server entry whose value sets an `approval_mode`. */
function toolsWithApprovalMode(entry: unknown): string[] {
  const tools = (entry as { tools?: unknown } | null)?.tools
  if (typeof tools !== 'object' || tools === null || Array.isArray(tools)) return []
  return Object.entries(tools as Record<string, unknown>)
    .filter(([, tool]) => {
      const mode = (tool as { approval_mode?: unknown } | null)?.approval_mode
      return typeof tool === 'object' && tool !== null && typeof mode === 'string'
    })
    .map(([name]) => name)
}

/** The plan windows `account/rateLimits/read` reports, in the shape of a `rate-limit` event. */
export interface CodexRateLimits {
  windows: RateLimitWindow[]
  planType?: string
}

/** Where the plan meters get the Codex limits from. `CodexProbe` is the real one. */
export interface CodexRateLimitSource {
  readRateLimits(): Promise<CodexRateLimits>
}

/** Where the Codex commands get the skills from. `CodexProbe` is the real one. */
export interface CodexSkillSource {
  listSkills(cwds: readonly string[]): Promise<CodexSkillInfo[]>
}

/** Where the registry gets the Codex models from. `CodexProbe` is the real one. */
export interface CodexModelSource {
  listModels(): Promise<CodexModelInfo[]>
}

export interface CodexProbeDeps {
  supervisor: Pick<ProcessSupervisor, 'spawn'>
  /** `CliResolver.codexBinary()`. */
  binary: string
  /** Args placed before `app-server` (tests run a node script this way). */
  binaryArgs?: readonly string[]
  /** `CliResolver.resolvePath()`. */
  resolvePath: () => Promise<string>
  env?: NodeJS.ProcessEnv
  /** Applied last to the child env (tests). */
  extraEnv?: Readonly<Record<string, string>>
  /** Where the process runs; any existing folder will do. Defaults to the temp folder. */
  cwd?: string
  clientVersion?: string
  timeoutMs?: number
  /** Wait after closing stdin before the process group is signalled. */
  stopGraceMs?: number
}

export class CodexProbe implements CodexModelSource, CodexSkillSource, CodexRateLimitSource {
  constructor(private readonly deps: CodexProbeDeps) {}

  /** The visible models, default first. Rejects on a timeout, an early exit or an error answer. */
  listModels(): Promise<CodexModelInfo[]> {
    return this.withServer('Codex did not list its models in time', (rpc) => this.exchange(rpc))
  }

  /** The enabled skills of the user and of the given repositories, once each. No model call is made. */
  listSkills(cwds: readonly string[]): Promise<CodexSkillInfo[]> {
    return this.withServer('Codex did not list its skills in time', async (rpc) => {
      await this.handshake(rpc)
      const reply = skillListSchema.safeParse(await rpc.request('skills/list', { cwds }))
      if (!reply.success) throw new Error('Codex answered skills/list with an unexpected shape')
      const seen = new Set<string>()
      const skills: CodexSkillInfo[] = []
      for (const entry of reply.data.data) {
        for (const skill of entry.skills ?? []) {
          if (skill.enabled === false || skill.name === '' || seen.has(skill.path)) continue
          seen.add(skill.path)
          skills.push({
            name: skill.name,
            description: skill.description ?? skill.shortDescription ?? '',
            path: skill.path,
            scope: skill.scope ?? ''
          })
        }
      }
      return skills
    })
  }

  /** The account's plan limits (`account/rateLimits/read`). A read of the account, not a turn: no model call. */
  readRateLimits(): Promise<CodexRateLimits> {
    return this.withServer('Codex did not report its rate limits in time', async (rpc) => {
      await this.handshake(rpc)
      const reply = rateLimitsSchema.safeParse(await rpc.request('account/rateLimits/read'))
      if (!reply.success) {
        throw new Error('Codex answered account/rateLimits/read with an unexpected shape')
      }
      const { planType } = reply.data.rateLimits
      return {
        windows: codexRateLimitWindows(reply.data.rateLimits),
        ...(typeof planType === 'string' && planType !== '' ? { planType } : {})
      }
    })
  }

  /**
   * The MCP servers in the user's Codex configuration (`config/read`, with the project's layers for
   * `cwd`): each name, and the names of its tools that have an approval mode of their own. The answer
   * holds every server's `env` and tokens, so only those names are taken and the rest is dropped at
   * once; nothing is logged or kept.
   */
  listMcpServers(cwd: string): Promise<CodexPersonalServer[]> {
    return this.withServer('Codex did not read its configuration in time', async (rpc) => {
      await this.handshake(rpc)
      const reply = configReadSchema.safeParse(
        await rpc.request('config/read', { includeLayers: false, cwd })
      )
      if (!reply.success) throw new Error('Codex answered config/read with an unexpected shape')
      return Object.entries(reply.data.config.mcp_servers ?? {}).map(([name, entry]) => ({
        name,
        approvalTools: toolsWithApprovalMode(entry)
      }))
    })
  }

  private async withServer<T>(
    timeoutMessage: string,
    run: (rpc: CodexRpc) => Promise<T>
  ): Promise<T> {
    const baseEnv = this.deps.env ?? process.env
    const path = await this.deps.resolvePath()
    const env = buildAgentEnv(baseEnv, path, this.deps.extraEnv)
    // The user's own CODEX_HOME carries their login, which decides which models are offered.
    const codexHome = baseEnv['CODEX_HOME']
    if (codexHome) env['CODEX_HOME'] = codexHome
    const proc = this.deps.supervisor.spawn({
      command: this.deps.binary,
      args: [...(this.deps.binaryArgs ?? []), 'app-server'],
      cwd: this.deps.cwd ?? tmpdir(),
      env,
      agentId: `codex-probe-${Date.now().toString(36)}`
    })
    const rpc = new CodexRpc(proc, this.deps.timeoutMs ?? CODEX_PROBE_TIMEOUT_MS)
    proc.onLine((line) => rpc.handleLine(line))
    // An ignored request id is answered with an error so the app-server never waits on the probe.
    rpc.onServerRequest((request) => rpc.respondError(request.id, -32601, 'not supported'))
    void proc.exited.then((info) => {
      const reason = info.spawnError?.message ?? info.stderrTail.trim().slice(-300)
      rpc.close(new Error(`Codex exited before answering${reason ? `: ${reason}` : ''}`))
    })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(timeoutMessage)),
        this.deps.timeoutMs ?? CODEX_PROBE_TIMEOUT_MS
      )
    })
    try {
      return await Promise.race([run(rpc), timeout])
    } finally {
      clearTimeout(timer)
      rpc.close()
      await this.stop(proc)
    }
  }

  private async handshake(rpc: CodexRpc): Promise<void> {
    await rpc.request('initialize', {
      clientInfo: { name: 'arc', title: 'Arc', version: this.deps.clientVersion ?? '0' },
      capabilities: { experimentalApi: true }
    })
    rpc.notify('initialized')
  }

  private async exchange(rpc: CodexRpc): Promise<CodexModelInfo[]> {
    await this.handshake(rpc)
    const models: CodexModelInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const reply = modelListSchema.safeParse(
        await rpc.request('model/list', {
          limit: PAGE_LIMIT,
          includeHidden: false,
          ...(cursor !== undefined ? { cursor } : {})
        })
      )
      if (!reply.success) throw new Error('Codex answered model/list with an unexpected shape')
      for (const entry of reply.data.data) {
        const model = entry.model ?? entry.id
        if (model === undefined || model === '' || entry.hidden === true) continue
        models.push({
          model,
          displayName: entry.displayName ?? model,
          isDefault: entry.isDefault === true
        })
      }
      cursor = reply.data.nextCursor ?? undefined
      if (cursor === undefined) break
    }
    return models
  }

  /** Closes stdin, then signals the process group by its pid if Codex is still there. */
  private async stop(proc: SupervisedProcess): Promise<void> {
    proc.expectExit()
    proc.endStdin()
    if (proc.hasExited()) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      proc.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.deps.stopGraceMs ?? STOP_GRACE_MS)
      })
    ])
    clearTimeout(timer)
    if (proc.hasExited()) return
    await proc.killLadder([
      { signal: 'SIGTERM', waitMs: KILL_STEP_MS },
      { signal: 'SIGKILL', waitMs: KILL_STEP_MS }
    ])
  }
}
