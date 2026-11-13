import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildClaudeArgs } from '../../../src/main/agents/claude/claude-adapter'
import { writableRootsFor } from '../../../src/main/agents/codex/codex-config'
import { withAttachmentBlock } from '../../../src/main/attachments/attachment-block'
import { sentAttachmentPath } from '../../../src/main/attachments/attachment-paths'
import { MessageAttachmentsRepo } from '../../../src/main/db/repositories/message-attachments-repo'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { mapCursorModels } from '../../../src/main/agents/cursor/cursor-probe'
import type { CommandCatalogue } from '../../../src/main/agents/command-probe'
import { SessionService } from '../../../src/main/sessions/session-service'
import { BRAIN_MESSAGE_PREFIX } from '../../../src/main/sessions/typed-slash'
import { heldMessageText } from '../../../src/main/sessions/worker-manager'
import { parseWorkerAttachments } from '../../../src/main/attachments/worker-attachments'
import type { CommandInfo } from '../../../src/shared/types/commands'
import type { ProviderStatus, ProviderStatusMap } from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import { claudeRegistry, FakeAdapter, FakeCodexAdapter, FakeCursorAdapter } from './helpers'
import type { FakeHandle } from './helpers'

// Real repositories and several git processes per test: the default 5 s is tight on a loaded machine.
vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-worker-att-')
let e: EngineRig | undefined
const extra: SessionService[] = []

afterEach(async () => {
  for (const s of extra.splice(0)) await s.shutdown()
  await e?.close()
  e = undefined
})

interface Spec {
  id: string
  name: string
  kind?: 'image' | 'pdf' | 'text'
  mime?: string
  /** null: the stored file is missing on disk. */
  content?: string | null
}

const IMG: Spec = {
  id: 'att-img',
  name: 'design.png',
  kind: 'image',
  mime: 'image/png',
  content: 'PNGDATA'
}
const NOTE: Spec = { id: 'att-note', name: 'notes.txt', content: 'hello notes' }

/** One user message with these attachments, their rows and (unless null) their files. */
function seed(rig: EngineRig, sessionId: string, specs: Spec[]): void {
  const message = rig.rig.messagesRepo.append({
    sessionId,
    role: 'user',
    content: 'see these',
    state: 'complete',
    createdAt: 1,
    updatedAt: 1
  } as never)
  new MessageAttachmentsRepo(rig.rig.opened.db).insertMany(
    specs.map((s, position) => ({
      id: s.id,
      messageId: message.id,
      sessionId,
      position,
      kind: s.kind ?? 'text',
      mime: s.mime ?? 'text/plain',
      sizeBytes: (s.content ?? 'x').length,
      name: s.name,
      storedName: s.name,
      createdAt: 10 + position
    }))
  )
  for (const s of specs) {
    if (s.content === null) continue
    const path = sentAttachmentPath(rig.rig.deps.getSessionDir(sessionId), s.id, s.name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, s.content ?? 'x')
  }
}

const attachmentsDir = (rig: EngineRig, sessionId: string): string =>
  join(rig.rig.deps.getSessionDir(sessionId), 'attachments')

const pathOf = (rig: EngineRig, sessionId: string, spec: Spec): string =>
  sentAttachmentPath(rig.rig.deps.getSessionDir(sessionId), spec.id, spec.name)

const refOf = (rig: EngineRig, sessionId: string, spec: Spec) => ({
  id: spec.id,
  name: spec.name,
  kind: spec.kind ?? 'text',
  mime: spec.mime ?? 'text/plain',
  size: (spec.content ?? 'x').length,
  path: pathOf(rig, sessionId, spec)
})

interface Started {
  rig: EngineRig
  sessionId: string
}

async function start(overrides: Parameters<typeof makeEngineRig>[1] = {}): Promise<Started> {
  e = await makeEngineRig(dir(), overrides)
  e.rig.service['deps'].messageAttachmentsRepo = new MessageAttachmentsRepo(e.rig.opened.db)
  const sessionId = await e.startSession('autonomous')
  return { rig: e, sessionId }
}

const task = (extraArgs: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'api-retry',
  task: 'Add retries',
  repos: ['api'],
  ...extraArgs
})

const rowOf = (s: Started, workerId: string) => s.rig.rig.deps.workersRepo.get(workerId)
const workerHandles = (s: Started): FakeHandle[] =>
  s.rig.rig.adapter.handles.filter((h) => h.agentId.startsWith('worker-'))
const lastView = (s: Started, workerId: string) =>
  s.rig.rig
    .of('session:worker-changed')
    .filter((p) => p.worker.id === workerId)
    .at(-1)?.worker

