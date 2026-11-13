import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sweepOrphanAttachmentFolders } from '../../../src/main/attachments/attachment-cleanup'
import { AttachmentSender } from '../../../src/main/attachments/attachment-send'
import { AttachmentService } from '../../../src/main/attachments/attachment-service'
import { sentAttachmentPath } from '../../../src/main/attachments/attachment-paths'
import { MessageAttachmentsRepo } from '../../../src/main/db/repositories/message-attachments-repo'
import { createStubDialogs } from '../../../src/main/platform/dialogs'
import { resolveAttachmentRequest } from '../../../src/main/protocol/attachment-request'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig } from '../sessions/engine-rig'
import type { EngineRig } from '../sessions/engine-rig'

vi.setConfig({ testTimeout: 30000 })

const dir = useTempDir('arc-att-privacy-')
let e: EngineRig | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
})

/** The file name and a string from the file's contents: neither may reach a log. */
const NAME = 'private-marker-name.txt'
const BODY = 'CONTENT-MARKER-7731'

/** Every argument of every call, errors expanded the way a log file would write them. */
const flat = (calls: unknown[][]): string =>
  JSON.stringify(
    calls.map((args) =>
      args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : a))
    )
  )

type Capture = ((...args: unknown[]) => void) & { mock: { calls: unknown[][] } }

function captured(): { fn: Capture; text: () => string } {
  const fn = vi.fn<(...args: unknown[]) => void>() as unknown as Capture
  return { fn, text: () => flat(fn.mock.calls) }
}

function expectClean(text: string): void {
  expect(text).not.toContain(dir())
  expect(text).not.toContain(NAME)
  expect(text).not.toContain('private-marker')
  expect(text).not.toContain(BODY)
}

