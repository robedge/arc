import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { AgentSetupRepo } from '../../../src/main/db/repositories/agent-setup-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let repo: AgentSetupRepo

const key = { sessionId: 's1', agentKey: 'brain', provider: 'claude' }
const additions = (over: Partial<{ arcAdditionsTokens: number; at: number; model: string }> = {}) =>
  repo.upsertAdditions({ ...key, model: 'sonnet', arcAdditionsTokens: 100, at: 1, ...over })

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  opened.sqlite
    .prepare(
      "INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES ('g1','G','g',1,1)"
    )
    .run()
  opened.sqlite
    .prepare(
      `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
       VALUES ('s1','g1','S','autonomous',2,'auto','sonnet','active',1,1)`
    )
    .run()
  repo = new AgentSetupRepo(opened.db)
})
afterEach(() => opened.sqlite.close())

describe('AgentSetupRepo', () => {
  it('inserts additions with a null fixed setup', () => {
    additions()
    expect(repo.get('s1', 'brain', 'claude')).toMatchObject({
      model: 'sonnet',
      arcAdditionsTokens: 100,
      fixedSetupTokens: null,
      estimatedAt: 1
    })
    expect(repo.get('s1', 'brain', 'codex')).toBeUndefined()
  })

  it('upsertAdditions refreshes additions, model and time but never clobbers the fixed setup', () => {
    additions()
    repo.setFixedSetupIfMissing({ ...key, fixedSetupTokens: 18000 })
    additions({ arcAdditionsTokens: 250, at: 9, model: 'opus' })
    expect(repo.get('s1', 'brain', 'claude')).toMatchObject({
      model: 'opus',
      arcAdditionsTokens: 250,
      fixedSetupTokens: 18000,
      estimatedAt: 9
    })
    expect(repo.forSession('s1')).toHaveLength(1)
  })

  it('setFixedSetupIfMissing sets only once, so a resume cannot overwrite it', () => {
    additions()
    expect(repo.setFixedSetupIfMissing({ ...key, fixedSetupTokens: 18000 })).toBe(true)
    expect(repo.setFixedSetupIfMissing({ ...key, fixedSetupTokens: 64000 })).toBe(false)
    expect(repo.get('s1', 'brain', 'claude')?.fixedSetupTokens).toBe(18000)
  })

  it('setFixedSetupIfMissing without an additions row sets nothing', () => {
    expect(repo.setFixedSetupIfMissing({ ...key, fixedSetupTokens: 5 })).toBe(false)
    expect(repo.get('s1', 'brain', 'claude')).toBeUndefined()
  })

  it('forSession lists every agent and provider of the session only', () => {
    additions()
    repo.upsertAdditions({ ...key, agentKey: 'w1', model: null, arcAdditionsTokens: 7, at: 1 })
    expect(repo.forSession('s1').map((r) => r.agentKey)).toEqual(['brain', 'w1'])
    expect(repo.forSession('other')).toEqual([])
  })
})
