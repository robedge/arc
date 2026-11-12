import { posix } from 'node:path'
import type { KnowledgeSuggestionRow } from '../db/repositories/knowledge-suggestions-repo'
import type { DiffHunk } from '@shared/types/review'
import type { KnowledgeSuggestionView } from '@shared/types/knowledge-suggestion'

/** Maps a stored suggestion to what the renderer shows. */
export function toKnowledgeSuggestionView(
  row: KnowledgeSuggestionRow,
  /** The id of the indexed item at a path, when one exists; an update's target carries it. */
  itemIdAt: (relPath: string) => string | undefined = () => undefined
): KnowledgeSuggestionView {
  const base = {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.action,
    title: row.title,
    reason: row.reason,
    sectionId: row.sectionId,
    sectionName: row.sectionName,
    createdAt: row.createdAt
  }
  if (row.action === 'new') {
    return {
      ...base,
      target: { itemId: null, name: row.proposedName ?? '', relPath: null },
      text: row.proposedContent
    }
  }
  const relPath = row.targetRelPath
  return {
    ...base,
    target: {
      itemId: relPath === null ? null : (itemIdAt(relPath) ?? null),
      name: relPath === null ? '' : posix.basename(relPath),
      relPath
    },
    hunks: row.hunksJson === null ? [] : (JSON.parse(row.hunksJson) as DiffHunk[])
  }
}
