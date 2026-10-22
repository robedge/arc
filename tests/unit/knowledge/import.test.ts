import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMPORT_MAX_BYTES } from '../../../src/shared/limits'
import { useTempDir } from '../helpers/temp-dir'
import { codeOf, createEnv } from './knowledge-test-env'
import type { KnowledgeEnv } from './knowledge-test-env'

const dir = useTempDir()
let env: KnowledgeEnv
let docsId: string
let src: string

beforeEach(async () => {
  env = await createEnv(dir())
  const sections = await env.sections.list(env.groupId)
  const docs = sections.find((s) => s.kind === 'docs')
  if (!docs) throw new Error('no docs section')
  docsId = docs.id
  src = join(dir(), 'src')
  await mkdir(src)
})
afterEach(() => env.opened.sqlite.close())

async function source(name: string, content: string | Buffer): Promise<string> {
  const path = join(src, name)
  await writeFile(path, content)
  return path
}

const docsFile = (name: string): string => join(env.root, 'Docs', name)

describe('importFiles', () => {
  it('imports a .sql file: listed, readable, editable, source untouched', async () => {
    const path = await source('orders_schema.sql', 'CREATE TABLE orders (id int);\n')
    await utimes(path, new Date(1_600_000_000_000), new Date(1_600_000_000_000))
    const before = await stat(path)

    const report = await env.service.importFiles(docsId, [path])
    expect(report.failed).toEqual([])
    expect(report.conflicts).toEqual([])
    expect(report.added).toHaveLength(1)
    expect(report.added[0]).toMatchObject({
      title: 'orders_schema.sql',
      kind: 'doc_text',
      editable: true
    })

    const listed = await env.service.list(docsId)
    expect(listed.map((i) => i.title)).toEqual(['orders_schema.sql'])
    const read = await env.service.read(report.added[0]?.id ?? '')
    expect(read).toMatchObject({ type: 'text', content: 'CREATE TABLE orders (id int);\n' })

    const after = await stat(path)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(path, 'utf8')).toBe('CREATE TABLE orders (id int);\n')
    expect((await readdir(join(env.root, 'Docs'))).filter((n) => n.startsWith('.tmp-'))).toEqual([])
  })

  it('rejects files over 20 MB and accepts exactly 20 MB', async () => {
    const big = await source('big.txt', Buffer.alloc(IMPORT_MAX_BYTES + 1, 'a'))
    const exact = await source('exact.txt', Buffer.alloc(IMPORT_MAX_BYTES, 'a'))
    const report = await env.service.importFiles(docsId, [big, exact])
    expect(report.failed).toEqual([{ name: 'big.txt', code: 'FILE_TOO_LARGE' }])
    expect(report.added.map((i) => i.title)).toEqual(['exact.txt'])
  })

  it.each([
    ['tool.exe', 'MZ text'],
    ['doc.pdf', 'plain text'],
    ['nul.sql', Buffer.from([0x53, 0x45, 0x4c, 0x00, 0x45, 0x43, 0x54])],
    ['bad.json', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])]
  ])('rejects %s as FILE_UNSUPPORTED', async (name, content) => {
    const path = await source(name, content)
    const report = await env.service.importFiles(docsId, [path])
    expect(report.added).toEqual([])
    expect(report.failed).toEqual([{ name, code: 'FILE_UNSUPPORTED' }])
    expect(await readdir(join(env.root, 'Docs'))).toEqual([])
  })

  it('rejects a directory as FILE_UNSUPPORTED', async () => {
    await mkdir(join(src, 'folder.txt'))
    const report = await env.service.importFiles(docsId, [join(src, 'folder.txt')])
    expect(report.failed).toEqual([{ name: 'folder.txt', code: 'FILE_UNSUPPORTED' }])
  })

  it('handles a batch independently: 4 added, the oversized one fails', async () => {
    const paths = [
      await source('a.md', '# a'),
      await source('b.txt', 'b'),
      await source('c.yaml', 'c: 1'),
      await source('huge.csv', Buffer.alloc(IMPORT_MAX_BYTES + 1, 'x')),
      await source('e.proto', 'syntax = "proto3";')
    ]
    const report = await env.service.importFiles(docsId, paths)
    expect(report.added).toHaveLength(4)
    expect(report.failed).toEqual([{ name: 'huge.csv', code: 'FILE_TOO_LARGE' }])
  })

  it('accepts a file whose 4096th byte is inside a multi-byte character', async () => {
    // 4095 ASCII bytes, then a 3-byte char straddling the sniff boundary.
    const path = await source('wide.txt', `${'a'.repeat(4095)}€ tail`)
    const report = await env.service.importFiles(docsId, [path])
    expect(report.failed).toEqual([])
    expect(report.added).toHaveLength(1)
  })

  it('rejects Links sections with VALIDATION_FAILED', async () => {
    const links = (await env.sections.list(env.groupId)).find((s) => s.kind === 'links')
    if (!links) throw new Error('no links section')
    const path = await source('a.txt', 'a')
    expect(await codeOf(env.service.importFiles(links.id, [path]))).toBe('VALIDATION_FAILED')
  })

  it('imports a second batch entry with the same basename as a conflict', async () => {
    await mkdir(join(src, 'sub'))
    const first = await source('same.txt', 'one')
    const second = join(src, 'sub', 'same.txt')
    await writeFile(second, 'two')
    const report = await env.service.importFiles(docsId, [first, second])
    expect(report.added).toHaveLength(1)
    expect(report.conflicts).toEqual([{ name: 'same.txt', path: second }])
    expect(await readFile(docsFile('same.txt'), 'utf8')).toBe('one')
  })
})

