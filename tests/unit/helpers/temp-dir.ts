import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

/** Gives each test a fresh temp directory, removed afterwards. Returns a getter for its path. */
export function useTempDir(prefix = 'harness-test-'): () => string {
  let dir: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), prefix))
  })

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  return () => {
    if (!dir) throw new Error('useTempDir: directory is only available inside a test')
    return dir
  }
}
