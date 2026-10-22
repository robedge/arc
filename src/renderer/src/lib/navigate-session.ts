import { activeSession } from './stores/active-session.svelte'
import { leaveGuard } from './stores/leave-guard.svelte'
import { sessionsList } from './stores/sessions-list.svelte'
import { toasts } from './stores/toasts.svelte'
import { SECTION_SESSIONS, ui } from './stores/ui.svelte'

/**
 * Opens a session from anywhere (the Usage page): leaves the current view, selects the session's group
 * and the Sessions tab, and opens the session. When the leave guard refuses (an unsaved draft
 * elsewhere) a toast says so and nothing moves.
 */
export async function openSession(sessionId: string): Promise<void> {
  let groupId = Object.entries(sessionsList.byGroup).find(([, list]) =>
    list.some((s) => s.id === sessionId)
  )?.[0]
  if (groupId === undefined) {
    // The group's list is not loaded: opening the session tells us which group it belongs to.
    await activeSession.open(sessionId)
    groupId = activeSession.header?.groupId
  }
  if (groupId === undefined) return
  const moved =
    (await leaveGuard.selectGroup(groupId)) && (await leaveGuard.selectSection(SECTION_SESSIONS))
  if (!moved) {
    toasts.show(
      'Finish or discard your unsaved changes first, then open the session again.',
      'warning'
    )
    return
  }
  ui.closeUsage()
  if (activeSession.sessionId !== sessionId) await activeSession.open(sessionId)
}
