import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

describe('adoptFolders', () => {
  it('adopts a new subfolder as a custom section and mirrors meta.json', async () => {
    await mkdir(join(env.root, 'Runbooks'))
    const added = await env.sections.adoptFolders(env.groupId)
    expect(added).toMatchObject([{ name: 'Runbooks', kind: 'custom', builtIn: false }])
    expect((await env.metaStore.read(env.root)).sections.map((s) => s.folder)).toContain('Runbooks')
  })

  it('is idempotent and skips built-in folders, dot-folders and case variants', async () => {
    await mkdir(join(env.root, 'notes-archive'))
    await mkdir(join(env.root, '.hidden'))
    await writeFile(join(env.root, 'loose.md'), 'x')
    expect(await env.sections.adoptFolders(env.groupId)).toHaveLength(1)
    expect(await env.sections.adoptFolders(env.groupId)).toEqual([])
  })

  it('makes the display name unique when it collides with an existing section', async () => {
    await mkdir(join(env.root, 'Projects'))
    const added = await env.sections.adoptFolders(env.groupId)
    expect(added.map((s) => s.name)).toEqual(['Projects (2)'])
  })
})
