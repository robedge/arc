import { chmod, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IMPORT_MAX_BYTES } from '@shared/limits'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { createEnv } from './knowledge-test-env'
import type { KnowledgeEnv } from './knowledge-test-env'

const dir = useTempDir()
let env: KnowledgeEnv

beforeEach(async () => {
  env = await createEnv(dir())
})
afterEach(() => env.opened.sqlite.close())

const notePath = (name: string): string => join(env.root, 'Notes', name)

describe('reconcileSection', () => {
  it('picks up a file added externally, with front matter title and meta description', async () => {
    await writeFile(notePath('x.md'), '---\ntitle: "Fancy: X"\n---\nbody')
    await env.metaStore.updateMeta(env.root, (m) => {
      m.items['Notes/x.md'] = { description: 'from meta' }
    })
    await writeFile(notePath('.hidden.md'), 'no')
    await writeFile(notePath('.tmp-abc-y.md'), 'no')
    await writeFile(notePath('tool.exe'), 'no')
    await env.index.reconcileSection(env.groupId, env.notesId)
    const rows = env.itemsRepo.listBySection(env.notesId)
    expect(rows.map((r) => [r.title, r.description, r.kind])).toEqual([
      ['Fancy: X', 'from meta', 'note']
    ])
  })

  it('drops a file removed externally', async () => {
    await writeFile(notePath('a.md'), 'a')
    await writeFile(notePath('b.md'), 'b')
    await env.index.reconcileSection(env.groupId, env.notesId)
    expect(env.itemsRepo.listBySection(env.notesId)).toHaveLength(2)
    await rm(notePath('a.md'))
    await env.index.reconcileSection(env.groupId, env.notesId)
    expect(env.itemsRepo.listBySection(env.notesId).map((r) => r.relPath)).toEqual(['Notes/b.md'])
  })

  it('updates the revision on an external edit and keeps ids stable', async () => {
    const item = await env.service.create(env.notesId, 'Plan')
    await writeFile(notePath('Plan.md'), 'changed outside')
    const [after] = await env.service.list(env.notesId)
    expect(after?.id).toBe(item.id)
    expect(after?.revision).not.toBe(item.revision)
    const again = await env.service.list(env.notesId)
    expect(again[0]).toEqual(after)
  })

  it('reconcileGroup indexes every section with a folder', async () => {
    await writeFile(notePath('a.md'), 'a')
    await writeFile(join(env.root, 'Playbooks', 'p.md'), 'p')
    await env.index.reconcileGroup(env.groupId)
    const playbooks = (await env.sections.list(env.groupId)).find((s) => s.kind === 'playbooks')
    expect(env.itemsRepo.listBySection(env.notesId)).toHaveLength(1)
    expect(env.itemsRepo.listBySection(playbooks?.id ?? '')[0]?.kind).toBe('playbook')
  })

  it('lists files over the import size limit read-only, without reading them', async () => {
    await writeFile(notePath('small.md'), 'ok')
    await writeFile(notePath('huge.sql'), '')
    await truncate(notePath('huge.sql'), IMPORT_MAX_BYTES + 1)
    // Unreadable: indexing it would throw if the indexer tried to read the bytes.
    await chmod(notePath('huge.sql'), 0o000)
    try {
      await env.index.reconcileSection(env.groupId, env.notesId)
      const huge = env.itemsRepo
        .listBySection(env.notesId)
        .find((r) => r.relPath === 'Notes/huge.sql')
      expect(huge).toMatchObject({ title: 'huge.sql', isEditable: false })
      expect(huge?.sizeBytes).toBe(IMPORT_MAX_BYTES + 1)
      await expect(env.service.read(huge?.id ?? '')).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE'
      })
    } finally {
      await chmod(notePath('huge.sql'), 0o644)
    }
  })

  it('keeps indexing the rest of a section when one file cannot be read', async () => {
    await writeFile(notePath('a.md'), 'a')
    await writeFile(notePath('locked.md'), 'b')
    await chmod(notePath('locked.md'), 0o000)
    try {
      await env.index.reconcileSection(env.groupId, env.notesId)
    } finally {
      await chmod(notePath('locked.md'), 0o644)
    }
    expect(env.itemsRepo.listBySection(env.notesId).map((r) => r.relPath)).toContain('Notes/a.md')
  })
})
