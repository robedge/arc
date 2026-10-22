import { mkdir } from 'node:fs/promises'
import { z } from 'zod'
import {
  buildAgentEnv,
  type ProcessSupervisor,
  type SupervisedProcess
} from '../process-supervisor'
import { AcpClient } from './acp-client'
import { isForbiddenCursorEnvKey } from './cursor-config'
import {
  ACP_METHOD_NOT_FOUND,
  availableCommandsSchema,
  sessionUpdateParamsSchema,
  type CursorCommand
} from './cursor-types'

/**
 * Lists the models the signed-in Cursor account offers (tech spec 2.6). It starts a short-lived
 * `agent acp`, runs `initialize`, `authenticate` and `session/new` in an empty folder Arc owns, reads
 * `models.availableModels` from the answer, and ends the process. No prompt is sent, so no model call
 * is made and nothing is billed.
 */

/** The whole exchange, from spawn to the last answer. `session/new` alone takes a few seconds. */
export const CURSOR_PROBE_TIMEOUT_MS = 20_000
const STOP_GRACE_MS = 1000
const KILL_STEP_MS = 1500

/** The makers the model chooser groups by. */
export const CURSOR_GROUPS = {
  claude: 'Claude',
  gpt: 'GPT/Codex',
  grok: 'Grok',
  gemini: 'Gemini',
  cursor: 'Cursor',
  other: 'Other'
} as const

/** One model of the account, in the shape the registry caches. */
export interface CursorModelInfo {
  /** The ACP `modelId`, the whole bracketed string (`gpt-5.4-mini[reasoning=medium]`). */
  model: string
  /** `name` plus the parsed parameters ("grok-4.7 · high · fast"); Auto for `default[]`. */
  displayName: string
  isDefault: boolean
  /** The maker. */
  group: string
  /** The name without parameters. */
  base: string
  /** The bracket parameters; absent for a model without any. */
  variant?: string
}

/** Where the registry gets the Cursor models from. `CursorProbe` is the real one. */
export interface CursorModelSource {
  listModels(): Promise<CursorModelInfo[]>
}

const sessionModelsSchema = z.looseObject({
  models: z
    .looseObject({
      currentModelId: z.string().optional(),
      availableModels: z.array(z.looseObject({ modelId: z.string(), name: z.string().optional() }))
    })
    .nullish()
})

/** `grok-4.7[context=256k,fast=true]` into the name and its parameters; `default[]` has none. */
export function splitModelId(modelId: string): {
  name: string
  params: [string, string][]
  /** The text between the brackets, as Cursor wrote it. */
  raw: string
} {
  const open = modelId.indexOf('[')
  if (open === -1 || !modelId.endsWith(']')) return { name: modelId, params: [], raw: '' }
  const raw = modelId.slice(open + 1, -1)
  const params = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part): [string, string] => {
      const eq = part.indexOf('=')
      return eq === -1 ? [part, 'true'] : [part.slice(0, eq).trim(), part.slice(eq + 1).trim()]
    })
  return { name: modelId.slice(0, open), params, raw }
}

/**
 * The parts of the label that follow the name: the effort or reasoning level, then `fast` and
 * `thinking` when switched on. The context size is left out; it does not tell variants apart.
 */
function labelParts(params: readonly [string, string][]): string[] {
  const parts: string[] = []
  for (const [key, value] of params) {
    if (key === 'effort' || key === 'reasoning' || key.endsWith('_effort')) parts.push(value)
  }
  for (const key of ['fast', 'thinking']) {
    if (params.some(([k, v]) => k === key && v === 'true')) parts.push(key)
  }
  return parts
}

/** The maker of a model by its name. Auto and Composer are Cursor's own. */
export function cursorGroupOf(name: string): string {
  const n = name.toLowerCase()
  if (n === 'default' || n === 'auto' || n.startsWith('composer')) return CURSOR_GROUPS.cursor
  if (n.startsWith('claude')) return CURSOR_GROUPS.claude
  if (n.startsWith('gpt') || n.includes('codex') || /^o\d/.test(n)) return CURSOR_GROUPS.gpt
  if (n.startsWith('grok')) return CURSOR_GROUPS.grok
  if (n.startsWith('gemini')) return CURSOR_GROUPS.gemini
  return CURSOR_GROUPS.other
}

