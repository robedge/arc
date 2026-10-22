import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { useTempDir } from './helpers/temp-dir'

describe('unit test harness', () => {
  const tempDir = useTempDir()

  it('gives each test a writable temp directory', async () => {
    const file = join(tempDir(), 'hello.txt')
    await writeFile(file, 'hello')
    expect(await readFile(file, 'utf8')).toBe('hello')
  })

  it("runs under Electron's Node", () => {
    expect(process.versions.electron).toBeTruthy()
  })

  it('loads the Electron-ABI better-sqlite3 build', () => {
    const db = new Database(':memory:')
    try {
      expect(db.prepare('select 1 as one').get()).toEqual({ one: 1 })
    } finally {
      db.close()
    }
  })
})
