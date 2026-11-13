// @spec: 013-session-branches-on-demand
// @regression
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { createGitFixture } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'
import { useTempDir } from '../helpers/temp-dir'
import { makeEngineRig } from './engine-rig'
import type { EngineRig } from './engine-rig'

const dir = useTempDir('arc-header-push-')
let e: EngineRig | undefined
const fixtures: GitFixture[] = []

afterEach(async () => {
  await e?.close()
  e = undefined
  while (fixtures.length) fixtures.pop()?.cleanup()
})

/** The last `session:header` the renderer was sent, reduced to what the header chips need. */
function lastPushed(rig: EngineRig) {
  const header = rig.rig.of('session:header').at(-1)?.header
  return (header?.branches ?? []).map((b) => ({
    name: b.projectName,
    branch: b.branchName,
    removed: b.removed === true
  }))
}

describe('the session header while branches are created on demand', () => {
  it('lists every git project with no branch right after the session is named', async () => {
    e = await makeEngineRig(dir())
    const sessionId = await e.startSession('autonomous')

    const branches = e.rig.service.snapshot(sessionId).header.branches
    // `repo-a` is the rig's own read-only folder.
    expect(branches.map((b) => [b.projectName, b.branchName, b.readOnly])).toEqual([
      ['repo-a', null, true],
      ['api', null, false],
      ['web', null, false]
    ])
  })

  it('pushes the header with the new branch when a worker first starts in a repository', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const before = e.rig.of('session:header').length

    const started = await e.call(e.brain(), 'spawn_worker', {
      name: 'web-fix',
      task: 'Fix web',
      repos: ['web'],
      model: 'sonnet'
    })
    expect(started.value['status']).toBe('started')

    expect(e.rig.of('session:header').length).toBeGreaterThan(before)
    expect(lastPushed(e)).toEqual([
      { name: 'repo-a', branch: null, removed: false },
      { name: 'api', branch: null, removed: false },
      { name: 'web', branch: 'arc/retry-work', removed: false }
    ])
  })

  it('pushes the header with the new project, without a branch, when it joins the group', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const before = e.rig.of('session:header').length

    const infra = createGitFixture()
    fixtures.push(infra)
    const projects = new ProjectsRepo(e.rig.opened.db)
    projects.insert({
      id: 'infra',
      path: infra.path,
      displayName: 'infra',
      isGit: true,
      createdAt: 5
    })
    projects.addMembership(e.rig.groupId, 'infra', 9, 5)
    await e.rig.service.groupChanged(e.rig.groupId, { kind: 'projects' })

    expect(e.rig.of('session:header').length).toBeGreaterThan(before)
    expect(lastPushed(e)).toContainEqual({ name: 'infra', branch: null, removed: false })
  })

  it('pushes the header with the project marked removed when it leaves the group', async () => {
    e = await makeEngineRig(dir())
    await e.startSession('autonomous')
    const before = e.rig.of('session:header').length

    const projects = new ProjectsRepo(e.rig.opened.db)
    projects.removeMembership(e.rig.groupId, 'p-web')
    projects.deleteIfOrphan('p-web')
    await e.rig.service.groupChanged(e.rig.groupId, { kind: 'projects' })

    expect(e.rig.of('session:header').length).toBeGreaterThan(before)
    expect(lastPushed(e)).toContainEqual({ name: 'web', branch: null, removed: true })
  })
})
