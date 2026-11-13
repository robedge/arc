import type { AppServices } from '../../app/app-services'
import { handle } from '../register'

type AttachmentServices = Pick<AppServices, 'attachments'>

export function registerAttachmentHandlers(services: AttachmentServices): void {
  const { attachments } = services
  handle('attachments:new-draft', () => attachments.newDraft())
  handle('attachments:stage-paths', ({ draftId, paths }) => attachments.stagePaths(draftId, paths))
  handle('attachments:stage-bytes', ({ draftId, bytes }) => attachments.stageBytes(draftId, bytes))
  handle('attachments:pick', ({ draftId }) => attachments.pick(draftId))
  handle('attachments:remove', ({ draftId, id }) => attachments.remove(draftId, id))
  handle('attachments:discard-draft', ({ draftId }) => attachments.discardDraft(draftId))
}
