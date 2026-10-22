import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_WITHDRAWN,
  type ApprovalHandler,
  type CodexApprovalKind,
  type CodexApprovalRequest,
  type CodexItem,
  type JsonObject
} from '../../../src/main/agents/codex/codex-types'
import type { SessionAllowRuleRow } from '../../../src/main/db/repositories/allow-rules-repo'
import { AttentionRepo } from '../../../src/main/db/repositories/attention-repo'
import {
  AttentionCoordinator,
  answerNote,
  type AttentionHost
} from '../../../src/main/sessions/attention-coordinator'
import { createCodexApprovalHandler, McpCoverage } from '../../../src/main/sessions/codex-approvals'
import type { McpServerTools } from '../../../src/main/agents/agent-adapter'
import { McpToolCatalogue } from '../../../src/main/personal/mcp-tool-catalogue'
import type { BridgeAgent } from '../../../src/main/bridge/types'
import { useTempDir } from '../helpers/temp-dir'
import { makeRig } from './helpers'
import type { Rig } from './helpers'

const dir = useTempDir('arc-codex-approvals-')
const worker: BridgeAgent = { sessionId: '', agentId: 'worker-w1', role: 'worker' }
const brain: BridgeAgent = { sessionId: '', agentId: 'brain', role: 'brain' }

let rig: Rig
let repo: AttentionRepo
let sessionId: string
let wt: string
let coordinator: AttentionCoordinator
let host: AttentionHost
let workerHandler: ApprovalHandler
let brainHandler: ApprovalHandler
const notes: string[] = []
const rules = vi.fn()
const stored: SessionAllowRuleRow[] = []
const events: string[] = []

function makeCoordinator(): AttentionCoordinator {
  let n = 0
  host = {
    sessionId,
    now: () => Date.now(),
    newId: () => `R${(n += 1)}`,
    logEvent: (_kind, text) => events.push(text),
    notifyBrain: (text) => notes.push(text),
    workerOf: () => ({ id: 'w1', number: 1, slug: 'api-retry' }),
    workerLabel: () => 'W1 api-retry',
    policyContext: (workerId) =>
      workerId === null
        ? { worktreeRoots: [], readOnlyDirs: [], cwd: wt }
        : { worktreeRoots: [wt], readOnlyDirs: [], cwd: wt },
    setWorkerStatus: () => undefined,
    isControlled: () => false,
    onBrainWaiting: () => undefined,
    onChanged: () => undefined,
    autoApprove: () => false,
    allowRules: () => stored,
    addAllowRule: (rule) => {
      rules(rule)
      const row = { id: `A${stored.length + 1}`, sessionId, createdAt: 1, ...rule }
      stored.push(row)
      return row
    }
  }
  return new AttentionCoordinator(repo, host)
}

function handlersFor(c: AttentionCoordinator): { w: ApprovalHandler; b: ApprovalHandler } {
  const requestAction: Parameters<typeof createCodexApprovalHandler>[0]['requestAction'] = (
    agent,
    action,
    meta,
    call
  ) =>
    agent.role === 'brain'
      ? c.brainRequestAction(action, meta, call.signal)
      : c.requestAction(agent, action, meta, call.signal)
  return {
    w: createCodexApprovalHandler({ agent: worker, requestAction }),
    b: createCodexApprovalHandler({ agent: brain, requestAction })
  }
}

beforeEach(async () => {
  rig = await makeRig(dir())
  const created = await rig.service.create(rig.groupId, 'Do the thing', 'autonomous', 3)
  if (!('sessionId' in created)) throw new Error('expected a session id')
  sessionId = created.sessionId
  worker.sessionId = sessionId
  brain.sessionId = sessionId
  wt = join(dir(), 'wt')
  mkdirSync(wt, { recursive: true })
  rig.deps.workersRepo.insert({
    id: 'w1',
    sessionId,
    number: 1,
    slug: 'api-retry',
    task: 't',
    projectIdsJson: '[]',
    model: 'sonnet',
    status: 'working',
    activity: null,
    failureReason: null,
    summary: null,
    providerSessionId: null,
    planId: null,
    dependsOnJson: '[]',
    stoppedBy: null,
    createdAt: 1,
    updatedAt: 1
  })
  repo = new AttentionRepo(rig.opened.db)
  notes.length = 0
  events.length = 0
  rules.mockClear()
  stored.length = 0
  coordinator = makeCoordinator()
  const handlers = handlersFor(coordinator)
  workerHandler = handlers.w
  brainHandler = handlers.b
})

