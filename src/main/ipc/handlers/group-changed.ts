import type { GroupChange, SessionService } from '../../sessions/session-service'
import { sessionsLog } from '../../logging'

/**
 * Open sessions take a group change without a restart (functional spec 2.11). It runs in the
 * background: the project or storage call has already succeeded and its answer is not delayed.
 */
export function notifyGroupChanged(
  sessions: Pick<SessionService, 'groupChanged'>,
  groupId: string | null,
  change: GroupChange
): void {
  void sessions.groupChanged(groupId, change).catch((e: unknown) => {
    sessionsLog.error('could not apply a group change to the open sessions', e)
  })
}
