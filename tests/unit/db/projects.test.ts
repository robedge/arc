import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo, isUniqueViolation } from '../../../src/main/db/repositories/groups-repo'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { GroupService } from '../../../src/main/groups/group-service'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let groups: GroupsRepo
let repo: ProjectsRepo
let service: GroupService

const G1 = '01HZZZZZZZZZZZZZZZZZZZZZG1'
const G2 = '01HZZZZZZZZZZZZZZZZZZZZZG2'
const G3 = '01HZZZZZZZZZZZZZZZZZZZZZG3'

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  groups = new GroupsRepo(opened.db)
  repo = new ProjectsRepo(opened.db)
  service = new GroupService({
    db: opened.db,
    groupsRepo: groups,
    appDataDir: join(dir(), 'userData')
  })
  for (const [i, id] of [G1, G2, G3].entries()) {
    groups.insert({
      id,
      name: `g${i}`,
      nameKey: `g${i}`,
      sortOrder: i,
      createdAt: 1,
      updatedAt: 1
    })
  }
})
afterEach(() => {
  opened.sqlite.close()
})

function project(id: string, path: string) {
  repo.insert({ id, path, displayName: id, isGit: false, createdAt: 1 })
}

function memberGroups(projectId: string): string[] {
  return (
    opened.sqlite
      .prepare('SELECT group_id FROM group_projects WHERE project_id = ? ORDER BY group_id')
      .all(projectId) as { group_id: string }[]
  ).map((r) => r.group_id)
}

describe('projects', () => {
  it('inserts and finds by path; duplicate path is rejected', () => {
    project('A', '/p/a')
    expect(repo.getByPath('/p/a')?.id).toBe('A')
    expect(repo.getById('A')?.isGit).toBe(false)
    let caught: unknown
    try {
      project('B', '/p/a')
    } catch (e: unknown) {
      caught = e
    }
    expect(isUniqueViolation(caught)).toBe(true)
  })

  it('updates fields', () => {
    project('A', '/p/a')
    repo.update('A', { path: '/p/z', displayName: 'Z', isGit: true, lastSeenAt: 5 })
    expect(repo.getById('A')).toMatchObject({
      path: '/p/z',
      displayName: 'Z',
      isGit: true,
      lastSeenAt: 5
    })
  })
})

describe('memberships', () => {
  it('rejects the same project twice in a group, allows it in two groups', () => {
    project('A', '/p/a')
    repo.addMembership(G1, 'A', 0, 1)
    let caught: unknown
    try {
      repo.addMembership(G1, 'A', 1, 2)
    } catch (e: unknown) {
      caught = e
    }
    expect(isUniqueViolation(caught)).toBe(true)
    repo.addMembership(G2, 'A', 0, 1)
    expect(memberGroups('A')).toEqual([G1, G2])
    expect(repo.hasMembership(G1, 'A')).toBe(true)
    expect(repo.hasMembership(G3, 'A')).toBe(false)
  })

  it('lists by sort_order then added_at, and reports max sort order', () => {
    project('A', '/p/a')
    project('B', '/p/b')
    project('C', '/p/c')
    expect(repo.maxSortOrder(G1)).toBe(-1)
    repo.addMembership(G1, 'A', 1, 10)
    repo.addMembership(G1, 'B', 0, 20)
    repo.addMembership(G1, 'C', 1, 5)
    expect(repo.listByGroup(G1).map((p) => p.id)).toEqual(['B', 'C', 'A'])
    expect(repo.maxSortOrder(G1)).toBe(1)
  })

  it('RESTRICT: deleting a project that still has memberships fails', () => {
    project('A', '/p/a')
    repo.addMembership(G1, 'A', 0, 1)
    expect(() => opened.sqlite.prepare('DELETE FROM projects WHERE id = ?').run('A')).toThrow(
      /FOREIGN KEY/
    )
  })

  it('deleteIfOrphan is false while a member and true after removal', () => {
    project('A', '/p/a')
    repo.addMembership(G1, 'A', 0, 1)
    expect(repo.deleteIfOrphan('A')).toBe(false)
    expect(repo.getById('A')).toBeDefined()
    repo.removeMembership(G1, 'A')
    expect(repo.deleteIfOrphan('A')).toBe(true)
    expect(repo.getById('A')).toBeUndefined()
  })

  it('mergeMemberships moves memberships, skipping groups that already have the target', () => {
    project('A', '/p/a')
    project('B', '/p/b')
    repo.addMembership(G1, 'A', 0, 1)
    repo.addMembership(G2, 'A', 0, 1)
    repo.addMembership(G2, 'B', 0, 1)
    repo.addMembership(G3, 'B', 0, 1)
    repo.mergeMemberships('A', 'B')
    expect(memberGroups('B')).toEqual([G1, G2, G3])
    expect(repo.getById('A')).toBeUndefined()
    expect(memberGroups('A')).toEqual([])
  })
})

describe('group deletion', () => {
  it('cascades memberships, removes sole-group projects, keeps shared ones', async () => {
    project('SOLO', '/p/solo')
    project('SHARED', '/p/shared')
    repo.addMembership(G1, 'SOLO', 0, 1)
    repo.addMembership(G1, 'SHARED', 1, 1)
    repo.addMembership(G2, 'SHARED', 0, 1)
    await service.delete(G1)
    expect(repo.getById('SOLO')).toBeUndefined()
    expect(repo.getById('SHARED')).toBeDefined()
    expect(memberGroups('SHARED')).toEqual([G2])
  })
})