afterEach(async () => {
  coordinator.releaseAll()
  await rig.service.shutdown()
  rig.close()
})

function request(
  kind: CodexApprovalKind,
  raw: JsonObject,
  item?: CodexItem,
  id = 1
): CodexApprovalRequest {
  return {
    kind,
    method: `test/${kind}`,
    requestId: id,
    agentId: 'worker-w1',
    threadId: 't1',
    turnId: 'u1',
    raw,
    ...(item ? { item } : {})
  }
}

const command = (script: string, cwd = wt): CodexApprovalRequest =>
  request('command', { command: `/bin/zsh -lc '${script}'`, cwd, itemId: 'c1' })

const never = new AbortController().signal

/** The one stored request, once the handler has created it. */
async function pendingRow(index = 0): Promise<NonNullable<ReturnType<AttentionRepo['get']>>> {
  await vi.waitFor(() => expect(repo.listPending(sessionId).length).toBeGreaterThan(index))
  return repo.listPending(sessionId)[index] as NonNullable<ReturnType<AttentionRepo['get']>>
}

describe('a Codex command approval', () => {
  it('asks the user before a git push, and runs it only after the user approves', async () => {
    const pending = workerHandler.handle(command('git push origin HEAD'), never)
    const row = await pendingRow()
    // the exact command, unwrapped from the shell, with the classifier's reason, waiting for the user
    expect(row).toMatchObject({
      source: 'worker',
      workerId: 'w1',
      kind: 'permission',
      toolName: 'Bash',
      action: 'git push origin HEAD',
      category: 'leaves_machine',
      mustEscalate: true,
      escalated: true,
      route: 'queue',
      status: 'pending'
    })
    expect(JSON.parse(row.toolInputJson ?? '{}')).toEqual({
      command: 'git push origin HEAD',
      cwd: wt
    })
    expect(coordinator.state().count).toBe(1)
    // the brain is told it cannot approve it
    expect(notes[0]).toContain('git push origin HEAD')
    expect(notes[0]).toContain('you cannot approve it')
    let settled = false
    void pending.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)

    coordinator.answer(row.id, { approve: true })
    await expect(pending).resolves.toEqual({ decision: 'accept' })
    expect(repo.get(row.id)).toMatchObject({ status: 'approved', delivered: true })
  })

  it('declines a denied push with the reason, which the adapter steers into the turn', async () => {
    const pending = workerHandler.handle(command('git push origin HEAD'), never)
    const row = await pendingRow()
    coordinator.answer(row.id, { approve: false })
    const decision = await pending
    expect(decision.decision).toBe('decline')
    expect(decision.message).toContain('git push origin HEAD')
    expect(decision.message).toContain('The user denied this request.')
  })

  it('the brain cannot approve a push: resolve_request is refused', async () => {
    const pending = workerHandler.handle(command('git push origin HEAD'), never)
    const row = await pendingRow()
    expect(() =>
      coordinator.resolveRequest(worker, { requestId: row.id, decision: 'approve' })
    ).toThrow(/must go to the user/)
    coordinator.answer(row.id, { approve: false })
    await pending
  })

  it('asks for the other protected kinds too, never answering for the session', async () => {
    for (const [script, category] of [
      ['rm -rf node_modules', 'destructive'],
      ['npm install -g left-pad', 'global_install'],
      ['cp a.txt /opt/app/a.txt', 'outside_worktree']
    ] as const) {
      const pending = workerHandler.handle(command(script), never)
      const row = await pendingRow()
      expect(row.category).toBe(category)
      coordinator.answer(row.id, { approve: true })
      expect(await pending).toEqual({ decision: 'accept' })
    }
  })

  it('accepts a command nothing protects at once: no row, no brain turn', async () => {
    for (const script of ['cat hello.txt', 'ls -la', 'git status', 'echo hi > out.txt']) {
      expect(await workerHandler.handle(command(script), never)).toEqual({ decision: 'accept' })
    }
    expect(repo.listPending(sessionId)).toEqual([])
    expect(notes).toEqual([])
  })

  it('stores a Codex bash request exactly as a Claude one, so the dialog card renders it the same', async () => {
    const codex = workerHandler.handle(command('git push origin HEAD'), never)
    const codexRow = await pendingRow()
    const claude = coordinator.requestPermission(
      worker,
      {
        tool_name: 'Bash',
        input: { command: 'git push origin HEAD', description: 'push' },
        tool_use_id: 'toolu_1'
      },
      never
    )
    const claudeRow = await pendingRow(1)
    for (const field of [
      'source',
      'kind',
      'action',
      'reason',
      'toolName',
      'category',
      'mustEscalate',
      'escalated',
      'route',
      'status'
    ] as const) {
      expect(codexRow[field], field).toEqual(claudeRow[field])
    }
    coordinator.answer(codexRow.id, { approve: false })
    coordinator.answer(claudeRow.id, { approve: false })
    await Promise.all([codex, claude])
  })
})

