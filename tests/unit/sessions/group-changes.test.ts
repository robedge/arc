import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionService } from '../../../src/main/sessions/session-service'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { SessionProjectsRepo } from '../../../src/main/db/repositories/session-projects-repo'
import { createGitFixture, git, trackedFile } from '../../helpers/git-fixtures'
import type { GitFixture, GitFixtureKind } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig, until } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-group-changes-')
let e: EngineRig | undefined
const fixtures: GitFixture[] = []

afterEach(async () => {
  await e?.close()
  e = undefined
  while (fixtures.length) fixtures.pop()?.cleanup()
})

const BRANCH = 'arc/retry-work'

function rows(rig: EngineRig, sessionId: string) {
  return new SessionProjectsRepo(rig.rig.opened.db).listBySession(sessionId)
}

/** A new project in the group, as `projects:add` leaves it. */
function addProject(
  rig: EngineRig,
  id: string,
  kind: GitFixtureKind = 'clean'
): { fixture: GitFixture; groupChanged: () => Promise<void> } {
  const fixture = createGitFixture({ kind })
  fixtures.push(fixture)
  const projects = new ProjectsRepo(rig.rig.opened.db)
  projects.insert({
    id,
    path: fixture.path,
    displayName: id,
    isGit: kind !== 'plain',
    createdAt: 5
  })
  projects.addMembership(rig.rig.groupId, id, 9, 5)
  return {
    fixture,
    groupChanged: () => rig.rig.service.groupChanged(rig.rig.groupId, { kind: 'projects' })
  }
}

const branchOf = (repo: string): string => git(repo, 'symbolic-ref', '--short', 'HEAD').trim()

/** Starts the next brain turn and waits until the message reached the (fake) brain. */
async function send(rig: EngineRig, sessionId: string, text: string): Promise<void> {
  const before = rig.rig.adapter.handles.reduce((n, h) => n + h.sent.length, 0)
  await rig.rig.service.sendMessage(sessionId, text)
  await until(() => rig.rig.adapter.handles.reduce((n, h) => n + h.sent.length, 0) > before)
}

/** The rig answers the first request before the brain is marked as working; end that turn again. */
async function idle(rig: EngineRig, sessionId: string): Promise<void> {
  await until(() => rig.brain().sent.length > 0)
  rig.brain().emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
  await until(() => rig.rig.service.snapshot(sessionId).brainState === 'idle')
}

function endTurn(rig: EngineRig): void {
  rig.rig.adapter.last.emit({ type: 'turn-result', ok: true, interrupted: false, durationMs: 1 })
}

