import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ATTACHMENTS_MAX_PER_MESSAGE,
  type AttachmentMeta,
  type AttachmentRefusal,
  type StageResult
} from '@shared/attachments'
import { AppErrorException } from '@shared/errors'
import { ulid } from '../db/ids'
import type { Dialogs } from '../platform/dialogs'
import { THUMB_NAME, avoidThumbName } from './attachment-paths'
import {
  displayName,
  sanitizeName,
  validateAttachment,
  validateImageBytes
} from './attachment-validate'

/** Writes a 96 px high PNG of the image at `src` to `dest`; false when the image cannot be decoded. */
export type MakeThumbnail = (src: string, dest: string) => Promise<boolean>

/** A file copied into the staging folder and not yet sent. */
export interface StagedAttachment {
  draftId: string
  meta: AttachmentMeta
  storedName: string
  /** Absolute path of the staged copy. */
  path: string
}

export interface AttachmentServiceDeps {
  /** `userData/attachment-staging`. */
  stagingRoot: string
  dialogs: Dialogs
  /** Absent: no thumbnails (an image is then served as itself). */
  makeThumbnail?: MakeThumbnail
}

/** Stages files for a message that is not sent yet. Never logs names, paths or contents. */
export class AttachmentService {
  private readonly stagingRoot: string
  private readonly dialogs: Dialogs
  private readonly makeThumbnail: MakeThumbnail | undefined
  /** Pasted images accepted so far per draft: names never repeat within a draft, even after removals. */
  private readonly pasted = new Map<string, number>()
  private readonly drafts = new Map<string, Map<string, StagedAttachment>>()
  private readonly byId = new Map<string, StagedAttachment>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(deps: AttachmentServiceDeps) {
    this.stagingRoot = deps.stagingRoot
    this.dialogs = deps.dialogs
    this.makeThumbnail = deps.makeThumbnail
  }

  newDraft(): { draftId: string } {
    const draftId = ulid()
    this.drafts.set(draftId, new Map())
    return { draftId }
  }

  /** Validates and copies each path; the refused ones are reported and the rest are kept. */
  async stagePaths(draftId: string, paths: readonly string[]): Promise<StageResult> {
    this.requireDraft(draftId)
    return this.withLock(draftId, async () => {
      const attachments: AttachmentMeta[] = []
      const refused: AttachmentRefusal[] = []
      for (const path of paths) {
        const name = displayName(path)
        const verdict = await validateAttachment(path)
        if (!verdict.ok) {
          refused.push({ name, reason: verdict.reason })
          continue
        }
        const draft = this.drafts.get(draftId)
        if (!draft) throw this.unknownDraft()
        if (draft.size >= ATTACHMENTS_MAX_PER_MESSAGE) {
          refused.push({ name, reason: 'too_many' })
          continue
        }
        const id = ulid()
        const storedName = avoidThumbName(sanitizeName(name))
        const folder = join(this.stagingRoot, draftId, id)
        const target = join(folder, storedName)
        try {
          await mkdir(folder, { recursive: true })
          await copyFile(verdict.realPath, target)
        } catch {
          await rm(folder, { recursive: true, force: true })
          refused.push({ name, reason: 'unreadable' })
          continue
        }
        const meta: AttachmentMeta = {
          id,
          name,
          kind: verdict.kind,
          mime: verdict.mime,
          size: verdict.size
        }
        await this.thumbnail(meta.kind, target, folder)
        const staged: StagedAttachment = { draftId, meta, storedName, path: target }
        draft.set(id, staged)
        this.byId.set(id, staged)
        attachments.push(meta)
      }
      return { attachments, refused }
    })
  }