describe('spawn_worker with attachments', () => {
  it('delivers the refs with the first message and stores the list (spawn_worker with attachment ids delivers the refs with the first message)', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [IMG, NOTE])

    const result = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ attachments: ['att-note', 'att-img'] })
    )

    expect(result.isError).toBe(false)
    const handle = s.rig.workerHandle()
    expect(handle.sent).toEqual(['Add retries'])
    expect(handle.sentAttachments).toEqual([
      [refOf(s.rig, s.sessionId, NOTE), refOf(s.rig, s.sessionId, IMG)]
    ])
    expect(
      JSON.parse(rowOf(s, String(result.value['workerId']))?.attachmentsJson ?? 'null')
    ).toEqual([
      { id: 'att-note', name: 'notes.txt', kind: 'text', size: 11 },
      { id: 'att-img', name: 'design.png', kind: 'image', size: 7 }
    ])
  })

  it('sends no refs and stores nothing for a worker spawned without attachments', async () => {
    const s = await start()
    const result = await s.rig.call(s.rig.brain(), 'spawn_worker', task())
    expect(result.isError).toBe(false)
    expect(s.rig.workerHandle().sentAttachments).toEqual([undefined])
    expect(rowOf(s, String(result.value['workerId']))?.attachmentsJson).toBeNull()
    expect(lastView(s, String(result.value['workerId']))).not.toHaveProperty('attachments')
  })

  it('refuses an unknown id, names it, lists the valid ids with names and spawns nothing', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [IMG, NOTE])

    const result = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ attachments: ['att-img', 'att-missing'] })
    )

    expect(result.isError).toBe(true)
    expect(result.value['error']).toBe('unknown_attachment')
    const message = String(result.value['message'])
    expect(message).toContain('"att-missing"')
    expect(message).toContain('att-img (design.png)')
    expect(message).toContain('att-note (notes.txt)')
    expect(s.rig.rig.deps.workersRepo.listBySession(s.sessionId)).toEqual([])
    expect(workerHandles(s)).toEqual([])
    expect(s.rig.rig.deps.worktreesRepo.listBySession(s.sessionId)).toEqual([])
  })

  it('refuses an id that belongs to another session', async () => {
    const s = await start()
    const other = await s.rig.rig.service.create(
      s.rig.rig.groupId,
      'Another one entirely',
      'autonomous',
      3
    )
    if (!('sessionId' in other)) throw new Error('expected a session id')
    seed(s.rig, other.sessionId, [{ id: 'att-foreign', name: 'secret.txt' }])
    seed(s.rig, s.sessionId, [NOTE])

    const result = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ attachments: ['att-foreign'] })
    )

    expect(result.isError).toBe(true)
    expect(result.value['error']).toBe('unknown_attachment')
    expect(String(result.value['message'])).toContain('att-note (notes.txt)')
    expect(String(result.value['message'])).not.toContain('secret.txt')
    expect(workerHandles(s)).toEqual([])
  })

  it('keeps the ref when the stored file is missing on disk and still spawns', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [{ ...NOTE, content: null }])

    const result = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ attachments: ['att-note'] })
    )

    expect(result.isError).toBe(false)
    expect(existsSync(pathOf(s.rig, s.sessionId, NOTE))).toBe(false)
    expect(s.rig.workerHandle().sentAttachments[0]?.map((r) => r.id)).toEqual(['att-note'])
  })

  it('shows the attachments on the worker view the renderer receives', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [IMG])
    const result = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ attachments: ['att-img'] })
    )
    expect(lastView(s, String(result.value['workerId']))?.attachments).toEqual([
      { id: 'att-img', name: 'design.png', kind: 'image', size: 7 }
    ])
  })

  it('reads a damaged stored list as none', async () => {
    const s = await start()
    const result = await s.rig.call(s.rig.brain(), 'spawn_worker', task())
    const workerId = String(result.value['workerId'])
    s.rig.rig.opened.sqlite
      .prepare('update workers set attachments_json = ? where id = ?')
      .run('{broken', workerId)
    await s.rig.rig.service.stepInWorker(workerId)
    expect(lastView(s, workerId)?.attachments ?? []).toEqual([])
  })

  it('starts a queued worker later with the same refs', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [IMG])
    s.rig.rig.service.setConfig(s.sessionId, { workerLimit: 1 })
    const first = await s.rig.call(s.rig.brain(), 'spawn_worker', task({ name: 'first' }))
    const second = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ name: 'second', attachments: ['att-img'] })
    )
    expect(second.value['status']).toBe('queued')
    expect(workerHandles(s)).toHaveLength(1)
    expect(rowOf(s, String(second.value['workerId']))?.attachmentsJson).not.toBeNull()

    const handle = s.rig.workerHandle(0)
    await s.rig.call(handle, 'report_done', { summary: 'ok' })
    handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => workerHandles(s).length === 2)

    const queued = workerHandles(s)[1] as FakeHandle
    expect(queued.sent).toEqual(['Add retries'])
    expect(queued.sentAttachments).toEqual([[refOf(s.rig, s.sessionId, IMG)]])
    expect(String(first.value['workerId'])).not.toBe('')
  })

  it('records dependsOn without delaying the start, and the refs go with the first message', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [NOTE])
    const first = await s.rig.call(s.rig.brain(), 'spawn_worker', task({ name: 'first' }))
    await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({
        name: 'after',
        dependsOn: [String(first.value['workerId'])],
        attachments: ['att-note']
      })
    )
    expect(s.rig.workerHandle(1).sentAttachments).toEqual([[refOf(s.rig, s.sessionId, NOTE)]])
  })

  it('carries the attachments through a plan-first session: spawn_worker after approval', async () => {
    e = await makeEngineRig(dir())
    e.rig.service['deps'].messageAttachmentsRepo = new MessageAttachmentsRepo(e.rig.opened.db)
    const sessionId = await e.startSession('plan_first')
    seed(e, sessionId, [IMG])
    const spawn = (): ReturnType<EngineRig['call']> =>
      (e as EngineRig).call(
        (e as EngineRig).brain(),
        'spawn_worker',
        task({ attachments: ['att-img'] })
      )

    const refused = await spawn()
    expect(refused.value['error']).toBe('plan_not_approved')
    expect(workerHandles({ rig: e, sessionId })).toEqual([])

    const proposed = e.call(e.brain(), 'propose_plan', {
      workers: [
        { name: 'api-retry', task: 'Add retries', repos: ['api'], rationale: 'Independent.' }
      ]
    })
    await until(() => (e?.rig.deps.plansRepo.listBySession(sessionId).length ?? 0) > 0)
    const plan = e.rig.deps.plansRepo.listBySession(sessionId)[0]
    e.rig.service.decidePlan(sessionId, plan?.id ?? '', 'approve')
    await proposed

    const approved = await spawn()
    expect(approved.isError).toBe(false)
    expect(e.workerHandle().sentAttachments).toEqual([[refOf(e, sessionId, IMG)]])
    expect(
      parseWorkerAttachments(
        rowOf({ rig: e, sessionId }, String(approved.value['workerId']))?.attachmentsJson ?? null
      )
    ).toHaveLength(1)
  })
})

