import type { AppServices } from '../../app/app-services'
import { handle } from '../register'

export function registerReviewHandlers(services: Pick<AppServices, 'sessions'>): void {
  const { sessions } = services
  handle('review:get', ({ sessionId }) => sessions.getReview(sessionId))
  handle('review:file', ({ sessionId, projectId, path, source, showAnyway }) =>
    sessions.getReviewFile(sessionId, projectId, path, showAnyway === true, source ?? 'session')
  )
  handle('review:undo-preview', ({ sessionId, projectId, path }) =>
    sessions.undoPreview(sessionId, projectId, path)
  )
  handle('review:undo', ({ sessionId, projectId, path }) =>
    sessions.undoFile(sessionId, projectId, path)
  )
  handle('review:push-preview', ({ sessionId, projectId }) =>
    sessions.pushPreview(sessionId, projectId)
  )
  handle('review:push', ({ sessionId, projectId }) => sessions.pushBranch(sessionId, projectId))
  handle('review:set-reviewed', ({ sessionId, projectId, path, reviewed }) =>
    sessions.setReviewed(sessionId, projectId, path, reviewed)
  )
  handle('review:note-create', (input) => sessions.createNote(input))
  handle('review:note-update', ({ noteId, body }) => sessions.updateNote(noteId, body))
  handle('review:note-delete', ({ noteId }) => sessions.deleteNote(noteId))
  handle('review:send-notes', ({ sessionId }) => sessions.sendReviewNotes(sessionId))
}
