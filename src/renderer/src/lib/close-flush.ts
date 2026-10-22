import { itemDraft } from './stores/item-draft.svelte'
import { knowledge } from './stores/knowledge.svelte'

/**
 * Text that autosave cannot write (it conflicts with disk) must not be lost when the window
 * closes, and the close gate cannot wait for a person to answer. The safe default keeps both
 * versions: the file on disk is left untouched and the local text becomes a new item
 * "<title> (conflict)" in the same section. Falls back to a numbered title if that one is taken.
 */
async function saveConflictCopy(): Promise<void> {
  const sectionId = knowledge.sectionId
  if (sectionId === null) return
  const base = `${itemDraft.title || 'Recovered item'} (conflict)`
  for (const title of [base, `${base} ${Date.now()}`]) {
    const result = await itemDraft.saveAsNew(sectionId, title)
    if (!('code' in result)) return
  }
}

/**
 * Close handshake: when main announces the window is closing, save pending edits and
 * then tell main it may proceed. Replies even when the save fails so closing never hangs.
 * Returns the unsubscribe function.
 */
export function registerCloseFlush(): () => void {
  return window.harness.on('app:before-close', () => {
    const save = itemDraft.hasConflict ? saveConflictCopy() : itemDraft.flush()
    void save.catch(() => {}).finally(() => void window.harness.invoke('app:close-ready', {}))
  })
}
