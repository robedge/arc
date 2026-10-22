import { constants as fsConstants } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AppErrorException } from '@shared/errors'
import type { FsOps } from './knowledge-storage-service'

const MAX_NAME_LENGTH = 100

/** `<group name>-knowledge` as a single safe macOS folder name (no separators, colons or control characters). */
export function exportFolderName(groupName: string): string {
  const cleaned = groupName
    .normalize('NFC')
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:\u0000-\u001f\u007f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  const base = [...cleaned].slice(0, MAX_NAME_LENGTH).join('').trim()
  return `${base.length > 0 ? base : 'Group'}-knowledge`
}

interface Entry {
  rel: string
  isDir: boolean
  size: number
}

async function listTree(root: string, fs: FsOps): Promise<Entry[]> {
  const out: Entry[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${e.name}`
      if (e.isDirectory()) {
        out.push({ rel, isDir: true, size: 0 })
        await walk(join(dir, e.name), `${rel}/`)
      } else if (e.isFile()) {
        out.push({ rel, isDir: false, size: (await fs.stat(join(dir, e.name))).size })
      }
    }
  }
  await walk(root, '')
  return out
}

export interface CopyProgress {
  (phase: 'preparing' | 'exporting' | 'verifying', done: number, total: number): void
}

/**
 * Copies every file and folder (dot entries included) from `source` into the existing, empty
 * `dest` without overwriting anything, then verifies every file's existence and size.
 * Returns the number of files copied. Throws on any failure; the caller removes `dest`.
 */
export async function copyAndVerify(
  source: string,
  dest: string,
  fs: FsOps,
  onProgress: CopyProgress
): Promise<number> {
  onProgress('preparing', 0, 0)
  const entries = await listTree(source, fs)
  const files = entries.filter((e) => !e.isDir)
  for (const dir of entries.filter((e) => e.isDir)) {
    await fs.mkdir(join(dest, ...dir.rel.split('/')), { recursive: true })
  }
  let done = 0
  onProgress('exporting', 0, files.length)
  for (const file of files) {
    const segments = file.rel.split('/')
    await fs.copyFile(join(source, ...segments), join(dest, ...segments), fsConstants.COPYFILE_EXCL)
    done++
    if (done % 10 === 0 || done === files.length) onProgress('exporting', done, files.length)
  }
  onProgress('verifying', 0, files.length)
  const copied = (await listTree(dest, fs)).filter((e) => !e.isDir)
  if (copied.length !== files.length) throw new AppErrorException('EXPORT_FAILED')
  const sizes = new Map(copied.map((e) => [e.rel, e.size]))
  for (const file of files) {
    if (sizes.get(file.rel) !== file.size) throw new AppErrorException('EXPORT_FAILED')
  }
  onProgress('verifying', files.length, files.length)
  return files.length
}
