import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandCatalogue } from '../../../src/main/agents/command-probe'
import { workerLabel } from '../../../src/main/sessions/worker-label'
import type { CommandInfo } from '../../../src/shared/types/commands'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-command-launch-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

const yours: CommandInfo = {
  id: 'claude:' + 'user:review',
  provider: 'claude',
  kind: 'command',
  name: 'user:review',
  description: 'Review',
  source: 'user'
}
const plugin: CommandInfo = {
  id: 'claude:' + 'superpowers:brainstorming',
  provider: 'claude' as const,
  kind: 'command' as const,
  name: 'superpowers:brainstorming',
  description: 'Brainstorm',
  source: 'plugin:superpowers'
}
const specInApi: CommandInfo = {
  id: 'claude:' + 'awos:spec',
  provider: 'claude',
  kind: 'command',
  name: 'awos:spec',
  description: 'Spec',
  source: 'repo:api'
}

function rigWith(commands: CommandInfo[] | Error): Promise<EngineRig> {
  const list = vi.fn<CommandCatalogue['list']>(() =>
    commands instanceof Error ? Promise.reject(commands) : Promise.resolve(commands)
  )
  return makeEngineRig(dir(), { commands: { list } })
}

async function sendAndRead(rig: EngineRig, sessionId: string, text: string): Promise<string> {
  const brain = rig.brain()
  const before = brain.sent.length
  await rig.rig.service.sendMessage(sessionId, text)
  await until(() => brain.sent.length > before)
  return brain.sent.at(-1) ?? ''
}

describe('command routing', () => {
  it('appends the instruction to a message that starts with a known command', async () => {
    e = await rigWith([yours, plugin, specInApi])
    const id = await e.startSession('autonomous')
    const sent = await sendAndRead(e, id, '/superpowers:brainstorming retry settings')
    expect(sent).toContain('/superpowers:brainstorming retry settings')
    expect(sent).toContain(
      '[Arc] The user ran the command /superpowers:brainstorming with arguments "retry settings".'
    )
    expect(sent).toContain('spawn_worker(command: "/superpowers:brainstorming retry settings")')
    expect(sent).toContain('call ask_user with the repository names as choices')
    expect(sent).not.toContain('saved only in')
    // The conversation keeps what the user typed.
    const last = e.rig.messagesRepo.latest(id, 10).filter((m) => m.role === 'user')
    expect(last.at(-1)?.content).toBe('/superpowers:brainstorming retry settings')
  })

  it('names the repositories that have a repository command', async () => {
    e = await rigWith([specInApi, { ...specInApi, source: 'repo:web' }])
    const id = await e.startSession('autonomous')
    const sent = await sendAndRead(e, id, '/awos:spec')
    expect(sent).toContain('with arguments ""')
    expect(sent).toContain('saved only in the repositories: api, web')
  })

  it.each([
    ['an unknown command', '/nope do it', [yours]],
    ['text that merely mentions a command', 'please run /user:review', [yours]]
  ])('sends %s as an ordinary message', async (_name, text, commands) => {
    e = await rigWith(commands)
    const id = await e.startSession('autonomous')
    expect(await sendAndRead(e, id, text)).toBe(text)
  })

  it('sends the message as it is when the catalogue fails', async () => {
    e = await rigWith(new Error('probe failed'))
    const id = await e.startSession('autonomous')
    expect(await sendAndRead(e, id, '/user:review now')).toBe('/user:review now')
  })

  it('sends the message as it is when the catalogue is too slow', async () => {
    const list = vi.fn<CommandCatalogue['list']>(() => new Promise(() => undefined))
    e = await makeEngineRig(dir(), { commands: { list }, timings: { commandLookupMs: 30 } })
    const id = await e.startSession('autonomous')
    expect(await sendAndRead(e, id, '/user:review now')).toBe('/user:review now')
  })

  it('tells the user a group without repositories cannot run it, and still sends the text', async () => {
    e = await rigWith([yours])
    const id = await e.startSession('autonomous')
    e.rig.opened.sqlite.prepare("update session_projects set membership = 'removed'").run()
    const sent = await sendAndRead(e, id, '/user:review now')
    expect(sent).toBe('/user:review now')
    const system = e.rig.messagesRepo.latest(id, 20).filter((m) => m.role === 'system')
    expect(system.map((m) => m.content)).toContain(
      'Commands run in a repository, and this group has none.'
    )
  })
})

async function spawnWith(
  rig: EngineRig,
  extra: Record<string, unknown>
): ReturnType<EngineRig['call']> {
  return rig.call(rig.brain(), 'spawn_worker', {
    name: 'spec',
    task: 'Write the spec for retry settings',
    repos: ['api'],
    model: 'sonnet',
    ...extra
  })
}

