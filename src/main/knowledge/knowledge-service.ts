import type { Stats } from 'node:fs'
import { copyFile, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, extname, join, posix } from 'node:path'
import { AppErrorException } from '@shared/errors'
import type { ErrorCode } from '@shared/errors'
import { IMPORT_MAX_BYTES, ITEM_DESCRIPTION_MAX, ITEM_TITLE_MAX } from '@shared/limits'
import type { ConflictResolution, ImportReport, ItemContent, ItemSummary } from '@shared/types/item'
import type { KnowledgeItemRow, KnowledgeItemsRepo } from '../db/repositories/knowledge-items-repo'
import type { SectionRow, SectionsRepo } from '../db/repositories/sections-repo'
import { atomicWriteFile } from './atomic-write'
import {
  SNIFF_BYTES,
  binaryMimeOf,
  importClassOf,
  looksLikeText,
  sniffBinary
} from './import-types'
import {
  joinFrontMatter,
  splitFrontMatter,
  titleLine,
  urlFromLines,
  urlLine,
  withTitle
} from './front-matter'
import {
  computeRevision,
  isLargeFile,
  isRegularFileInside,
  kindForSection,
  revisionOfRow
} from './knowledge-index'
import type { KnowledgeIndex } from './knowledge-index'
import { resolveInRoot, sanitizeName, uniqueName } from './knowledge-paths'
import type { MetaStore } from './meta-store'

export interface KnowledgeServiceDeps {
  sectionsRepo: SectionsRepo
  itemsRepo: KnowledgeItemsRepo
  index: KnowledgeIndex
  metaStore: MetaStore
  getKnowledgeRoot: (groupId: string) => string
}

