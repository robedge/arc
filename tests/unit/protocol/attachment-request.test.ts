import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAttachmentRequest } from '../../../src/main/protocol/attachment-request'
import type {
  AttachmentFacts,
  AttachmentRequestDeps
} from '../../../src/main/protocol/attachment-request'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()
const DRAFT = '01HDRAFTBBBBBBBBBBBBBBBBBB'
const SESSION = '01HSESSNBBBBBBBBBBBBBBBBBB'
const IMG = '01HMAGEBBBBBBBBBBBBBBBBBBB'
const PDF = '01HPDFBBBBBBBBBBBBBBBBBBBB'
const TXT = '01HTEXTBBBBBBBBBBBBBBBBBBB'

type Staged = AttachmentFacts & { draftId: string }
type Sent = AttachmentFacts & { sessionId: string }

function rig(staged: Record<string, Staged>, sent: Record<string, Sent>) {
  const root = dir()
  const stagingRoot = join(root, 'staging')
  const sessionDir = join(root, 'session')
  const deps: AttachmentRequestDeps = {
    stagingRoot,
    getStaged: (id) => staged[id],
    getSent: (id) => sent[id],
    getSessionDir: () => sessionDir
  }
  return { deps, stagingRoot, sessionDir }
}

const png = (storedName = 'shot.png'): AttachmentFacts => ({
  kind: 'image',
  mime: 'image/png',
  storedName
})

async function put(path: string, body = 'x'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
}

const get = (deps: AttachmentRequestDeps, url: string, method = 'GET') =>
  resolveAttachmentRequest({ method, url }, deps)