describe('a project added to the group', () => {
  it('joins the open session: row, branch, header, note, and the brain restarts with it after its turn', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const infra = addProject(e, 'infra')
    // The brain is busy with a turn: it must not be touched.
    await send(e, sessionId, 'look at the api')
    const first = e.rig.adapter.handles[0]
    expect(e.rig.adapter.starts).toHaveLength(1)

    await infra.groupChanged()

    const row = rows(e, sessionId).find((r) => r.projectId === 'infra')
    expect(row).toMatchObject({
      branchName: BRANCH,
      baseBranch: 'dev',
      readOnly: false,
      membership: 'active',
      projectPath: infra.fixture.path
    })
    expect(row?.baseSha).toBe(git(infra.fixture.path, 'rev-parse', `refs/heads/${BRANCH}`).trim())
    expect(branchOf(infra.fixture.path)).toBe(BRANCH)
    const pushed = e.rig.of('session:header').at(-1)
    expect(pushed?.header.branches.find((b) => b.projectId === 'infra')).toMatchObject({
      branchName: BRANCH,
      baseBranch: 'dev'
    })
    expect(
      e.rig.eventsRepo.latest(sessionId, 50).some((x) => x.text.includes(`${BRANCH} in infra`))
    ).toBe(true)

    // Mid-turn: nothing was stopped or restarted.
    expect(first?.stopped).toBe(false)
    expect(e.rig.adapter.starts).toHaveLength(1)

    // The turn ends: the brain pauses and is stopped; the next message starts it again.
    endTurn(e)
    await until(() => first?.stopped === true)
    await send(e, sessionId, 'now change infra')
    expect(e.rig.adapter.starts).toHaveLength(2)
    const second = e.rig.adapter.starts[1]
    expect(second?.addDirs).toContain(infra.fixture.path)
    expect(second?.resume?.threadId).toBe('brain-claude-1')
    const message = e.rig.adapter.last.sent[0] ?? ''
    expect(message).toContain('[Arc] The group changed')
    expect(message).toContain('"infra" joined the group')
    expect(message).toContain(BRANCH)
    expect(message).toContain(infra.fixture.path)
    expect(message).toContain('now change infra')
  })

  it('lets the brain start a worker in it', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const infra = addProject(e, 'infra')
    await infra.groupChanged()
    const result = await e.call(e.brain(), 'spawn_worker', {
      name: 'infra-fix',
      task: 'Fix infra',
      repos: ['infra'],
      model: 'sonnet'
    })
    expect(result.isError).toBe(false)
    expect(result.value['status']).toBe('started')
    const tree = e.rig.deps.worktreesRepo
      .listByWorker(String(result.value['workerId']))
      .find((t) => t.projectId === 'infra')
    expect(tree).toBeDefined()
    expect(rows(e, sessionId).find((r) => r.projectId === 'infra')?.branchName).toBe(BRANCH)
  })

  it('joins a non-git folder as read only', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const docs = addProject(e, 'docs', 'plain')
    await docs.groupChanged()
    expect(rows(e, sessionId).find((r) => r.projectId === 'docs')).toMatchObject({
      readOnly: true,
      branchName: null
    })
    expect(e.rig.of('session:header').at(-1)?.header.branches).toContainEqual(
      expect.objectContaining({ projectId: 'docs', readOnly: true })
    )
  })

  it('asks about unsaved changes, and Cancel leaves the project out without asking again', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const infra = addProject(e, 'infra', 'dirty')
    await infra.groupChanged()

    const asked = e.rig.of('session:dirty-question')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.sessionId).toBe(sessionId)
    expect(asked[0]?.needsDirtyChoice.repos).toEqual([
      expect.objectContaining({ projectId: 'infra', name: 'infra', fileCount: 2 })
    ])
    expect(asked[0]?.needsDirtyChoice.repos[0]?.files).toContain(trackedFile)
    // Nothing happened to the repository yet.
    expect(branchOf(infra.fixture.path)).toBe('dev')
    // A second change while the question is open does not ask again.
    await infra.groupChanged()
    expect(e.rig.of('session:dirty-question')).toHaveLength(1)

    const token = asked[0]?.needsDirtyChoice.token ?? ''
    const resolved = await e.rig.service.resolveDirty(token, { infra: 'cancel' })
    expect(resolved).toEqual({ status: 'cancelled' })
    expect(branchOf(infra.fixture.path)).toBe('dev')
    expect(git(infra.fixture.path, 'status', '--porcelain')).toContain(trackedFile)
    expect(rows(e, sessionId).find((r) => r.projectId === 'infra')?.membership).toBe('left_out')
    expect(e.rig.service.snapshot(sessionId).header.branches.map((b) => b.projectId)).not.toContain(
      'infra'
    )

    await infra.groupChanged()
    expect(e.rig.of('session:dirty-question')).toHaveLength(1)
    const refused = await e.call(e.brain(), 'spawn_worker', {
      name: 'infra-fix',
      task: 'Fix infra',
      repos: ['infra'],
      model: 'sonnet'
    })
    expect(refused.value['error']).toBe('unknown_repo')
  })

  it('Set aside puts the changes in a stash and creates the branch', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const infra = addProject(e, 'infra', 'dirty')
    await infra.groupChanged()
    const token = e.rig.of('session:dirty-question')[0]?.needsDirtyChoice.token ?? ''
    const resolved = await e.rig.service.resolveDirty(token, { infra: 'stash' })
    expect(resolved).toEqual({ status: 'ready', sessionId })
    expect(branchOf(infra.fixture.path)).toBe(BRANCH)
    expect(git(infra.fixture.path, 'status', '--porcelain')).toBe('')
    expect(git(infra.fixture.path, 'stash', 'list')).toContain('arc:')
    expect(rows(e, sessionId).find((r) => r.projectId === 'infra')).toMatchObject({
      branchName: BRANCH,
      dirtyHandling: 'stashed'
    })
    expect(e.rig.of('session:header').at(-1)?.header.branches).toContainEqual(
      expect.objectContaining({ projectId: 'infra', branchName: BRANCH })
    )
  })
})

