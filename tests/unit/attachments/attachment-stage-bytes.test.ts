import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AttachmentService,
  type MakeThumbnail
} from '../../../src/main/attachments/attachment-service'
import { createStubDialogs } from '../../../src/main/platform/dialogs'
import { ATTACHMENTS_MAX_PER_MESSAGE } from '../../../src/shared/attachments'
import { IMPORT_MAX_BYTES } from '../../../src/shared/limits'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])

/** Writes a placeholder thumb so the tests see what the service keeps. */
const fakeThumb: MakeThumbnail = async (_src, dest) => {
  await writeFile(dest, 'thumb')
  return true
}

function setup(makeThumbnail?: MakeThumbnail) {
  const staging = join(dir(), 'staging')
  const svc = new AttachmentService({
    stagingRoot: staging,
    dialogs: createStubDialogs().dialogs,
    makeThumbnail
  })
  return { svc, staging }
}

describe('stageBytes', () => {
  it('accepts a png as "Pasted image 1" then "Pasted image 2"', async () => {
    const { svc, staging } = setup()
    const { draftId } = svc.newDraft()
    const a = await svc.stageBytes(draftId, PNG)
    const b = await svc.stageBytes(draftId, PNG)
    expect(a.attachments[0]).toMatchObject({
      name: 'Pasted image 1',
      kind: 'image',
      mime: 'image/png',
      size: PNG.length
    })
    expect(b.attachments[0]?.name).toBe('Pasted image 2')
    const first = a.attachments[0]!
    expect(await readdir(join(staging, draftId, first.id))).toEqual(['pasted-image-1.png'])
    expect(svc.staged(draftId, [first.id])[0]?.storedName).toBe('pasted-image-1.png')
  })

  it('keeps counting after a removal so two listed items never share a name', async () => {
    const { svc } = setup()
    const { draftId } = svc.newDraft()
    const a = await svc.stageBytes(draftId, PNG)
    const b = await svc.stageBytes(draftId, PNG)
    await svc.remove(draftId, a.attachments[0]!.id)
    const c = await svc.stageBytes(draftId, PNG)
    expect(c.attachments[0]?.name).toBe('Pasted image 3')
    expect(b.attachments[0]?.name).toBe('Pasted image 2')
    // Another draft starts again at 1.
    const other = svc.newDraft().draftId
    expect((await svc.stageBytes(other, PNG)).attachments[0]?.name).toBe('Pasted image 1')
  })

  it('decides the type by magic bytes and ignores a claimed mime', async () => {
    const { svc, staging } = setup()
    const { draftId } = svc.newDraft()
    const res = await svc.stageBytes(draftId, JPG)
    expect(res.attachments[0]).toMatchObject({ mime: 'image/jpeg' })
    const id = res.attachments[0]!.id
    expect(await readdir(join(staging, draftId, id))).toEqual(['pasted-image-1.jpg'])
  })

  it('refuses bytes that are not an image as unsupported, stages nothing and burns no number', async () => {
    const { svc, staging } = setup()
    const { draftId } = svc.newDraft()
    const res = await svc.stageBytes(draftId, Buffer.from('hello, not a picture'))
    expect(res).toEqual({
      attachments: [],
      refused: [{ name: 'Pasted image 1', reason: 'unsupported' }]
    })
    expect(existsSync(join(staging, draftId))).toBe(false)
    expect((await svc.stageBytes(draftId, PNG)).attachments[0]?.name).toBe('Pasted image 1')
    expect((await svc.stageBytes(draftId, new Uint8Array(0))).refused[0]?.reason).toBe(
      'unsupported'
    )
  })

  it('refuses more than 20 MB as too_large without throwing', async () => {
    const { svc } = setup()
    const { draftId } = svc.newDraft()
    const big = Buffer.alloc(IMPORT_MAX_BYTES + 1)
    PNG.copy(big)
    expect((await svc.stageBytes(draftId, big)).refused).toEqual([
      { name: 'Pasted image 1', reason: 'too_large' }
    ])
    const edge = Buffer.alloc(IMPORT_MAX_BYTES)
    PNG.copy(edge)
    expect((await svc.stageBytes(draftId, edge)).attachments).toHaveLength(1)
  })

  it('refuses the eleventh item as too_many', async () => {
    const { svc } = setup()
    const { draftId } = svc.newDraft()
    for (let i = 0; i < ATTACHMENTS_MAX_PER_MESSAGE; i++) await svc.stageBytes(draftId, PNG)
    const res = await svc.stageBytes(draftId, PNG)
    expect(res.attachments).toEqual([])
    expect(res.refused[0]?.reason).toBe('too_many')
  })

  it('rejects an unknown draft', async () => {
    const { svc } = setup()
    await expect(svc.stageBytes('01HZZZZZZZZZZZZZZZZZZZZZZZ', PNG)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
  })
})

describe('thumbnails', () => {
  it('makes thumb.png next to a pasted image and an image from a path', async () => {
    const { svc, staging } = setup(fakeThumb)
    const { draftId } = svc.newDraft()
    const pasted = (await svc.stageBytes(draftId, PNG)).attachments[0]!
    const src = join(dir(), 'shot.png')
    await writeFile(src, PNG)
    const viaPath = (await svc.stagePaths(draftId, [src])).attachments[0]!
    for (const a of [pasted, viaPath])
      expect(existsSync(join(staging, draftId, a.id, 'thumb.png'))).toBe(true)
  })

  it('makes no thumbnail for a text file', async () => {
    const calls: string[] = []
    const { svc } = setup(async (src) => {
      calls.push(src)
      return true
    })
    const { draftId } = svc.newDraft()
    const src = join(dir(), 'a.txt')
    await writeFile(src, 'x')
    await svc.stagePaths(draftId, [src])
    expect(calls).toEqual([])
  })

  it.each([
    ['returns false', async () => false],
    [
      'throws',
      async () => {
        throw new Error('decode')
      }
    ]
  ])('still stages the image when the resizer %s, with no thumb', async (_label, fn) => {
    const { svc, staging } = setup(fn as MakeThumbnail)
    const { draftId } = svc.newDraft()
    const res = await svc.stageBytes(draftId, PNG)
    expect(res.attachments).toHaveLength(1)
    expect(await readdir(join(staging, draftId, res.attachments[0]!.id))).toEqual([
      'pasted-image-1.png'
    ])
  })

  it('does not let a file named thumb.png collide with the thumbnail', async () => {
    const { svc, staging } = setup(fakeThumb)
    const { draftId } = svc.newDraft()
    const src = join(dir(), 'thumb.png')
    await writeFile(src, PNG)
    const a = (await svc.stagePaths(draftId, [src])).attachments[0]!
    expect((await readdir(join(staging, draftId, a.id))).sort()).toEqual([
      'original-thumb.png',
      'thumb.png'
    ])
  })
})
