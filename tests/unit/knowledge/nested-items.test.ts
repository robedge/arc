import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SECTION_DEPTH } from '../../../src/main/knowledge/section-scan'
import { isIgnoredRelPath, snapshotFolders } from '../../../src/main/knowledge/knowledge-watcher'
import { useTempDir } from '../helpers/temp-dir'
import { createEnv } from './knowledge-test-env'
import type { KnowledgeEnv } from './knowledge-test-env'

const dir = useTempDir()
let env: KnowledgeEnv

beforeEach(async () => {
  env = await createEnv(dir())
})
afterEach(() => env.opened.sqlite.close())

async function put(rel: string, text = 'x'): Promise<void> {
  const abs = join(env.root, ...rel.split('/'))
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, text)
}

describe('nested section items', () => {
  it('indexes files in subfolders at any depth up to the cap, with full relPaths', async () => {
    await put('Notes/top.md')
    await put('Notes/001-x/a.md')
    await put('Notes/001-x/deep/b.md')
    await env.index.reconcileSection(env.groupId, env.notesId)
    const paths = env.itemsRepo
      .listBySection(env.notesId)
      .map((r) => r.relPath)
      .sort()
    expect(paths).toEqual(['Notes/001-x/a.md', 'Notes/001-x/deep/b.md', 'Notes/top.md'])
  })

  it('skips dot folders and junk folders, but not files beyond the depth cap being counted', async () => {
    await put('Notes/.hidden/a.md')
    await put('Notes/node_modules/pkg/a.md')
    await put('Notes/Dist/a.md')
    await put('Notes/ok/a.md')
    const tooDeep = Array.from({ length: MAX_SECTION_DEPTH + 1 }, (_, i) => `d${i}`).join('/')
    await put(`Notes/${tooDeep}/far.md`)
    await env.index.reconcileSection(env.groupId, env.notesId)
    expect(env.itemsRepo.listBySection(env.notesId).map((r) => r.relPath)).toEqual([
      'Notes/ok/a.md'
    ])
  })

  it('reports the subfolder on the summary', async () => {
    await put('Notes/top.md')
    await put('Notes/001-x/deep/b.md')
    const items = await env.service.list(env.notesId)
    expect(items.map((i) => [i.fileName, i.folder])).toEqual(
      expect.arrayContaining([
        ['top.md', ''],
        ['b.md', '001-x/deep']
      ])
    )
  })

  it('renames a nested item inside its own folder, keeping id and meta', async () => {
    await put('Notes/sub/a.md', 'hello')
    const [item] = await env.service.list(env.notesId)
    if (!item) throw new Error('no item')
    await env.service.setDescription(item.id, 'desc')
    const renamed = await env.service.rename(item.id, 'Renamed')
    expect(renamed).toMatchObject({ id: item.id, fileName: 'Renamed.md', folder: 'sub' })
    expect(existsSync(join(env.root, 'Notes', 'sub', 'Renamed.md'))).toBe(true)
    expect(existsSync(join(env.root, 'Notes', 'sub', 'a.md'))).toBe(false)
    expect(env.itemsRepo.getById(item.id)?.relPath).toBe('Notes/sub/Renamed.md')
    expect(renamed.description).toBe('desc')
  })

  it('reads, saves and deletes a nested item', async () => {
    await put('Notes/sub/a.md', 'hello')
    const [item] = await env.service.list(env.notesId)
    if (!item) throw new Error('no item')
    const read = await env.service.read(item.id)
    if (read.type !== 'text') throw new Error('expected text')
    expect(read.content).toBe('hello')
    await env.service.save(item.id, 'changed', read.revision)
    expect(await readFile(join(env.root, 'Notes', 'sub', 'a.md'), 'utf8')).toBe('changed')
    await env.service.delete(item.id)
    expect(existsSync(join(env.root, 'Notes', 'sub', 'a.md'))).toBe(false)
    expect(env.itemsRepo.getById(item.id)).toBeUndefined()
  })

  it('creating an item still goes to the section top level', async () => {
    await put('Notes/sub/a.md')
    const created = await env.service.create(env.notesId, 'Fresh')
    expect(created.folder).toBe('')
    expect(existsSync(join(env.root, 'Notes', 'Fresh.md'))).toBe(true)
  })
})

describe('watcher helpers for nested folders', () => {
  it('ignores junk folders below a section but still watches the section itself', () => {
    expect(isIgnoredRelPath('Notes/node_modules/x/a.md')).toBe(true)
    expect(isIgnoredRelPath('Notes/sub/.git/HEAD')).toBe(true)
    expect(isIgnoredRelPath('Notes/sub/a.md')).toBe(false)
  })

  it('the polling snapshot changes when a nested file is added', async () => {
    await put('Notes/sub/a.md')
    const before = await snapshotFolders(env.root)
    await put('Notes/sub/deeper/b.md')
    const after = await snapshotFolders(env.root)
    expect(after.get('Notes')).not.toBe(before.get('Notes'))
  })
})
