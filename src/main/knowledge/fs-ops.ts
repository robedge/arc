import { copyFile, mkdir, rename, rm, rmdir, stat } from 'node:fs/promises'

/** The fs calls whose failure matters to a storage operation; injectable so tests can fail them. */
export interface FsOps {
  copyFile(src: string, dest: string, mode?: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>
  rmdir(path: string): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  stat(path: string): Promise<{ size: number; mtimeMs: number }>
}

export const defaultFs: FsOps = {
  copyFile: (src, dest, mode) => copyFile(src, dest, mode),
  rename,
  rm,
  rmdir,
  mkdir: async (path, options) => {
    await mkdir(path, options)
  },
  stat
}
