import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentSender } from '../../../src/main/attachments/attachment-send'
import { AttachmentService } from '../../../src/main/attachments/attachment-service'
import {
  EARLIER_ATTACHMENTS_MAX,
  earlierAttachmentsBlock
} from '../../../src/main/attachments/attachment-block'
import type { AttachmentRef } from '../../../src/main/agents/agent-adapter'
import { MessageAttachmentsRepo } from '../../../src/main/db/repositories/message-attachments-repo'
import { ModelRegistry } from '../../../src/main/models/model-registry'
import { createStubDialogs } from '../../../src/main/platform/dialogs'
import type { ProviderStatus, ProviderStatusMap } from '../../../src/shared/types/provider'
import { useTempDir } from '../helpers/temp-dir'
import { until } from './engine-rig'
import { FakeCodexAdapter, makeRig } from './helpers'
import type { FakeHandle, Rig } from './helpers'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-att-handoff-')
let rig: Rig | undefined

afterEach(async () => {
  await rig?.service.shutdown()
  rig?.close()
  rig = undefined
})

const ref = (n: number): AttachmentRef => ({
  id: `ID${String(n).padStart(2, '0')}`,
  name: `file ${n}.txt`,
  kind: 'text',
  mime: 'text/plain',
  size: 100 + n,
  path: `/data/sessions/s1/attachments/ID${String(n).padStart(2, '0')}/file ${n}.txt`
})

describe('earlierAttachmentsBlock', () => {
  it('is empty for no attachments', () => {
    expect(earlierAttachmentsBlock([])).toBe('')
  })

  it('uses the Layer 1 line format under a heading that says "earlier in this session"', () => {
    const block = earlierAttachmentsBlock([ref(1), ref(2)])
    expect(block.split('\n')).toEqual([
      '[Attachments from earlier in this session]',
      'Open a listed file when the request depends on it; do not guess from its name.',
      '- ID01 · file 1.txt · text · 101 bytes · /data/sessions/s1/attachments/ID01/file 1.txt',
      '- ID02 · file 2.txt · text · 102 bytes · /data/sessions/s1/attachments/ID02/file 2.txt'
    ])
  })

  it('keeps the newest, newest last, and says how many older ones were left out', () => {
    const all = Array.from({ length: EARLIER_ATTACHMENTS_MAX + 5 }, (_, i) => ref(i + 1))
    const lines = earlierAttachmentsBlock(all).split('\n')
    expect(lines).toContain('(5 older attachments are not listed.)')
    const entries = lines.filter((l) => l.startsWith('- '))
    expect(entries).toHaveLength(EARLIER_ATTACHMENTS_MAX)
    expect(entries[0]).toContain('ID06')
    expect(entries.at(-1)).toContain('ID35')
  })

  it('says "1 older attachment" in the singular', () => {
    const all = Array.from({ length: EARLIER_ATTACHMENTS_MAX + 1 }, (_, i) => ref(i + 1))
    expect(earlierAttachmentsBlock(all)).toContain('(1 older attachment is not listed.)')
  })
})

const MODELS = [{ model: 'gpt-deep', displayName: 'GPT Deep', isDefault: true }]

async function setup(): Promise<{ codex: FakeCodexAdapter; svc: AttachmentService }> {
  const codex = new FakeCodexAdapter()
  const map = (): ProviderStatusMap => ({
    codex: { provider: 'codex', state: 'ok', message: '', checkedAt: 1 } as ProviderStatus
  })
  const models = new ModelRegistry({
    codex: { listModels: () => Promise.resolve(MODELS) },
    status: map
  })
  await models.refresh()
  rig = await makeRig(dir(), {
    codexAdapter: codex,
    models,
    providers: { get: map, ensureFresh: vi.fn(() => Promise.resolve(map().codex)) }
  })
  const svc = new AttachmentService({
    stagingRoot: join(dir(), 'staging'),
    dialogs: createStubDialogs().dialogs
  })
  const deps = rig.service['deps']
  deps.messageAttachmentsRepo = new MessageAttachmentsRepo(rig.opened.db)
  deps.attachmentSender = new AttachmentSender({
    db: rig.opened.db,
    staging: svc,
    getSessionDir: rig.deps.getSessionDir,
    now: () => Date.now(),
    log: { warn: vi.fn() }
  })
  return { codex, svc }
}