describe('name conflicts', () => {
  let path: string
  let originalId: string

  beforeEach(async () => {
    path = await source('orders_schema.sql', 'v1')
    const first = await env.service.importFiles(docsId, [path])
    originalId = first.added[0]?.id ?? ''
    await writeFile(path, 'v2')
  })

  it('returns a conflict without writing', async () => {
    const report = await env.service.importFiles(docsId, [path])
    expect(report).toEqual({
      added: [],
      failed: [],
      conflicts: [{ name: 'orders_schema.sql', path }]
    })
    expect(await readFile(docsFile('orders_schema.sql'), 'utf8')).toBe('v1')
  })

  it('keepBoth writes "orders_schema (2).sql"', async () => {
    const report = await env.service.importFiles(docsId, [path], {
      'orders_schema.sql': 'keepBoth'
    })
    expect(report.added).toHaveLength(1)
    expect(await readFile(docsFile('orders_schema (2).sql'), 'utf8')).toBe('v2')
    expect(await readFile(docsFile('orders_schema.sql'), 'utf8')).toBe('v1')
  })

  it('replace overwrites the content and keeps the item id', async () => {
    const report = await env.service.importFiles(docsId, [path], {
      'orders_schema.sql': 'replace'
    })
    expect(report.added[0]?.id).toBe(originalId)
    expect(await readFile(docsFile('orders_schema.sql'), 'utf8')).toBe('v2')
    expect(await env.service.list(docsId)).toHaveLength(1)
    expect(await readFile(path, 'utf8')).toBe('v2')
  })

  it('skip does nothing', async () => {
    const report = await env.service.importFiles(docsId, [path], { 'orders_schema.sql': 'skip' })
    expect(report).toEqual({ added: [], failed: [], conflicts: [] })
    expect(await readdir(join(env.root, 'Docs'))).toEqual(['orders_schema.sql'])
    expect(await readFile(docsFile('orders_schema.sql'), 'utf8')).toBe('v1')
  })

  it('compares names case-insensitively', async () => {
    const upper = await source('ORDERS_SCHEMA.SQL', 'upper')
    const report = await env.service.importFiles(docsId, [upper])
    expect(report.conflicts).toEqual([{ name: 'ORDERS_SCHEMA.SQL', path: upper }])
    expect(report.added).toEqual([])
    expect(await readdir(join(env.root, 'Docs'))).toEqual(['orders_schema.sql'])
  })
})