describe('resolveAttachmentRequest', () => {
  it('serves a staged image with its type and nosniff', async () => {
    const r = rig({ [IMG]: { ...png(), draftId: DRAFT } }, {})
    await put(join(r.stagingRoot, DRAFT, IMG, 'shot.png'))
    const res = await get(r.deps, `arc-attachment://staged/${IMG}`)
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('image/png')
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(res.filePath).toBe(join(r.stagingRoot, DRAFT, IMG, 'shot.png'))
  })

  it('serves a sent image from the session attachments folder, with its stored mime', async () => {
    const r = rig({}, { [IMG]: { ...png('p.jpg'), mime: 'image/jpeg', sessionId: SESSION } })
    await put(join(r.sessionDir, 'attachments', IMG, 'p.jpg'))
    const res = await get(r.deps, `arc-attachment://sent/${IMG}`)
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('image/jpeg')
    expect(res.filePath).toBe(join(r.sessionDir, 'attachments', IMG, 'p.jpg'))
  })

  it('does not find a sent id under staged, or a staged id under sent', async () => {
    const r = rig(
      { [IMG]: { ...png(), draftId: DRAFT } },
      { [PDF]: { ...png(), sessionId: SESSION } }
    )
    expect((await get(r.deps, `arc-attachment://sent/${IMG}`)).status).toBe(404)
    expect((await get(r.deps, `arc-attachment://staged/${PDF}`)).status).toBe(404)
  })

  it.each([
    ['a bad id', 'arc-attachment://staged/not-an-id'],
    ['a path in the id', 'arc-attachment://staged/..%2F..%2Fetc%2Fpasswd'],
    ['a lower-case id', `arc-attachment://staged/${IMG.toLowerCase()}`],
    ['an unknown store', `arc-attachment://other/${IMG}`],
    ['no id', 'arc-attachment://staged/'],
    ['an unknown id', 'arc-attachment://staged/01HNPEBBBBBBBBBBBBBBBBBBBB'],
    ['another scheme', `arc-knowledge://staged/${IMG}`]
  ])('404 for %s', async (_label, url) => {
    const r = rig({ [IMG]: { ...png(), draftId: DRAFT } }, {})
    await put(join(r.stagingRoot, DRAFT, IMG, 'shot.png'))
    expect((await get(r.deps, url)).status).toBe(404)
  })

  it.each(['POST', 'PUT', 'DELETE', 'HEAD'])('405 for %s', async (method) => {
    const r = rig({ [IMG]: { ...png(), draftId: DRAFT } }, {})
    await put(join(r.stagingRoot, DRAFT, IMG, 'shot.png'))
    expect((await get(r.deps, `arc-attachment://staged/${IMG}`, method)).status).toBe(405)
  })

  it('kind pdf is not served', async () => {
    const pdf: Staged = {
      kind: 'pdf',
      mime: 'application/pdf',
      storedName: 'a.pdf',
      draftId: DRAFT
    }
    const txt: Staged = { kind: 'text', mime: 'text/plain', storedName: 'a.txt', draftId: DRAFT }
    const r = rig({ [PDF]: pdf, [TXT]: txt }, {})
    await put(join(r.stagingRoot, DRAFT, PDF, 'a.pdf'))
    await put(join(r.stagingRoot, DRAFT, TXT, 'a.txt'))
    expect((await get(r.deps, `arc-attachment://staged/${PDF}`)).status).toBe(404)
    expect((await get(r.deps, `arc-attachment://staged/${TXT}`)).status).toBe(404)
  })

  it('404 when the file is gone', async () => {
    const r = rig({ [IMG]: { ...png(), draftId: DRAFT } }, {})
    expect((await get(r.deps, `arc-attachment://staged/${IMG}`)).status).toBe(404)
  })

  it('404 for a stored name or draft that would leave the root', async () => {
    const r = rig(
      {
        [IMG]: { ...png('../../../outside.png'), draftId: DRAFT },
        [PDF]: { ...png(), draftId: '..' }
      },
      {}
    )
    await put(join(r.stagingRoot, '..', 'outside.png'))
    await put(join(r.stagingRoot, '..', PDF, 'shot.png'))
    expect((await get(r.deps, `arc-attachment://staged/${IMG}`)).status).toBe(404)
    expect((await get(r.deps, `arc-attachment://staged/${PDF}`)).status).toBe(404)
  })

  it('404 for a symlinked leaf, even one that points inside the root', async () => {
    const r = rig(
      { [IMG]: { ...png(), draftId: DRAFT }, [TXT]: { ...png('l2.png'), draftId: DRAFT } },
      {}
    )
    const outside = join(dir(), 'secret.png')
    await writeFile(outside, 'secret')
    await mkdir(join(r.stagingRoot, DRAFT, IMG), { recursive: true })
    await symlink(outside, join(r.stagingRoot, DRAFT, IMG, 'shot.png'))
    expect((await get(r.deps, `arc-attachment://staged/${IMG}`)).status).toBe(404)
    await put(join(r.stagingRoot, DRAFT, 'real.png'))
    await mkdir(join(r.stagingRoot, DRAFT, TXT), { recursive: true })
    await symlink(join(r.stagingRoot, DRAFT, 'real.png'), join(r.stagingRoot, DRAFT, TXT, 'l2.png'))
    expect((await get(r.deps, `arc-attachment://staged/${TXT}`)).status).toBe(404)
  })

  it('a symlinked thumbnail is never served, the original is', async () => {
    const r = rig({ [IMG]: { ...png(), draftId: DRAFT } }, {})
    const folder = join(r.stagingRoot, DRAFT, IMG)
    await put(join(folder, 'shot.png'))
    const outside = join(dir(), 'secret.png')
    await writeFile(outside, 'secret')
    await symlink(outside, join(folder, 'thumb.png'))
    const res = await get(r.deps, `arc-attachment://staged/${IMG}?thumb=1`)
    expect(res.filePath).toBe(join(folder, 'shot.png'))
  })

  it('?thumb=1 serves thumb.png as image/png, and falls back to the original without one', async () => {
    const r = rig({ [IMG]: { ...png('p.jpg'), mime: 'image/jpeg', draftId: DRAFT } }, {})
    const folder = join(r.stagingRoot, DRAFT, IMG)
    await put(join(folder, 'p.jpg'))
    const without = await get(r.deps, `arc-attachment://staged/${IMG}?thumb=1`)
    expect(without.filePath).toBe(join(folder, 'p.jpg'))
    expect(without.headers['Content-Type']).toBe('image/jpeg')
    await put(join(folder, 'thumb.png'))
    const withThumb = await get(r.deps, `arc-attachment://staged/${IMG}?thumb=1`)
    expect(withThumb.filePath).toBe(join(folder, 'thumb.png'))
    expect(withThumb.headers['Content-Type']).toBe('image/png')
    // Without the query the original is served even when a thumb exists.
    expect((await get(r.deps, `arc-attachment://staged/${IMG}`)).filePath).toBe(
      join(folder, 'p.jpg')
    )
  })

  it('serves a sent thumbnail', async () => {
    const r = rig({}, { [IMG]: { ...png(), sessionId: SESSION } })
    const folder = join(r.sessionDir, 'attachments', IMG)
    await put(join(folder, 'shot.png'))
    await put(join(folder, 'thumb.png'))
    expect((await get(r.deps, `arc-attachment://sent/${IMG}?thumb=1`)).filePath).toBe(
      join(folder, 'thumb.png')
    )
  })
})
