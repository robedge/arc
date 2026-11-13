import { chmod, mkdir, readdir, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AttachmentService } from '../../../src/main/attachments/attachment-service'
import {
  validateAttachment,
  validateImageBytes
} from '../../../src/main/attachments/attachment-validate'
import { createStubDialogs } from '../../../src/main/platform/dialogs'
import { ATTACHMENTS_MAX_PER_MESSAGE } from '../../../src/shared/attachments'
import { IMPORT_MAX_BYTES } from '../../../src/shared/limits'
import { useTempDir } from '../helpers/temp-dir'

// Tech spec 2.4 / functional spec 2.2, rule by rule, for both entry points.
const dir = useTempDir()
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)])
const HEIF = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmif1'), Buffer.alloc(8)])

async function make(name: string, content: Buffer | string): Promise<string> {
  const p = join(dir(), name)
  await writeFile(p, content)
  return p
}

function setup(thumbs: string[] = []) {
  const staging = join(dir(), 'staging')
  const svc = new AttachmentService({
    stagingRoot: staging,
    dialogs: createStubDialogs().dialogs,
    makeThumbnail: async (src) => {
      thumbs.push(src)
      return false
    }
  })
  return { svc, staging, draftId: svc.newDraft().draftId }
}

describe('HEIC and HEIF', () => {
  it.each([
    ['a.heic', HEIC],
    ['a.heif', HEIF],
    ['a.png', HEIC],
    ['a', HEIC]
  ])('refuses %s from a path, by extension or by ftyp magic', async (name, bytes) => {
    expect(await validateAttachment(await make(name, bytes))).toEqual({
      ok: false,
      reason: 'unsupported'
    })
  })
  it('refuses HEIC pasted bytes', () => {
    expect(validateImageBytes(HEIC)).toEqual({ ok: false, reason: 'unsupported' })
    expect(validateImageBytes(HEIF)).toEqual({ ok: false, reason: 'unsupported' })
  })
})

describe('SVG', () => {
  it('is text/plain and never an image, with no thumbnail made', async () => {
    const thumbs: string[] = []
    const { svc, draftId } = setup(thumbs)
    const src = await make('a.SVG', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const res = await svc.stagePaths(draftId, [src])
    expect(res.attachments[0]).toMatchObject({ kind: 'text', mime: 'text/plain' })
    expect(thumbs).toEqual([])
  })
  it('is not accepted as pasted image bytes', () => {
    expect(validateImageBytes(Buffer.from('<svg xmlns="x"></svg>'))).toMatchObject({ ok: false })
  })
})

describe('empty input', () => {
  it('refuses zero-byte files with any extension as unsupported', async () => {
    for (const n of ['e.txt', 'e.png', 'e.pdf', 'e']) {
      expect(await validateAttachment(await make(n, ''))).toEqual({
        ok: false,
        reason: 'unsupported'
      })
    }
  })
  it('refuses zero-length pasted bytes through the service', async () => {
    const { svc, draftId } = setup()
    expect((await svc.stageBytes(draftId, new Uint8Array(0))).refused[0]?.reason).toBe(
      'unsupported'
    )
  })
})

describe('unknown extension, decided by content', () => {
  it('refuses UTF-16 with a BOM (it holds NUL bytes)', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')])
    expect(await validateAttachment(await make('a.log', utf16))).toEqual({
      ok: false,
      reason: 'unsupported'
    })
  })
  it('refuses a NUL byte just inside the first 8 KB and ignores one past it', async () => {
    const inside = Buffer.alloc(9000, 0x61)
    inside[8191] = 0
    expect(await validateAttachment(await make('in.dat', inside))).toMatchObject({ ok: false })
    const past = Buffer.alloc(9000, 0x61)
    past[8192] = 0
    expect(await validateAttachment(await make('past.dat', past))).toMatchObject({ ok: true })
  })
  it('accepts a whole small file ending in a multi-byte character', async () => {
    expect(await validateAttachment(await make('u.dat', 'café 世界'))).toMatchObject({
      ok: true,
      kind: 'text'
    })
  })
  it('refuses a file that ends in a truncated multi-byte character when it is whole', async () => {
    const cut = Buffer.concat([Buffer.from('abc'), Buffer.from([0xc3])])
    expect(await validateAttachment(await make('t.dat', cut))).toMatchObject({ ok: false })
  })
  it('accepts a file with no extension when it is UTF-8 text', async () => {
    expect(await validateAttachment(await make('Makefile', 'all:\n\ttrue\n'))).toMatchObject({
      ok: true,
      kind: 'text'
    })
  })
})

