import { existsSync, readFileSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AttachmentService } from '../../../src/main/attachments/attachment-service'
import { createStubDialogs } from '../../../src/main/platform/dialogs'
import { ATTACHMENTS_MAX_PER_MESSAGE } from '../../../src/shared/attachments'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()

function setup() {
  const { dialogs, hook } = createStubDialogs()
  const staging = join(dir(), 'staging')
  return { svc: new AttachmentService({ stagingRoot: staging, dialogs }), hook, staging }
}

async function files(n: number, prefix = 'f'): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const p = join(dir(), `${prefix}${i}.txt`)
    await writeFile(p, `body ${i}`)
    out.push(p)
  }
  return out
}

describe('AttachmentService', () => {
  it('stages a file under staging/<draft>/<id>/<stored name> and indexes it', async () => {
    const { svc, staging } = setup()
    const { draftId } = svc.newDraft()
    expect(draftId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const src = join(dir(), 'notes.txt')
    await writeFile(src, 'hello')
    const res = await svc.stagePaths(draftId, [src])
    expect(res.refused).toEqual([])
    const [meta] = res.attachments
    expect(meta).toMatchObject({ name: 'notes.txt', kind: 'text', size: 5 })
    const path = join(staging, draftId, meta!.id, 'notes.txt')
    expect(readFileSync(path, 'utf8')).toBe('hello')
    expect(svc.stagedPath(meta!.id)).toBe(path)
    expect(svc.staged(draftId, [meta!.id, 'missing'])).toEqual([
      { draftId, meta, storedName: 'notes.txt', path }
    ])
    expect(svc.staged('other', [meta!.id])).toEqual([])
  })

  it('stores a sanitised name but displays the original base name', async () => {
    const { svc } = setup()
    const { draftId } = svc.newDraft()
    const src = join(dir(), 'a\tb.txt')
    await writeFile(src, 'x')
    const { attachments } = await svc.stagePaths(draftId, [src])
    expect(attachments[0]!.name).toBe('a\tb.txt')
    expect(svc.staged(draftId, [attachments[0]!.id])[0]!.storedName).toBe('ab.txt')
  })

  it('accepts some and refuses others in one call', async () => {
    const { svc } = setup()
    const { draftId } = svc.newDraft()
    const [ok] = await files(1)
    const zip = join(dir(), 'a.zip')
    await writeFile(zip, Buffer.from([0x50, 0x4b, 0, 0]))
    const res = await svc.stagePaths(draftId, [zip, ok!, dir()])
    expect(res.attachments).toHaveLength(1)
    expect(res.refused).toEqual([
      { name: 'a.zip', reason: 'unsupported' },
      { name: expect.any(String), reason: 'folder' }
    ])
  })

  it('refuses files past ten with too_many and keeps earlier ones', async () => {
    const { svc } = setup()
    const { draftId } = svc.newDraft()
    const paths = await files(ATTACHMENTS_MAX_PER_MESSAGE + 2)
    const res = await svc.stagePaths(draftId, paths)
    expect(res.attachments).toHaveLength(10)
    expect(res.refused).toEqual([
      { name: 'f10.txt', reason: 'too_many' },
      { name: 'f11.txt', reason: 'too_many' }
    ])
  })

  it('counts earlier calls and holds the limit across concurrent calls', async () => {
    const { svc } = setup()
    const { draftId } = svc.newDraft()
    const a = await files(6, 'a')
    const b = await files(6, 'b')
    const [r1, r2] = await Promise.all([svc.stagePaths(draftId, a), svc.stagePaths(draftId, b)])
    expect(r1.attachments.length + r2.attachments.length).toBe(10)
    expect(r1.refused.length + r2.refused.length).toBe(2)
    expect(
      svc.staged(
        draftId,
        [...r1.attachments, ...r2.attachments].map((m) => m.id)
      )
    ).toHaveLength(10)
  })

  it('keeps drafts apart', async () => {
    const { svc } = setup()
    const d1 = svc.newDraft().draftId
    const d2 = svc.newDraft().draftId
    await svc.stagePaths(d1, await files(10))
    const res = await svc.stagePaths(d2, await files(1, 'z'))
    expect(res.attachments).toHaveLength(1)
  })

  it('pick stages the chosen files, with no filter', async () => {
    const { svc, hook } = setup()
    const { draftId } = svc.newDraft()
    const [p] = await files(1)
    hook.queueOpenDialog([p!])
    const res = await svc.pick(draftId)
    expect(res.attachments).toHaveLength(1)
    expect(hook.getDialogCalls()).toEqual([{ kind: 'pickFiles', options: { multi: true } }])
  })

  it('pick with a cancelled dialog stages nothing', async () => {
    const { svc, hook } = setup()
    const { draftId } = svc.newDraft()
    hook.queueOpenDialog(null)
    expect(await svc.pick(draftId)).toEqual({ attachments: [], refused: [] })
  })

  it('remove deletes one attachment folder and frees a slot', async () => {
    const { svc, staging } = setup()
    const { draftId } = svc.newDraft()
    const { attachments } = await svc.stagePaths(draftId, await files(2))
    const [first, second] = attachments
    await svc.remove(draftId, first!.id)
    expect(existsSync(join(staging, draftId, first!.id))).toBe(false)
    expect(existsSync(join(staging, draftId, second!.id))).toBe(true)
    expect(svc.stagedPath(first!.id)).toBeUndefined()
    expect(svc.staged(draftId, [second!.id])).toHaveLength(1)
    await svc.remove(draftId, first!.id)
  })

  it('discardDraft deletes the draft folder and forgets it', async () => {
    const { svc, staging } = setup()
    const { draftId } = svc.newDraft()
    const { attachments } = await svc.stagePaths(draftId, await files(2))
    await svc.discardDraft(draftId)
    expect(existsSync(join(staging, draftId))).toBe(false)
    expect(svc.stagedPath(attachments[0]!.id)).toBeUndefined()
    await expect(svc.stagePaths(draftId, await files(1))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })

  it('refuses an unknown draft without creating folders', async () => {
    const { svc, hook, staging } = setup()
    const bad = 'X'.repeat(26)
    await expect(svc.stagePaths(bad, await files(1))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    await expect(svc.pick(bad)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(svc.remove(bad, 'x')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(svc.discardDraft(bad)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(hook.getDialogCalls()).toEqual([])
    expect(existsSync(staging) ? await readdir(staging) : []).toEqual([])
  })
})
