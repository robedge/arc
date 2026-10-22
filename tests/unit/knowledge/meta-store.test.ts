import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MetaStore } from '../../../src/main/knowledge/meta-store'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()
const log = { warn: vi.fn() }
let store: MetaStore
let root: string

beforeEach(async () => {
  log.warn.mockClear()
  store = new MetaStore({ log, now: () => 1000 })
  root = join(dir(), 'k')
  await mkdir(root)
})

describe('MetaStore', () => {
  it('returns defaults when meta.json is missing', async () => {
    expect(await store.read(root)).toEqual({ version: 1, sections: [], items: {}, updatedAt: 1000 })
  })

  it('writes atomically and reads back', async () => {
    await store.updateMeta(root, (m) => {
      m.sections = [{ folder: 'Runbooks', name: 'Runbooks', kind: 'custom' }]
    })
    const meta = await store.read(root)
    expect(meta.sections).toEqual([{ folder: 'Runbooks', name: 'Runbooks', kind: 'custom' }])
    expect(await readdir(join(root, '.arc'))).toEqual(['meta.json'])
  })

  it('renames a legacy .harness dir to .arc on first read', async () => {
    await mkdir(join(root, '.harness'))
    await writeFile(
      join(root, '.harness', 'meta.json'),
      JSON.stringify({ version: 1, sections: [], items: { 'a.md': { description: 'kept' } } })
    )
    const meta = await store.read(root)
    expect(meta.items).toEqual({ 'a.md': { description: 'kept' } })
    expect(await readdir(root)).toEqual(['.arc'])
  })

  it('leaves a legacy .harness dir alone when .arc already exists', async () => {
    await mkdir(join(root, '.harness'))
    await mkdir(join(root, '.arc'))
    await store.read(root)
    expect((await readdir(root)).sort()).toEqual(['.arc', '.harness'])
  })

  it('backs up a corrupt file and returns defaults', async () => {
    await mkdir(join(root, '.arc'))
    await writeFile(join(root, '.arc', 'meta.json'), '{not json')
    const meta = await store.read(root)
    expect(meta.sections).toEqual([])
    expect(await readFile(join(root, '.arc', 'meta.json.bak'), 'utf8')).toBe('{not json')
    expect(log.warn).toHaveBeenCalled()
  })

  it('overwrites an older .bak', async () => {
    await mkdir(join(root, '.arc'))
    await writeFile(join(root, '.arc', 'meta.json.bak'), 'old')
    await writeFile(join(root, '.arc', 'meta.json'), '[1,2]')
    await store.read(root)
    expect(await readFile(join(root, '.arc', 'meta.json.bak'), 'utf8')).toBe('[1,2]')
  })

  it('preserves unknown top-level fields across updates', async () => {
    await mkdir(join(root, '.arc'))
    await writeFile(
      join(root, '.arc', 'meta.json'),
      JSON.stringify({ version: 1, sections: [], items: {}, updatedAt: 1, future: { a: 1 } })
    )
    await store.updateMeta(root, (m) => {
      m.items['Notes/a.md'] = { description: 'd' }
    })
    const raw = JSON.parse(await readFile(join(root, '.arc', 'meta.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(raw['future']).toEqual({ a: 1 })
    expect(raw['items']).toEqual({ 'Notes/a.md': { description: 'd' } })
  })

  it('serializes concurrent updates', async () => {
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        store.updateMeta(root, (m) => {
          m.items[`f${n}`] = { description: String(n) }
        })
      )
    )
    expect(Object.keys((await store.read(root)).items).sort()).toEqual([
      'f1',
      'f2',
      'f3',
      'f4',
      'f5'
    ])
  })
})