describe('a worker that runs a command', () => {
  const spec: CommandInfo = {
    id: 'claude:awos:spec',
    provider: 'claude',
    kind: 'command',
    name: 'awos:spec',
    description: 'Spec',
    source: 'repo:api'
  }

  it('keeps the command as its first message and gets the attachment block in its instructions', async () => {
    const list = vi.fn<CommandCatalogue['list']>(() => Promise.resolve([spec]))
    const s = await start({ commands: { list } })
    seed(s.rig, s.sessionId, [IMG])

    const result = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ command: '/awos:spec retry', attachments: ['att-img'] })
    )

    expect(result.isError).toBe(false)
    const handle = s.rig.workerHandle()
    expect(handle.sent).toEqual(['/awos:spec retry'])
    expect(handle.sentAttachments).toEqual([undefined])
    const instructions = s.rig.rig.adapter.starts.find(
      (x) => x.agentId === handle.agentId
    )?.instructions
    expect(instructions).toContain('[Attachments for this message]')
    expect(instructions).toContain('Open a listed file when the request depends on it')
    expect(instructions).toContain(pathOf(s.rig, s.sessionId, IMG))
  })
})

describe('message_worker with attachments', () => {
  it('delivers the refs with the prefixed text and adds them to the stored list by id', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [IMG, NOTE])
    const spawned = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ attachments: ['att-img'] })
    )
    const workerId = String(spawned.value['workerId'])
    const handle = s.rig.workerHandle()

    const sent = await s.rig.call(s.rig.brain(), 'message_worker', {
      workerId: 'W1',
      text: 'also read this',
      attachments: ['att-note', 'att-img']
    })

    expect(sent).toMatchObject({ isError: false, value: { delivered: true } })
    expect(handle.sent.at(-1)).toBe(`${BRAIN_MESSAGE_PREFIX}also read this`)
    expect(handle.sentAttachments.at(-1)).toEqual([
      refOf(s.rig, s.sessionId, NOTE),
      refOf(s.rig, s.sessionId, IMG)
    ])
    expect(
      parseWorkerAttachments(rowOf(s, workerId)?.attachmentsJson ?? null).map((a) => a.id)
    ).toEqual(['att-img', 'att-note'])
    expect(lastView(s, workerId)?.attachments?.map((a) => a.id)).toEqual(['att-img', 'att-note'])
  })

  it('refuses an unknown id, lists the valid ones, and sends nothing', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [NOTE])
    await s.rig.call(s.rig.brain(), 'spawn_worker', task())
    const handle = s.rig.workerHandle()
    const before = handle.sent.length

    const result = await s.rig.call(s.rig.brain(), 'message_worker', {
      workerId: 'W1',
      text: 'hi',
      attachments: ['nope']
    })

    expect(result.isError).toBe(true)
    expect(result.value['error']).toBe('unknown_attachment')
    expect(String(result.value['message'])).toContain('att-note (notes.txt)')
    expect(handle.sent).toHaveLength(before)
  })

  it('keeps a held message with its attachment block and delivers it at the hand-back', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [IMG])
    const spawned = await s.rig.call(s.rig.brain(), 'spawn_worker', task())
    const workerId = String(spawned.value['workerId'])
    const handle = s.rig.workerHandle()
    await s.rig.rig.service.stepInWorker(workerId)
    const before = handle.sent.length

    const held = await s.rig.call(s.rig.brain(), 'message_worker', {
      workerId: 'W1',
      text: 'use this mock-up',
      attachments: ['att-img']
    })

    expect(held).toMatchObject({ isError: false, value: { delivered: false, queued: true } })
    expect(handle.sent).toHaveLength(before)
    const body = withAttachmentBlock('use this mock-up', [refOf(s.rig, s.sessionId, IMG)])
    expect(s.rig.rig.deps.heldMessagesRepo.listUndelivered(workerId).map((m) => m.body)).toEqual([
      body
    ])
    expect(body).toContain(pathOf(s.rig, s.sessionId, IMG))
    expect(
      parseWorkerAttachments(rowOf(s, workerId)?.attachmentsJson ?? null).map((a) => a.id)
    ).toEqual(['att-img'])

    await s.rig.rig.service.handBackWorker(workerId)

    expect(handle.sent.slice(before).join('\n')).toContain(heldMessageText(body))
    expect(s.rig.rig.deps.heldMessagesRepo.listUndelivered(workerId)).toEqual([])
  })
})