describe('rename of imported docs', () => {
  async function imported(name: string, content: string): Promise<string> {
    const report = await env.service.importFiles(docsId, [await source(name, content)])
    return report.added[0]?.id ?? ''
  }

  it('keeps the extension, the id and the content; adds no front matter', async () => {
    const id = await imported('orders_schema.sql', 'SELECT 1;\n')
    const renamed = await env.service.rename(id, 'orders')
    expect(renamed).toMatchObject({ id, title: 'orders.sql', fileName: 'orders.sql' })
    expect(await readdir(join(env.root, 'Docs'))).toEqual(['orders.sql'])
    expect(await readFile(docsFile('orders.sql'), 'utf8')).toBe('SELECT 1;\n')
  })

  it('does not double the extension when the title already has it', async () => {
    const id = await imported('orders_schema.sql', 'x')
    const renamed = await env.service.rename(id, 'orders.sql')
    expect(renamed.fileName).toBe('orders.sql')
    expect(await readdir(join(env.root, 'Docs'))).toEqual(['orders.sql'])
  })

  it('keeps .yaml, numbers collisions and moves the description', async () => {
    const id = await imported('config.yaml', 'a: 1\n')
    await imported('other.yaml', 'b: 2\n')
    await env.service.setDescription(id, 'cfg')
    const renamed = await env.service.rename(id, 'other')
    expect(renamed).toMatchObject({ id, fileName: 'other (2).yaml', description: 'cfg' })
    const meta = await env.metaStore.read(env.root)
    expect(meta.items['Docs/other (2).yaml']).toEqual({ description: 'cfg' })
    expect(meta.items['Docs/config.yaml']).toBeUndefined()
  })

  it('handles a case-only rename and keeps the extension', async () => {
    const id = await imported('config.yaml', 'a: 1\n')
    const renamed = await env.service.rename(id, 'CONFIG')
    expect(renamed).toMatchObject({ id, fileName: 'CONFIG.yaml' })
    expect(await readdir(join(env.root, 'Docs'))).toEqual(['CONFIG.yaml'])
  })
})

describe('binary import', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4)
  ])
  const valid: [string, Buffer | string][] = [
    ['a.pdf', '%PDF-1.4\n'],
    ['a.png', png],
    ['a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])],
    ['a.gif', 'GIF89a....'],
    ['a.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')],
    ['a.svg', '<?xml version="1.0"?><SVG xmlns="http://www.w3.org/2000/svg"/>']
  ]

  it.each(valid)('accepts %s as a non-editable doc_binary', async (name, content) => {
    const report = await env.service.importFiles(docsId, [await source(name, content)])
    expect(report.failed).toEqual([])
    expect(report.added[0]).toMatchObject({ kind: 'doc_binary', editable: false })
    expect(await env.service.list(docsId)).toHaveLength(1)
  })

  it.each([
    ['wrong.pdf', 'not a pdf'],
    ['text.png', 'just text'],
    ['plain.svg', 'hello world']
  ])('rejects %s as FILE_UNSUPPORTED', async (name, content) => {
    const report = await env.service.importFiles(docsId, [await source(name, content)])
    expect(report.failed).toEqual([{ name, code: 'FILE_UNSUPPORTED' }])
  })

  it('reads a binary item as a protocol url and refuses to save it', async () => {
    const report = await env.service.importFiles(docsId, [await source('a.png', png)])
    const item = report.added[0]
    if (!item) throw new Error('not imported')
    const read = await env.service.read(item.id)
    expect(read).toMatchObject({ type: 'binary', mime: 'image/png' })
    if (read.type !== 'binary') throw new Error('expected binary')
    expect(read.url.startsWith(`harness-knowledge://${env.groupId}/${item.id}?rev=`)).toBe(true)
    expect(await codeOf(env.service.save(item.id, 'x', item.revision))).toBe('VALIDATION_FAILED')
  })
})
