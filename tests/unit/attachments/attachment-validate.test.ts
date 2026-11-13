import { chmod, mkdir, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sanitizeName, validateAttachment } from '../../../src/main/attachments/attachment-validate'
import { IMPORT_MAX_BYTES } from '../../../src/shared/limits'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const GIF = Buffer.from('GIF89a\0\0')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])

async function make(name: string, content: Buffer | string): Promise<string> {
  const p = join(dir(), name)
  await writeFile(p, content)
  return p
}

describe('validateAttachment', () => {
  it.each([
    ['a.png', PNG, 'image/png'],
    ['a.jpg', JPG, 'image/jpeg'],
    ['a.JPEG', JPG, 'image/jpeg'],
    ['a.gif', GIF, 'image/gif'],
    ['a.webp', WEBP, 'image/webp']
  ])('accepts %s as an image', async (name, bytes, mime) => {
    const v = await validateAttachment(await make(name, bytes))
    expect(v).toMatchObject({ ok: true, kind: 'image', mime })
  })

  it('refuses an image whose bytes do not match its extension', async () => {
    expect(await validateAttachment(await make('a.png', JPG))).toEqual({
      ok: false,
      reason: 'unsupported'
    })
  })

  it('refuses image bytes under a non-image extension', async () => {
    expect(await validateAttachment(await make('a.dat', PNG))).toEqual({
      ok: false,
      reason: 'unsupported'
    })
  })

  it('accepts a PDF by its magic and refuses a fake one', async () => {
    expect(await validateAttachment(await make('a.pdf', '%PDF-1.7\n'))).toMatchObject({
      ok: true,
      kind: 'pdf',
      mime: 'application/pdf'
    })
    const late = Buffer.concat([Buffer.alloc(1100, 0x20), Buffer.from('%PDF-1')])
    expect(await validateAttachment(await make('b.pdf', late))).toMatchObject({ ok: false })
    expect(await validateAttachment(await make('c.pdf', 'hello'))).toMatchObject({
      ok: false,
      reason: 'unsupported'
    })
  })

  it('accepts a known text extension and an unknown one with UTF-8 text', async () => {
    expect(await validateAttachment(await make('a.md', '# hi'))).toMatchObject({
      ok: true,
      kind: 'text'
    })
    expect(await validateAttachment(await make('run.log', 'line one\nline two é\n'))).toMatchObject(
      { ok: true, kind: 'text' }
    )
  })

  it('refuses an unknown extension with a NUL byte', async () => {
    const v = await validateAttachment(await make('a.bin', Buffer.from([0x61, 0, 0x62])))
    expect(v).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('tolerates a multi-byte character cut at the 8 KB boundary', async () => {
    const body = Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from('é'), Buffer.alloc(20, 0x61)])
    expect(await validateAttachment(await make('cut.log', body))).toMatchObject({ ok: true })
  })

  it('refuses invalid UTF-8 under an unknown extension', async () => {
    const v = await validateAttachment(await make('a.dat', Buffer.from([0xc3, 0x28, 0x61])))
    expect(v).toMatchObject({ ok: false, reason: 'unsupported' })
  })

  it('treats SVG as text', async () => {
    expect(await validateAttachment(await make('a.svg', '<svg xmlns="x"></svg>'))).toMatchObject({
      ok: true,
      kind: 'text'
    })
  })

  it('refuses HEIC and ZIP', async () => {
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.alloc(8)
    ])
    expect(await validateAttachment(await make('a.heic', heic))).toMatchObject({
      reason: 'unsupported'
    })
    const zip = Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0])
    expect(await validateAttachment(await make('a.zip', zip))).toMatchObject({
      reason: 'unsupported'
    })
  })

  it('refuses a zero-byte file as unsupported', async () => {
    expect(await validateAttachment(await make('e.txt', ''))).toEqual({
      ok: false,
      reason: 'unsupported'
    })
  })

  it('refuses a file over the limit and accepts one at the limit', async () => {
    const big = await make('big.txt', 'x')
    await truncate(big, IMPORT_MAX_BYTES + 1)
    expect(await validateAttachment(big)).toEqual({ ok: false, reason: 'too_large' })
    await truncate(big, IMPORT_MAX_BYTES)
    expect(await validateAttachment(big)).toMatchObject({ ok: true, size: IMPORT_MAX_BYTES })
  })

  it('refuses a folder', async () => {
    const d = join(dir(), 'sub')
    await mkdir(d)
    expect(await validateAttachment(d)).toEqual({ ok: false, reason: 'folder' })
  })

  it('refuses a missing path as unreadable', async () => {
    expect(await validateAttachment(join(dir(), 'nope.txt'))).toEqual({
      ok: false,
      reason: 'unreadable'
    })
  })

  it('refuses a file it cannot open', async () => {
    const p = await make('locked.txt', 'secret')
    await chmod(p, 0o000)
    try {
      expect(await validateAttachment(p)).toEqual({ ok: false, reason: 'unreadable' })
    } finally {
      await chmod(p, 0o600)
    }
  })

  it('follows a symlink to a file and refuses one to a folder', async () => {
    const target = await make('real.txt', 'hello')
    await symlink(target, join(dir(), 'link.txt'))
    const v = await validateAttachment(join(dir(), 'link.txt'))
    expect(v).toMatchObject({ ok: true, kind: 'text' })
    if (v.ok) expect(v.realPath).toMatch(/real\.txt$/)
    const d = join(dir(), 'd')
    await mkdir(d)
    await symlink(d, join(dir(), 'dlink'))
    expect(await validateAttachment(join(dir(), 'dlink'))).toEqual({ ok: false, reason: 'folder' })
  })
})

describe('sanitizeName', () => {
  it('keeps the base name only', () => {
    expect(sanitizeName('../../x.txt')).toBe('x.txt')
    expect(sanitizeName('a\\b\\c.md')).toBe('c.md')
  })
  it('strips control characters and NUL', () => {
    expect(sanitizeName('a\u0000b\u0007\nc.txt')).toBe('abc.txt')
  })
  it('caps at 120 characters and keeps the extension', () => {
    const out = sanitizeName(`${'a'.repeat(300)}.json`)
    expect(out).toHaveLength(120)
    expect(out.endsWith('.json')).toBe(true)
  })
  it('falls back when nothing is left', () => {
    expect(sanitizeName('')).toBe('attachment')
    expect(sanitizeName('\u0001\u0002')).toBe('attachment')
    expect(sanitizeName('..')).toBe('attachment')
    expect(sanitizeName('a/')).toBe('a')
  })
})