describe('a Codex file-change approval', () => {
  const fileChange = (
    paths: string[] | null,
    grantRoot: string | null = null
  ): CodexApprovalRequest =>
    request(
      'file-change',
      { itemId: 'f1', reason: null, grantRoot },
      paths === null
        ? undefined
        : { type: 'fileChange', id: 'f1', changes: paths.map((path) => ({ path })) }
    )

  it('accepts a change inside the working copy at once', async () => {
    expect(
      await workerHandler.handle(fileChange([join(wt, 'a.ts'), join(wt, 'b.ts')]), never)
    ).toEqual({
      decision: 'accept'
    })
    expect(repo.listPending(sessionId)).toEqual([])
  })

  it('asks the user about a file outside the working copy', async () => {
    const pending = workerHandler.handle(fileChange([join(wt, 'a.ts'), '/opt/app/x.ts']), never)
    const row = await pendingRow()
    expect(row).toMatchObject({
      toolName: 'Edit',
      category: 'outside_worktree',
      mustEscalate: true,
      action: `Edit ${join(wt, 'a.ts')}, /opt/app/x.ts`
    })
    coordinator.answer(row.id, { approve: false })
    expect((await pending).decision).toBe('decline')
  })

  it('fails closed when it does not know which files change', async () => {
    const pending = workerHandler.handle(fileChange(null), never)
    const row = await pendingRow()
    expect(row.category).toBe('outside_worktree')
    coordinator.answer(row.id, { approve: false })
    await pending
    // even a grant root inside the working copy asks
    const second = workerHandler.handle(fileChange(null, wt), never)
    expect((await pendingRow()).category).toBe('outside_worktree')
    coordinator.answer((await pendingRow()).id, { approve: false })
    await second
  })

  it('stores a single changed file the way a Claude Edit is stored', async () => {
    const pending = workerHandler.handle(fileChange(['/opt/app/x.ts']), never)
    const row = await pendingRow()
    expect(JSON.parse(row.toolInputJson ?? '{}')).toEqual({ file_path: '/opt/app/x.ts' })
    coordinator.answer(row.id, { approve: false })
    await pending
  })
})

describe('a Codex permissions approval', () => {
  const permissions = request('permissions', {
    reason: 'write the build output',
    cwd: wt,
    permissions: { fileSystem: { read: null, write: ['/opt/out'] }, network: { enabled: true } }
  })

  it('asks the user, and only the user: the brain is never given it to approve', async () => {
    const pending = workerHandler.handle(permissions, never)
    const row = await pendingRow()
    expect(row).toMatchObject({
      toolName: 'CodexPermissions',
      category: 'extra_permissions',
      mustEscalate: true,
      escalated: true,
      action: 'Extra access: write the build output'
    })
    expect(JSON.parse(row.toolInputJson ?? '{}')).toEqual({
      reason: 'write the build output',
      fileSystem: { write: ['/opt/out'] },
      network: true
    })
    coordinator.answer(row.id, { approve: true })
    expect(await pending).toEqual({ decision: 'accept' })
  })

  it('never turns "always allow" into a rule: extra access is decided each time', async () => {
    const pending = workerHandler.handle(permissions, never)
    const row = await pendingRow()
    coordinator.answer(row.id, { approve: true, always: true })
    expect(await pending).toEqual({ decision: 'accept' })
    expect(rules).not.toHaveBeenCalled()
    // the next request asks again
    const again = workerHandler.handle(permissions, never)
    expect((await pendingRow()).id).not.toBe(row.id)
    coordinator.answer((await pendingRow()).id, { approve: false })
    await again
  })

  it('declines when the user refuses', async () => {
    const pending = workerHandler.handle(permissions, never)
    coordinator.answer((await pendingRow()).id, { approve: false })
    expect((await pending).decision).toBe('decline')
  })
})