describe('extension and magic must agree', () => {
  it.each([
    ['a.png', JPG],
    ['a.jpg', PNG],
    ['a.png', Buffer.from('plain text')],
    ['a.gif', PNG],
    ['a.webp', PNG]
  ])('refuses %s whose bytes are not that image', async (name, bytes) => {
    expect(await validateAttachment(await make(name, bytes))).toEqual({
      ok: false,
      reason: 'unsupported'
    })
  })
  it.each(['a.PNG', 'a.Png'])('accepts upper-case %s', async (name) => {
    expect(await validateAttachment(await make(name, PNG))).toMatchObject({
      ok: true,
      kind: 'image'
    })
  })
  it('accepts .jpeg and .jpg alike', async () => {
    for (const n of ['a.jpeg', 'a.jpg', 'a.JPG']) {
      expect(await validateAttachment(await make(n, JPG))).toMatchObject({
        ok: true,
        mime: 'image/jpeg'
      })
    }
  })
  it('refuses PNG or JPEG bytes under a non-image, non-text extension or none (binary is not text)', async () => {
    for (const n of ['a.bin', 'noext', 'a.jpg.bin']) {
      expect(await validateAttachment(await make(n, PNG))).toMatchObject({ ok: false })
    }
  })
  it('takes the extension as written for a listed text extension, PNG bytes included (pinned)', async () => {
    // Tech spec 2.4: "Extension in TEXT_EXTENSIONS" suffices. The content is not checked.
    expect(await validateAttachment(await make('x.txt', PNG))).toMatchObject({
      ok: true,
      kind: 'text'
    })
  })
})

describe('PDF', () => {
  it('accepts upper-case .PDF and %PDF- within the first 1 KB', async () => {
    const lead = Buffer.concat([Buffer.alloc(900, 0x20), Buffer.from('%PDF-1.4')])
    expect(await validateAttachment(await make('a.PDF', lead))).toMatchObject({
      ok: true,
      kind: 'pdf'
    })
  })
  it('refuses a .pdf without the marker', async () => {
    expect(await validateAttachment(await make('a.pdf', Buffer.alloc(2000, 0x61)))).toEqual({
      ok: false,
      reason: 'unsupported'
    })
  })
  it('treats PDF bytes under another extension as text only if they are UTF-8 text (pinned)', async () => {
    expect(await validateAttachment(await make('a.dat', '%PDF-1.4 plain'))).toMatchObject({
      kind: 'text'
    })
    const bin = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0, 1, 2])])
    expect(await validateAttachment(await make('b.dat', bin))).toMatchObject({ ok: false })
  })
})

describe('unreadable and special paths', () => {
  it('refuses a broken symlink as unreadable', async () => {
    await symlink(join(dir(), 'gone.txt'), join(dir(), 'dangling.txt'))
    expect(await validateAttachment(join(dir(), 'dangling.txt'))).toEqual({
      ok: false,
      reason: 'unreadable'
    })
  })
  it('refuses a permission-denied file through the service and stages nothing', async () => {
    const { svc, staging, draftId } = setup()
    const p = await make('locked.txt', 'secret')
    await chmod(p, 0o000)
    try {
      const res = await svc.stagePaths(draftId, [p, join(dir(), 'missing.txt')])
      expect(res.attachments).toEqual([])
      expect(res.refused.map((r) => r.reason)).toEqual(['unreadable', 'unreadable'])
      await expect(readdir(join(staging, draftId))).rejects.toThrow()
    } finally {
      await chmod(p, 0o600)
    }
  })
  it.each(['Thing.app', 'Doc.rtfd'])('refuses a %s bundle folder as folder', async (name) => {
    await mkdir(join(dir(), name, 'Contents'), { recursive: true })
    await writeFile(join(dir(), name, 'Contents', 'a.txt'), 'x')
    expect(await validateAttachment(join(dir(), name))).toEqual({ ok: false, reason: 'folder' })
  })
})