describe('a worker that is resumed', () => {
  async function relaunch(): Promise<{ service: SessionService; adapter: FakeAdapter }> {
    if (!e) throw new Error('rig')
    await e.rig.service.shutdown()
    const adapter = new FakeAdapter()
    const service = new SessionService({ ...e.rig.deps, registry: claudeRegistry(adapter) })
    extra.push(service)
    return { service, adapter }
  }

  it('is not sent its attachments again, and still has the folder', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [IMG])
    const spawned = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ attachments: ['att-img'] })
    )
    const workerId = String(spawned.value['workerId'])
    s.rig.workerHandle().emit({
      type: 'session',
      providerSessionId: 'claude-w1',
      model: 'claude-sonnet-5-5',
      mcpServers: [{ name: 'arc', status: 'connected' }]
    })
    await until(() => rowOf(s, workerId)?.status === 'working')
    const { service, adapter } = await relaunch()

    await service.continueWorker(workerId)

    const started = adapter.starts[0]
    expect(started?.resume?.threadId).toBe('claude-w1')
    const handle = adapter.handles[0] as FakeHandle
    expect(handle.sent).toEqual(['You were interrupted. Continue the task.'])
    expect(handle.sentAttachments).toEqual([undefined])
    const folder = attachmentsDir(s.rig, s.sessionId)
    expect(started?.addDirs).toContain(folder)
    expect(started?.readOnlyDirs).toContain(folder)
    expect(parseWorkerAttachments(rowOf(s, workerId)?.attachmentsJson ?? null)).toHaveLength(1)
  })

  it('starts over with its task and the attachments when no session id was stored', async () => {
    const s = await start()
    seed(s.rig, s.sessionId, [NOTE])
    const spawned = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ attachments: ['att-note'] })
    )
    const workerId = String(spawned.value['workerId'])
    expect(rowOf(s, workerId)?.providerSessionId).toBeNull()
    const { service, adapter } = await relaunch()

    await service.continueWorker(workerId)

    expect(adapter.starts[0]?.resume?.threadId).toBeUndefined()
    const handle = adapter.handles[0] as FakeHandle
    expect(handle.sent).toEqual(['Add retries'])
    expect(handle.sentAttachments).toEqual([[refOf(s.rig, s.sessionId, NOTE)]])
  })
})

