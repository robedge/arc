import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { atomicWriteFile, onAtomicWrite } from '../../../src/main/knowledge/atomic-write'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()

describe('atomicWriteFile', () => {
  it('writes content, leaves no temp file and invokes the hook', async () => {
    const path = join(dir(), 'a.md')
    const hook = vi.fn()
    const off = onAtomicWrite(hook)
    await atomicWriteFile(path, 'hello')
    off()
    expect(await readFile(path, 'utf8')).toBe('hello')
    expect(await readdir(dir())).toEqual(['a.md'])
    expect(hook).toHaveBeenCalledWith(path, { mtimeMs: expect.any(Number), size: 5 })
  })

  it('replaces existing content', async () => {
    const path = join(dir(), 'a.md')
    await atomicWriteFile(path, 'one')
    await atomicWriteFile(path, 'two!')
    expect(await readFile(path, 'utf8')).toBe('two!')
  })

  it('stops calling a hook after it is unsubscribed', async () => {
    const hook = vi.fn()
    onAtomicWrite(hook)()
    await atomicWriteFile(join(dir(), 'a.md'), 'x')
    expect(hook).not.toHaveBeenCalled()
  })

  it('fails without leaving a temp file when the rename target is invalid', async () => {
    const target = join(dir(), 'taken')
    await mkdir(target) // renaming a file over a directory fails
    await expect(atomicWriteFile(target, 'x')).rejects.toThrow()
    expect(await readdir(dir())).toEqual(['taken'])
  })

  it('fails when the target directory is missing', async () => {
    await expect(atomicWriteFile(join(dir(), 'missing', 'a.md'), 'x')).rejects.toThrow()
    expect(await readdir(dir())).toEqual([])
  })
})
