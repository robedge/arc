import { createHash, randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { AppErrorException } from '@shared/errors'
import type { AppError } from '@shared/errors'
import type { IpcEvents } from '@shared/ipc/contract'
import { IMPORT_MAX_BYTES, TEXT_EXTENSIONS } from '@shared/limits'
import { diffLines } from '@shared/text-diff'
import type {
  AcceptAllItemResult,
  AcceptAllResult,
  AcceptOutcome,
  KnowledgeSuggestionEdits,
  KnowledgeSuggestionView
} from '@shared/types/knowledge-suggestion'
import type {
  KnowledgeSuggestionInsertResult,
  KnowledgeSuggestionRow,
  KnowledgeSuggestionsRepo
} from '../db/repositories/knowledge-suggestions-repo'
import type { SectionRow, SectionsRepo } from '../db/repositories/sections-repo'
import type { ItemSummary } from '@shared/types/item'
import type { KnowledgeItemsRepo } from '../db/repositories/knowledge-items-repo'
import type { KnowledgeService } from './knowledge-service'
import { isNameTaken, resolveInRoot, sanitizeName } from './knowledge-paths'
import { toKnowledgeSuggestionView } from './knowledge-suggestion-view'

/** Why a suggestion was refused, in terms the caller (the bridge tool) can map to a hint. */
export type KnowledgeSuggestionRefusal =
  | 'unknown_section'
  | 'section_not_allowed'
  | 'not_text_file'
  | 'file_not_found'
  | 'edit_not_found'
  | 'edit_ambiguous'
  | 'invalid_name'
  | 'name_taken'
  | 'duplicate'
  | 'already_discarded'
  | 'cap_reached'

/** The most suggestions the brain may make for one request (functional spec 2.1). */
export const MAX_SUGGESTIONS_PER_REQUEST = 5

/** Thrown by `suggest` for a refusal the brain can act on. Never thrown for a bug. */
export class KnowledgeSuggestionRefused extends Error {
  constructor(
    readonly code: KnowledgeSuggestionRefusal,
    message: string,
    /** For `unknown_section`: the section names that can take a suggestion. */
    readonly validSections?: string[]
  ) {
    super(message)
    this.name = 'KnowledgeSuggestionRefused'
  }
}

interface SuggestBase {
  title: string
  reason: string
  /** Section name or folder, matched case-insensitively. */
  section: string
}

export interface SuggestNewInput extends SuggestBase {
  kind: 'new'
  /** May end in an extension from `TEXT_EXTENSIONS`; `.md` when it does not. */
  name: string
  content: string
}

export interface SuggestUpdateInput extends SuggestBase {
  kind: 'update'
  file: string
  edits: { old_text: string; new_text: string }[]
}

export type SuggestInput = SuggestNewInput | SuggestUpdateInput

export interface SuggestResult {
  id: string
  /** How many more suggestions this request may still make. */
  remainingThisRequest: number
}

export interface KnowledgeSuggestionServiceDeps {
  repo: KnowledgeSuggestionsRepo
  sectionsRepo: Pick<SectionsRepo, 'listByGroup'>
  getKnowledgeRoot: (groupId: string) => string
  /** Writes the accepted note, and reads the notes an update suggestion changes. */
  knowledge: Pick<KnowledgeService, 'createWithContent' | 'read' | 'reconcileAndList' | 'save'>
  /** Finds the item an update suggestion changes, for the view. */
  itemsRepo: Pick<KnowledgeItemsRepo, 'getByRelPath'>
  /** Announces the file Accept wrote; the watcher drops Arc's own writes. */
  emitChanged: (payload: IpcEvents['knowledge:changed']) => void
  /** True while a storage move runs for the group; Accept then fails with STORAGE_BUSY. */
  isStorageLocked?: (groupId: string) => boolean
  /** Writes a session event; works with or without a running orchestrator. */
  logSessionEvent: (sessionId: string, kind: string, text: string, data?: unknown) => void
  /** Pushes a session's full waiting list to the renderer. */
  publish: (sessionId: string, waiting: KnowledgeSuggestionView[]) => void
  /** Told the titles of suggestions the user discarded, so the brain can hear of it. Never for an accept. */
  onDiscarded?: (sessionId: string, titles: string[]) => void
  now?: () => number
  newId?: () => string
}

const DEFAULT_EXTENSION = '.md'
const TRAILING_EXTENSION = /\.([A-Za-z][A-Za-z0-9]{0,7})$/

const sectionKey = (value: string): string => value.normalize('NFC').trim().toLowerCase()
const canAcceptSuggestions = (section: SectionRow): boolean =>
  section.kind !== 'projects' && section.kind !== 'links' && section.folderName !== null

/**
 * The brain's knowledge suggestions. `suggest` stores one and nothing else: no file in the knowledge
 * folder is touched until the user accepts (a later step).
 */
export class KnowledgeSuggestionService {
  private readonly now: () => number
  private readonly newId: () => string

  constructor(private readonly deps: KnowledgeSuggestionServiceDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
  }

  /** Stores one suggestion for the session; throws `KnowledgeSuggestionRefused` when it is not allowed. */
  async suggest(
    sessionId: string,
    groupId: string,
    requestId: string,
    input: SuggestInput
  ): Promise<SuggestResult> {
    this.assertRoom(sessionId, requestId)
    const section = this.resolveSection(groupId, input.section)
    if (input.kind === 'update') {
      return this.suggestUpdate(sessionId, groupId, requestId, input, section)
    }
    const folder = section.folderName ?? ''
    const fileName = await this.safeFileName(groupId, folder, input.name)
    const key = dedupeKey(sessionId, 'new', section.id, fileName, input.content)
    // A repeat is named as one before the name check: once accepted, its file is on disk and would read as a taken name.
    const known = this.deps.repo.getByDedupeKey(key)
    if (known !== undefined) throw repeatRefusal(known.status)
    if (await this.nameExists(groupId, folder, fileName)) {
      throw new KnowledgeSuggestionRefused(
        'name_taken',
        `A note named "${fileName}" already exists in ${section.name}.`
      )
    }
    this.assertRoom(sessionId, requestId)
    const result = this.deps.repo.insert({
      id: this.newId(),
      sessionId,
      groupId,
      requestId,
      action: 'new',
      title: input.title,
      reason: input.reason,
      sectionId: section.id,
      sectionName: section.name,
      proposedName: fileName,
      proposedContent: input.content,
      dedupeKey: key,
      createdAt: this.now()
    })
    return this.store(sessionId, requestId, result)
  }

  /**
   * Stores a change to an existing note. The edits are applied in memory to the note's body (what
   * `KnowledgeService.read` returns, without front matter), so `proposed_content` is exactly the text a
   * later accept passes to `KnowledgeService.save` together with `base_revision`. The file is not touched.
   */
  private async suggestUpdate(
    sessionId: string,
    groupId: string,
    requestId: string,
    input: SuggestUpdateInput,
    section: SectionRow
  ): Promise<SuggestResult> {
    const item = await this.findFile(groupId, section, input.file)
    const current = await this.deps.knowledge.read(item.id)
    if (current.type !== 'text') {
      throw new KnowledgeSuggestionRefused('not_text_file', `${item.fileName} is not a text file.`)
    }
    const result = applyEdits(current.content, input.edits)
    if (result === current.content) {
      throw new KnowledgeSuggestionRefused(
        'duplicate',
        `${item.fileName} already says this: the edits change nothing.`
      )
    }
    const relPath = `${section.folderName ?? ''}/${item.folder === undefined || item.folder === '' ? '' : `${item.folder}/`}${item.fileName}`
    const hunks = diffLines(current.content, result)
    this.assertRoom(sessionId, requestId)
    const stored = this.deps.repo.insert({
      id: this.newId(),
      sessionId,
      groupId,
      requestId,
      action: 'update',
      title: input.title,
      reason: input.reason,
      sectionId: section.id,
      sectionName: section.name,
      targetRelPath: relPath,
      proposedContent: result,
      // Null when the file is too long to diff; a real update always has at least one hunk.
      hunksJson: hunks === null ? null : JSON.stringify(hunks),
      baseRevision: current.revision,
      dedupeKey: dedupeKey(sessionId, 'update', section.id, relPath, result),
      createdAt: this.now()
    })
    return this.store(sessionId, requestId, stored)
  }

  /** Resolves the brain's `file` to an editable text item of the section. */
  private async findFile(
    groupId: string,
    section: SectionRow,
    wanted: string
  ): Promise<ItemSummary> {
    const segments = wanted
      .normalize('NFC')
      .replace(/\\/g, '/')
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s !== '' && s !== '.')
    const notFound = (why: string): KnowledgeSuggestionRefused =>
      new KnowledgeSuggestionRefused(
        'file_not_found',
        `No file "${wanted}" in ${section.name}. ${why}`
      )
    if (segments.length === 0) throw notFound('The file name is empty.')
    try {
      await resolveInRoot(this.deps.getKnowledgeRoot(groupId), [
        section.folderName ?? '',
        ...segments
      ])
    } catch (error: unknown) {
      if (error instanceof AppErrorException && error.code === 'PATH_OUTSIDE_ROOT') {
        throw notFound('The path is not allowed.')
      }
      throw error
    }
    const wantedKey = segments.join('/').toLowerCase()
    const matches = (await this.deps.knowledge.reconcileAndList(section.id)).filter((item) => {
      const path = item.folder ? `${item.folder}/${item.fileName}` : item.fileName
      const key = path.normalize('NFC').toLowerCase()
      return key === wantedKey || withoutMd(key) === wantedKey
    })
    // A bare file name may also name a file in a subfolder, when exactly one file has that name.
    const found =
      matches[0] ??
      (segments.length === 1 ? await this.uniqueByName(section, wantedKey) : undefined)
    if (found === undefined) throw notFound('Use the name or path shown in the section.')
    if (found.kind === 'link' || !found.editable) {
      throw new KnowledgeSuggestionRefused(
        'not_text_file',
        `${found.fileName} cannot be edited as text.`
      )
    }
    return found
  }

  private async uniqueByName(
    section: SectionRow,
    wantedKey: string
  ): Promise<ItemSummary | undefined> {
    const named = (await this.deps.knowledge.reconcileAndList(section.id)).filter((item) => {
      const key = item.fileName.normalize('NFC').toLowerCase()
      return key === wantedKey || withoutMd(key) === wantedKey
    })
    return named.length === 1 ? named[0] : undefined
  }

  /** The shared tail of `suggest`: a refusal for a repeat, else the event and the pushed list. */
  private store(
    sessionId: string,
    requestId: string,
    result: KnowledgeSuggestionInsertResult
  ): SuggestResult {
    if (!result.inserted) {
      throw repeatRefusal(result.existing.status)
    }
    this.deps.logSessionEvent(
      sessionId,
      'knowledge-suggested',
      eventText(result.row),
      eventData(result.row)
    )
    this.push(sessionId)
    return {
      id: result.row.id,
      remainingThisRequest: Math.max(
        0,
        MAX_SUGGESTIONS_PER_REQUEST - this.deps.repo.countForRequest(sessionId, requestId)
      )
    }
  }

  /**
   * Refuses when the request already has its five. Every suggestion made for the request uses a slot
   * whatever happened to it since, and a refused call never made one. Checked first, so a call that
   * cannot be stored anyway says so, and again just before the insert, which runs with no await after
   * it, so two calls in flight together cannot both take the last slot.
   */
  private assertRoom(sessionId: string, requestId: string): void {
    if (this.deps.repo.countForRequest(sessionId, requestId) >= MAX_SUGGESTIONS_PER_REQUEST) {
      throw new KnowledgeSuggestionRefused(
        'cap_reached',
        `This request already has ${MAX_SUGGESTIONS_PER_REQUEST} suggestions.`
      )
    }
  }

  listWaiting(sessionId: string): KnowledgeSuggestionView[] {
    return this.deps.repo
      .listWaiting(sessionId)
      .map((row) =>
        toKnowledgeSuggestionView(
          row,
          (relPath) => this.deps.itemsRepo.getByRelPath(row.groupId, relPath)?.id
        )
      )
  }

  /** Marks a waiting suggestion discarded. An id that is not waiting is ignored. */
  discard(id: string): void {
    const row = this.deps.repo.get(id)
    if (row === undefined || !this.deps.repo.setOutcome(id, 'discarded', this.now())) return
    this.deps.logSessionEvent(
      row.sessionId,
      'knowledge-discarded',
      `${eventText(row)} · Discarded`,
      eventData(row)
    )
    this.push(row.sessionId)
    this.deps.onDiscarded?.(row.sessionId, [row.title])
  }

  /**
   * Discards every waiting suggestion of the session: one `knowledge-discarded` event each and one push.
   * Oldest first. Returns the id and title of each, so the caller can tell the brain what the user threw away.
   */
  discardAll(sessionId: string): { id: string; title: string }[] {
    const waiting = [...this.deps.repo.listWaiting(sessionId)].reverse()
    const done = new Set(this.deps.repo.discardAllWaiting(sessionId, this.now()))
    const discarded = waiting.filter((row) => done.has(row.id))
    for (const row of discarded) {
      this.deps.logSessionEvent(
        sessionId,
        'knowledge-discarded',
        `${eventText(row)} · Discarded`,
        eventData(row)
      )
    }
    if (discarded.length > 0) {
      this.push(sessionId)
      this.deps.onDiscarded?.(
        sessionId,
        discarded.map((row) => row.title)
      )
    }
    return discarded.map((row) => ({ id: row.id, title: row.title }))
  }

  /**
   * Applies every waiting suggestion of the session as suggested, oldest first and one after another.
   * A failure never stops the batch: that suggestion stays waiting and its error is in its result. The
   * waiting list is pushed once at the end, and only when something was applied.
   */
  async acceptAll(sessionId: string): Promise<AcceptAllResult> {
    const oldestFirst = [...this.deps.repo.listWaiting(sessionId)].reverse()
    const results: AcceptAllItemResult[] = []
    for (const { id } of oldestFirst) {
      try {
        results.push({ id, outcome: await this.applyAccept(id) })
      } catch (error: unknown) {
        results.push({ id, error: toAppError(error) })
      }
    }
    if (results.some((r) => 'outcome' in r)) this.push(sessionId)
    return { results }
  }

  /**
   * Applies a waiting suggestion. Nothing is written and the suggestion stays waiting on any failure.
   * `edits` carries what the user changed: `text` (a new note, an update, or "Add as a new note"), and
   * `name` and `sectionId` (a new note, or "Add as a new note"; ignored for an update whose file exists).
   * Each falls back to the suggestion's own value and is validated like a suggestion. When the saved
   * values differ from the suggestion's, the status is `accepted_edited` and the outcome `edited`.
   */
  async accept(id: string, edits?: KnowledgeSuggestionEdits): Promise<AcceptOutcome> {
    const outcome = await this.applyAccept(id, edits)
    this.push(this.deps.repo.get(id)?.sessionId ?? '')
    return outcome
  }

  /** Everything `accept` does except pushing the waiting list, which `acceptAll` does once. */
  private async applyAccept(id: string, edits?: KnowledgeSuggestionEdits): Promise<AcceptOutcome> {
    const row = this.deps.repo.get(id)
    if (row === undefined || row.status !== 'waiting') {
      throw new AppErrorException('SUGGESTION_NOT_FOUND')
    }
    if (row.action === 'new' ? row.proposedName === null : row.targetRelPath === null) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    if (row.action === 'update' && row.baseRevision === null) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    if (this.deps.isStorageLocked?.(row.groupId) === true) {
      throw new AppErrorException('STORAGE_BUSY')
    }
    const text = editedText(row, edits)
    if (row.action === 'update') return this.acceptUpdate(row, text, edits)

    const stored = row.proposedName ?? ''
    const sectionId = edits?.sectionId ?? row.sectionId
    const section = this.requireAllowedSection(row.groupId, sectionId)
    const { fileName } = await this.checkedName(row.groupId, section, edits?.name ?? stored)
    // The stored name must already be the safe form; a tampered row is refused, never repaired.
    if (edits?.name === undefined && fileName !== stored) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    const item = await this.createNote(section, fileName, text)
    const edited =
      text !== row.proposedContent || fileName !== stored || sectionId !== row.sectionId
    return this.finishAccepted(row, section, item, edited ? text : undefined)
  }

  /**
   * Applies an update through `KnowledgeService.save` with the revision stored at suggest time, so a note
   * edited since refuses with `EXTERNAL_MODIFIED`. A deleted file is checked first and yields
   * `ITEM_NOT_FOUND`; with a `name` it becomes a new note instead.
   */
  private async acceptUpdate(
    row: KnowledgeSuggestionRow,
    text: string,
    edits: KnowledgeSuggestionEdits | undefined
  ): Promise<AcceptOutcome> {
    const section = this.requireAllowedSection(row.groupId, row.sectionId)
    const relPath = row.targetRelPath ?? ''
    const root = this.deps.getKnowledgeRoot(row.groupId)
    const segments = relPath.split('/')
    let path: string
    try {
      path = await resolveInRoot(root, segments)
    } catch (error: unknown) {
      if (error instanceof AppErrorException && error.code === 'PATH_OUTSIDE_ROOT') {
        throw new AppErrorException('VALIDATION_FAILED')
      }
      throw withLocation(error, join(root, section.folderName ?? ''))
    }
    const location = dirname(path)
    const exists = await fileExists(path, location)
    if (!exists) {
      // "Add as a new note": the target is gone, so the proposed text becomes a new file.
      if (edits?.name === undefined) throw new AppErrorException('ITEM_NOT_FOUND')
      return this.acceptAsNew(row, text, edits.name, edits.sectionId ?? row.sectionId)
    }
    if (segments[0] !== section.folderName) throw new AppErrorException('VALIDATION_FAILED')
    const item = await this.findItem(row.groupId, section.id, relPath)
    let saved: { revision: string }
    try {
      saved = await this.deps.knowledge.save(item.id, text, row.baseRevision ?? '')
    } catch (error: unknown) {
      throw withLocation(error, location)
    }
    return this.finishAccepted(
      row,
      section,
      { id: item.id, fileName: posix.basename(relPath), revision: saved.revision },
      text !== row.proposedContent ? text : undefined
    )
  }

  private async acceptAsNew(
    row: KnowledgeSuggestionRow,
    text: string,
    name: string,
    sectionId: string
  ): Promise<AcceptOutcome> {
    const section = this.requireAllowedSection(row.groupId, sectionId)
    const { fileName } = await this.checkedName(row.groupId, section, name)
    const item = await this.createNote(section, fileName, text)
    // The name and section are required here (the target is gone), so only the text can be an edit.
    const edited = text !== row.proposedContent
    return this.finishAccepted(row, section, item, edited ? text : undefined)
  }

  /** The item row of an existing file, indexing the section first when the file is new to Arc. */
  private async findItem(
    groupId: string,
    sectionId: string,
    relPath: string
  ): Promise<{ id: string }> {
    const found = this.deps.itemsRepo.getByRelPath(groupId, relPath)
    if (found !== undefined) return found
    await this.deps.knowledge.reconcileAndList(sectionId)
    const reconciled = this.deps.itemsRepo.getByRelPath(groupId, relPath)
    if (reconciled === undefined) throw new AppErrorException('ITEM_NOT_FOUND')
    return reconciled
  }

  /**
   * The target file's current body text, for "Show current". Only a waiting update has one:
   * `SUGGESTION_NOT_FOUND` for an unknown or resolved id, `VALIDATION_FAILED` for a new note,
   * `ITEM_NOT_FOUND` when the file is gone.
   */
  async current(id: string): Promise<{ text: string }> {
    const row = this.deps.repo.get(id)
    if (row === undefined || row.status !== 'waiting') {
      throw new AppErrorException('SUGGESTION_NOT_FOUND')
    }
    if (row.action !== 'update' || row.targetRelPath === null) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    const root = this.deps.getKnowledgeRoot(row.groupId)
    let path: string
    try {
      path = await resolveInRoot(root, row.targetRelPath.split('/'))
    } catch (error: unknown) {
      if (error instanceof AppErrorException && error.code === 'PATH_OUTSIDE_ROOT') {
        throw new AppErrorException('VALIDATION_FAILED')
      }
      throw error
    }
    if (!(await fileExists(path, dirname(path)))) throw new AppErrorException('ITEM_NOT_FOUND')
    const item = await this.findItem(row.groupId, row.sectionId, row.targetRelPath)
    const content = await this.deps.knowledge.read(item.id)
    if (content.type !== 'text') throw new AppErrorException('VALIDATION_FAILED')
    return { text: content.content }
  }

  /** The full proposed text of a waiting suggestion, for the editor: the new note's text or the update's resulting body. */
  resultText(id: string): Promise<{ text: string }> {
    const row = this.deps.repo.get(id)
    if (row === undefined || row.status !== 'waiting') {
      return Promise.reject(new AppErrorException('SUGGESTION_NOT_FOUND'))
    }
    return Promise.resolve({ text: row.proposedContent })
  }

  private requireAllowedSection(groupId: string, sectionId: string): SectionRow {
    const section = this.deps.sectionsRepo.listByGroup(groupId).find((s) => s.id === sectionId)
    if (section === undefined) throw new AppErrorException('SECTION_NOT_FOUND')
    if (!canAcceptSuggestions(section)) throw new AppErrorException('VALIDATION_FAILED')
    return section
  }

  /** The safe file name for `raw` in the section, or `VALIDATION_FAILED` when it is not usable. */
  private async checkedName(
    groupId: string,
    section: SectionRow,
    raw: string
  ): Promise<{ fileName: string }> {
    const folder = section.folderName ?? ''
    try {
      return { fileName: await this.safeFileName(groupId, folder, raw) }
    } catch (error: unknown) {
      if (error instanceof KnowledgeSuggestionRefused) {
        throw new AppErrorException('VALIDATION_FAILED', { reason: error.message })
      }
      throw withLocation(error, join(this.deps.getKnowledgeRoot(groupId), folder))
    }
  }

  private async createNote(
    section: SectionRow,
    fileName: string,
    content: string
  ): Promise<{ id: string; fileName: string; revision: string }> {
    try {
      return await this.deps.knowledge.createWithContent(section.id, fileName, content, {
        failOnExisting: true
      })
    } catch (error: unknown) {
      throw withLocation(
        error,
        join(this.deps.getKnowledgeRoot(section.groupId), section.folderName ?? '')
      )
    }
  }

  /** The shared tail of a successful accept: outcome, event, `knowledge:changed` and the pushed list. */
  private finishAccepted(
    row: KnowledgeSuggestionRow,
    section: SectionRow,
    item: { id: string; fileName: string; revision: string },
    /** The text the user saved, set only when it, the name or the section differs from the suggestion. */
    editedText?: string
  ): AcceptOutcome {
    const edited = editedText !== undefined
    this.deps.repo.setOutcome(
      row.id,
      edited ? 'accepted_edited' : 'accepted',
      this.now(),
      editedText
    )
    this.deps.logSessionEvent(
      row.sessionId,
      'knowledge-accepted',
      `${eventText(row, edited ? { sectionName: section.name, name: item.fileName } : undefined)} · ${
        edited ? 'Accepted after editing' : 'Accepted'
      }`,
      eventData(row)
    )
    this.deps.emitChanged({
      groupId: row.groupId,
      sectionIds: [section.id],
      items: [{ id: item.id, sectionId: section.id, revision: item.revision }],
      reason: 'suggestion'
    })
    return {
      groupId: row.groupId,
      sectionId: section.id,
      sectionName: section.name,
      itemId: item.id,
      name: item.fileName,
      edited
    }
  }

  private async nameExists(groupId: string, folder: string, fileName: string): Promise<boolean> {
    try {
      const folderPath = await resolveInRoot(this.deps.getKnowledgeRoot(groupId), [folder])
      return isNameTaken(await readdir(folderPath), fileName)
    } catch (error: unknown) {
      // A missing folder or root has no taken names; Accept reports it when it matters.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      if (error instanceof AppErrorException && error.code === 'KNOWLEDGE_ROOT_MISSING')
        return false
      throw error
    }
  }

  private push(sessionId: string): void {
    this.deps.publish(sessionId, this.listWaiting(sessionId))
  }

  private resolveSection(groupId: string, wanted: string): SectionRow {
    const sections = this.deps.sectionsRepo.listByGroup(groupId)
    const key = sectionKey(wanted)
    const found = sections.find(
      (s) =>
        sectionKey(s.name) === key || (s.folderName !== null && sectionKey(s.folderName) === key)
    )
    if (found === undefined) {
      const valid = sections.filter(canAcceptSuggestions).map((s) => s.name)
      throw new KnowledgeSuggestionRefused(
        'unknown_section',
        `No section named "${wanted}".`,
        valid
      )
    }
    if (!canAcceptSuggestions(found)) {
      throw new KnowledgeSuggestionRefused(
        'section_not_allowed',
        `Suggestions cannot go into ${found.name}.`
      )
    }
    return found
  }

  /** The sanitised file name (with extension) of a new note, proved to stay inside the knowledge root. */
  private async safeFileName(groupId: string, folder: string, raw: string): Promise<string> {
    let base = sanitizeName(raw)
    let extension = DEFAULT_EXTENSION
    const match = TRAILING_EXTENSION.exec(base)
    if (match?.[1] !== undefined) {
      const ext = match[1].toLowerCase()
      if (!(TEXT_EXTENSIONS as readonly string[]).includes(ext)) {
        throw new KnowledgeSuggestionRefused(
          'not_text_file',
          `Only text files can be suggested (${TEXT_EXTENSIONS.join(', ')}), not .${ext}.`
        )
      }
      extension = `.${ext}`
      base = sanitizeName(base.slice(0, match.index))
    }
    if (base === '') {
      throw new KnowledgeSuggestionRefused(
        'invalid_name',
        'The note name has no usable characters.'
      )
    }
    const fileName = `${base}${extension}`
    try {
      await resolveInRoot(this.deps.getKnowledgeRoot(groupId), [folder, fileName])
    } catch (error: unknown) {
      if (error instanceof AppErrorException && error.code === 'PATH_OUTSIDE_ROOT') {
        throw new KnowledgeSuggestionRefused('invalid_name', 'The note name is not allowed.')
      }
      throw error
    }
    return fileName
  }
}