describe('a Codex MCP tool approval', () => {
  const elicitation = (readOnlyHint?: boolean): CodexApprovalRequest =>
    request(
      'mcp-elicitation',
      { serverName: 'figma', message: 'Allow the figma MCP server to run tool "set_node"?' },
      {
        type: 'mcpToolCall',
        id: 'm1',
        server: 'figma',
        tool: 'set_node',
        arguments: { id: '1:2' },
        ...(readOnlyHint === undefined ? {} : { readOnlyHint })
      }
    )

  it('runs a tool that says it only reads, with no row', async () => {
    expect(await workerHandler.handle(elicitation(true), never)).toEqual({ decision: 'accept' })
    expect(repo.listPending(sessionId)).toEqual([])
  })

  it.each([
    ['changes something', false],
    ['has no annotation', undefined]
  ])('asks the brain first when the tool %s', async (_name, hint) => {
    const pending = workerHandler.handle(elicitation(hint), never)
    const row = await pendingRow()
    expect(row).toMatchObject({
      toolName: 'mcp__figma__set_node',
      category: 'mcp_write',
      mustEscalate: false,
      escalated: false
    })
    expect(JSON.parse(row.toolInputJson ?? '{}')).toEqual({ id: '1:2' })
    expect(notes[0]).toContain('resolve_request')
    coordinator.resolveRequest(
      { sessionId, agentId: 'brain', role: 'brain' },
      { requestId: row.id, decision: 'approve' }
    )
    expect(await pending).toEqual({ decision: 'accept' })
  })

  it('goes to the user when the brain does not answer or passes it on', async () => {
    const pending = workerHandler.handle(elicitation(false), never)
    const row = await pendingRow()
    coordinator.escalateToUser(
      { sessionId, agentId: 'brain', role: 'brain' },
      { requestId: row.id, reason: 'not sure' }
    )
    expect(coordinator.state().count).toBe(1)
    coordinator.answer(row.id, { approve: false })
    expect((await pending).decision).toBe('decline')
  })
})