/** True when `raw` parses as an absolute http or https URL. */
export function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function fold(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

export class KnowledgeService {
  constructor(private readonly deps: KnowledgeServiceDeps) {}

  async list(sectionId: string): Promise<ItemSummary[]> {
    const section = this.requireSection(sectionId)
    await this.deps.index.reconcileSection(section.groupId, sectionId)
    return this.deps.itemsRepo.listBySection(sectionId).map((row) => this.toSummary(row))
  }

  async read(itemId: string): Promise<ItemContent> {
    const { row, path } = await this.locate(itemId)
    const mime = binaryMimeOf(row.relPath)
    const isBinary = mime !== null && importClassOf(row.relPath) === 'binary'
    // A large text file is never loaded; the renderer offers Show in Finder instead.
    if (!isBinary && isLargeFile(await this.sizeOnDisk(row, path))) {
      throw new AppErrorException('FILE_TOO_LARGE')
    }
    if (isBinary) {
      return {
        type: 'binary',
        url: `harness-knowledge://${row.groupId}/${row.id}?rev=${encodeURIComponent(this.revisionOf(row))}`,
        mime
      }
    }
    const { buffer, info } = await this.readDisk(row, path)
    return {
      type: 'text',
      content: splitFrontMatter(buffer.toString('utf8')).body,
      revision: computeRevision(info.mtimeMs, info.size, buffer)
    }
  }

  async create(sectionId: string, rawTitle: string, rawDescription?: string): Promise<ItemSummary> {
    const section = this.requireSection(sectionId)
    const kind = kindForSection(section.kind)
    if (!kind || kind === 'link' || !section.folderName) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    const title = this.validTitle(rawTitle)
    const description = rawDescription === undefined ? '' : this.validDescription(rawDescription)

    const root = this.deps.getKnowledgeRoot(section.groupId)
    const folder = section.folderName
    const folderPath = await resolveInRoot(root, [folder])
    const name = uniqueName(await readdir(folderPath), `${this.baseName(title)}.md`)
    const path = await resolveInRoot(root, [folder, name])
    const lines = this.needsTitle(title) ? withTitle(null, title) : null
    await atomicWriteFile(path, joinFrontMatter(lines, ''))
    const relPath = `${folder}/${name}`
    if (description) await this.setMetaDescription(root, relPath, description)
    return this.toSummary(await this.indexOne(section, relPath, description || null))
  }

  /**
   * Creates or updates one link: `Links/<title>.md` with `url`/`title` front matter and the
   * description as the body. A changed title renames the file; the id stays.
   */
  async upsertLink(input: {
    sectionId: string
    itemId?: string
    url: string
    title?: string
    description?: string
  }): Promise<ItemSummary> {
    const section = this.requireSection(input.sectionId)
    if (section.kind !== 'links' || !section.folderName) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    const url = input.url.trim()
    if (!isHttpUrl(url)) throw new AppErrorException('LINK_URL_INVALID')
    let title = url
    if (input.title !== undefined && input.title.trim() !== '') title = this.validTitle(input.title)
    const description = this.validDescription(input.description ?? '')
    const text = joinFrontMatter([urlLine(url), titleLine(title)], description)

    const root = this.deps.getKnowledgeRoot(section.groupId)
    const folder = section.folderName
    const folderPath = await resolveInRoot(root, [folder])
    const desired = `${this.linkBaseName(title)}.md`

    if (input.itemId === undefined) {
      const name = uniqueName(await readdir(folderPath), desired)
      await this.write(await resolveInRoot(root, [folder, name]), text)
      return this.toSummary(await this.indexOne(section, `${folder}/${name}`, null))
    }

    const { row, path } = await this.locate(input.itemId)
    if (row.sectionId !== section.id || row.kind !== 'link') {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    await this.write(path, text)
    const oldName = posix.basename(row.relPath)
    const parent = posix.dirname(row.relPath)
    let relPath = row.relPath
    if (row.title !== title && fold(desired) !== fold(oldName)) {
      const others = (await readdir(dirname(path))).filter((n) => n !== oldName)
      const newName = uniqueName(others, desired)
      await rename(path, await resolveInRoot(root, [...parent.split('/'), newName]))
      relPath = `${parent}/${newName}`
      this.deps.itemsRepo.renameRelPath(row.groupId, row.relPath, relPath)
    }
    return this.toSummary(await this.indexOne(section, relPath, null))
  }

  /** Re-reads the link file from disk (never the cache) and returns its raw, unvalidated url. */
  async readLinkUrl(itemId: string): Promise<string> {
    const { row, path } = await this.locate(itemId)
    if (row.kind !== 'link') throw new AppErrorException('LINK_TARGET_INVALID')
    const { buffer } = await this.readDisk(row, path)
    const url = urlFromLines(splitFrontMatter(buffer.toString('utf8')).lines)
    if (url === undefined) throw new AppErrorException('LINK_TARGET_INVALID')
    return url
  }

  async save(itemId: string, content: string, baseRevision: string): Promise<{ revision: string }> {
    const { row, path, section } = await this.locate(itemId)
    if (!row.isEditable) throw new AppErrorException('VALIDATION_FAILED')
    const { buffer, info } = await this.readDisk(row, path)
    if (computeRevision(info.mtimeMs, info.size, buffer) !== baseRevision) {
      throw new AppErrorException('EXTERNAL_MODIFIED')
    }
    const { lines } = splitFrontMatter(buffer.toString('utf8'))
    await this.write(path, joinFrontMatter(lines, content))
    const updated = await this.indexOne(section, row.relPath, row.description)
    return { revision: this.revisionOf(updated) }
  }

  async rename(itemId: string, rawTitle: string): Promise<ItemSummary> {
    const { row, path, section, root } = await this.locate(itemId)
    const title = this.validTitle(rawTitle)
    const oldName = posix.basename(row.relPath)
    const parent = posix.dirname(row.relPath).split('/')
    // Rename never changes the file type. Markdown keeps title-in-front-matter behaviour. Any other
    // file (imported .sql/.yaml/...) is listed by its full file name, has no front matter, and the
    // typed title may omit or include the extension: it is appended only when missing.
    const ext = extname(oldName)
    const isMarkdown = ext.toLowerCase() === '.md'
    const desired = isMarkdown
      ? `${this.baseName(title)}.md`
      : `${this.baseName(this.withoutExtension(title, ext))}${ext}`

    let newName = desired
    if (fold(desired) !== fold(oldName)) {
      const others = (await readdir(dirname(path))).filter((n) => n !== oldName)
      newName = uniqueName(others, desired)
    }

    // Rewrite front matter first (in place), then move the file. Markdown only.
    if (isMarkdown && row.isEditable) {
      const { buffer } = await this.readDisk(row, path)
      const { lines, body } = splitFrontMatter(buffer.toString('utf8'))
      const nextLines = withTitle(lines, this.needsTitle(title) ? title : null)
      const nextText = joinFrontMatter(nextLines, body)
      if (nextText !== buffer.toString('utf8')) await this.write(path, nextText)
    }

    const relPath = [...parent, newName].join('/')
    if (newName !== oldName) {
      const dest = await resolveInRoot(root, [...parent, newName])
      if (fold(newName) === fold(oldName)) {
        const temp = await resolveInRoot(root, [...parent, `${newName}.rename-tmp-${Date.now()}`])
        await rename(path, temp)
        await rename(temp, dest)
      } else {
        await rename(path, dest)
      }
      this.deps.itemsRepo.renameRelPath(row.groupId, row.relPath, relPath)
      await this.deps.metaStore.updateMeta(root, (meta) => {
        const entry = meta.items[row.relPath]
        delete meta.items[row.relPath]
        if (entry) meta.items[relPath] = entry
      })
    }
    return this.toSummary(await this.indexOne(section, relPath, row.description))
  }

  async setDescription(itemId: string, raw: string): Promise<void> {
    const { row, root } = await this.locate(itemId)
    const description = this.validDescription(raw)
    await this.setMetaDescription(root, row.relPath, description)
    this.deps.itemsRepo.upsertByRelPath({ ...row, description: description || null })
  }

  async delete(itemId: string): Promise<void> {
    const { row, path, root } = await this.locate(itemId)
    try {
      await rm(path, { force: true })
    } catch {
      throw new AppErrorException('IO_FAILED')
    }
    this.deps.itemsRepo.deleteByRelPath(row.groupId, row.relPath)
    await this.deps.metaStore.updateMeta(root, (meta) => {
      delete meta.items[row.relPath]
    })
  }

  /**
   * Copies files into a section. Each file is validated independently (one failure never stops
   * the batch); a name that already exists is returned in `conflicts` and nothing is written
   * until the caller supplies `onConflict[name]`. The source is only ever read.
   * Items take the section's kind, and are editable.
   */
  async importFiles(
    sectionId: string,
    paths: readonly string[],
    onConflict: Readonly<Record<string, ConflictResolution>> = {}
  ): Promise<ImportReport> {
    const section = this.requireSection(sectionId)
    const sectionKind = kindForSection(section.kind)
    if (!sectionKind || sectionKind === 'link' || !section.folderName) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    const folder = section.folderName
    const root = this.deps.getKnowledgeRoot(section.groupId)
    const folderPath = await resolveInRoot(root, [folder])

    const checked = await Promise.allSettled(paths.map((p) => this.checkImportable(p)))
    const report: ImportReport = { added: [], failed: [], conflicts: [] }

    // Placement is sequential so two inputs with one basename see each other on disk.
    for (let i = 0; i < checked.length; i++) {
      const result = checked[i]
      const source = paths[i]
      if (!result || source === undefined) continue
      if (result.status === 'rejected') {
        const code: ErrorCode =
          result.reason instanceof AppErrorException ? result.reason.code : 'IO_FAILED'
        report.failed.push({ name: basename(source), code })
        continue
      }
      const name = result.value
      try {
        const existing = (await readdir(folderPath)).find((n) => fold(n) === fold(name))
        let target = name
        if (existing !== undefined) {
          const choice = onConflict[name]
          if (!choice) {
            report.conflicts.push({ name, path: source })
            continue
          }
          if (choice === 'skip') continue
          target = choice === 'replace' ? existing : uniqueName(await readdir(folderPath), name)
        }
        const dest = await resolveInRoot(root, [folder, target])
        await this.copyInto(source, dest)
        const row = await this.indexOne(
          section,
          `${folder}/${target}`,
          this.deps.itemsRepo.getByRelPath(section.groupId, `${folder}/${target}`)?.description ??
            null
        )
        report.added.push(this.toSummary(row))
      } catch (error: unknown) {
        report.failed.push({
          name,
          code: error instanceof AppErrorException ? error.code : 'IO_FAILED'
        })
      }
    }
    return report
  }

  /** Validates one source file; resolves to the target file name or throws an AppErrorException. */
  private async checkImportable(source: string): Promise<string> {
    let info: Stats
    try {
      info = await stat(source)
    } catch {
      throw new AppErrorException('IO_FAILED')
    }
    if (!info.isFile()) throw new AppErrorException('FILE_UNSUPPORTED')
    if (info.size > IMPORT_MAX_BYTES) throw new AppErrorException('FILE_TOO_LARGE')
    const base = basename(source).normalize('NFC')
    const name = sanitizeName(base) === base ? base : sanitizeName(base)
    // Extension is judged on the original name so sanitizing cannot change the type.
    const cls = importClassOf(base)
    if (!cls || !name) throw new AppErrorException('FILE_UNSUPPORTED')

    const head = Buffer.alloc(Math.min(SNIFF_BYTES, info.size))
    try {
      const handle = await open(source, 'r')
      try {
        await handle.read(head, 0, head.length, 0)
      } finally {
        await handle.close()
      }
    } catch {
      throw new AppErrorException('IO_FAILED')
    }
    const whole = info.size <= SNIFF_BYTES
    const valid = cls === 'binary' ? sniffBinary(base, head, whole) : looksLikeText(head, whole)
    if (!valid) {
      throw new AppErrorException('FILE_UNSUPPORTED')
    }
    return name
  }

  /** Copy to a temp file beside the destination, then rename into place. */
  private async copyInto(source: string, dest: string): Promise<void> {
    const temp = join(dirname(dest), `.tmp-${randomBytes(6).toString('hex')}-${basename(dest)}`)
    try {
      await copyFile(source, temp)
      await rename(temp, dest)
    } catch (error: unknown) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  // --- helpers ---

  private requireSection(sectionId: string): SectionRow {
    const section = this.deps.sectionsRepo.getById(sectionId)
    if (!section) throw new AppErrorException('INTERNAL')
    return section
  }

  private async locate(itemId: string): Promise<{
    row: KnowledgeItemRow
    section: SectionRow
    root: string
    path: string
  }> {
    const row = this.deps.itemsRepo.getById(itemId)
    if (!row) throw new AppErrorException('INTERNAL')
    const section = this.requireSection(row.sectionId)
    const root = this.deps.getKnowledgeRoot(row.groupId)
    const path = await resolveInRoot(root, row.relPath.split('/'))
    if (!(await isRegularFileInside(root, path))) {
      this.deps.itemsRepo.deleteByRelPath(row.groupId, row.relPath)
      throw new AppErrorException('PATH_OUTSIDE_ROOT')
    }
    return { row, section, root, path }
  }

  private async readDisk(
    row: KnowledgeItemRow,
    path: string
  ): Promise<{ buffer: Buffer; info: Stats }> {
    try {
      return { buffer: await readFile(path), info: await stat(path) }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.deps.itemsRepo.deleteByRelPath(row.groupId, row.relPath)
      }
      throw new AppErrorException('IO_FAILED')
    }
  }

  private async sizeOnDisk(row: KnowledgeItemRow, path: string): Promise<number> {
    try {
      return (await stat(path)).size
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.deps.itemsRepo.deleteByRelPath(row.groupId, row.relPath)
      }
      throw new AppErrorException('IO_FAILED')
    }
  }

  private async write(path: string, text: string): Promise<void> {
    try {
      await atomicWriteFile(path, text)
    } catch {
      throw new AppErrorException('IO_FAILED')
    }
  }

  private async indexOne(
    section: SectionRow,
    relPath: string,
    description: string | null
  ): Promise<KnowledgeItemRow> {
    const kind = kindForSection(section.kind)
    if (!kind) throw new AppErrorException('VALIDATION_FAILED')
    const root = this.deps.getKnowledgeRoot(section.groupId)
    const absPath = await resolveInRoot(root, relPath.split('/'))
    const info = await stat(absPath)
    return this.deps.index.indexFile(
      section,
      kind,
      {
        name: posix.basename(relPath),
        relPath,
        absPath,
        mtimeMs: info.mtimeMs,
        size: info.size
      },
      description
    )
  }

  private async setMetaDescription(
    root: string,
    relPath: string,
    description: string
  ): Promise<void> {
    await this.deps.metaStore.updateMeta(root, (meta) => {
      if (description) meta.items[relPath] = { description }
      else delete meta.items[relPath]
    })
  }

  private validTitle(raw: string): string {
    const title = raw.trim().normalize('NFC')
    const length = [...title].length
    if (length === 0) throw new AppErrorException('TITLE_REQUIRED')
    if (length > ITEM_TITLE_MAX) throw new AppErrorException('VALIDATION_FAILED')
    return title
  }

  private validDescription(raw: string): string {
    const description = raw.trim()
    if ([...description].length > ITEM_DESCRIPTION_MAX) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    return description
  }

  private linkBaseName(title: string): string {
    return [...(sanitizeName(title) || 'Link')].slice(0, ITEM_TITLE_MAX).join('').trim() || 'Link'
  }

  private baseName(title: string): string {
    return sanitizeName(title) || 'Untitled'
  }

  private withoutExtension(title: string, ext: string): string {
    return ext && title.toLowerCase().endsWith(ext.toLowerCase())
      ? title.slice(0, title.length - ext.length)
      : title
  }

  /** The filename differs from the title, so the title must live in front matter. */
  private needsTitle(title: string): boolean {
    return sanitizeName(title) !== title
  }

  private revisionOf(row: KnowledgeItemRow): string {
    return revisionOfRow(row)
  }

  /** The subfolder path between the section folder and the file; '' for a top-level file. */
  private folderOf(row: KnowledgeItemRow): string {
    const parts = posix.dirname(row.relPath).split('/')
    return parts.slice(1).join('/')
  }

  private toSummary(row: KnowledgeItemRow): ItemSummary {
    return {
      id: row.id,
      sectionId: row.sectionId,
      title: row.title,
      fileName: posix.basename(row.relPath),
      folder: this.folderOf(row),
      description: row.description ?? '',
      kind: row.kind,
      ...(row.kind === 'link' && row.url !== null ? { url: row.url } : {}),
      editable: row.isEditable,
      revision: this.revisionOf(row)
    }
  }
}