/** The refusal for a suggestion that was already made: `already_discarded` when the user threw it away. */
function repeatRefusal(status: KnowledgeSuggestionRow['status']): KnowledgeSuggestionRefused {
  return status === 'discarded'
    ? new KnowledgeSuggestionRefused(
        'already_discarded',
        'The user discarded this suggestion in this session.'
      )
    : new KnowledgeSuggestionRefused(
        'duplicate',
        'This suggestion was already made in this session.'
      )
}

/** The typed error a failed single accept gives the renderer; anything else is `INTERNAL`. */
function toAppError(error: unknown): AppError {
  if (error instanceof AppErrorException) {
    return error.details ? { code: error.code, details: error.details } : { code: error.code }
  }
  return { code: 'INTERNAL' }
}

/** True when `path` is a file; false when it is missing. Any other failure is `IO_FAILED` at `location`. */
async function fileExists(path: string, location: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new AppErrorException('IO_FAILED', { location })
  }
}

/** Adds the folder a failed write was aimed at to `IO_FAILED` and `KNOWLEDGE_ROOT_MISSING`. */
function withLocation(error: unknown, location: string): unknown {
  if (
    error instanceof AppErrorException &&
    (error.code === 'IO_FAILED' || error.code === 'KNOWLEDGE_ROOT_MISSING')
  ) {
    return new AppErrorException(error.code, { ...error.details, location })
  }
  return error
}