describe('a Codex MCP tool approval decided with the catalogue and the covered servers', () => {
  const elicitation = (server: string, readOnlyHint: boolean): CodexApprovalRequest =>
    request(
      'mcp-elicitation',
      { serverName: server, message: `Allow the ${server} MCP server to run tool "get_file"?` },
      { type: 'mcpToolCall', id: 'm1', server, tool: 'get_file', readOnlyHint }
    )

  function handlerWith(
    covered: string[],
    tools: McpServerTools[] | Error
  ): { handler: ApprovalHandler; cover: McpCoverage } {
    const catalogue = new McpToolCatalogue()
    catalogue.attach(worker.agentId, () =>
      tools instanceof Error ? Promise.reject(tools) : Promise.resolve(tools)
    )
    const cover = new McpCoverage()
    cover.servers = new Set(covered)
    const requestAction: Parameters<typeof createCodexApprovalHandler>[0]['requestAction'] = (
      agent,
      action,
      meta,
      call
    ) => coordinator.requestAction(agent, action, meta, call.signal)
    return {
      handler: createCodexApprovalHandler({
        agent: worker,
        requestAction,
        mcp: catalogue,
        covered: cover
      }),
      cover
    }
  }

  it('runs a read-only tool of a server Arc put into prompt mode, with no row', async () => {
    const { handler } = handlerWith(
      ['figma'],
      [
        {
          name: 'figma',
          connected: true,
          tools: [{ name: 'get_file', readOnly: true, destructive: false }]
        }
      ]
    )
    expect(await handler.handle(elicitation('figma', true), never)).toEqual({ decision: 'accept' })
    expect(repo.listPending(sessionId)).toEqual([])
  })

  it('asks about a read-only tool that is also destructive', async () => {
    const { handler } = handlerWith(
      ['figma'],
      [
        {
          name: 'figma',
          connected: true,
          tools: [{ name: 'get_file', readOnly: true, destructive: true }]
        }
      ]
    )
    const pending = handler.handle(elicitation('figma', true), never)
    expect(await pendingRow()).toMatchObject({
      toolName: 'mcp__figma__get_file',
      category: 'mcp_write'
    })
    coordinator.answer((await pendingRow()).id, { approve: false })
    expect((await pending).decision).toBe('decline')
  })

  it('fails closed: when the user’s server list could not be read, a call from an unknown server asks even if it says read-only', async () => {
    const { handler } = handlerWith([], new Error('mcpServerStatus failed'))
    const pending = handler.handle(elicitation('trello', true), never)
    const row = await pendingRow()
    expect(row).toMatchObject({
      toolName: 'mcp__trello__get_file',
      category: 'mcp_write',
      mustEscalate: false
    })
    coordinator.answer(row.id, { approve: true })
    expect(await pending).toEqual({ decision: 'accept' })
  })

  it('asks about a plugin’s server too: Arc could not put it into prompt mode', async () => {
    const { handler } = handlerWith(['figma'], [])
    const pending = handler.handle(elicitation('plugin-server', true), never)
    expect((await pendingRow()).toolName).toBe('mcp__plugin-server__get_file')
    coordinator.answer((await pendingRow()).id, { approve: false })
    expect((await pending).decision).toBe('decline')
  })

  it('stores "always allow" as the exact tool: the next call runs, another tool of the server still asks', async () => {
    const { handler } = handlerWith(['figma'], [])
    const first = handler.handle(elicitation('figma', false), never)
    const row = await pendingRow()
    coordinator.answer(row.id, { approve: true, always: true })
    expect(await first).toEqual({ decision: 'accept' })
    expect(rules).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'mcp__figma__get_file', prefix: '', folder: null })
    )
    expect(await handler.handle(elicitation('figma', false), never)).toEqual({ decision: 'accept' })
    const other = request(
      'mcp-elicitation',
      { serverName: 'figma', message: 'Allow the figma MCP server to run tool "delete_file"?' },
      { type: 'mcpToolCall', id: 'm2', server: 'figma', tool: 'delete_file', readOnlyHint: false }
    )
    const second = handler.handle(other, never)
    const asked = await pendingRow()
    expect(asked.toolName).toBe('mcp__figma__delete_file')
    coordinator.answer(asked.id, { approve: false })
    expect((await second).decision).toBe('decline')
  })
})

describe('the Codex brain', () => {
  it('keeps the brain rules for shell commands: reads run, a push waits for the user', async () => {
    expect(await brainHandler.handle(command('git status'), never)).toEqual({ decision: 'accept' })
    const pending = brainHandler.handle(command('git push origin HEAD'), never)
    const row = await pendingRow()
    expect(row).toMatchObject({ source: 'brain', workerId: null, category: 'leaves_machine' })
    coordinator.answer(row.id, { approve: false })
    expect((await pending).decision).toBe('decline')
  })

  it('always declines edits and permission requests, with no row', async () => {
    const edit = request(
      'file-change',
      {},
      {
        type: 'fileChange',
        id: 'f1',
        changes: [{ path: join(wt, 'a.ts') }]
      }
    )
    const declined = await brainHandler.handle(edit, never)
    expect(declined.decision).toBe('decline')
    expect(declined.message).toContain('The brain cannot use Edit')
    const perm = await brainHandler.handle(
      request('permissions', { reason: 'x', permissions: { network: { enabled: true } } }),
      never
    )
    expect(perm.decision).toBe('decline')
    expect(repo.listPending(sessionId)).toEqual([])
  })
})

