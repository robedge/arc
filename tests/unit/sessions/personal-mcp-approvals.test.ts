import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerTools } from '../../../src/main/agents/agent-adapter'
import type { CodexApprovalRequest } from '../../../src/main/agents/codex/codex-types'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { McpToolCatalogue } from '../../../src/main/personal/mcp-tool-catalogue'
import type {
  CodexPersonalMcp,
  PersonalLaunchConfig
} from '../../../src/main/personal/personal-config'
import type {
  BypassReport,
  ProviderStatus,
  ProviderStatusMap
} from '../../../src/shared/types/provider'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import type { ToolCallOutcome } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { FakeCodexAdapter } from './helpers'
import type { FakeHandle } from './helpers'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-personal-mcp-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const report: McpServerTools[] = [
  {
    name: 'fig_ma',
    connected: true,
    tools: [
      { name: 'figma_read', readOnly: true, destructive: false },
      { name: 'figma_write', readOnly: false, destructive: false },
      { name: 'figma_other', readOnly: false, destructive: false }
    ]
  }
]

const NO_BYPASS: BypassReport = {
  claudeHookEvents: [],
  codexAllowPrefixes: [],
  codexRulesCovered: 0
}

function personalWith(
  mcp: McpToolCatalogue,
  extra: { bypass?: BypassReport; codex?: CodexPersonalMcp } = {}
): PersonalLaunchConfig & { bypass: ReturnType<typeof vi.fn> } {
  let count = 0
  return {
    mcp,
    claude: vi.fn((request: { arcConfigPath?: string }) => {
      const out = join(dir(), `merged-${++count}.json`)
      if (request.arcConfigPath) copyFileSync(request.arcConfigPath, out)
      return Promise.resolve({ mcpConfigPath: out })
    }),
    codexMcp: vi.fn(() => Promise.resolve(extra.codex ?? { servers: [], degraded: false })),
    bypass: vi.fn(() => Promise.resolve(extra.bypass ?? NO_BYPASS))
  }
}

interface Started {
  rig: EngineRig
  sessionId: string
  worker: FakeHandle
}

async function startClaudeWorker(personal: PersonalLaunchConfig): Promise<Started> {
  e = await makeEngineRig(dir(), { personal })
  const sessionId = await e.startSession('autonomous')
  const started = await e.call(e.brain(), 'spawn_worker', {
    name: 'figma-sync',
    task: 'Sync the file',
    repos: ['api']
  })
  const workerId = String(started.value['workerId'])
  const worker = e.workerHandle()
  worker.emit({
    type: 'session',
    providerSessionId: 'w-claude-1',
    model: 'claude-sonnet-5-5',
    mcpServers: [{ name: 'arc', status: 'connected' }]
  })
  await until(() => e?.rig.deps.workersRepo.get(workerId)?.status === 'working')
  return { rig: e, sessionId, worker }
}

const permission = (
  s: Started,
  tool: string,
  input: Record<string, unknown> = {}
): Promise<ToolCallOutcome> =>
  s.rig.call(s.worker, 'request_permission', { tool_name: tool, input, tool_use_id: 'toolu_1' })

const pending = (s: Started): AttentionRequestRow[] =>
  s.rig.rig.deps.attentionRepo.listPending(s.sessionId)

const events = (s: Started): string[] =>
  s.rig.rig.eventsRepo.latest(s.sessionId, 200).map((x) => x.text)

