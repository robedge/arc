/**
 * Folders that are never adopted as sections and never descended into when listing a section:
 * dependency, build and cache output that a linked code repository carries. Dot-folders are
 * skipped separately. Names are compared NFC + case-folded.
 */
export const NON_KNOWLEDGE_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules',
  'out',
  'dist',
  'build',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  'venv'
])

/** How many folder levels below a section folder are indexed (0 = only direct files). */
export const MAX_SECTION_DEPTH = 6

/** Upper bound on files indexed per section; also the watcher's live-watch file cap. */
export const MAX_SECTION_FILES = 5000

export function isNonKnowledgeFolder(name: string): boolean {
  return NON_KNOWLEDGE_FOLDERS.has(name.normalize('NFC').toLowerCase())
}
