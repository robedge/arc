import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import { basename, parse, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { AppErrorException } from '@shared/errors'
import type { AddProjectsResult, Project, SkippedProject } from '@shared/types/project'
import { ulid } from '../db/ids'
import type { Db } from '../db/client'
import { isUniqueViolation } from '../db/repositories/groups-repo'
import { ProjectsRepo } from '../db/repositories/projects-repo'
import type { ProjectMemberRow, ProjectRow } from '../db/repositories/projects-repo'
import type { Dialogs } from '../platform/dialogs'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 2000

export type ExecFn = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<unknown>

function stripTrailingSeparators(p: string): string {
  const root = parse(p).root
  let out = p
  while (out.length > root.length && out.endsWith(sep)) out = out.slice(0, -1)
  return out
}

/** realpath, trailing separators stripped, NFC. Falls back to `path.resolve` when the path is missing. */
export async function canonicalizePath(p: string): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(p)
  } catch {
    resolved = resolve(p)
  }
  return stripTrailingSeparators(resolved).normalize('NFC')
}

/** `.git` folder or file, else `git rev-parse` (2 s timeout) which also catches repo subfolders. */
export async function detectGit(
  dir: string,
  exec: ExecFn = (file, args, options) => execFileAsync(file, args, options)
): Promise<boolean> {
  try {
    await lstat(resolve(dir, '.git'))
    return true
  } catch {
    // not present; fall through to git itself
  }
  try {
    await exec('git', ['-C', dir, 'rev-parse', '--git-dir'], { timeout: GIT_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

export interface ProjectServiceDeps {
  db: Db
  projectsRepo: ProjectsRepo
  dialogs: Dialogs
  now?: () => number
  newId?: () => string
  detectGit?: (dir: string) => Promise<boolean>
}

export async function isAvailable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) return false
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export class ProjectService {
  private readonly db: Db
  private readonly repo: ProjectsRepo
  private readonly dialogs: Dialogs
  private readonly now: () => number
  private readonly newId: () => string
  private readonly detectGit: (dir: string) => Promise<boolean>

  constructor(deps: ProjectServiceDeps) {
    this.db = deps.db
    this.repo = deps.projectsRepo
    this.dialogs = deps.dialogs
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? (() => ulid(this.now()))
    this.detectGit = deps.detectGit ?? ((dir) => detectGit(dir))
  }

  async list(groupId: string): Promise<Project[]> {
    return Promise.all(this.repo.listByGroup(groupId).map((row) => this.toProject(row)))
  }

  async pick(groupId: string): Promise<AddProjectsResult> {
    const paths = await this.dialogs.pickFolders({ multi: true })
    if (!paths || paths.length === 0) return { added: [], skipped: [] }
    return this.add(groupId, paths)
  }

  async add(groupId: string, paths: string[]): Promise<AddProjectsResult> {
    const added: Project[] = []
    const skipped: SkippedProject[] = []
    for (const path of paths) {
      try {
        added.push(await this.addOne(groupId, path))
      } catch (error: unknown) {
        if (error instanceof AppErrorException) skipped.push({ path, code: error.code })
        else throw error
      }
    }
    return { added, skipped }
  }

  remove(groupId: string, projectId: string): void {
    this.db.transaction((tx) => {
      const repo = new ProjectsRepo(tx)
      repo.removeMembership(groupId, projectId)
      repo.deleteIfOrphan(projectId)
    })
  }

  /** Re-points a project at a new folder (for every group). Canceled picker returns it unchanged. */
  async relocate(groupId: string, projectId: string): Promise<Project> {
    const current = this.repo.getById(projectId)
    if (!current || !this.repo.hasMembership(groupId, projectId)) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    const paths = await this.dialogs.pickFolders({ multi: false })
    const picked = paths?.[0]
    if (!picked) return this.toProject(current)

    let info
    try {
      info = await stat(picked)
    } catch {
      throw new AppErrorException('FOLDER_MISSING')
    }
    if (!info.isDirectory()) throw new AppErrorException('PROJECT_NOT_DIRECTORY')

    const canonical = await canonicalizePath(picked)
    const isGit = await this.detectGit(canonical)
    const timestamp = this.now()

    const result = this.db.transaction((tx) => {
      const repo = new ProjectsRepo(tx)
      const other = repo.getByPath(canonical)
      if (other && other.id !== projectId) {
        repo.mergeMemberships(projectId, other.id)
        repo.update(other.id, { isGit, lastSeenAt: timestamp })
        return { ...other, isGit, lastSeenAt: timestamp }
      }
      const fields = {
        path: canonical,
        displayName: basename(canonical),
        isGit,
        lastSeenAt: timestamp
      }
      repo.update(projectId, fields)
      return { ...current, ...fields }
    })
    return this.toProject(result)
  }

  private async addOne(groupId: string, path: string): Promise<Project> {
    let info
    try {
      info = await stat(path)
    } catch {
      throw new AppErrorException('FOLDER_MISSING')
    }
    if (!info.isDirectory()) throw new AppErrorException('PROJECT_NOT_DIRECTORY')

    const canonical = await canonicalizePath(path)
    const isGit = await this.detectGit(canonical)
    const timestamp = this.now()

    const existing = this.repo.getByPath(canonical)
    if (existing && this.repo.hasMembership(groupId, existing.id)) {
      throw new AppErrorException('PROJECT_DUPLICATE')
    }

    let row: ProjectRow
    try {
      row = this.db.transaction((tx) => {
        const repo = new ProjectsRepo(tx)
        const found = repo.getByPath(canonical)
        let project: ProjectRow
        if (found) {
          repo.update(found.id, { isGit, lastSeenAt: timestamp })
          project = { ...found, isGit, lastSeenAt: timestamp }
        } else {
          project = {
            id: this.newId(),
            path: canonical,
            displayName: basename(canonical),
            isGit,
            lastSeenAt: timestamp,
            createdAt: timestamp
          }
          repo.insert(project)
        }
        repo.addMembership(groupId, project.id, repo.maxSortOrder(groupId) + 1, timestamp)
        return project
      })
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new AppErrorException('PROJECT_DUPLICATE')
      throw error
    }
    return this.toProject(row)
  }

  private async toProject(row: ProjectRow | ProjectMemberRow): Promise<Project> {
    return {
      id: row.id,
      name: row.displayName,
      path: row.path,
      isGit: row.isGit,
      available: await isAvailable(row.path)
    }
  }
}