describe('a Claude worker using a tool of the user’s MCP server', () => {
  it('runs a read-only tool with no row, and sends a tool with no annotation to the brain first', async () => {
    const s = await startClaudeWorker(personalWith(new McpToolCatalogue()))
    s.worker.mcpTools = () => Promise.resolve(report)

    const read = await permission(s, 'mcp__fig_ma__figma_read', { id: '1' })
    expect(read.value).toEqual({ behavior: 'allow', updatedInput: { id: '1' } })
    expect(pending(s)).toEqual([])

    const write = permission(s, 'mcp__fig_ma__figma_write', { id: '1' })
    await until(() => pending(s).length === 1)
    expect(pending(s)[0]).toMatchObject({
      source: 'worker',
      toolName: 'mcp__fig_ma__figma_write',
      category: 'mcp_write',
      mustEscalate: false,
      escalated: false
    })
    s.rig.rig.service.answerAttention((pending(s)[0] as AttentionRequestRow).id, { approve: true })
    expect((await write).value).toEqual({ behavior: 'allow', updatedInput: { id: '1' } })
  })

  it('"Always allow" stores the exact tool: the same tool runs next time, the server’s other tools still ask', async () => {
    const s = await startClaudeWorker(personalWith(new McpToolCatalogue()))
    s.worker.mcpTools = () => Promise.resolve(report)

    const first = permission(s, 'mcp__fig_ma__figma_write', { id: '1' })
    await until(() => pending(s).length === 1)
    s.rig.rig.service.answerAttention((pending(s)[0] as AttentionRequestRow).id, {
      approve: true,
      always: true
    })
    await first
    expect(s.rig.rig.deps.allowRulesRepo.listBySession(s.sessionId)).toMatchObject([
      { category: 'mcp_write', tool: 'mcp__fig_ma__figma_write', prefix: '', folder: null }
    ])
    expect((await permission(s, 'mcp__fig_ma__figma_write', { id: '2' })).value).toMatchObject({
      behavior: 'allow'
    })
    expect(pending(s)).toEqual([])

    void permission(s, 'mcp__fig_ma__figma_other')
    await until(() => pending(s).length === 1)
    expect(pending(s)[0]?.toolName).toBe('mcp__fig_ma__figma_other')
  })

  it('asks for every tool, read-only ones too, when the agent cannot list its servers', async () => {
    const s = await startClaudeWorker(personalWith(new McpToolCatalogue()))
    s.worker.mcpTools = () => Promise.reject(new Error('mcp_status failed'))
    void permission(s, 'mcp__fig_ma__figma_read')
    await until(() => pending(s).length === 1)
    expect(pending(s)[0]).toMatchObject({
      category: 'mcp_write',
      toolName: 'mcp__fig_ma__figma_read'
    })
  })

  it('still lets Arc’s own tools through', async () => {
    const s = await startClaudeWorker(personalWith(new McpToolCatalogue()))
    s.worker.mcpTools = () => Promise.resolve([])
    const own = await permission(s, 'mcp__arc__report_progress', { note: 'x' })
    expect(own.value).toMatchObject({ behavior: 'allow' })
    expect(pending(s)).toEqual([])
  })
})

describe('the brain using a tool of the user’s MCP server', () => {
  it('runs a read-only tool, and sends any other to the user, never to itself', async () => {
    const personal = personalWith(new McpToolCatalogue())
    e = await makeEngineRig(dir(), { personal })
    const sessionId = await e.startSession('autonomous')
    e.brain().mcpTools = () => Promise.resolve(report)
    const ask = (tool: string): Promise<ToolCallOutcome> =>
      e!.call(e!.brain(), 'request_permission', { tool_name: tool, input: {}, tool_use_id: 't' })

    expect((await ask('mcp__fig_ma__figma_read')).value).toMatchObject({ behavior: 'allow' })
    void ask('mcp__fig_ma__figma_write')
    const attention = e.rig.deps.attentionRepo
    await until(() => attention.listPending(sessionId).length === 1)
    expect(attention.listPending(sessionId)[0]).toMatchObject({
      source: 'brain',
      category: 'mcp_write',
      escalated: true
    })
  })
})