/** The text to save: the user's when given (never blank, within the editable-file limit), else the suggestion's. */
function editedText(
  row: KnowledgeSuggestionRow,
  edits: KnowledgeSuggestionEdits | undefined
): string {
  if (edits?.text === undefined) return row.proposedContent
  if (edits.text.trim() === '') {
    throw new AppErrorException('VALIDATION_FAILED', { reason: 'The text is empty.' })
  }
  if (Buffer.byteLength(edits.text, 'utf8') > IMPORT_MAX_BYTES) {
    throw new AppErrorException('FILE_TOO_LARGE')
  }
  return edits.text
}

const withoutMd = (key: string): string => (key.endsWith('.md') ? key.slice(0, -3) : key)

/**
 * Applies the edits to `text`. Every `old_text` is located in the original text, not in the result of the
 * edits before it, so the brain can reason from the file it read. Each must occur exactly once, and the
 * matched ranges may not overlap; otherwise the whole suggestion is refused.
 */
export function applyEdits(text: string, edits: SuggestUpdateInput['edits']): string {
  const ranges = edits.map((edit, i) => {
    const start = text.indexOf(edit.old_text)
    if (start === -1) {
      throw new KnowledgeSuggestionRefused(
        'edit_not_found',
        `Edit ${i + 1}: old_text does not occur in the file.`
      )
    }
    if (text.indexOf(edit.old_text, start + 1) !== -1) {
      throw new KnowledgeSuggestionRefused(
        'edit_ambiguous',
        `Edit ${i + 1}: old_text occurs more than once in the file.`
      )
    }
    return { start, end: start + edit.old_text.length, replacement: edit.new_text, n: i + 1 }
  })
  ranges.sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const range of ranges) {
    if (range.start < at) {
      throw new KnowledgeSuggestionRefused(
        'edit_ambiguous',
        `Edit ${range.n} overlaps another edit.`
      )
    }
    out += text.slice(at, range.start) + range.replacement
    at = range.end
  }
  return out + text.slice(at)
}

function dedupeKey(
  sessionId: string,
  action: string,
  sectionId: string,
  target: string,
  content: string
): string {
  const normalised = content.replace(/\s+/g, ' ').trim().toLowerCase()
  return createHash('sha256')
    .update(JSON.stringify([sessionId, action, sectionId, target.toLowerCase(), normalised]))
    .digest('hex')
}

/** "Orders table is partitioned by month · Notes › New note: Service map" */
function eventText(
  row: KnowledgeSuggestionRow,
  destination?: { sectionName: string; name: string }
): string {
  const name = destination?.name ?? row.proposedName ?? posix.basename(row.targetRelPath ?? '')
  const shown = name.endsWith(DEFAULT_EXTENSION) ? name.slice(0, -DEFAULT_EXTENSION.length) : name
  const target = row.action === 'new' ? `New note: ${shown}` : shown
  return `${row.title} · ${destination?.sectionName ?? row.sectionName} › ${target}`
}

function eventData(row: KnowledgeSuggestionRow): unknown {
  return {
    id: row.id,
    action: row.action,
    section: { id: row.sectionId, name: row.sectionName },
    target: { name: row.proposedName, relPath: row.targetRelPath }
  }
}
