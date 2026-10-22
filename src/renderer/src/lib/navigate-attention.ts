import { activeSession } from './stores/active-session.svelte'
import { leaveGuard } from './stores/leave-guard.svelte'
import { sessionsList } from './stores/sessions-list.svelte'
import { toasts } from './stores/toasts.svelte'
import { SECTION_SESSIONS } from './stores/ui.svelte'

/**
 * A notification click (`session:open-attention`): select the session's group, the Sessions tab and the
 * session, then open the attention dialog with the clicked request first. When the leave guard
 * refuses (an unsaved draft elsewhere) nothing else happens beyond a toast.
 */
export async function navigateToAttention(target: {
  sessionId: string
  groupId?: string
  requestId?: string
}): Promise<void> {
  const groupId =
    target.groupId ??
    Object.entries(sessionsList.byGroup).find(([, list]) =>
      list.some((s) => s.id === target.sessionId)
    )?.[0]
  if (groupId === undefined) return
  const moved =
    (await leaveGuard.selectGroup(groupId)) && (await leaveGuard.selectSection(SECTION_SESSIONS))
  if (!moved) {
    toasts.show(
      'Finish or discard your unsaved changes first, then open the request again.',
      'warning'
    )
    return
  }
  if (activeSession.sessionId !== target.sessionId) await activeSession.open(target.sessionId)
  if (activeSession.sessionId === target.sessionId) activeSession.openAttention(target.requestId)
}
