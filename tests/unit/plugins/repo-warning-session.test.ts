import { afterEach, describe, expect, it } from 'vitest'
import { RepoSettingsWarner } from '../../../src/main/plugins/plugin-service'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { createGitFixture } from '../../helpers/git-fixtures'
import type { GitFixture } from '../../helpers/git-fixtures'
import { makeEngineRig, until } from '../sessions/engine-rig'
import type { EngineRig } from '../sessions/engine-rig'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-repo-warning-')
let e: EngineRig | undefined
let fixture: GitFixture | undefined

afterEach(async () => {
  await e?.close()
  e = undefined
  fixture?.cleanup()
  fixture = undefined
})

describe('repository settings warning in a session', () => {
  it('is logged when the orchestrator is created and once more for a newly joined project, never repeated', async () => {
    const asked: string[] = []
    e = await makeEngineRig(dir(), {
      repoSettings: new RepoSettingsWarner({
        warnings: (path) => {
          asked.push(path)
          return Promise.resolve({ hooks: true, enabledPlugins: [] })
        }
      })
    })
    const sessionId = await e.startSession('autonomous')
    const warnings = (): string[] =>
      e!.rig.eventsRepo
        .latest(sessionId, 100)
        .filter((x) => x.kind === 'repo-settings')
        .map((x) => x.text)
    // The rig's group has three repositories: one line each.
    await until(() => warnings().length === 3)
    for (const text of warnings()) {
      expect(text).toMatch(
        /^(repo-a|api|web) has its own Claude Code settings: its hooks will run in workers\.$/
      )
    }

    fixture = createGitFixture({ kind: 'clean' })
    const projects = new ProjectsRepo(e.rig.opened.db)
    projects.insert({
      id: 'infra',
      path: fixture.path,
      displayName: 'infra',
      isGit: true,
      createdAt: 5
    })
    projects.addMembership(e.rig.groupId, 'infra', 9, 5)
    await e.rig.service.groupChanged(e.rig.groupId, { kind: 'projects' })
    await until(() => warnings().length === 4)
    expect(warnings()[3]).toMatch(/^infra has its own/)

    // The same change again, and a reopened session, add nothing.
    await e.rig.service.groupChanged(e.rig.groupId, { kind: 'projects' })
    await e.rig.service.groupChanged(e.rig.groupId, { kind: 'projects' })
    expect(warnings()).toHaveLength(4)
    expect(new Set(asked).size).toBe(asked.length)
  })
})
