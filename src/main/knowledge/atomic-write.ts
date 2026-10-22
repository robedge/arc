import { randomBytes } from 'node:crypto'
import { open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface AtomicWriteInfo {
  mtimeMs: number
  size: number
}

export type AtomicWriteHook = (path: string, info: AtomicWriteInfo) => void

const hooks = new Set<AtomicWriteHook>()

/** Registers a listener called after every successful atomic write (for watcher echo suppression). */
export function onAtomicWrite(hook: AtomicWriteHook): () => void {
  hooks.add(hook)
  return () => {
    hooks.delete(hook)
  }
}

/** Writes via `<dir>/.tmp-<random>-<basename>`, fsync, then rename; the temp file never survives a failure. */
export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  const temp = join(dirname(path), `.tmp-${randomBytes(6).toString('hex')}-${basename(path)}`)
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  const info = await stat(path)
  for (const hook of hooks) hook(path, { mtimeMs: info.mtimeMs, size: info.size })
}
