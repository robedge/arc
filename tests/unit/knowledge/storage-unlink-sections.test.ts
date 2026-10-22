import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { exists, fingerprint, put, setup } from './storage-test-harness'
import type { StorageHarness } from './storage-test-harness'

const tempDir = useTempDir('harness-unlink-sections-')

function customNames(h: StorageHarness): string[] {
  return h.env.sectionsRepo
    .listByGroup(h.env.groupId)
    .filter((s) => s.kind === 'custom')
    .map((s) => s.name)
}

/** An in-app group with a custom section and notes, then linked to a code-repo-like folder. */
async function linkedToRepo(): Promise<{ h: StorageHarness; linked: string; before: string[] }> {
  const h = await setup(await realpath(tempDir()))
  const id = h.env.groupId
  await h.env.sections.create(id, 'Ideas')
  await put(h.env.root, 'Notes/App1.md', '# App1\none')
  await put(h.env.root, 'Ideas/Idea1.md', '# Idea1\nidea')
  await h.env.index.reconcileGroup(id)
  const before = customNames(h)
  await put(h.target, 'src/main.ts', 'export {}')
  await put(h.target, 'node_modules/dep/index.js', 'x')
  await put(h.target, 'out/bundle.js', 'x')
  await put(h.target, 'tests/a.md', '# A\na')
  await put(h.target, 'README.md', '# readme')
  await h.service.linkPath(id, h.target, 'folder-only')
  return { h, linked: await realpath(h.target), before }
}

describe('restore-kept after linking a repo folder', () => {
  it('does not turn dependency and build folders into sections', async () => {
    const { h } = await linkedToRepo()
    const names = customNames(h).map((n) => n.toLowerCase())
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('out')
    expect(names).toContain('src')
  })

  it('restores the original sections and items, dropping folder-only sections', async () => {
    const { h, linked, before } = await linkedToRepo()
    const id = h.env.groupId
    expect(customNames(h)).toContain('tests') // adopted while linked
    const folderBefore = await fingerprint(linked)

    await h.service.unlink(id, 'restore-kept')

    expect(customNames(h)).toEqual(before)
    const rows = h.env.sectionsRepo.listByGroup(id)
    expect(
      rows.every((s) => s.folderName === null || !['src', 'tests'].includes(s.folderName))
    ).toBe(true)
    const ideas = rows.find((s) => s.name === 'Ideas')
    expect(h.env.itemsRepo.listBySection(ideas?.id ?? '').map((r) => r.title)).toEqual(['Idea1'])
    expect(h.env.itemsRepo.listBySection(h.env.notesId).map((r) => r.title)).toEqual(['App1'])
    expect(await exists(join(h.env.root, 'src'))).toBe(false)
    expect(await fingerprint(linked)).toEqual(folderBefore)
  })
})
