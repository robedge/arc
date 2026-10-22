export interface FileFilter {
  name: string
  extensions: string[]
}

export type DialogKind = 'pickFolders' | 'pickFiles' | 'pickSaveFolder'

export interface DialogCall {
  kind: DialogKind
  options: Record<string, unknown>
}

export interface Dialogs {
  pickFolders(options: { multi: boolean }): Promise<string[] | null>
  pickFiles(options: { multi: boolean; filters?: FileFilter[] }): Promise<string[] | null>
  pickSaveFolder(): Promise<string | null>
}

export interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

/** Native open-dialog function bound to the main window (injected so this module needs no Electron). */
export type ShowOpenDialog = (options: {
  properties: string[]
  filters?: FileFilter[]
}) => Promise<OpenDialogResult>

export function createNativeDialogs(showOpenDialog: ShowOpenDialog): Dialogs {
  const pick = async (properties: string[], filters?: FileFilter[]): Promise<string[] | null> => {
    const result = await showOpenDialog(filters ? { properties, filters } : { properties })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
  }
  return {
    pickFolders: ({ multi }) =>
      pick(multi ? ['openDirectory', 'multiSelections'] : ['openDirectory']),
    pickFiles: ({ multi, filters }) =>
      pick(multi ? ['openFile', 'multiSelections'] : ['openFile'], filters),
    pickSaveFolder: async () => (await pick(['openDirectory', 'createDirectory']))?.[0] ?? null
  }
}

export interface E2eHook {
  queueOpenDialog(paths: string[] | null): void
  getDialogCalls(): DialogCall[]
}

/**
 * Stub dialogs for E2E: each call shifts the next queued response (null when empty)
 * and records the call.
 */
export function createStubDialogs(): { dialogs: Dialogs; hook: E2eHook } {
  const queue: (string[] | null)[] = []
  const calls: DialogCall[] = []
  const next = (kind: DialogKind, options: Record<string, unknown>): string[] | null => {
    calls.push({ kind, options })
    return queue.shift() ?? null
  }
  return {
    dialogs: {
      pickFolders: (o) => Promise.resolve(next('pickFolders', { ...o })),
      pickFiles: (o) => Promise.resolve(next('pickFiles', { ...o })),
      pickSaveFolder: () => Promise.resolve(next('pickSaveFolder', {})?.[0] ?? null)
    },
    hook: {
      queueOpenDialog: (paths) => {
        queue.push(paths)
      },
      getDialogCalls: () => calls.map((c) => ({ ...c }))
    }
  }
}

/** Picks the stub (installing `globalThis.__e2e`) only when HARNESS_E2E=1; otherwise native. */
export function createDialogs(
  env: NodeJS.ProcessEnv,
  showOpenDialog: ShowOpenDialog,
  target: { __e2e?: E2eHook } = globalThis as { __e2e?: E2eHook }
): Dialogs {
  if (env['HARNESS_E2E'] === '1') {
    const { dialogs, hook } = createStubDialogs()
    target.__e2e = hook
    return dialogs
  }
  return createNativeDialogs(showOpenDialog)
}