describe('a session that was not open when the group changed', () => {
  it('takes the added project when it is opened', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const infra = addProject(e, 'infra')
    // A fresh service stands for the app after a restart: no session is cached.
    const reopened = new SessionService(e.rig.deps)
    const result = await reopened.open(sessionId)
    if ('needsDirtyChoice' in result) throw new Error('expected a snapshot')
    expect(result.header.branches).toContainEqual(
      expect.objectContaining({ projectId: 'infra', branchName: BRANCH })
    )
    expect(branchOf(infra.fixture.path)).toBe(BRANCH)
    await reopened.shutdown()
  })
})

describe('a project removed from the group', () => {
  it('shows as Removed, refuses new workers with a clear message, and keeps running workers', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    const running = await e.call(e.brain(), 'spawn_worker', {
      name: 'web-fix',
      task: 'Fix web',
      repos: ['web'],
      model: 'sonnet'
    })
    expect(running.value['status']).toBe('started')
    const worker = e.workerHandle(0)

    const projects = new ProjectsRepo(e.rig.opened.db)
    projects.removeMembership(e.rig.groupId, 'p-web')
    projects.deleteIfOrphan('p-web')
    await e.rig.service.groupChanged(e.rig.groupId, { kind: 'projects' })

    const header = e.rig.of('session:header').at(-1)?.header
    expect(header?.branches).toContainEqual(
      expect.objectContaining({ projectName: 'web', removed: true, branchName: BRANCH })
    )
    expect(rows(e, sessionId).find((r) => r.projectName === 'web')?.membership).toBe('removed')
    expect(worker.stopped).toBe(false)
    expect(
      e.rig.eventsRepo.latest(sessionId, 50).some((x) => x.text.includes('web was removed'))
    ).toBe(true)

    const refused = await e.call(e.brain(), 'spawn_worker', {
      name: 'web-more',
      task: 'More web',
      repos: ['web'],
      model: 'sonnet'
    })
    expect(refused.value['error']).toBe('unknown_repo')
    expect(String(refused.value['message'] ?? refused.value['detail'] ?? '')).toContain(
      'no longer part of the group'
    )

    // The brain hears about it with its next message, after restarting without the folder.
    await idle(e, sessionId)
    await until(() => e?.brain().stopped === true)
    await send(e, sessionId, 'change web please')
    expect(e.rig.adapter.starts.at(-1)?.addDirs).not.toContain(e.web.path)
    expect(e.rig.adapter.last.sent[0]).toContain('"web" was removed from the group')
  })
})

describe('a project moved to a new folder', () => {
  it('uses the new folder for workers started afterwards', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')
    // The repository now lives elsewhere, with the session branch.
    const moved = createGitFixture()
    fixtures.push(moved)
    git(moved.path, 'checkout', '-b', BRANCH, 'dev')
    new ProjectsRepo(e.rig.opened.db).update('p-api', { path: moved.path, displayName: 'api' })

    await e.rig.service.groupChanged(null, { kind: 'projects' })

    expect(rows(e, sessionId).find((r) => r.projectId === 'p-api')?.projectPath).toBe(moved.path)
    const result = await e.call(e.brain(), 'spawn_worker', {
      name: 'api-fix',
      task: 'Fix api',
      repos: ['api'],
      model: 'sonnet'
    })
    expect(result.value['status']).toBe('started')
    const tree = e.rig.deps.worktreesRepo
      .listByWorker(String(result.value['workerId']))
      .find((t) => t.projectId === 'p-api')
    expect(tree).toBeDefined()
    const common = git(tree?.path ?? '', 'rev-parse', '--path-format=absolute', '--git-common-dir')
    expect(common.trim().endsWith(join('repo', '.git'))).toBe(true)
    expect(common.trim()).toContain(moved.path.replace(/^\/private/, ''))
  })
})

