import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { GroupService } from '../../../src/main/groups/group-service'
import {
  ProjectService,
  canonicalizePath,
  detectGit
} from '../../../src/main/groups/project-service'
import type { Dialogs } from '../../../src/main/platform/dialogs'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from '../db/helpers'

const run = promisify(execFile)
const dir = useTempDir()
let opened: OpenedDatabase
let projectsRepo: ProjectsRepo
let groupService: GroupService
let service: ProjectService
let nextPick: string[] | null = null
let work: string

const dialogs: Dialogs = {
  pickFolders: () => Promise.resolve(nextPick),
  pickFiles: () => Promise.resolve(null),
  pickSaveFolder: () => Promise.resolve(null)
}

beforeEach(async () => {
  work = await realpath(dir())
  opened = openDatabase({ dbPath: join(work, 'arc.db'), migrationsFolder: realMigrations })
  projectsRepo = new ProjectsRepo(opened.db)
  groupService = new GroupService({
    db: opened.db,
    groupsRepo: new GroupsRepo(opened.db),
    appDataDir: join(work, 'userData')
  })
  service = new ProjectService({ db: opened.db, projectsRepo, dialogs })
  nextPick = null
})
afterEach(() => opened.sqlite.close())

const git = (cwd: string, ...args: string[]): Promise<unknown> =>
  run('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args])

async function makeRepo(name: string): Promise<string> {
  const repo = join(work, name)
  await mkdir(repo, { recursive: true })
  await git(repo, 'init')
  await git(repo, 'config', 'user.name', 'Test')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await writeFile(join(repo, 'a.txt'), 'a')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', 'init')
  return repo
}

async function makeDir(name: string): Promise<string> {
  const p = join(work, name)
  await mkdir(p, { recursive: true })
  return p
}

describe('detectGit', () => {
  it('detects a repo, a worktree, a subfolder and rejects a plain folder', async () => {
    const repo = await makeRepo('repo')
    const wt = join(work, 'wt')
    await git(repo, 'worktree', 'add', wt, '-b', 'feature')
    const sub = await makeDir('repo/src/deep')
    const plain = await makeDir('plain')

    expect(await detectGit(repo)).toBe(true)
    expect(await detectGit(wt)).toBe(true)
    expect((await lstat(join(wt, '.git'))).isFile()).toBe(true)
    expect(await detectGit(sub)).toBe(true)
    expect(await detectGit(plain)).toBe(false)
  })

  it('is false when the git invocation fails', async () => {
    const sub = await makeDir('nogit')
    const failing = (): Promise<never> => Promise.reject(new Error('spawn git ENOENT'))
    expect(await detectGit(sub, failing)).toBe(false)
  })
})

describe('canonicalizePath', () => {
  it('strips trailing slashes, resolves symlinks and normalizes to NFC', async () => {
    const p = await makeDir('café')
    expect(await canonicalizePath(`${p}/`)).toBe(join(work, 'café'))
    expect(await canonicalizePath(join(work, 'missing/'))).toBe(join(work, 'missing'))
  })
})

describe('ProjectService', () => {
  async function newGroup(name: string): Promise<string> {
    return (await groupService.create(name)).id
  }

  it('adds folders with git flags and names, then reports duplicates and invalid inputs', async () => {
    const g = await newGroup('G')
    const repo = await makeRepo('repo')
    const sub = await makeDir('repo/sub')
    const plain = await makeDir('plain')
    const file = join(work, 'file.txt')
    await writeFile(file, 'x')
    const link = join(work, 'link')
    await symlink(plain, link)

    const res = await service.add(g, [repo, sub, plain])
    expect(res.skipped).toEqual([])
    expect(res.added.map((p) => [p.name, p.isGit, p.available])).toEqual([
      ['repo', true, true],
      ['sub', true, true],
      ['plain', false, true]
    ])

    const again = await service.add(g, [repo, file, join(work, 'nope'), link, `${plain}/`])
    expect(again.added).toEqual([])
    expect(again.skipped).toEqual([
      { path: repo, code: 'PROJECT_DUPLICATE' },
      { path: file, code: 'PROJECT_NOT_DIRECTORY' },
      { path: join(work, 'nope'), code: 'FOLDER_MISSING' },
      { path: link, code: 'PROJECT_DUPLICATE' },
      { path: `${plain}/`, code: 'PROJECT_DUPLICATE' }
    ])
    expect((await service.list(g)).map((p) => p.name)).toEqual(['repo', 'sub', 'plain'])
  })

  it('flags two inputs resolving to the same folder within one batch', async () => {
    const g = await newGroup('G')
    const plain = await makeDir('plain')
    const link = join(work, 'link')
    await symlink(plain, link)
    const res = await service.add(g, [plain, link])
    expect(res.added).toHaveLength(1)
    expect(res.skipped).toEqual([{ path: link, code: 'PROJECT_DUPLICATE' }])
  })

  it('shares one projects row between groups', async () => {
    const g1 = await newGroup('One')
    const g2 = await newGroup('Two')
    const plain = await makeDir('plain')
    await service.add(g1, [plain])
    await service.add(g2, [plain])
    const [a] = await service.list(g1)
    const [b] = await service.list(g2)
    expect(a?.id).toBe(b?.id)
    expect(opened.sqlite.prepare('select count(*) as n from projects').get()).toEqual({ n: 1 })

    // shared row survives removal from one group
    service.remove(g1, a!.id)
    expect(await service.list(g1)).toEqual([])
    expect(projectsRepo.getById(a!.id)).toBeDefined()
  })

  it('remove drops the membership and orphan row but leaves the folder on disk', async () => {
    const g = await newGroup('G')
    const plain = await makeDir('plain')
    const { added } = await service.add(g, [plain])
    service.remove(g, added[0]!.id)
    expect(await service.list(g)).toEqual([])
    expect(projectsRepo.getById(added[0]!.id)).toBeUndefined()
    expect(existsSync(plain)).toBe(true)
  })

  it('reports available=false after the folder is renamed on disk', async () => {
    const g = await newGroup('G')
    const plain = await makeDir('plain')
    await service.add(g, [plain])
    await rename(plain, join(work, 'moved'))
    expect((await service.list(g)).map((p) => p.available)).toEqual([false])
  })

  it('pick feeds the dialog selection into add and handles cancel', async () => {
    const g = await newGroup('G')
    const plain = await makeDir('plain')
    expect(await service.pick(g)).toEqual({ added: [], skipped: [] })
    nextPick = [plain]
    const res = await service.pick(g)
    expect(res.added.map((p) => p.path)).toEqual([plain])
  })
})

describe('ProjectService.relocate', () => {
  async function setup(): Promise<{ a: string; b: string; id: string; old: string }> {
    const a = (await groupService.create('A')).id
    const b = (await groupService.create('B')).id
    const old = await makeDir('old')
    const added = await service.add(a, [old])
    const id = added.added[0]!.id
    await service.add(b, [old])
    return { a, b, id, old }
  }

  it('updates the path for every group containing the project', async () => {
    const { a, b, id } = await setup()
    const next = await makeDir('next')
    nextPick = [next]
    const result = await service.relocate(a, id)
    expect(result).toMatchObject({ id, path: next, name: 'next', available: true })
    expect((await service.list(b)).map((p) => p.path)).toEqual([next])
  })

  it('merges memberships when the new path already belongs to another project', async () => {
    const { a, b, id } = await setup()
    const c = (await groupService.create('C')).id
    const target = await makeDir('target')
    const other = (await service.add(c, [target])).added[0]!
    await service.add(a, [target]) // a already contains the target: merge must skip it
    nextPick = [target]

    const result = await service.relocate(b, id)

    expect(result.id).toBe(other.id)
    expect(projectsRepo.getById(id)).toBeUndefined()
    expect((await service.list(b)).map((p) => p.id)).toEqual([other.id])
    expect((await service.list(a)).map((p) => p.id)).toEqual([other.id])
  })

  it('returns the project unchanged when the picker is canceled', async () => {
    const { a, id, old } = await setup()
    nextPick = null
    expect(await service.relocate(a, id)).toMatchObject({ id, path: old })
  })

  it('rejects a file with PROJECT_NOT_DIRECTORY', async () => {
    const { a, id } = await setup()
    const file = join(work, 'f.txt')
    await writeFile(file, 'x')
    nextPick = [file]
    await expect(service.relocate(a, id)).rejects.toMatchObject({ code: 'PROJECT_NOT_DIRECTORY' })
  })
})