describe('the bypass note in the event log', () => {
  const note =
    "Your hooks, Codex rules or Cursor settings can skip some of Arc's approvals. See Settings → Providers."

  it('is written once for a session whose hooks or rules can skip approvals', async () => {
    const personal = personalWith(new McpToolCatalogue(), {
      bypass: {
        claudeHookEvents: ['PreToolUse'],
        codexAllowPrefixes: ['git commit'],
        codexRulesCovered: 2
      }
    })
    const s = await startClaudeWorker(personal)
    await until(() => events(s).includes(note))
    // Starting a worker is not a second chance: the session has its one note.
    expect(events(s).filter((t) => t === note)).toHaveLength(1)
    expect(personal.bypass).toHaveBeenCalledTimes(1)
  })

  it('is not written when nothing can skip approvals', async () => {
    const personal = personalWith(new McpToolCatalogue())
    const s = await startClaudeWorker(personal)
    await until(() => personal.bypass.mock.calls.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(events(s)).not.toContain(note)
  })
})

describe('a Codex worker whose MCP servers could not be listed', () => {
  const elicitation = (server: string): CodexApprovalRequest => ({
    kind: 'mcp-elicitation',
    method: 'mcpServer/elicitation/request',
    requestId: 1,
    agentId: 'w',
    threadId: 't',
    turnId: 'u',
    raw: { serverName: server, message: `Allow the ${server} MCP server to run tool "get"?` },
    item: { type: 'mcpToolCall', id: 'm1', server, tool: 'get', readOnlyHint: true }
  })

  async function codexRig(codexMcp: CodexPersonalMcp): Promise<{
    codex: FakeCodexAdapter
    personal: ReturnType<typeof personalWith>
    sessionId: string
  }> {
    const personal = personalWith(new McpToolCatalogue(), { codex: codexMcp })
    const codex = new FakeCodexAdapter()
    const map = (): ProviderStatusMap => ({
      codex: { provider: 'codex', state: 'ok', message: '', checkedAt: 1 } as ProviderStatus
    })
    const models = new ModelRegistry({
      codex: {
        listModels: () =>
          Promise.resolve([{ model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true }])
      },
      status: map
    })
    await models.refresh()
    e = await makeEngineRig(dir(), {
      codexAdapter: codex,
      models,
      providers: { get: map, ensureFresh: () => Promise.resolve(map().codex) },
      personal
    })
    const sessionId = await e.startSession('autonomous')
    e.rig.service.setConfig(sessionId, { workers: { mode: 'provider', provider: 'codex' } })
    const started = await e.call(e.brain(), 'spawn_worker', {
      name: 'one',
      task: 'Do one',
      repos: ['api']
    })
    expect(started.isError).toBe(false)
    await until(() => codex.starts.length === 1)
    return { codex, personal, sessionId }
  }

  it('says so once in the event log and asks about the read-only call of an unknown server', async () => {
    const { codex, sessionId } = await codexRig({ servers: [], degraded: true })
    const start = codex.starts[0]
    expect(start?.codex.personalMcpServers).toBeUndefined()
    const texts = e!.rig.eventsRepo.latest(sessionId, 200).map((x) => x.text)
    expect(texts.filter((t) => t.includes("couldn't read your Codex MCP servers"))).toHaveLength(1)

    const decided = start?.approvals?.handle(elicitation('trello'), new AbortController().signal)
    const attention = e!.rig.deps.attentionRepo
    await until(() => attention.listPending(sessionId).length === 1)
    expect(attention.listPending(sessionId)[0]).toMatchObject({
      toolName: 'mcp__trello__get',
      category: 'mcp_write'
    })
    e!.rig.service.answerAttention(
      (attention.listPending(sessionId)[0] as AttentionRequestRow).id,
      {
        approve: false
      }
    )
    expect((await decided)?.decision).toBe('decline')
  })

  it('runs a read-only call of a server it did put into prompt mode', async () => {
    const { codex } = await codexRig({
      servers: [{ name: 'trello', approvalTools: ['trello_update_card'] }],
      degraded: false
    })
    const start = codex.starts[0]
    expect(start?.codex).toMatchObject({
      personalMcpServers: ['trello'],
      personalMcpApprovalTools: { trello: ['trello_update_card'] }
    })
    const decided = await start?.approvals?.handle(
      elicitation('trello'),
      new AbortController().signal
    )
    expect(decided).toEqual({ decision: 'accept' })
  })
})
