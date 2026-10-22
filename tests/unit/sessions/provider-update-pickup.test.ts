import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import type { ProviderStatusMap } from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { until } from './engine-rig'
import { FakeCodexAdapter, makeRig } from './helpers'
import type { FakeHandle, Rig } from './helpers'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-update-pickup-')
let rig: Rig | undefined

afterEach(async () => {
  await rig?.service.shutdown()
  rig?.close()
  rig = undefined
})

const MODELS = [{ model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true }]

/** A rig whose provider versions the test can change, as a Check again would. */
async function setup(): Promise<{
  rig: Rig
  codex: FakeCodexAdapter
  setVersions: (claude: string, codex: string) => void
}> {
  const versions = { claude: '2.1.302', codex: '0.162.1' }
  const map = (): ProviderStatusMap => ({
    claude: {
      provider: 'claude',
      state: 'ok',
      version: versions.claude,
      message: '',
      checkedAt: 1
    },
    codex: { provider: 'codex', state: 'ok', version: versions.codex, message: '', checkedAt: 1 }
  })
  const codex = new FakeCodexAdapter()
  const models = new ModelRegistry({
    codex: { listModels: () => Promise.resolve(MODELS) },
    status: map
  })
  await models.refresh()
  rig = await makeRig(dir(), {
    codexAdapter: codex,
    models,
    providers: { get: map, ensureFresh: () => Promise.resolve(map().codex) }
  })
  return {
    rig,
    codex,
    setVersions: (claude, codexVersion) => {
      versions.claude = claude
      versions.codex = codexVersion
    }
  }
}

async function create(r: Rig): Promise<string> {
  const result = await r.service.create(
    r.groupId,
    'Plan the billing refactor please',
    'plan_first',
    3
  )
  if (!('sessionId' in result)) throw new Error('expected a session id')
  return result.sessionId
}

async function reply(
  r: Rig,
  sessionId: string,
  handle: FakeHandle,
  thread: string,
  text: string
): Promise<void> {
  handle.emit({ type: 'session', providerSessionId: thread, model: 'm', mcpServers: [] })
  handle.emit({ type: 'assistant-message', messageId: `m-${text}`, text })
  handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
  await until(() => r.service.snapshot(sessionId).brainState === 'idle')
}

describe('the brain after a provider tool update', () => {
  it('keeps running while the version is unchanged', async () => {
    const s = await setup()
    const sessionId = await create(s.rig)
    await until(() => s.rig.adapter.starts.length === 1)
    const first = s.rig.adapter.last
    await reply(s.rig, sessionId, first, 'claude-thread', 'Title: Billing\nReady.')

    await s.rig.service.sendMessage(sessionId, 'next')
    await until(() => first.sent.length === 2)
    expect(first.stopped).toBe(false)
    expect(s.rig.adapter.starts).toHaveLength(1)
  })

  it('restarts a Claude brain at its next reply and resumes its thread on the new binary', async () => {
    const s = await setup()
    const sessionId = await create(s.rig)
    await until(() => s.rig.adapter.starts.length === 1)
    const first = s.rig.adapter.last
    await reply(s.rig, sessionId, first, 'claude-thread', 'Title: Billing\nReady.')

    s.setVersions('2.1.310', '0.162.1')
    // Nothing happens between replies: the process is only replaced when the next message arrives.
    expect(first.stopped).toBe(false)

    await s.rig.service.sendMessage(sessionId, 'after the update')
    await until(() => s.rig.adapter.starts.length === 2)
    expect(first.stopped).toBe(true)
    expect(s.rig.adapter.starts[1]).toMatchObject({ resume: { threadId: 'claude-thread' } })
    const second = s.rig.adapter.last
    await until(() => second.sent.length === 1)
    expect(second.sent).toEqual(['after the update'])

    // Started on 2.1.310, so the next reply needs no further restart.
    await reply(s.rig, sessionId, second, 'claude-thread', 'Done.')
    await s.rig.service.sendMessage(sessionId, 'once more')
    await until(() => second.sent.length === 2)
    expect(s.rig.adapter.starts).toHaveLength(2)
  })

  it('waits for the reply in progress before replacing the brain', async () => {
    const s = await setup()
    const sessionId = await create(s.rig)
    await until(() => s.rig.adapter.starts.length === 1)
    const first = s.rig.adapter.last
    first.delta('partial ', 'm1')
    await until(() => s.rig.service.snapshot(sessionId).brainState === 'thinking')

    s.setVersions('2.1.310', '0.162.1')
    expect(first.stopped).toBe(false)

    first.emit({ type: 'session', providerSessionId: 'claude-thread', model: 'm', mcpServers: [] })
    first.emit({ type: 'assistant-message', messageId: 'm1', text: 'Title: Setup\npartial answer' })
    first.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
    await until(() => first.stopped)
  })

  it('restarts a Codex brain on its own provider’s version change and resumes its thread', async () => {
    const s = await setup()
    s.rig.appSettingsRepo.set('providers.brain', { provider: 'codex', model: 'gpt-deep' }, 1)
    const sessionId = await create(s.rig)
    await until(() => s.codex.starts.length === 1)
    const first = s.codex.handles[0] as FakeHandle
    await reply(s.rig, sessionId, first, 'codex-thread', 'Title: Billing\nReady.')

    // Claude updating does not touch a Codex brain.
    s.setVersions('2.1.310', '0.162.1')
    await s.rig.service.sendMessage(sessionId, 'one')
    await until(() => first.sent.length === 2)
    expect(first.stopped).toBe(false)
    await reply(s.rig, sessionId, first, 'codex-thread', 'Fine.')

    s.setVersions('2.1.310', '0.170.0')
    await s.rig.service.sendMessage(sessionId, 'two')
    await until(() => s.codex.starts.length === 2)
    expect(first.stopped).toBe(true)
    expect(s.codex.resumes[0]?.resume).toEqual({ threadId: 'codex-thread' })
  })
})