describe("the session's attachments folder in every worker's launch", () => {
  it('is in addDirs and readOnlyDirs of a Claude worker with no attachments passed, and edits there are denied', async () => {
    const s = await start()
    await s.rig.call(s.rig.brain(), 'spawn_worker', task())
    const start1 = s.rig.rig.adapter.starts.find((x) => x.role === 'worker')
    const folder = attachmentsDir(s.rig, s.sessionId)
    expect(start1?.addDirs).toContain(folder)
    expect(start1?.readOnlyDirs).toContain(folder)
    const args = buildClaudeArgs(start1 as NonNullable<typeof start1>)
    expect(args).toContain('--add-dir')
    expect(args).toContain(folder)
    expect(args).toContain(`Edit(/${folder}/**)`)
    expect(args).toContain(`Write(/${folder}/**)`)
  })

  it('is the same for the worker that is told to ignore it: it is in the policy read-only dirs', async () => {
    const s = await start()
    const spawned = await s.rig.call(s.rig.brain(), 'spawn_worker', task())
    const workers = (
      s.rig.rig.service['orchestrators'] as unknown as Map<
        string,
        { workers: { policyContext: (id: string) => { readOnlyDirs: readonly string[] } } }
      >
    ).get(s.sessionId)?.workers
    expect(workers?.policyContext(String(spawned.value['workerId'])).readOnlyDirs).toContain(
      attachmentsDir(s.rig, s.sessionId)
    )
  })

  const status = (provider: 'codex' | 'cursor'): ProviderStatusMap => ({
    [provider]: { provider, state: 'ok', message: '', checkedAt: 1 } as ProviderStatus
  })

  it('is read only for a Codex worker: not among its writable roots', async () => {
    const codex = new FakeCodexAdapter()
    const models = new ModelRegistry({
      codex: {
        listModels: () =>
          Promise.resolve([{ model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true }])
      },
      status: () => status('codex')
    })
    const s = await start({
      codexAdapter: codex,
      models,
      providers: { get: () => status('codex'), ensureFresh: () => Promise.resolve(undefined) }
    })
    seed(s.rig, s.sessionId, [IMG])
    s.rig.rig.service.setConfig(s.sessionId, { workers: { mode: 'provider', provider: 'codex' } })

    const result = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ attachments: ['att-img'] })
    )

    expect(result.isError).toBe(false)
    const started = codex.starts[0]
    const folder = attachmentsDir(s.rig, s.sessionId)
    expect(started?.addDirs).toContain(folder)
    expect(started?.readOnlyDirs).toContain(folder)
    expect(writableRootsFor(started as NonNullable<typeof started>)).not.toContain(folder)
    expect((codex.handles[0] as FakeHandle).sentAttachments).toEqual([
      [refOf(s.rig, s.sessionId, IMG)]
    ])
  })

  it('is denied for writes in a Cursor worker, and its refs ride with the first message', async () => {
    const cursor = new FakeCursorAdapter()
    const models = new ModelRegistry({
      cursor: {
        listModels: () => Promise.resolve(mapCursorModels([{ modelId: 'default[]', name: 'Auto' }]))
      },
      status: () => status('cursor')
    })
    await models.refresh()
    const s = await start({
      cursorAdapter: cursor,
      models,
      providers: { get: () => status('cursor'), ensureFresh: () => Promise.resolve(undefined) }
    })
    seed(s.rig, s.sessionId, [IMG])
    s.rig.rig.service.setConfig(s.sessionId, { workers: { mode: 'provider', provider: 'cursor' } })

    const result = await s.rig.call(
      s.rig.brain(),
      'spawn_worker',
      task({ attachments: ['att-img'] })
    )

    expect(result.isError).toBe(false)
    const started = cursor.starts[0]
    const folder = attachmentsDir(s.rig, s.sessionId)
    expect(started?.addDirs).toContain(folder)
    expect(started?.readOnlyDirs).toContain(folder)
    const deny = (
      JSON.parse(readFileSync(join(started?.cwd ?? '', '.cursor', 'cli.json'), 'utf8')) as {
        permissions: { deny: string[] }
      }
    ).permissions.deny
    expect(deny.some((d) => d.startsWith('Write(') && d.includes(`${folder}/**`))).toBe(true)
    expect((cursor.handles[0] as FakeHandle).sentAttachments).toEqual([
      [refOf(s.rig, s.sessionId, IMG)]
    ])
  })
})