/** Maps `session/new.models.availableModels` to the registry's entries. `default[]` is Auto and the default. */
export function mapCursorModels(
  available: readonly { modelId: string; name?: string | undefined }[]
): CursorModelInfo[] {
  const seen = new Set<string>()
  const out: CursorModelInfo[] = []
  for (const entry of available) {
    if (entry.modelId === '' || seen.has(entry.modelId)) continue
    seen.add(entry.modelId)
    const { name: idName, params, raw } = splitModelId(entry.modelId)
    const isDefault = entry.modelId === 'default[]'
    const base = isDefault ? 'Auto' : entry.name && entry.name !== '' ? entry.name : idName
    const parts = isDefault ? [] : labelParts(params)
    out.push({
      model: entry.modelId,
      displayName: [base, ...parts].join(' · '),
      isDefault,
      group: cursorGroupOf(isDefault ? 'default' : idName),
      base,
      ...(raw !== '' ? { variant: raw } : {})
    })
  }
  return out
}

export interface CursorProbeDeps {
  supervisor: Pick<ProcessSupervisor, 'spawn'>
  /** `CliResolver.cursorBinary()`. */
  binary: () => string | undefined | Promise<string | undefined>
  /** Args placed before `acp` (tests run a node script this way). */
  binaryArgs?: readonly string[]
  /** `CliResolver.resolvePath()`. */
  resolvePath: () => Promise<string>
  /** The empty folder Cursor opens its probe session in (`userData/cursor-probe`); created when missing. */
  dir: string
  env?: NodeJS.ProcessEnv
  /** Applied last to the child env (tests). */
  extraEnv?: Readonly<Record<string, string>>
  timeoutMs?: number
  /** Wait after closing stdin before the process group is signalled. */
  stopGraceMs?: number
}

export class CursorProbe implements CursorModelSource {
  private commands: CursorCommand[] = []
  /** Why the process ended before it answered, to report instead of the closed-pipe error. */
  private exitReason: Error | undefined

  constructor(private readonly deps: CursorProbeDeps) {}

  /** The Cursor commands and skills the last probe saw in `available_commands_update` (empty before the first probe). */
  lastCommands(): readonly CursorCommand[] {
    return this.commands
  }

  /** The account's models, Auto first when it is listed. Rejects on a timeout, an early exit or an error answer. */
  async listModels(): Promise<CursorModelInfo[]> {
    const timeoutMs = this.deps.timeoutMs ?? CURSOR_PROBE_TIMEOUT_MS
    this.exitReason = undefined
    const binary = await this.deps.binary()
    if (binary === undefined) throw new Error("Cursor isn't installed.")
    await mkdir(this.deps.dir, { recursive: true })
    const path = await this.deps.resolvePath()
    const baseEnv = this.deps.env ?? process.env
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(buildAgentEnv(baseEnv, path, this.deps.extraEnv))) {
      if (!isForbiddenCursorEnvKey(key)) env[key] = value
    }
    const proc = this.deps.supervisor.spawn({
      command: binary,
      args: [...(this.deps.binaryArgs ?? []), 'acp'],
      cwd: this.deps.dir,
      env,
      agentId: `cursor-probe-${Date.now().toString(36)}`
    })
    const client = new AcpClient(proc, timeoutMs)
    proc.onLine((line) => client.handleLine(line))
    // Nothing the server asks of a client is supported here; an answer keeps it from waiting on the probe.
    client.onServerRequest((request) =>
      client.rejectRequest(request.id, ACP_METHOD_NOT_FOUND, 'not supported')
    )
    client.onNotification((method, params) => this.onNotification(method, params))
    void proc.exited.then((info) => {
      const reason = info.spawnError?.message ?? info.stderrTail.trim().slice(-300)
      client.close()
      this.exitReason = new Error(`Cursor exited before answering${reason ? `: ${reason}` : ''}`)
    })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Cursor did not list its models in time')),
        timeoutMs
      )
    })
    try {
      return await Promise.race([this.exchange(client), timeout])
    } finally {
      clearTimeout(timer)
      client.close()
      await this.stop(proc)
    }
  }

  private async exchange(client: AcpClient): Promise<CursorModelInfo[]> {
    try {
      await client.initialize()
      await client.authenticate()
      const reply = sessionModelsSchema.safeParse(
        await client.newSession({ cwd: this.deps.dir, mcpServers: [] })
      )
      const available = reply.success ? reply.data.models?.availableModels : undefined
      if (!available) throw new Error('Cursor answered session/new without a model list')
      return mapCursorModels(available)
    } catch (error: unknown) {
      throw this.exitReason ?? error
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update') return
    const update = sessionUpdateParamsSchema.safeParse(params)
    if (!update.success || update.data.update.sessionUpdate !== 'available_commands_update') return
    const commands = availableCommandsSchema.safeParse(update.data.update)
    if (commands.success) {
      this.commands = commands.data.availableCommands.map((c) => ({
        name: c.name,
        description: c.description ?? ''
      }))
    }
  }

  /** Closes stdin, then signals the process group by its pid if Cursor is still there. */
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
