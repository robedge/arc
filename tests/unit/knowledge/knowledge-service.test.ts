import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { codeOf, createEnv } from './knowledge-test-env'
import type { KnowledgeEnv } from './knowledge-test-env'

const dir = useTempDir()
let env: KnowledgeEnv

beforeEach(async () => {
  env = await createEnv(dir())
})
afterEach(() => env.opened.sqlite.close())

const notePath = (name: string): string => join(env.root, 'Notes', name)

describe('create', () => {
  it('writes Notes/<title>.md without front matter when nothing is lost', async () => {
    const item = await env.service.create(env.notesId, 'Service map')
    expect(await readFile(notePath('Service map.md'), 'utf8')).toBe('')
    expect(item).toMatchObject({ title: 'Service map', kind: 'note', editable: true })
  })

  it('sanitizes the filename and keeps the real title in front matter', async () => {
    const item = await env.service.create(env.notesId, 'a/b: c')
    expect(item.title).toBe('a/b: c')
    const names = await readdir(join(env.root, 'Notes'))
    expect(names).toContain('ab c.md')
    expect(await readFile(notePath('ab c.md'), 'utf8')).toBe('---\ntitle: "a/b: c"\n---\n')
    const listed = await env.service.list(env.notesId)
    expect(listed.map((i) => i.title)).toEqual(['a/b: c'])
  })

  it('numbers case-insensitive duplicates and lists both', async () => {
    await env.service.create(env.notesId, 'Service map')
    await env.service.create(env.notesId, 'service map')
    expect(await readdir(join(env.root, 'Notes'))).toContain('service map (2).md')
    expect(await env.service.list(env.notesId)).toHaveLength(2)
  })

  it('rejects an empty title and an over-long one', async () => {
    expect(await codeOf(env.service.create(env.notesId, '   '))).toBe('TITLE_REQUIRED')
    expect(await codeOf(env.service.create(env.notesId, 'x'.repeat(101)))).toBe('VALIDATION_FAILED')
  })
})

describe('read and save', () => {
  it('saves with the right baseRevision and returns a new revision', async () => {
    const item = await env.service.create(env.notesId, 'Plan')
    const { revision } = await env.service.save(item.id, 'hello', item.revision)
    expect(await readFile(notePath('Plan.md'), 'utf8')).toBe('hello')
    expect(revision).not.toBe(item.revision)
    expect(await env.service.read(item.id)).toEqual({ type: 'text', content: 'hello', revision })
  })

  it('returns EXTERNAL_MODIFIED and writes nothing after an outside edit', async () => {
    const item = await env.service.create(env.notesId, 'Plan')
    await writeFile(notePath('Plan.md'), 'edited elsewhere')
    expect(await codeOf(env.service.save(item.id, 'mine', item.revision))).toBe('EXTERNAL_MODIFIED')
    expect(await readFile(notePath('Plan.md'), 'utf8')).toBe('edited elsewhere')
  })

  it('read strips front matter and save preserves it', async () => {
    const item = await env.service.create(env.notesId, 'a/b: c')
    const first = await env.service.read(item.id)
    if (first.type !== 'text') throw new Error('expected text')
    const { revision } = await env.service.save(item.id, 'body text', first.revision)
    const second = await env.service.read(item.id)
    expect(second).toMatchObject({ type: 'text', content: 'body text' })
    expect(await readFile(notePath('ab c.md'), 'utf8')).toBe('---\ntitle: "a/b: c"\n---\nbody text')
    expect(revision).toBeTruthy()
  })
})

describe('rename', () => {
  it('keeps the id, moves the file and the description', async () => {
    const item = await env.service.create(env.notesId, 'Old', 'about it')
    const renamed = await env.service.rename(item.id, 'New')
    expect(renamed).toMatchObject({ id: item.id, title: 'New', description: 'about it' })
    expect(await readdir(join(env.root, 'Notes'))).toEqual(['New.md'])
    const meta = await env.metaStore.read(env.root)
    expect(meta.items['Notes/New.md']).toEqual({ description: 'about it' })
    expect(meta.items['Notes/Old.md']).toBeUndefined()
  })

  it('handles a case-only rename', async () => {
    const item = await env.service.create(env.notesId, 'plan')
    const renamed = await env.service.rename(item.id, 'PLAN')
    expect(renamed.id).toBe(item.id)
    expect(await readdir(join(env.root, 'Notes'))).toEqual(['PLAN.md'])
  })

  it('adds and removes front matter as the title needs it', async () => {
    const item = await env.service.create(env.notesId, 'Plain')
    const a = await env.service.rename(item.id, 'x: y')
    expect(a.title).toBe('x: y')
    expect(await readFile(notePath('x y.md'), 'utf8')).toBe('---\ntitle: "x: y"\n---\n')
    const b = await env.service.rename(item.id, 'Clean')
    expect(b.title).toBe('Clean')
    expect(await readFile(notePath('Clean.md'), 'utf8')).toBe('')
  })
})

describe('setDescription', () => {
  it('stores in meta.json, lists it, removes on empty, rejects 201 chars', async () => {
    const item = await env.service.create(env.notesId, 'Plan')
    await env.service.setDescription(item.id, '  how things talk  ')
    expect((await env.metaStore.read(env.root)).items['Notes/Plan.md']).toEqual({
      description: 'how things talk'
    })
    expect((await env.service.list(env.notesId))[0]?.description).toBe('how things talk')
    expect(await codeOf(env.service.setDescription(item.id, 'x'.repeat(201)))).toBe(
      'VALIDATION_FAILED'
    )
    await env.service.setDescription(item.id, '')
    expect((await env.metaStore.read(env.root)).items['Notes/Plan.md']).toBeUndefined()
    expect((await env.service.list(env.notesId))[0]?.description).toBe('')
  })
})

describe('delete', () => {
  it('removes the file, the row and the meta key', async () => {
    const item = await env.service.create(env.notesId, 'Plan', 'desc')
    await env.service.delete(item.id)
    expect(await readdir(join(env.root, 'Notes'))).toEqual([])
    expect(env.itemsRepo.getById(item.id)).toBeUndefined()
    expect((await env.metaStore.read(env.root)).items['Notes/Plan.md']).toBeUndefined()
  })
})

describe('sections and traversal', () => {
  it('section delete reports the item count', async () => {
    const section = await env.sections.create(env.groupId, 'Runbooks')
    await env.service.create(section.id, 'Deploy')
    expect(await env.sections.delete(section.id)).toEqual({ removed: 1 })
  })

  it('refuses links and projects', async () => {
    const links = (await env.sections.list(env.groupId)).find((s) => s.kind === 'links')
    if (!links) throw new Error('no links')
    expect(await codeOf(env.service.create(links.id, 'x'))).toBe('VALIDATION_FAILED')
  })

  it('does not list or read a symlink pointing outside the root', async () => {
    const outside = join(dir(), 'outside.md')
    await writeFile(outside, 'secret')
    await mkdir(join(env.root, 'Notes'), { recursive: true })
    await symlink(outside, notePath('leak.md'))
    expect(await env.service.list(env.notesId)).toEqual([])
    expect((await env.sections.list(env.groupId)).find((s) => s.kind === 'notes')?.itemCount).toBe(
      0
    )
  })
})
