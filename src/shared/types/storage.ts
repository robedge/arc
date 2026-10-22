export type StorageMode = 'app' | 'linked'

/** What `storage:get` and `storage:link` return. */
export interface StorageState {
  mode: StorageMode
  /** The linked folder (canonical path) in linked mode, otherwise null. */
  linkedPath: string | null
  /** Earlier in-app knowledge is kept aside in `knowledge.kept/` and offered back on unlink. */
  keptAside: boolean
  /** Linked mode: the folder exists and is readable. Always true in app mode. */
  available: boolean
  /** The current knowledge root holds at least one file. */
  hasKnowledge: boolean
}

/** Why a picked folder cannot be linked. Nothing is linked and no token is issued. */
export type StorageBlockedReason =
  | 'not-a-folder'
  | 'not-writable'
  | 'inside-app-storage'
  | 'contains-app-storage'
  | 'inside-other-group'
  | 'contains-other-group'

export type StoragePickResult =
  | { picked: false }
  | {
      picked: true
      /** Canonical path of the chosen folder. */
      path: string
      /** Non-null when the folder cannot be linked; no `token` then. */
      blocked: StorageBlockedReason | null
      /** Pass to `storage:link`. Single use, bound to the group, expires after 10 minutes. */
      token: string | null
      /** The group currently has knowledge; the UI shows the two-option dialog only then. */
      hasKnowledge: boolean
      /** The chosen folder already holds files or folders (excluding hidden entries). */
      targetHasContent: boolean
      /** The folder is inside one of the group's git projects: show a warning, not a block. */
      insideProjectRepo: { projectId: string; projectName: string } | null
    }

/** `keep-current` copies the linked folder's knowledge into app storage; `restore-kept` brings back the earlier in-app knowledge. */
export type StorageUnlinkChoice = 'keep-current' | 'restore-kept'

export type StorageLocateResult =
  | { located: false }
  | {
      located: true
      state: StorageState
      /**
       * The new folder has `.arc/meta.json` or a folder named like one of the group's sections.
       * Advisory only: a folder that does not look right is still linked.
       */
      looksLikeKnowledge: boolean
    }

export type StorageLinkChoice = 'move' | 'folder-only'

export const STORAGE_PROGRESS_PHASES = [
  'preparing',
  'copying',
  'verifying',
  'switching',
  'cleaning',
  'exporting',
  'rolling-back',
  'done'
] as const
export type StorageProgressPhase = (typeof STORAGE_PROGRESS_PHASES)[number]

export type StorageExportPickResult =
  | { picked: false }
  | {
      picked: true
      /** Canonical path of the chosen folder. */
      path: string
      /** Non-null when the folder cannot receive an export; no `token` then. */
      blocked: StorageBlockedReason | null
      /** Pass to `storage:export` or `groups:delete` as `exportTo`. Single use, bound to the group, expires after 10 minutes. */
      token: string | null
    }

export interface StorageExportResult {
  /** Files copied and verified (including `.arc/`). */
  count: number
  /** The new `<group name>-knowledge` folder inside the chosen folder. */
  path: string
}