describe('size', () => {
  it('reads only the head to decide, so a file at the limit is cheap and one byte over is too_large', async () => {
    const big = await make('big.log', 'x')
    await truncate(big, IMPORT_MAX_BYTES)
    const before = process.memoryUsage().arrayBuffers
    expect(await validateAttachment(big)).toMatchObject({ ok: false }) // sparse: all NUL
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(1024 * 1024)
    await truncate(big, IMPORT_MAX_BYTES + 1)
    expect(await validateAttachment(big)).toEqual({ ok: false, reason: 'too_large' })
  })
  it('stages a file of exactly the limit and refuses one byte over, through the service', async () => {
    const { svc, draftId } = setup()
    const at = await make('at.txt', 'x')
    await truncate(at, IMPORT_MAX_BYTES)
    const over = await make('over.txt', 'x')
    await truncate(over, IMPORT_MAX_BYTES + 1)
    const res = await svc.stagePaths(draftId, [at, over])
    expect(res.attachments).toHaveLength(1)
    expect(res.refused).toEqual([{ name: 'over.txt', reason: 'too_large' }])
  })
})

describe('count', () => {
  async function many(n: number, prefix: string): Promise<string[]> {
    const out: string[] = []
    for (let i = 0; i < n; i++) out.push(await make(`${prefix}${i}.txt`, `b${i}`))
    return out
  }
  it('refuses the 11th across calls, frees a slot on remove, and a refused file takes none', async () => {
    const { svc, draftId } = setup()
    const first = await svc.stagePaths(draftId, await many(ATTACHMENTS_MAX_PER_MESSAGE - 1, 'a'))
    expect(first.attachments).toHaveLength(9)
    const zip = await make('x.zip', Buffer.from([0x50, 0x4b, 3, 4]))
    const [tenth] = (await svc.stagePaths(draftId, [zip, ...(await many(2, 'b'))])).attachments
    expect(tenth).toBeDefined() // the refused zip did not use the 10th slot
    const full = await svc.stagePaths(draftId, await many(1, 'c'))
    expect(full.refused[0]?.reason).toBe('too_many')
    await svc.remove(draftId, first.attachments[0]!.id)
    expect((await svc.stagePaths(draftId, await many(1, 'd'))).attachments).toHaveLength(1)
  })
  it('counts staged paths and pasted bytes together', async () => {
    const { svc, draftId } = setup()
    await svc.stagePaths(draftId, await many(9, 'a'))
    expect((await svc.stageBytes(draftId, PNG)).attachments).toHaveLength(1)
    expect((await svc.stageBytes(draftId, PNG)).refused[0]?.reason).toBe('too_many')
  })
})

describe('names', () => {
  it('stages two same-named files in different id folders and the same file twice', async () => {
    const { svc, staging, draftId } = setup()
    await mkdir(join(dir(), 'sub'))
    const a = await make('same.txt', 'one')
    const b = join(dir(), 'sub', 'same.txt')
    await writeFile(b, 'two')
    const res = await svc.stagePaths(draftId, [a, b, a])
    expect(res.refused).toEqual([])
    expect(res.attachments.map((m) => m.name)).toEqual(['same.txt', 'same.txt', 'same.txt'])
    expect(new Set(res.attachments.map((m) => m.id)).size).toBe(3)
    for (const m of res.attachments) {
      expect(await readdir(join(staging, draftId, m.id))).toEqual(['same.txt'])
    }
  })
  it('keeps the display name and sanitises the stored one', async () => {
    const { svc, draftId } = setup()
    const p = await make('we\u0007ird name.md', 'x')
    const { attachments } = await svc.stagePaths(draftId, [p])
    expect(attachments[0]!.name).toBe('we\u0007ird name.md')
    expect(svc.staged(draftId, [attachments[0]!.id])[0]!.storedName).toBe('weird name.md')
  })
})
