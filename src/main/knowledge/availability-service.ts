import type { ProjectsRepo } from '../db/repositories/projects-repo'
import { detectGit, isAvailable } from '../groups/project-service'
import type { IpcEvents } from '@shared/ipc/contract'

export const AVAILABILITY_INTERVAL_MS = 30_000

type AvailabilityPayload = IpcEvents['availability:changed']

export interface AvailabilityServiceDeps {
  projectsRepo: ProjectsRepo
  emit: (event: 'availability:changed', payload: AvailabilityPayload) => void
  /** Ids of all groups; used by `checkAll` at app start. */
  listGroupIds?: () => string[]
  /** The group's linked knowledge folder, or null when it is stored in the app. */
  getLinkedRoot?: (groupId: string) => string | null
  /** Called after the linked root's status changed (and `availability:changed` was emitted). */
  onKnowledgeRootChange?: (groupId: string, available: boolean) => void | Promise<void>
  checkDir?: (path: string) => Promise<boolean>
  detectGit?: (dir: string) => Promise<boolean>
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  now?: () => number
}

/**
 * Checks that project folders exist and are readable. Keeps the last known status per project and
 * emits `availability:changed` only when it differs. The first observation of a project records
 * its status without emitting, because the renderer already has it. Whenever the renderer receives
 * a project (`projects:list`, add, pick, relocate) the handler calls `recordBaseline` with the
 * `available` value it was sent, so that value is the baseline the next check compares against.
 */
function knowledgeKey(groupId: string): string {
  return `knowledge:${groupId}`
}

export class AvailabilityService {
  private readonly lastKnown = new Map<string, boolean>()
  private openGroupId: string | null = null
  private timer: unknown = null
  private queue: Promise<void> = Promise.resolve()
  private readonly checkDir: (path: string) => Promise<boolean>
  private readonly detectGit: (dir: string) => Promise<boolean>
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown
  private readonly clearIntervalFn: (handle: unknown) => void
  private readonly now: () => number

  constructor(private readonly deps: AvailabilityServiceDeps) {
    this.checkDir = deps.checkDir ?? isAvailable
    this.detectGit = deps.detectGit ?? ((dir) => detectGit(dir))
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIntervalFn =
      deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
    this.now = deps.now ?? Date.now
  }

  /** Records the status the renderer was just given, so a later change emits. */
  recordBaseline(projectId: string, available: boolean): void {
    this.lastKnown.set(projectId, available)
  }

  /**
   * Records the status the renderer was just given for the group's linked knowledge folder
   * (`storage:get`, unlink, locate, ...). `null` = the group is stored in the app: forget it.
   */
  recordKnowledgeBaseline(groupId: string, available: boolean | null): void {
    if (available === null) this.lastKnown.delete(knowledgeKey(groupId))
    else this.lastKnown.set(knowledgeKey(groupId), available)
  }

  /** Checks run one at a time so a slow earlier check cannot overwrite a newer status. */
  checkGroup(groupId: string): Promise<void> {
    const run = this.queue.then(() => this.runCheck(groupId))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async runCheck(groupId: string): Promise<void> {
    await this.checkKnowledgeRoot(groupId)
    const rows = this.deps.projectsRepo.listByGroup(groupId)
    await Promise.all(
      rows.map(async (row) => {
        const available = await this.checkDir(row.path)
        if (available) {
          this.deps.projectsRepo.update(row.id, {
            isGit: await this.detectGit(row.path),
            lastSeenAt: this.now()
          })
        }
        const previous = this.lastKnown.get(row.id)
        this.lastKnown.set(row.id, available)
        if (previous !== undefined && previous !== available) {
          this.deps.emit('availability:changed', { groupId, projectId: row.id, available })
        }
      })
    )
  }

  /** Same change-only rule as projects; a group stored in the app has no knowledge-root status. */
  private async checkKnowledgeRoot(groupId: string): Promise<void> {
    const key = knowledgeKey(groupId)
    const root = ((): string | null => {
      try {
        return this.deps.getLinkedRoot?.(groupId) ?? null
      } catch {
        return null // group deleted meanwhile
      }
    })()
    if (root === null) {
      this.lastKnown.delete(key)
      return
    }
    const available = await this.checkDir(root)
    const previous = this.lastKnown.get(key)
    this.lastKnown.set(key, available)
    if (previous === undefined || previous === available) return
    this.deps.emit('availability:changed', { groupId, knowledgeRoot: true, available })
    try {
      await this.deps.onKnowledgeRootChange?.(groupId, available)
    } catch {
      // the status event already went out; a failed watcher restart is retried by the next change
    }
  }

  /** App start: check every group once. */
  async checkAll(): Promise<void> {
    for (const groupId of this.deps.listGroupIds?.() ?? []) await this.checkGroup(groupId)
  }

  /** Window focus: re-check the open group, if any. */
  async checkOpenGroup(): Promise<void> {
    if (this.openGroupId) await this.checkGroup(this.openGroupId)
  }

  /** Checks the group now and every 30 s while it stays open; null stops the timer. */
  setOpenGroup(groupId: string | null): Promise<void> {
    this.stop()
    this.openGroupId = groupId
    if (groupId === null) return Promise.resolve()
    this.timer = this.setIntervalFn(() => void this.checkGroup(groupId), AVAILABILITY_INTERVAL_MS)
    return this.checkGroup(groupId)
  }

  stop(): void {
    if (this.timer !== null) this.clearIntervalFn(this.timer)
    this.timer = null
  }
}