describe('the handler never answers with more than one action', () => {
  it('answers Always allow with a one-action accept; the rule stays in Arc and covers the next push', async () => {
    const first = workerHandler.handle(command('git push origin HEAD'), never)
    const row = await pendingRow()
    coordinator.answer(row.id, { approve: true, always: true })
    const decision = await first
    // no session grant and no execpolicy amendment can leave through the decision
    expect(decision).toEqual({ decision: 'accept' })
    expect(Object.keys(decision)).toEqual(['decision'])
    expect(rules).toHaveBeenCalledTimes(1)
    expect(rules.mock.calls[0]?.[0]).toMatchObject({ prefix: 'git push', text: 'git push' })
    // Arc's own rule answers the next push, still as a single accept
    expect(await workerHandler.handle(command('git push origin other'), never)).toEqual({
      decision: 'accept'
    })
    expect(repo.listPending(sessionId)).toEqual([])
  })

  it('maps a refusal that ends the turn to cancel', async () => {
    const handler = createCodexApprovalHandler({
      agent: worker,
      requestAction: () => Promise.resolve({ allow: false, cancelTurn: true })
    })
    expect(await handler.handle(command('git push'), never)).toEqual({ decision: 'cancel' })
  })

  it('declines when the coordinator fails', async () => {
    const handler = createCodexApprovalHandler({
      agent: worker,
      requestAction: () => Promise.reject(new Error('boom'))
    })
    expect(await handler.handle(command('git push'), never)).toEqual({ decision: 'decline' })
  })
})

describe('interrupt and restart', () => {
  it('cancels the stored request when Codex withdraws it (the turn was interrupted)', async () => {
    const controller = new AbortController()
    const pending = workerHandler.handle(command('git push origin HEAD'), controller.signal)
    const row = await pendingRow()
    expect(coordinator.state().count).toBe(1)
    controller.abort(APPROVAL_WITHDRAWN)
    expect((await pending).decision).toBe('decline') // dropped by the adapter, which sees the abort
    expect(repo.get(row.id)).toMatchObject({ status: 'cancelled', delivered: true })
    expect(coordinator.state().count).toBe(0)
    expect(coordinator.undelivered('w1')).toEqual([])
    expect(events.at(-1)).toContain('withdrew a request')
  })

  it('leaves the request pending when the app-server only ended (a quit or a crash)', async () => {
    const controller = new AbortController()
    const pending = workerHandler.handle(command('git push origin HEAD'), controller.signal)
    const row = await pendingRow()
    controller.abort() // no reason: the process went away
    await pending
    expect(repo.get(row.id)).toMatchObject({ status: 'pending', delivered: false })
    expect(coordinator.state().count).toBe(1)
  })

  it('delivers an answer given after the restart as a note, the first turn after the resume', async () => {
    const controller = new AbortController()
    const pending = workerHandler.handle(command('git push origin HEAD'), controller.signal)
    const row = await pendingRow()
    controller.abort() // the quit killed the app-server and its open request
    await pending
    coordinator.releaseAll()

    // Arc starts again: the coordinator is new, the row is still pending in the database
    const restarted = makeCoordinator()
    expect(restarted.state().count).toBe(1)
    restarted.answer(row.id, { approve: true })

    const waiting = restarted.undelivered('w1')
    expect(waiting.map((r) => r.id)).toEqual([row.id])
    expect(waiting.map(answerNote)).toEqual([
      "Your earlier request 'git push origin HEAD' was approved: you may go ahead."
    ])
    restarted.markDelivered(waiting.map((r) => r.id))
    expect(restarted.undelivered('w1')).toEqual([])
    restarted.releaseAll()
  })

  it('tells the worker a denial given after the restart', async () => {
    const controller = new AbortController()
    const pending = workerHandler.handle(command('git push origin HEAD'), controller.signal)
    const row = await pendingRow()
    controller.abort()
    await pending
    coordinator.answer(row.id, { approve: false })
    expect(coordinator.undelivered('w1').map(answerNote)).toEqual([
      "Your earlier request 'git push origin HEAD' was denied: The user denied this request."
    ])
  })
})

describe('Claude requests through the same entry point', () => {
  it('still answer in the permission-prompt shape', async () => {
    const allow = await coordinator.requestPermission(
      worker,
      { tool_name: 'Bash', input: { command: 'ls' } },
      never
    )
    expect(allow).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    const pending = coordinator.requestPermission(
      worker,
      { tool_name: 'Bash', input: { command: 'git push', description: 'd' }, tool_use_id: 't1' },
      never
    )
    const row = await pendingRow()
    expect(JSON.parse(row.toolInputJson ?? '{}')).toEqual({ command: 'git push', description: 'd' })
    coordinator.answer(row.id, { approve: true })
    expect(await pending).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git push', description: 'd' }
    })
  })
})