describe('no attachment path, name or content reaches a log', () => {
  it('stage, refusal, send, a missing staged file and a copy failure', async () => {
    const log = captured()
    const consoleCalls = captured()
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation(consoleCalls.fn)
    }
    const svc = new AttachmentService({
      stagingRoot: join(dir(), 'staging'),
      dialogs: createStubDialogs().dialogs
    })
    e = await makeEngineRig(dir())
    const repoDb = e.rig
    const sessionsRoot = join(dir(), 'sessions')
    const sender = new AttachmentSender({
      db: repoDb.opened.db,
      staging: svc,
      getSessionDir: (id) => join(sessionsRoot, id),
      now: () => 1,
      log: { warn: log.fn }
    })
    const { draftId } = svc.newDraft()
    const good = join(dir(), NAME)
    writeFileSync(good, BODY)
    const zip = join(dir(), 'private-marker-archive.zip')
    writeFileSync(zip, Buffer.from([0x50, 0x4b, 3, 4, 0, 0]))
    const missing = join(dir(), 'private-marker-gone.txt')
    // Stage: a file, a refusal (binary under a .zip name), a path that does not exist, pasted bytes.
    const staged = await svc.stagePaths(draftId, [good, zip, missing])
    expect(staged.attachments).toHaveLength(1)
    expect(staged.refused.length).toBeGreaterThan(0)
    await svc.stageBytes(draftId, new Uint8Array([1, 2, 3]))
    const ids = staged.attachments.map((a) => a.id)

    // Send with the file missing on disk.
    writeFileSync(svc.stagedPath(ids[0]!)!, BODY)
    const onDisk = svc.stagedPath(ids[0]!)!
    await import('node:fs/promises').then((fs) => fs.rm(onDisk))
    await expect(
      sender.send({ sessionId: 'SA', draftId, ids, message: msg('SA') })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' })

    // Send with the copy failing: a file stands where the attachments folder must be.
    writeFileSync(onDisk, BODY)
    mkdirSync(join(sessionsRoot, 'SB'), { recursive: true })
    writeFileSync(join(sessionsRoot, 'SB', 'attachments'), 'in the way')
    await expect(
      sender.send({ sessionId: 'SB', draftId, ids, message: msg('SB') })
    ).rejects.toMatchObject({ code: 'IO_FAILED' })
    expect(log.fn.mock.calls.length).toBeGreaterThan(0)

    expectClean(log.text())
    expectClean(consoleCalls.text())
    vi.restoreAllMocks()
  })

  it('a send that works', async () => {
    const log = captured()
    e = await makeEngineRig(dir())
    const rig = e.rig
    const sessionId = await e.startSession()
    const svc = new AttachmentService({
      stagingRoot: join(dir(), 'staging'),
      dialogs: createStubDialogs().dialogs
    })
    const sender = new AttachmentSender({
      db: rig.opened.db,
      staging: svc,
      getSessionDir: (id) => join(dir(), 'sessions', id),
      now: () => 1,
      log: { warn: log.fn }
    })
    const { draftId } = svc.newDraft()
    const file = join(dir(), NAME)
    writeFileSync(file, BODY)
    const staged = await svc.stagePaths(draftId, [file])
    const ids = staged.attachments.map((a) => a.id)
    await sender.send({ sessionId, draftId, ids, message: msg(sessionId) })
    expectClean(log.text())
  })

  it('protocol requests, served and refused', async () => {
    const log = captured()
    const staging = join(dir(), 'staging')
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const file = join(staging, 'D1', id, 'shot.png')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, BODY)
    const base = {
      stagingRoot: staging,
      getStaged: (x: string) =>
        x === id
          ? {
              id,
              name: NAME,
              kind: 'image' as const,
              mime: 'image/png',
              size: 5,
              draftId: 'D1',
              storedName: 'shot.png'
            }
          : undefined,
      getSent: () => undefined,
      getSessionDir: (s: string) => join(dir(), 'sessions', s),
      log: { warn: log.fn }
    }
    const ok = await resolveAttachmentRequest(
      { method: 'GET', url: `arc-attachment://staged/${id}` },
      base
    )
    expect(ok.status).toBe(200)
    for (const [method, url] of [
      ['POST', `arc-attachment://staged/${id}`],
      ['GET', 'arc-attachment://staged/not-an-id'],
      ['GET', `arc-attachment://staged/${'0'.repeat(26)}`],
      ['GET', `arc-attachment://sent/${id}`]
    ] as const) {
      expect((await resolveAttachmentRequest({ method, url }, base)).status).not.toBe(200)
    }
    // A lookup that throws an error naming the path and the file.
    const boom = await resolveAttachmentRequest(
      { method: 'GET', url: `arc-attachment://staged/${id}` },
      {
        ...base,
        getStaged: () => {
          throw new Error(`EACCES: permission denied, open '${file}' (${NAME}) ${BODY}`)
        }
      }
    )
    expect(boom.status).toBe(404)
    expect(log.fn.mock.calls.length).toBeGreaterThan(0)
    expectClean(log.text())
  })

  it('the start-up sweep', async () => {
    const log = captured()
    const root = join(dir(), 'sessions')
    mkdirSync(join(root, 'S1', 'attachments', '01ARZ3NDEKTSV4RRFFQ69G5FAV'), { recursive: true })
    await sweepOrphanAttachmentFolders({
      sessionsRoot: root,
      sessionExists: () => true,
      knownIds: () => {
        throw new Error(`failed at ${root} for ${NAME}`)
      },
      now: () => Date.now() + 10 * 60_000,
      log: { warn: log.fn }
    })
    expect(log.fn.mock.calls.length).toBeGreaterThan(0)
    expectClean(log.text())
  })

  it('a worker spawned with attachments, and one refused for an unknown id', async () => {
    const log = {
      info: captured(),
      warn: captured(),
      error: captured()
    }
    e = await makeEngineRig(dir(), {
      log: { info: log.info.fn, warn: log.warn.fn, error: log.error.fn }
    })
    e.rig.service['deps'].messageAttachmentsRepo = new MessageAttachmentsRepo(e.rig.opened.db)
    const sessionId = await e.startSession('autonomous')
    const message = e.rig.messagesRepo.append({
      sessionId,
      role: 'user',
      content: 'see this',
      state: 'complete',
      createdAt: 1,
      updatedAt: 1
    } as never)
    new MessageAttachmentsRepo(e.rig.opened.db).insertMany([
      {
        id: 'att-priv',
        messageId: message.id,
        sessionId,
        position: 0,
        kind: 'text',
        mime: 'text/plain',
        sizeBytes: BODY.length,
        name: NAME,
        storedName: NAME,
        createdAt: 5
      }
    ])
    const path = sentAttachmentPath(e.rig.deps.getSessionDir(sessionId), 'att-priv', NAME)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, BODY)

    const spawned = await e.call(e.brain(), 'spawn_worker', {
      name: 'api-retry',
      task: 'Add retries',
      repos: ['api'],
      attachments: ['att-priv']
    })
    expect(spawned.isError).toBe(false)
    const refused = await e.call(e.brain(), 'spawn_worker', {
      name: 'api-retry-2',
      task: 'Add retries',
      repos: ['api'],
      attachments: ['att-unknown']
    })
    expect(refused.isError).toBe(true)
    for (const l of [log.info, log.warn, log.error]) expectClean(l.text())
  })
})

function msg(sessionId: string) {
  return {
    sessionId,
    role: 'user' as const,
    content: 'hi',
    state: 'complete' as const,
    planId: null,
    createdAt: 1,
    updatedAt: 1
  }
}
