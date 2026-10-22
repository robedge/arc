import type { ErrorCode } from '../errors'

export type ItemKind = 'note' | 'playbook' | 'doc_text' | 'doc_binary' | 'link' | 'item'

export interface ItemSummary {
  id: string
  sectionId: string
  title: string
  /** On-disk file name including extension (decides the editor language). */
  fileName: string
  /** Subfolder path inside the section (`'a/b'`), `''` or absent for a top-level file. */
  folder?: string
  description: string
  kind: ItemKind
  /** Links only: the address as stored on disk (not yet validated; `shell:openLink` revalidates). */
  url?: string
  editable: boolean
  /** `${mtimeMs}:${size}:${sha1(content).slice(0, 12)}`, computed from disk. */
  revision: string
}

export interface TextItemContent {
  type: 'text'
  /** Body without front matter. */
  content: string
  revision: string
}

export interface BinaryItemContent {
  type: 'binary'
  /** `harness-knowledge://<groupId>/<itemId>?rev=<revision>`; the renderer fetches the bytes. */
  url: string
  mime: string
}

export type ItemContent = TextItemContent | BinaryItemContent

export type ConflictResolution = 'replace' | 'keepBoth' | 'skip'

export interface ImportReport {
  added: ItemSummary[]
  failed: { name: string; code: ErrorCode }[]
  /** Names that already exist; nothing was written. `path` is the source, for retrying. */
  conflicts: { name: string; path: string }[]
}
