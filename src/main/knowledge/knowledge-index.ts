import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { IMPORT_MAX_BYTES, ITEM_DESCRIPTION_MAX } from '@shared/limits'
import type { ItemKind } from '@shared/types/item'
import type { KnowledgeItemsRepo, KnowledgeItemRow } from '../db/repositories/knowledge-items-repo'
import type { SectionRow, SectionsRepo } from '../db/repositories/sections-repo'
import { splitFrontMatter, titleFromLines, urlFromLines } from './front-matter'
import { binaryMimeOf, importClassOf } from './import-types'
import type { MetaStore } from './meta-store'
import { MAX_SECTION_DEPTH, MAX_SECTION_FILES, isNonKnowledgeFolder } from './section-scan'

export interface SectionFile {
  name: string
  relPath: string
  absPath: string
  mtimeMs: number
  size: number
}

export function computeRevision(mtimeMs: number, size: number, content: Buffer | string): string {
  return `${mtimeMs}:${size}:${sha1(content).slice(0, 12)}`
}

/** Files over the import size limit are listed and referenced on disk but never read whole. */
export function isLargeFile(size: number): boolean {
  return size > IMPORT_MAX_BYTES
}

/** The revision string of a cached row; identical to what `items:list`/`items:save` report. */
export function revisionOfRow(
  row: Pick<KnowledgeItemRow, 'mtimeMs' | 'sizeBytes' | 'contentHash'>
): string {
  return `${row.mtimeMs}:${row.sizeBytes}:${(row.contentHash ?? '').slice(0, 12)}`
}

export function sha1(content: Buffer | string): string {
  return createHash('sha1').update(content).digest('hex')
}

/** Binary files are `doc_binary` in Docs and plain `item`s elsewhere; text takes the section kind. */
export function kindForFile(fileName: string, sectionKind: ItemKind): ItemKind {
  if (importClassOf(fileName) !== 'binary') return sectionKind
  return sectionKind === 'doc_text' ? 'doc_binary' : 'item'
}

export function kindForSection(kind: SectionRow['kind']): ItemKind | null {
  switch (kind) {
    case 'notes':
      return 'note'
    case 'playbooks':
      return 'playbook'
    case 'custom':
      return 'item'
    case 'docs':
      return 'doc_text'
    case 'links':
      return 'link'
    default:
      return null
  }
}

/** True when `path` resolves to a regular file whose real path lies inside the real root. */
export async function isRegularFileInside(root: string, path: string): Promise<boolean> {
  try {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(path)])
    if (!real.startsWith(realRoot + sep)) return false
    return (await stat(real)).isFile()
  } catch {
    return false
  }
}

/**
 * Lists the indexable files in a section folder and its subfolders (read-only): regular text
 * files, no dotfiles or temp files, no dot-folders or junk folders (`node_modules`, `dist`, ...),
 * no symlinked folders, no symlinks resolving outside the root. Descends at most
 * `MAX_SECTION_DEPTH` levels and stops at `MAX_SECTION_FILES` files. `name` is the file name;
 * `relPath` includes the subfolders. Shared with the section item count.
 */
export async function listSectionFiles(root: string, folder: string): Promise<SectionFile[]> {
  const files: SectionFile[] = []
  async function walk(relDir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await readdir(join(root, relDir), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const subfolders: string[] = []
    for (const entry of entries) {
      if (files.length >= MAX_SECTION_FILES) return
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (depth < MAX_SECTION_DEPTH && !isNonKnowledgeFolder(entry.name)) {
          subfolders.push(entry.name)
        }
        continue
      }
      if (!importClassOf(entry.name)) continue
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const absPath = join(root, relDir, entry.name)
      if (!(await isRegularFileInside(root, absPath))) continue
      try {
        const info = await stat(absPath)
        files.push({
          name: entry.name,
          relPath: `${relDir}/${entry.name}`,
          absPath,
          mtimeMs: info.mtimeMs,
          size: info.size
        })
      } catch {
        // vanished between readdir and stat
      }
    }
    for (const sub of subfolders) await walk(`${relDir}/${sub}`, depth + 1)
  }
  await walk(folder, 0)
  return files
}

export interface KnowledgeIndexDeps {
  sectionsRepo: SectionsRepo
  itemsRepo: KnowledgeItemsRepo
  metaStore: MetaStore
  getKnowledgeRoot: (groupId: string) => string
  log?: { warn: (...args: unknown[]) => void }
  now?: () => number
}

/** Keeps the `knowledge_items` cache in step with disk; disk wins on any disagreement. */
export class KnowledgeIndex {
  private readonly now: () => number
  private readonly log: { warn: (...args: unknown[]) => void }

  constructor(private readonly deps: KnowledgeIndexDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? { warn: () => undefined }
  }