async function reply(sessionId: string, handle: FakeHandle, thread: string, text: string) {
  handle.emit({ type: 'session', providerSessionId: thread, model: 'm', mcpServers: [] })
  handle.emit({ type: 'assistant-message', messageId: `m-${text}`, text })
  handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
  await until(() => rig!.service.snapshot(sessionId).brainState === 'idle')
}

async function attach(svc: AttachmentService, names: string[]) {
  const { draftId } = svc.newDraft()
  const paths = names.map((n) => {
    const p = join(dir(), n)
    writeFileSync(p, `body of ${n}`)
    return p
  })
  const staged = await svc.stagePaths(draftId, paths)
  return { draftId, attachmentIds: staged.attachments.map((a) => a.id) }
}

describe('the brain moves to another provider', () => {
  it('lists the earlier attachments after the recent messages, not the one in the turn itself', async () => {
    const { codex, svc } = await setup()
    const first = await rig!.service.create(
      rig!.groupId,
      'Plan the billing refactor',
      'plan_first',
      3
    )
    if (!('sessionId' in first)) throw new Error('expected a session id')
    const sessionId = first.sessionId
    await until(() => rig!.adapter.starts.length === 1)
    await reply(
      sessionId,
      rig!.adapter.last,
      'claude-thread',
      'Title: Billing\nStart with invoices.'
    )

    await rig!.service.sendMessage(
      sessionId,
      'see these',
      await attach(svc, ['spec.txt', 'rates.txt'])
    )
    await until(() => rig!.adapter.last.sent.length === 2)
    await reply(sessionId, rig!.adapter.last, 'claude-thread', 'Read them.')

    rig!.service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-deep' } })
    await rig!.service.sendMessage(sessionId, 'and this one', await attach(svc, ['new.txt']))
    await until(() => codex.starts.length === 1)
    const handle = codex.handles[0] as FakeHandle
    await until(() => handle.sent.length === 1)
    const text = handle.sent[0] ?? ''

    const sessionDir = rig!.deps.getSessionDir(sessionId)
    const earlier = new MessageAttachmentsRepo(rig!.opened.db)
      .listForSession(sessionId)
      .filter((r) => r.name !== 'new.txt')
    expect(earlier.map((r) => r.name)).toEqual(['spec.txt', 'rates.txt'])
    const heading = text.indexOf('[Attachments from earlier in this session]')
    expect(heading).toBeGreaterThan(text.indexOf('Brain: Read them.'))
    const block = text.slice(heading, text.indexOf('\n\nand this one'))
    const lines = block.split('\n')
    expect(lines[1]).toBe(
      'Open a listed file when the request depends on it; do not guess from its name.'
    )
    expect(lines).toHaveLength(4)
    expect(lines[2]).toBe(
      `- ${earlier[0]!.id} · spec.txt · text · 16 bytes · ${join(sessionDir, 'attachments', earlier[0]!.id, 'spec.txt')}`
    )
    expect(lines[3]).toContain(`${earlier[1]!.id} · rates.txt`)
    // The message sent as the turn carries its own block (added by the adapter); not listed here.
    expect(text).not.toContain('new.txt')
  })

  it('adds nothing when the session has no attachments', async () => {
    const { codex } = await setup()
    const first = await rig!.service.create(
      rig!.groupId,
      'Plan the billing refactor',
      'plan_first',
      3
    )
    if (!('sessionId' in first)) throw new Error('expected a session id')
    const sessionId = first.sessionId
    await until(() => rig!.adapter.starts.length === 1)
    await reply(sessionId, rig!.adapter.last, 'claude-thread', 'Title: Billing\nStart.')
    rig!.service.setConfig(sessionId, { brainModel: { provider: 'codex', model: 'gpt-deep' } })
    await rig!.service.sendMessage(sessionId, 'next')
    await until(() => codex.starts.length === 1)
    const handle = codex.handles[0] as FakeHandle
    await until(() => handle.sent.length === 1)
    expect(handle.sent[0]).toContain('[Arc] The user changed the brain model')
    expect(handle.sent[0]).not.toContain('Attachments from earlier')
  })
})
