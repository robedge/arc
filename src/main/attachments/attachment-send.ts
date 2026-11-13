import { access, constants, copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MessageAttachmentView } from '@shared/attachments'
import type { AttachmentRef } from '../agents/agent-adapter'
import { AppErrorException } from '@shared/errors'
import type { Db, DbHandle } from '../db/client'
import { MessageAttachmentsRepo } from '../db/repositories/message-attachments-repo'
import { MessagesRepo } from '../db/repositories/messages-repo'
import type { MessageRow, NewMessageRow } from '../db/repositories/messages-repo'
import type { AttachmentService } from './attachment-service'
import {
  THUMB_NAME,
  sentAttachmentDir,
  sentAttachmentPath,
  sentAttachmentThumbPath
} from './attachment-paths'

/** `ENOENT`, `EACCES`, ...: the part of an fs error that is safe to log. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

/** A sent attachment with its absolute path: what the delivery to the agent starts from. */
export type StoredAttachment = AttachmentRef

export interface AttachmentSendDeps {
  db: Db
  staging: Pick<AttachmentService, 'staged' | 'release' | 'lockDraft'>
  /** `userData/sessions/<id>/`. */
  getSessionDir: (sessionId: string) => string
  now: () => number
  /** Never given an error object: an fs error's message holds a path. */
  log: { warn: (message: string) => void }
}

export interface AttachmentSendRequest {
  sessionId: string
  draftId: string
  ids: readonly string[]
  /** Builds the user message row in the same transaction as the attachment rows. */
  message: Omit<NewMessageRow, 'id'>
}

/** As a send, but the caller writes the message (and what must commit with it) in the transaction. */
export interface AttachmentSendInRequest {
  sessionId: string
  draftId: string
  ids: readonly string[]
  /** Runs inside the transaction before the attachment rows; returns the user message row. */
  write: (tx: DbHandle) => MessageRow
}

export interface AttachmentSendResult {
  message: MessageRow
  attachments: StoredAttachment[]
}

export function attachmentView(
  a: Pick<StoredAttachment, 'id' | 'name' | 'kind' | 'size'>
): MessageAttachmentView {
  return { id: a.id, name: a.name, kind: a.kind, size: a.size }
}

/**
 * Moves staged files into a session with its message: check, copy, one transaction, delete the
 * staged copies. A draft sends once: a second call finds nothing staged and fails the same way a
 * missing file does.
 */
export class AttachmentSender {
  constructor(private readonly deps: AttachmentSendDeps) {}

  send(req: AttachmentSendRequest): Promise<AttachmentSendResult> {
    const { message, ...rest } = req
    return this.sendIn({ ...rest, write: (tx) => new MessagesRepo(tx).append(message) })
  }

  sendIn(req: AttachmentSendInRequest): Promise<AttachmentSendResult> {
    return this.deps.staging.lockDraft(req.draftId, () => this.sendLocked(req))
  }

  private async sendLocked(req: AttachmentSendInRequest): Promise<AttachmentSendResult> {
    const { staging, getSessionDir } = this.deps
    const staged = staging.staged(req.draftId, req.ids)
    // 1) Every id must be staged and its file readable; nothing is written otherwise.
    if (staged.length !== req.ids.length) throw new AppErrorException('ATTACHMENT_UNREADABLE')
    for (const s of staged) {
      try {
        await access(s.path, constants.R_OK)
      } catch {
        throw new AppErrorException('ATTACHMENT_UNREADABLE', { name: s.meta.name })
      }
    }
    // 2) Copy into the session's attachments folder.
    const sessionDir = getSessionDir(req.sessionId)
    const copied: string[] = []
    const cleanup = async (): Promise<void> => {
      for (const dir of copied)
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
    const stored: StoredAttachment[] = []
    try {
      for (const s of staged) {
        const dir = sentAttachmentDir(sessionDir, s.meta.id)
        copied.push(dir)
        await mkdir(dir, { recursive: true })
        const path = sentAttachmentPath(sessionDir, s.meta.id, s.storedName)
        await copyFile(s.path, path)
        // The thumbnail is a convenience: an image without one is served as itself.
        if (s.meta.kind === 'image')
          await copyFile(
            join(dirname(s.path), THUMB_NAME),
            sentAttachmentThumbPath(sessionDir, s.meta.id)
          ).catch(() => undefined)
        stored.push({ ...s.meta, path })
      }
    } catch (error: unknown) {
      await cleanup()
      this.deps.log.warn(
        `could not copy ${staged.length} attachment(s) into session ${req.sessionId} (${codeOf(error)})`
      )
      throw new AppErrorException('IO_FAILED')
    }
    // 3) The message and its attachment rows, or neither.
    let message: MessageRow
    try {
      message = this.deps.db.transaction((tx) => {
        const row = req.write(tx)
        new MessageAttachmentsRepo(tx).insertMany(
          staged.map((s, position) => ({
            id: s.meta.id,
            messageId: row.id,
            sessionId: req.sessionId,
            position,
            kind: s.meta.kind,
            mime: s.meta.mime,
            sizeBytes: s.meta.size,
            name: s.meta.name,
            storedName: s.storedName,
            createdAt: this.deps.now()
          }))
        )
        return row
      })
    } catch (error: unknown) {
      await cleanup()
      throw error
    }
    // 4) The staged copies are no longer needed; a leftover is swept at the next start.
    await staging.release(req.draftId, req.ids)
    return { message, attachments: stored }
  }
}