  async reconcileGroup(groupId: string): Promise<void> {
    for (const section of this.deps.sectionsRepo.listByGroup(groupId)) {
      try {
        await this.reconcileSection(groupId, section.id)
      } catch (error: unknown) {
        this.log.warn(`reconcile failed for section ${section.id}`, error)
      }
    }
  }

  async reconcileSection(groupId: string, sectionId: string): Promise<void> {
    const section = this.deps.sectionsRepo.getById(sectionId)
    if (!section || section.groupId !== groupId || !section.folderName) return
    const kind = kindForSection(section.kind)
    if (!kind) return
    const root = this.deps.getKnowledgeRoot(groupId)
    // A linked folder that is gone (renamed, unmounted) must not empty the index: its items come
    // back when the folder does, and the UI shows "Knowledge folder not found" meanwhile.
    if (
      !(await stat(root).then(
        (i) => i.isDirectory(),
        () => false
      ))
    )
      return
    const files = await listSectionFiles(root, section.folderName)
    const meta = await this.deps.metaStore.read(root)
    const cached = new Map(this.deps.itemsRepo.listBySection(sectionId).map((r) => [r.relPath, r]))

    for (const file of files) {
      const description = meta.items[file.relPath]?.description ?? null
      const row = cached.get(file.relPath)
      const unchanged =
        row &&
        row.mtimeMs === file.mtimeMs &&
        row.sizeBytes === file.size &&
        row.kind === kindForFile(file.name, kind)
      if (unchanged && kind === 'link') continue
      if (unchanged && row.description === description) continue
      if (unchanged) {
        this.deps.itemsRepo.upsertByRelPath({ ...row, description, indexedAt: this.now() })
        continue
      }
      try {
        await this.indexFile(section, kind, file, description)
      } catch (error: unknown) {
        // One unreadable file must not hide the rest of the section; its old row (if any) stays.
        this.log.warn(`index failed for ${file.relPath}`, error)
      }
    }
    this.deps.itemsRepo.deleteMissing(
      groupId,
      sectionId,
      files.map((f) => f.relPath)
    )
  }

  /** Parses one file and upserts its row (id stays stable). Returns the row. */
  async indexFile(
    section: SectionRow,
    kind: ItemKind,
    file: SectionFile,
    description: string | null
  ): Promise<KnowledgeItemRow> {
    const info = await stat(file.absPath)
    const mime = binaryMimeOf(file.name)
    if (isLargeFile(info.size)) {
      // Referenced, never read: a multi-GB dump in a linked folder must not be loaded into memory.
      // Size and mtime stand in for the content hash; the item is read-only.
      return this.deps.itemsRepo.upsertByRelPath({
        groupId: section.groupId,
        sectionId: section.id,
        relPath: file.relPath,
        kind: kindForFile(file.name, kind),
        title: file.name,
        description,
        url: null,
        mime: mime ?? null,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        contentHash: sha1(`large:${info.size}:${info.mtimeMs}`),
        isEditable: false,
        indexedAt: this.now()
      })
    }
    const buffer = await readFile(file.absPath)
    if (mime && importClassOf(file.name) === 'binary') {
      return this.deps.itemsRepo.upsertByRelPath({
        groupId: section.groupId,
        sectionId: section.id,
        relPath: file.relPath,
        kind: kindForFile(file.name, kind),
        title: file.name,
        description,
        url: null,
        mime,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        contentHash: sha1(buffer),
        isEditable: false,
        indexedAt: this.now()
      })
    }
    const { lines, body } = splitFrontMatter(buffer.toString('utf8'))
    if (kind === 'link') {
      // A link file is self-contained: url and title in front matter, description in the body.
      // An invalid url is still listed so the user can fix it; `shell:openLink` revalidates.
      return this.deps.itemsRepo.upsertByRelPath({
        groupId: section.groupId,
        sectionId: section.id,
        relPath: file.relPath,
        kind,
        title: titleFromLines(lines) ?? file.name.replace(/\.[^.]+$/, ''),
        description: [...body.trim()].slice(0, ITEM_DESCRIPTION_MAX).join('') || null,
        url: urlFromLines(lines) ?? null,
        mime: null,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        contentHash: sha1(buffer),
        isEditable: false,
        indexedAt: this.now()
      })
    }
    // Markdown: front matter title, else the name without `.md`. Other files (imported docs) have
    // no front matter and are shown by their full file name, e.g. `orders_schema.sql`.
    const isMarkdown = /\.md$/i.test(file.name)
    const title = isMarkdown
      ? (titleFromLines(lines) ?? file.name.replace(/\.[^.]+$/, ''))
      : file.name
    return this.deps.itemsRepo.upsertByRelPath({
      groupId: section.groupId,
      sectionId: section.id,
      relPath: file.relPath,
      kind,
      title,
      description,
      url: null,
      mime: null,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
      contentHash: sha1(buffer),
      isEditable: true,
      indexedAt: this.now()
    })
  }
}
