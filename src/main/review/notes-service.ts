import { randomUUID } from 'node:crypto'
import { AppErrorException } from '../../shared/errors'
import type { ReviewNote, ReviewNoteSide } from '../../shared/types/review'
import type { ReviewNotesRepo, SessionReviewNote } from '../db/repositories/review-notes-repo'
import type { SessionProjectsRepo } from '../db/repositories/session-projects-repo'
import type { ReviewService } from './review-service'

export const MAX_BODY_CHARS = 4000
export const MAX_LINE_TEXT_CHARS = 500
export const MAX_DRAFTS = 50

export interface NotesLog {
  warn: (message: string, ...rest: unknown[]) => void
}

export interface NotesServiceDeps {
  notesRepo: Pick<
    ReviewNotesRepo,
    | 'create'
    | 'get'
    | 'listBySession'
    | 'listDrafts'
    | 'countDrafts'
    | 'update'
    | 'delete'
    | 'markSent'
  >
  sessionProjectsRepo: Pick<SessionProjectsRepo, 'listBySession'>
  reviewService: Pick<ReviewService, 'getFile'>
  log: NotesLog
  now?: () => number
}

export interface CreateNoteInput {
  sessionId: string
  projectId: string
  path: string
  side: ReviewNoteSide
  line: number
  lineText: string
  body: string
}

/** Posts a visible user message to the session's brain; `SessionService.sendMessage`. */
export type SendMessage = (sessionId: string, text: string) => Promise<{ messageId: number }>

const truncate = (text: string): string =>
  text.length > MAX_LINE_TEXT_CHARS ? text.slice(0, MAX_LINE_TEXT_CHARS) : text

function checkedBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed === '' || trimmed.length > MAX_BODY_CHARS) {
    throw new AppErrorException('VALIDATION_FAILED')
  }
  return trimmed
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The text of the lines a file's hunks show, by number on each side. Context lines are on both sides;
 * `null` when the file has no text diff (binary, too large) or is no longer a changed file.
 */
interface AnchorLines {
  old: Map<number, string>
  new: Map<number, string>
}

/**
 * Review notes (tech spec 2.6): drafts the user writes on diff lines, sent together as one conversation message.
 * A note anchors on path + side + line number + the line's text; it is stale when the current diff no longer
 * has that text at that line.
 */
export class NotesService {
  private readonly sending = new Set<string>()

  constructor(private readonly deps: NotesServiceDeps) {}

  /** `review:note-create`. The path must be a changed file and the line must be shown in its current diff. */
  async create(input: CreateNoteInput): Promise<ReviewNote> {
    const body = checkedBody(input.body)
    const row = this.deps.sessionProjectsRepo
      .listBySession(input.sessionId)
      .find((r) => r.projectId === input.projectId)
    if (!row) throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    const anchors = await this.anchorsOf(input.sessionId, input.projectId, input.path)
    if (anchors === 'missing') throw new AppErrorException('REVIEW_FILE_NOT_FOUND')
    const current = anchors?.[input.side].get(input.line)
    const lineText = truncate(input.lineText)
    if (current === undefined || truncate(current) !== lineText) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    if (this.deps.notesRepo.countDrafts(input.sessionId) >= MAX_DRAFTS) {
      throw new AppErrorException('TOO_MANY_NOTES')
    }
    const at = (this.deps.now ?? Date.now)()
    const created = this.deps.notesRepo.create({
      id: randomUUID(),
      sessionProjectId: row.id,
      path: input.path,
      side: input.side,
      line: input.line,
      lineText,
      body,
      state: 'draft',
      messageId: null,
      createdAt: at,
      updatedAt: at
    })
    return toNote({ ...created, projectId: input.projectId, sessionId: input.sessionId }, false)
  }

  /** `review:note-update`: drafts only. */
  async update(noteId: string, body: string): Promise<ReviewNote> {
    const trimmed = checkedBody(body)
    const existing = this.requireNote(noteId)
    if (existing.state !== 'draft') throw new AppErrorException('NOT_DRAFT')
    if (!this.deps.notesRepo.update(noteId, trimmed, (this.deps.now ?? Date.now)())) {
      throw this.refusal(noteId)
    }
    const updated = this.requireNote(noteId)
    return toNote(updated, (await this.staleIds(existing.sessionId, [updated])).has(noteId))
  }

  /** `review:note-delete`: drafts only. */
  delete(noteId: string): void {
    const existing = this.requireNote(noteId)
    if (existing.state !== 'draft') throw new AppErrorException('NOT_DRAFT')
    if (!this.deps.notesRepo.delete(noteId)) throw this.refusal(noteId)
  }

  /** Every note of the session with `stale` worked out against the current diff (for `review:get`). */
  async list(sessionId: string): Promise<ReviewNote[]> {
    const notes = this.deps.notesRepo.listBySession(sessionId)
    const stale = await this.staleIds(sessionId, notes)
    return notes.map((n) => toNote(n, stale.has(n.id)))
  }

