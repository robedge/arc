import { AppErrorException } from '@shared/errors'
import type { RevealPath, RevealTarget } from '../knowledge/reveal-path'

export type ShellCall =
  | { kind: 'openLink' | 'openUrl'; url: string }
  /** `path` is the absolute path main resolved from ids. */
  | { kind: 'reveal'; path: string }

export interface ShellE2eHook {
  getShellCalls(): ShellCall[]
}

export interface ShellService {
  /** Re-reads the link from disk, accepts only http/https, then opens it in the browser. */
  openLink(itemId: string): Promise<void>
  /** Opens an address taken from rendered markdown; accepts only http/https. */
  openUrl(url: string): Promise<void>
  /** Shows a knowledge location in Finder; the path is resolved here from ids, never supplied. */
  reveal(target: RevealTarget): Promise<void>
}

export interface ShellServiceDeps {
  env: NodeJS.ProcessEnv
  /** `shell.openExternal`; never called when HARNESS_E2E=1. */
  openExternal: (url: string) => Promise<void>
  /** The raw url as currently stored on disk for a link item (never cached or from the renderer). */
  readLinkUrl: (itemId: string) => Promise<string>
  /** Resolves ids to a path inside the group's knowledge root. */
  resolveRevealPath: (target: RevealTarget) => Promise<RevealPath>
  /** `shell.showItemInFolder`; never called when HARNESS_E2E=1. */
  showItemInFolder: (path: string) => void
  /** `shell.openPath` (opens a folder in Finder); never called when HARNESS_E2E=1. */
  openPath: (path: string) => Promise<string>
  /** Receives `__e2e.getShellCalls` in E2E mode, merged into whatever hooks are already there. */
  target?: { __e2e?: Partial<ShellE2eHook> }
}

function validateTarget(raw: string): string {
  try {
    const { protocol } = new URL(raw)
    if (protocol === 'http:' || protocol === 'https:') return raw
  } catch {
    // falls through
  }
  throw new AppErrorException('LINK_TARGET_INVALID')
}

export function createShellService(deps: ShellServiceDeps): ShellService {
  const isE2e = deps.env['HARNESS_E2E'] === '1'
  const calls: ShellCall[] = []
  if (isE2e) {
    const target = deps.target ?? (globalThis as { __e2e?: Partial<ShellE2eHook> })
    target.__e2e = { ...target.__e2e, getShellCalls: () => calls.map((c) => ({ ...c })) }
  }
  async function open(kind: 'openLink' | 'openUrl', url: string): Promise<void> {
    if (isE2e) {
      calls.push({ kind, url })
      return
    }
    await deps.openExternal(url)
  }
  return {
    async openLink(itemId) {
      await open('openLink', validateTarget(await deps.readLinkUrl(itemId)))
    },
    async openUrl(raw) {
      await open('openUrl', validateTarget(raw))
    },
    async reveal(target) {
      const { path, isDirectory } = await deps.resolveRevealPath(target)
      if (isE2e) {
        calls.push({ kind: 'reveal', path })
        return
      }
      if (isDirectory) {
        const failure = await deps.openPath(path)
        if (failure) throw new AppErrorException('IO_FAILED')
      } else {
        deps.showItemInFolder(path)
      }
    }
  }
}