  /** Stages one pasted image. The bytes are checked like a file; the name is "Pasted image N". */
  async stageBytes(draftId: string, bytes: Uint8Array): Promise<StageResult> {
    this.requireDraft(draftId)
    return this.withLock(draftId, async () => {
      const draft = this.drafts.get(draftId)
      if (!draft) throw this.unknownDraft()
      const n = (this.pasted.get(draftId) ?? 0) + 1
      const name = `Pasted image ${n}`
      const refuse = (reason: AttachmentRefusal['reason']): StageResult => ({
        attachments: [],
        refused: [{ name, reason }]
      })
      const verdict = validateImageBytes(bytes)
      if (!verdict.ok) return refuse(verdict.reason)
      if (draft.size >= ATTACHMENTS_MAX_PER_MESSAGE) return refuse('too_many')
      const id = ulid()
      const storedName = `pasted-image-${n}.${verdict.ext}`
      const folder = join(this.stagingRoot, draftId, id)
      const target = join(folder, storedName)
      try {
        await mkdir(folder, { recursive: true })
        await writeFile(target, bytes)
      } catch {
        await rm(folder, { recursive: true, force: true })
        return refuse('unreadable')
      }
      this.pasted.set(draftId, n)
      const meta: AttachmentMeta = {
        id,
        name,
        kind: 'image',
        mime: verdict.mime,
        size: verdict.size
      }
      await this.thumbnail('image', target, folder)
      const staged: StagedAttachment = { draftId, meta, storedName, path: target }
      draft.set(id, staged)
      this.byId.set(id, staged)
      return { attachments: [meta], refused: [] }
    })
  }

  /** Best effort: a missing thumbnail never fails staging. */
  private async thumbnail(
    kind: AttachmentMeta['kind'],
    file: string,
    folder: string
  ): Promise<void> {
    if (kind !== 'image' || !this.makeThumbnail) return
    const dest = join(folder, THUMB_NAME)
    try {
      if (!(await this.makeThumbnail(file, dest))) await rm(dest, { force: true })
    } catch {
      await rm(dest, { force: true }).catch(() => undefined)
    }
  }

  /** Opens the file picker (no extension filter: validation decides) and stages what was chosen. */
  async pick(draftId: string): Promise<StageResult> {
    this.requireDraft(draftId)
    const paths = await this.dialogs.pickFiles({ multi: true })
    if (!paths) return { attachments: [], refused: [] }
    return this.stagePaths(draftId, paths)
  }

  /** Deletes one staged attachment; an id that is not staged is ignored. */
  async remove(draftId: string, id: string): Promise<void> {
    this.requireDraft(draftId)
    return this.withLock(draftId, async () => {
      const staged = this.drafts.get(draftId)?.get(id)
      if (!staged) return
      this.drafts.get(draftId)?.delete(id)
      this.byId.delete(id)
      await rm(join(this.stagingRoot, draftId, id), { recursive: true, force: true })
    })
  }

  /** Deletes the draft and everything staged for it. */
  async discardDraft(draftId: string): Promise<void> {
    this.requireDraft(draftId)
    return this.withLock(draftId, async () => {
      for (const id of this.drafts.get(draftId)?.keys() ?? []) this.byId.delete(id)
      this.drafts.delete(draftId)
      this.pasted.delete(draftId)
      await rm(join(this.stagingRoot, draftId), { recursive: true, force: true })
    })
  }

  /** The staged attachments of `draftId` among `ids`, in the order of `ids`; unknown ids are left out. */
  staged(draftId: string, ids: readonly string[]): StagedAttachment[] {
    const draft = this.drafts.get(draftId)
    if (!draft) return []
    return ids.flatMap((id) => draft.get(id) ?? [])
  }

  /** Runs `task` after the draft's earlier tasks (stage, remove, send), one at a time. */
  lockDraft<T>(draftId: string, task: () => Promise<T>): Promise<T> {
    return this.withLock(draftId, task)
  }

  /** After a send: forgets `ids` and deletes their staged folders. Best effort; never throws. Call under `lockDraft`. */
  async release(draftId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.drafts.get(draftId)?.delete(id)
      this.byId.delete(id)
      await rm(join(this.stagingRoot, draftId, id), { recursive: true, force: true }).catch(
        () => undefined
      )
    }
  }

  /** One staged attachment by id, whatever its draft: what the protocol serves from. */
  stagedById(id: string): StagedAttachment | undefined {
    return this.byId.get(id)
  }

  /** The staged copy's absolute path, for the protocol and the send path. */
  stagedPath(id: string): string | undefined {
    return this.byId.get(id)?.path
  }

  private unknownDraft(): AppErrorException {
    return new AppErrorException('VALIDATION_FAILED', { reason: 'unknown attachment draft' })
  }

  private requireDraft(draftId: string): void {
    if (!this.drafts.has(draftId)) throw this.unknownDraft()
  }

  private withLock<T>(draftId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(draftId) ?? Promise.resolve()).then(task, task)
    const tail = run.catch(() => undefined)
    this.locks.set(draftId, tail)
    void tail.then(() => {
      if (this.locks.get(draftId) === tail) this.locks.delete(draftId)
    })
    return run
  }
}