  /**
   * `review:send-notes`: every draft becomes one visible user message, then all are marked sent with that
   * message's id. `VALIDATION_FAILED` without drafts.
   */
  async send(
    sessionId: string,
    sendMessage: SendMessage
  ): Promise<{ messageId: number; count: number }> {
    if (this.sending.has(sessionId)) throw new AppErrorException('VALIDATION_FAILED')
    this.sending.add(sessionId)
    try {
      const drafts = this.deps.notesRepo.listDrafts(sessionId)
      if (drafts.length === 0) throw new AppErrorException('VALIDATION_FAILED')
      const text = this.formatMessage(sessionId, drafts)
      const { messageId } = await sendMessage(sessionId, text)
      const marked = this.deps.notesRepo.markSent(
        drafts.map((d) => d.id),
        messageId,
        (this.deps.now ?? Date.now)()
      )
      if (!marked) {
        this.deps.log.warn('review notes changed while they were being sent; they stay as drafts')
      }
      return { messageId, count: drafts.length }
    } finally {
      this.sending.delete(sessionId)
    }
  }

  /** The conversation message for a set of drafts (tech spec 2.6). */
  private formatMessage(sessionId: string, drafts: readonly SessionReviewNote[]): string {
    const names = new Map(
      this.deps.sessionProjectsRepo.listBySession(sessionId).map((r) => [r.id, r.projectName])
    )
    const repoOf = (n: SessionReviewNote): string => names.get(n.sessionProjectId) ?? ''
    const ordered = [...drafts].sort(
      (a, b) =>
        byText(repoOf(a), repoOf(b)) ||
        byText(a.path, b.path) ||
        byText(a.side === 'old' ? '0' : '1', b.side === 'old' ? '0' : '1') ||
        a.line - b.line ||
        a.createdAt - b.createdAt
    )
    const lines = [`Review notes (${ordered.length}):`]
    ordered.forEach((n, i) => {
      lines.push(`${i + 1}. ${repoOf(n)} · ${n.path} · line ${n.line} (${n.side})`)
      lines.push(`   > ${n.lineText}`)
      for (const bodyLine of n.body.split(/\r?\n/)) lines.push(`   ${bodyLine}`)
    })
    return lines.join('\n')
  }

  private requireNote(noteId: string): SessionReviewNote {
    const note = this.deps.notesRepo.get(noteId)
    if (!note) throw new AppErrorException('NOTE_NOT_FOUND')
    return note
  }

  /** A guarded write that returned false: the note was sent or deleted in between. */
  private refusal(noteId: string): AppErrorException {
    const now = this.deps.notesRepo.get(noteId)
    return new AppErrorException(now === undefined ? 'NOTE_NOT_FOUND' : 'NOT_DRAFT')
  }

  /**
   * The lines of one file's current diff by side, `null` when the diff has no text, `'missing'` when the
   * path is not a changed file of the project.
   */
  private async anchorsOf(
    sessionId: string,
    projectId: string,
    path: string
  ): Promise<AnchorLines | null | 'missing'> {
    let diff
    try {
      diff = await this.deps.reviewService.getFile(sessionId, projectId, path, true)
    } catch (error: unknown) {
      if (error instanceof AppErrorException && error.code === 'REVIEW_FILE_NOT_FOUND') {
        return 'missing'
      }
      throw error
    }
    if (diff.kind !== 'text') return null
    const lines: AnchorLines = { old: new Map(), new: new Map() }
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== 'add' && line.oldNo !== undefined) lines.old.set(line.oldNo, line.text)
        if (line.kind !== 'del' && line.newNo !== undefined) lines.new.set(line.newNo, line.text)
      }
    }
    return lines
  }

  /** Ids of the notes whose anchor is gone, checking each file that has notes once. */
  private async staleIds(
    sessionId: string,
    notes: readonly SessionReviewNote[]
  ): Promise<Set<string>> {
    const groups = new Map<string, SessionReviewNote[]>()
    for (const note of notes) {
      const key = `${note.projectId ?? ''}\0${note.path}`
      groups.set(key, [...(groups.get(key) ?? []), note])
    }
    const stale = new Set<string>()
    await Promise.all(
      [...groups.values()].map(async (group) => {
        const [first] = group
        if (!first) return
        let anchors: AnchorLines | null | 'missing' = 'missing'
        if (first.projectId !== null) {
          try {
            anchors = await this.anchorsOf(sessionId, first.projectId, first.path)
          } catch (error: unknown) {
            this.deps.log.warn(`could not check the notes on ${first.path}`, error)
            return
          }
        }
        for (const note of group) {
          const current =
            anchors === 'missing' || anchors === null
              ? undefined
              : anchors[note.side].get(note.line)
          if (current === undefined || truncate(current) !== note.lineText) stale.add(note.id)
        }
      })
    )
    return stale
  }
}

function toNote(row: SessionReviewNote, stale: boolean): ReviewNote {
  return {
    id: row.id,
    projectId: row.projectId ?? '',
    path: row.path,
    side: row.side,
    line: row.line,
    lineText: row.lineText,
    body: row.body,
    state: row.state,
    stale,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.messageId !== null ? { messageId: row.messageId } : {})
  }
}