describe('the knowledge folder changed', () => {
  async function relinkRig(): Promise<{ sessionId: string; root: { path: string } }> {
    const root = { path: join(dir(), 'knowledge-old') }
    e = await makeEngineRig(dir(), { getKnowledgeRoot: () => root.path })
    const sessionId = await e.startSession('autonomous')
    return { sessionId, root }
  }

  it('restarts the brain in the new folder at its next pause and tells it', async () => {
    const { sessionId, root } = await relinkRig()
    const rig = e as EngineRig
    await idle(rig, sessionId)
    root.path = join(dir(), 'linked-docs')
    await rig.rig.service.groupChanged(rig.rig.groupId, { kind: 'knowledge' })

    // The brain was idle: it is stopped right away and restarts on the next message.
    await until(() => rig.brain().stopped)
    await send(rig, sessionId, 'what is in Partitioning?')
    expect(rig.rig.adapter.starts).toHaveLength(2)
    // Same working folder as the first launch (so the conversation resumes); the new knowledge folder is added.
    expect(rig.rig.adapter.starts[1]?.cwd).toBe(rig.rig.adapter.starts[0]?.cwd)
    expect(rig.rig.adapter.starts[1]?.addDirs).toContain(root.path)
    expect(rig.rig.adapter.starts[1]?.instructions).toContain(
      `The group's knowledge folder is ${root.path}`
    )
    expect(rig.rig.sessionsRepo.getById(sessionId)?.brainCwd).toBe(rig.rig.adapter.starts[0]?.cwd)
    expect(rig.rig.adapter.last.sent[0]).toContain(`The knowledge folder is ${root.path}`)
    expect(rig.rig.adapter.last.sent[0]).toContain('the knowledge folder is now')
    // A repeated notification with the same folder changes nothing.
    await rig.rig.service.groupChanged(rig.rig.groupId, { kind: 'knowledge' })
    expect(rig.rig.adapter.last.stopped).toBe(false)
  })

  it('falls back to a folder of its own when the first working folder is gone', async () => {
    const root = { path: join(dir(), 'knowledge-old') }
    const gone = new Set<string>()
    e = await makeEngineRig(dir(), {
      getKnowledgeRoot: () => root.path,
      directoryExists: (p) => !gone.has(p)
    })
    const rig = e
    const sessionId = await rig.startSession('autonomous')
    await idle(rig, sessionId)
    gone.add(root.path)
    root.path = join(dir(), 'linked-docs')
    await rig.rig.service.groupChanged(rig.rig.groupId, { kind: 'knowledge' })
    await until(() => rig.brain().stopped)
    await send(rig, sessionId, 'hello again')
    const fallback = join(dir(), 'userData', 'sessions', sessionId, 'brain')
    expect(rig.rig.adapter.starts[1]?.cwd).toBe(fallback)
    expect(rig.rig.adapter.starts[1]?.addDirs).toContain(root.path)
    expect(rig.rig.sessionsRepo.getById(sessionId)?.brainCwd).toBe(fallback)
  })

  it('keeps the shell policy on the folder the running brain was started in', async () => {
    const { sessionId, root } = await relinkRig()
    const rig = e as EngineRig
    const started = root.path
    expect(started).toContain(dir())
    // A relative redirect writes into the brain's working folder: allowed in the temp folder only.
    const redirect = (): ReturnType<EngineRig['call']> =>
      rig.call(rig.brain(), 'request_permission', {
        tool_name: 'Bash',
        input: { command: 'echo x > out.txt' },
        tool_use_id: 'toolu_c1'
      })
    await send(rig, sessionId, 'hello')
    root.path = '/arc-test-knowledge-root'
    await rig.rig.service.groupChanged(rig.rig.groupId, { kind: 'knowledge' })
    // Mid-turn: the process still runs in the old folder, so the old folder's rules apply.
    expect(rig.brain().stopped).toBe(false)
    const outcome = await redirect()
    expect(outcome.value['behavior']).toBe('allow')
  })
})