describe('spawn_worker with a command', () => {
  it('persists the command and makes it the first message', async () => {
    e = await rigWith([plugin, specInApi])
    const id = await e.startSession('autonomous')
    const result = await spawnWith(e, { command: '/awos:spec retry settings' })
    expect(result).toMatchObject({ isError: false, value: { status: 'started' } })
    await until(() => e?.rig.adapter.handles.some((h) => h.agentId.startsWith('worker-')) === true)
    const worker = e.workerHandle()
    await until(() => worker.sent.length > 0)
    expect(worker.sent[0]).toBe('/awos:spec retry settings')
    const row = e.rig.deps.workersRepo.listBySession(id)[0]
    expect(row?.command).toBe('/awos:spec retry settings')
    expect(row?.task).toBe('Write the spec for retry settings')
    expect(workerLabel(row as NonNullable<typeof row>)).toBe('W1 · /awos:spec')
    expect(e.rig.service.snapshot(id).workers[0]?.command).toBe('/awos:spec retry settings')
    // The task stays known to the worker through its system prompt.
    const start = e.rig.adapter.starts.find((s) => s.role === 'worker')
    expect(start?.instructions).toContain('Your task: Write the spec for retry settings')
    expect(start?.instructions).toContain('report_done')
  })

  it('starts an ordinary worker with its task as the first message', async () => {
    e = await rigWith([])
    const id = await e.startSession('autonomous')
    await spawnWith(e, {})
    await until(() => e?.rig.adapter.handles.some((h) => h.agentId.startsWith('worker-')) === true)
    await until(() => (e?.workerHandle().sent.length ?? 0) > 0)
    expect(e.workerHandle().sent[0]).toBe('Write the spec for retry settings')
    expect(e.rig.deps.workersRepo.listBySession(id)[0]?.command).toBeNull()
  })

  it('refuses a command that is not in the catalogue', async () => {
    e = await rigWith([yours])
    const id = await e.startSession('autonomous')
    const result = await spawnWith(e, { command: '/awos:spec x' })
    expect(result).toMatchObject({ isError: true, value: { error: 'unknown_command' } })
    expect(e.rig.deps.workersRepo.listBySession(id)).toHaveLength(0)
  })

  it('refuses a repository command in a repository that does not have it', async () => {
    e = await rigWith([specInApi])
    const id = await e.startSession('autonomous')
    const result = await spawnWith(e, { command: '/awos:spec x', repos: ['web'] })
    expect(result).toMatchObject({ isError: true, value: { error: 'command_not_in_repo' } })
    expect(e.rig.deps.workersRepo.listBySession(id)).toHaveLength(0)
    const ok = await spawnWith(e, { command: '/awos:spec x', repos: ['API'] })
    expect(ok.isError).toBe(false)
  })

  it('refuses a command when the catalogue cannot be read', async () => {
    e = await rigWith(new Error('probe failed'))
    await e.startSession('autonomous')
    const result = await spawnWith(e, { command: '/user:review' })
    expect(result).toMatchObject({ isError: true, value: { error: 'unknown_command' } })
  })
})

describe('plan-first with a command', () => {
  const planned = {
    name: 'spec',
    task: 'Write the spec',
    repos: ['api'],
    rationale: '',
    command: '/awos:spec retry settings'
  }

  it('starts only the worker whose command matches the approved entry', async () => {
    e = await rigWith([plugin, specInApi])
    const id = await e.startSession('plan_first')
    const pending = e.call(e.brain(), 'propose_plan', { workers: [planned] })
    await until(() => e?.rig.deps.plansRepo.latest(id)?.status === 'proposed')
    expect(e.rig.service.snapshot(id).plan?.workers[0]?.command).toBe('/awos:spec retry settings')
    e.rig.service.decidePlan(id, e.rig.deps.plansRepo.latest(id)?.id ?? '', 'approve')
    await pending

    const args = { name: 'spec', task: 'Write the spec', repos: ['api'], model: 'sonnet' }
    const none = await e.call(e.brain(), 'spawn_worker', args)
    expect(none.value['error']).toBe('plan_not_approved')
    const other = await e.call(e.brain(), 'spawn_worker', {
      ...args,
      command: '/superpowers:brainstorming'
    })
    expect(other.value['error']).toBe('plan_not_approved')
    const ok = await e.call(e.brain(), 'spawn_worker', {
      ...args,
      command: '/awos:spec retry settings'
    })
    expect(ok).toMatchObject({ isError: false, value: { status: 'started' } })
  })
})
