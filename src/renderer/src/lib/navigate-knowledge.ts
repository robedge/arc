import { knowledgeSuggestions } from './stores/knowledge-suggestions.svelte'
import { leaveGuard } from './stores/leave-guard.svelte'
import { toasts } from './stores/toasts.svelte'
import { ui } from './stores/ui.svelte'

/**
 * Shows one knowledge item in its group's knowledge screen (the Open link on an accepted suggestion):
 * closes the suggestions dialog, selects the group and section through the leave guard, switches to the
 * main view and selects the item so its section opens it. When the guard refuses (an unsaved draft
 * elsewhere) a toast says so and nothing moves.
 */
export async function openKnowledgeItem(target: {
  groupId: string
  sectionId: string
  itemId: string
}): Promise<void> {
  knowledgeSuggestions.close()
  const moved =
    (await leaveGuard.selectGroup(target.groupId)) &&
    (await leaveGuard.selectSection(target.sectionId))
  if (!moved) {
    toasts.show(
      'Finish or discard your unsaved changes first, then open the note again.',
      'warning'
    )
    return
  }
  ui.view = 'main'
  await leaveGuard.selectItem(target.itemId)
}
