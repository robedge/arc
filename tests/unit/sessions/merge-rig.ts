import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeStartRequest } from '../../../src/main/agents/agent-adapter'
import { git } from '../../helpers/git-fixtures'
import { until } from './engine-rig'
import type { EngineRig } from './engine-rig'
import type { FakeHandle } from './helpers'

export interface DoneWorker {
  workerId: string
  handle: FakeHandle
  treePath: string
}

export function handleOf(e: EngineRig, workerId: string): FakeHandle {
  const handle = e.rig.adapter.handles.find((h) => h.agentId === `worker-${workerId}`)
  if (!handle) throw new Error(`no handle for ${workerId}`)
  return handle
}

/** Spawns a worker, makes one commit in its working copy per file, and takes it to Done. */
export async function spawnWorker(
  e: EngineRig,
  name: string,
  repo: string,
  files: Record<string, string> = {}
): Promise<DoneWorker> {
  const started = await e.call(e.brain(), 'spawn_worker', {
    name,
    task: `Do ${name}`,
    repos: [repo]
  })
  const workerId = String(started.value['workerId'])
  const treePath = e.rig.deps.worktreesRepo.listByWorker(workerId)[0]?.path ?? ''
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(treePath, file), content)
    git(treePath, 'add', file)
    git(treePath, 'commit', '-m', `${name}: ${file}`)
  }
  return { workerId, handle: handleOf(e, workerId), treePath }
}

export async function finishWorker(e: EngineRig, worker: DoneWorker): Promise<void> {
  await e.call(worker.handle, 'report_done', { summary: `Finished ${worker.workerId}` })
  worker.handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
  await until(() => e.rig.deps.workersRepo.get(worker.workerId)?.status === 'done')
}

export async function doneWorker(
  e: EngineRig,
  name: string,
  repo: string,
  files: Record<string, string>
): Promise<DoneWorker> {
  const worker = await spawnWorker(e, name, repo, files)
  await finishWorker(e, worker)
  return worker
}

/** The start options of the merge resolver, once it was launched. */
export async function resolverStart(e: EngineRig, index = 0): Promise<ClaudeStartRequest> {
  const find = (): ClaudeStartRequest | undefined =>
    e.rig.adapter.starts.filter((s) => s.instructions?.includes('[arc-worker:merge-conflict]'))[
      index
    ]
  await until(() => find() !== undefined)
  return find() as ClaudeStartRequest
}

export function resolverHandle(e: EngineRig, start: ClaudeStartRequest): FakeHandle {
  const handle = e.rig.adapter.handles.find((h) => h.agentId === start.agentId)
  if (!handle) throw new Error('no resolver handle')
  return handle
}

/** Plays a resolver that writes `content` into `file`, commits the merge and reports done. */
export async function resolveConflict(
  e: EngineRig,
  start: ClaudeStartRequest,
  file: string,
  content: string
): Promise<void> {
  const handle = resolverHandle(e, start)
  writeFileSync(join(start.cwd, file), content)
  git(start.cwd, 'add', file)
  git(start.cwd, 'commit', '--no-edit')
  await e.call(handle, 'report_done', { summary: 'Kept both changes' })
  handle.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
}

export function branchOf(e: EngineRig, sessionId: string, repo = 'api'): string {
  const row = e.rig.deps.sessionProjectsRepo
    .listBySession(sessionId)
    .find((p) => p.projectName === repo)
  return row?.branchName ?? ''
}

export function eventTexts(e: EngineRig, sessionId: string): string[] {
  return e.rig.eventsRepo.latest(sessionId, 200).map((x) => x.text)
}
