import { execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeItemsRepo } from '../../../src/main/db/repositories/knowledge-items-repo'
import { KnowledgeSuggestionsRepo } from '../../../src/main/db/repositories/knowledge-suggestions-repo'
import {
  KnowledgeSuggestionRefused,
  KnowledgeSuggestionService,
  MAX_SUGGESTIONS_PER_REQUEST
} from '../../../src/main/knowledge/knowledge-suggestion-service'
import type {
  SuggestNewInput,
  SuggestUpdateInput
} from '../../../src/main/knowledge/knowledge-suggestion-service'
import { KnowledgeIndex } from '../../../src/main/knowledge/knowledge-index'
import { KnowledgeService } from '../../../src/main/knowledge/knowledge-service'
import { AppErrorException } from '../../../src/shared/errors'
import type { ErrorCode, ErrorDetails } from '../../../src/shared/errors'
import type { IpcEvents } from '../../../src/shared/ipc/contract'
import type { KnowledgeSuggestionView } from '../../../src/shared/types/knowledge-suggestion'
import { useTempDir } from '../helpers/temp-dir'
import { createEnv } from './knowledge-test-env'
import type { KnowledgeEnv } from './knowledge-test-env'

const dir = useTempDir()
let env: KnowledgeEnv
let svc: KnowledgeSuggestionService
let logged: { sessionId: string; kind: string; text: string; data: unknown }[]
let pushed: { sessionId: string; waiting: KnowledgeSuggestionView[] }[]
let changed: IpcEvents['knowledge:changed'][]
let locked: boolean
let clock: number
let ids: number

beforeEach(async () => {
  env = await createEnv(dir())
  env.opened.sqlite
    .prepare(
      `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
       VALUES ('s1',?,'Sess','autonomous',2,'opus','sonnet','active',1,50)`
    )
    .run(env.groupId)
  logged = []
  pushed = []
  changed = []
  locked = false
  clock = 1000
  ids = 0
  svc = new KnowledgeSuggestionService({
    repo: new KnowledgeSuggestionsRepo(env.opened.db),
    sectionsRepo: env.sectionsRepo,
    getKnowledgeRoot: () => env.root,
    knowledge: env.service,
    itemsRepo: env.itemsRepo,
    emitChanged: (payload) => void changed.push(payload),
    isStorageLocked: () => locked,
    logSessionEvent: (sessionId, kind, text, data) =>
      void logged.push({ sessionId, kind, text, data }),
    publish: (sessionId, waiting) => void pushed.push({ sessionId, waiting }),
    now: () => (clock += 10),
    newId: () => `k${(ids += 1)}`
  })
})
afterEach(() => env.opened.sqlite.close())

const newNote = (over: Partial<SuggestNewInput> = {}): SuggestNewInput => ({
  kind: 'new',
  title: 'Orders table is partitioned by month',
  reason: 'Read in the schema dump',
  section: 'Notes',
  name: 'Service map',
  content: 'Checkout calls pricing twice.',
  ...over
})

async function refusal(p: Promise<unknown>): Promise<KnowledgeSuggestionRefused> {
  try {
    await p
  } catch (error: unknown) {
    if (error instanceof KnowledgeSuggestionRefused) return error
    throw error
  }
  throw new Error('expected a refusal')
}

const suggest = (input: SuggestNewInput = newNote(), request = 'm1') =>
  svc.suggest('s1', env.groupId, request, input)

describe('suggest a new note', () => {
  it('stores it and lists it newest first with the view fields', async () => {
    const first = await suggest()
    await suggest(newNote({ name: 'Other', content: 'second' }))
    expect(first.id).toBe('k1')
    const list = svc.listWaiting('s1')
    expect(list.map((v) => v.id)).toEqual(['k2', 'k1'])
    expect(list[1]).toEqual({
      id: 'k1',
      sessionId: 's1',
      kind: 'new',
      title: 'Orders table is partitioned by month',
      reason: 'Read in the schema dump',
      sectionId: env.notesId,
      sectionName: 'Notes',
      target: { itemId: null, name: 'Service map.md', relPath: null },
      text: 'Checkout calls pricing twice.',
      createdAt: 1010
    })
  })

  it('matches the section by folder, case-insensitively, and accepts a text extension', async () => {
    await suggest(newNote({ section: 'notes', name: 'schema.sql' }))
    expect(svc.listWaiting('s1')[0]?.target.name).toBe('schema.sql')
  })

  it('matches a custom section by its name', async () => {
    await env.sections.create(env.groupId, 'Runbooks')
    await suggest(newNote({ section: 'RUNBOOKS' }))
    expect(svc.listWaiting('s1')[0]?.sectionName).toBe('Runbooks')
  })

  it('logs knowledge-suggested with the title and destination', async () => {
    await suggest()
    expect(logged).toEqual([
      {
        sessionId: 's1',
        kind: 'knowledge-suggested',
        text: 'Orders table is partitioned by month · Notes › New note: Service map',
        data: {
          id: 'k1',
          action: 'new',
          section: { id: env.notesId, name: 'Notes' },
          target: { name: 'Service map.md', relPath: null }
        }
      }
    ])
  })

  it('pushes the full waiting list after each suggestion', async () => {
    await suggest()
    await suggest(newNote({ name: 'Other', content: 'second' }))
    expect(pushed.map((p) => p.waiting.map((v) => v.id))).toEqual([['k1'], ['k2', 'k1']])
    expect(pushed[1]?.sessionId).toBe('s1')
  })

  it('writes nothing to the knowledge folder', async () => {
    const before = await readdir(env.root, { recursive: true })
    await suggest()
    expect(await readdir(env.root, { recursive: true })).toEqual(before)
  })

  it('keeps a traversal name inside the root', async () => {
    await suggest(newNote({ name: '../../x' }))
    expect(svc.listWaiting('s1')[0]?.target.name).toBe('x.md')
  })

  it('refuses a name with nothing usable left', async () => {
    expect((await refusal(suggest(newNote({ name: '../..' })))).code).toBe('invalid_name')
  })
})

describe('refusals', () => {
  it('unknown_section carries the valid section names', async () => {
    const r = await refusal(suggest(newNote({ section: 'Nope' })))
    expect(r.code).toBe('unknown_section')
    expect(r.validSections).toEqual(['Notes', 'Docs', 'Playbooks'])
  })

  it.each(['Projects', 'Links'])('section_not_allowed for %s', async (section) => {
    expect((await refusal(suggest(newNote({ section })))).code).toBe('section_not_allowed')
    expect(svc.listWaiting('s1')).toEqual([])
  })

  it('not_text_file for a non-text extension', async () => {
    expect((await refusal(suggest(newNote({ name: 'diagram.pdf' })))).code).toBe('not_text_file')
  })

  it('does not mistake a dotted title for an extension', async () => {
    await suggest(newNote({ name: 'Release 2.0 plan' }))
    expect(svc.listWaiting('s1')[0]?.target.name).toBe('Release 2.0 plan.md')
  })

  it('duplicate when the same suggestion is waiting', async () => {
    await suggest()
    const r = await refusal(
      suggest(newNote({ title: 'Another title', content: ' checkout  CALLS pricing twice. ' }))
    )
    expect(r.code).toBe('duplicate')
  })

  it('already_discarded when the user discarded it', async () => {
    const { id } = await suggest()
    svc.discard(id)
    expect((await refusal(suggest())).code).toBe('already_discarded')
  })
})

describe('discard', () => {
  it('removes it from the waiting list, logs the event and pushes the list', async () => {
    const a = await suggest()
    await suggest(newNote({ name: 'Other', content: 'second' }))
    logged.length = 0
    pushed.length = 0
    svc.discard(a.id)
    expect(svc.listWaiting('s1').map((v) => v.id)).toEqual(['k2'])
    expect(logged).toEqual([
      {
        sessionId: 's1',
        kind: 'knowledge-discarded',
        text: 'Orders table is partitioned by month · Notes › New note: Service map · Discarded',
        data: {
          id: 'k1',
          action: 'new',
          section: { id: env.notesId, name: 'Notes' },
          target: { name: 'Service map.md', relPath: null }
        }
      }
    ])
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.waiting.map((v) => v.id)).toEqual(['k2'])
  })

  it('is a quiet no-op for an unknown or already resolved id', async () => {
    const a = await suggest()
    svc.discard(a.id)
    logged.length = 0
    pushed.length = 0
    expect(() => svc.discard(a.id)).not.toThrow()
    expect(() => svc.discard('missing')).not.toThrow()
    expect(logged).toEqual([])
    expect(pushed).toEqual([])
  })

  it('writes nothing to the knowledge folder', async () => {
    const a = await suggest()
    const before = await readdir(env.root, { recursive: true })
    svc.discard(a.id)
    expect(await readdir(env.root, { recursive: true })).toEqual(before)
  })
})

describe('without a live log sink', () => {
  it('still stores when the event sink is a spy that does nothing', async () => {
    const spy = vi.fn()
    const alone = new KnowledgeSuggestionService({
      repo: new KnowledgeSuggestionsRepo(env.opened.db),
      sectionsRepo: env.sectionsRepo,
      getKnowledgeRoot: () => env.root,
      knowledge: env.service,
      itemsRepo: env.itemsRepo,
      emitChanged: () => undefined,
      logSessionEvent: spy,
      publish: () => undefined
    })
    await alone.suggest('s1', env.groupId, 'm1', newNote())
    expect(spy).toHaveBeenCalledTimes(1)
    expect(alone.listWaiting('s1')).toHaveLength(1)
  })
})

interface Failure {
  code: ErrorCode | undefined
  details: ErrorDetails | undefined
}

async function failure(p: Promise<unknown>): Promise<Failure> {
  try {
    await p
  } catch (error: unknown) {
    if (error instanceof AppErrorException) return { code: error.code, details: error.details }
    throw error
  }
  return { code: undefined, details: undefined }
}

describe('suggest refuses a taken name', () => {
  it('name_taken for an existing file, case-insensitively', async () => {
    await env.service.create(env.notesId, 'Service map')
    expect((await refusal(suggest(newNote({ name: 'service MAP' })))).code).toBe('name_taken')
    expect(svc.listWaiting('s1')).toEqual([])
  })

  it('name_taken respects the extension', async () => {
    await env.service.create(env.notesId, 'Service map')
    await suggest(newNote({ name: 'Service map.txt' }))
    expect(svc.listWaiting('s1')).toHaveLength(1)
  })
})

describe('accept a new note', () => {
  it('creates the note in the app folder and returns the outcome', async () => {
    const { id } = await suggest()
    logged.length = 0
    pushed.length = 0
    const outcome = await svc.accept(id)
    expect(await readFile(join(env.root, 'Notes', 'Service map.md'), 'utf8')).toBe(
      'Checkout calls pricing twice.'
    )
    const item = (await env.service.reconcileAndList(env.notesId))[0]
    expect(item?.fileName).toBe('Service map.md')
    expect(outcome).toEqual({
      groupId: env.groupId,
      sectionId: env.notesId,
      sectionName: 'Notes',
      itemId: item?.id,
      name: 'Service map.md',
      edited: false
    })
  })

  it('marks it accepted, logs knowledge-accepted, pushes the list and emits knowledge:changed', async () => {
    const { id } = await suggest()
    await suggest(newNote({ name: 'Other', content: 'second' }))
    logged.length = 0
    pushed.length = 0
    const outcome = await svc.accept(id)
    expect(svc.listWaiting('s1').map((v) => v.id)).toEqual(['k2'])
    expect(
      env.opened.sqlite.prepare('SELECT status FROM knowledge_suggestions WHERE id=?').get(id)
    ).toEqual({ status: 'accepted' })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({
      sessionId: 's1',
      kind: 'knowledge-accepted',
      text: 'Orders table is partitioned by month · Notes › New note: Service map · Accepted'
    })
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.waiting.map((v) => v.id)).toEqual(['k2'])
    const item = env.itemsRepo.getById(outcome.itemId)
    expect(changed).toHaveLength(1)
    expect(changed[0]).toEqual({
      groupId: env.groupId,
      sectionIds: [env.notesId],
      items: [{ id: outcome.itemId, sectionId: env.notesId, revision: expect.any(String) }],
      reason: 'suggestion'
    })
    expect(item).toBeDefined()
  })

  it('writes into a linked git folder and makes no commit', async () => {
    const linked = join(dir(), 'linked')
    await mkdir(join(linked, 'Notes'), { recursive: true })
    await writeFile(join(linked, 'Notes', 'existing.md'), 'x')
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
        cwd: linked,
        encoding: 'utf8'
      })
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const before = git('log', '--oneline')
    const getKnowledgeRoot = (): string => linked
    const knowledge = new KnowledgeService({
      sectionsRepo: env.sectionsRepo,
      itemsRepo: new KnowledgeItemsRepo(env.opened.db),
      index: new KnowledgeIndex({
        sectionsRepo: env.sectionsRepo,
        itemsRepo: env.itemsRepo,
        metaStore: env.metaStore,
        getKnowledgeRoot
      }),
      metaStore: env.metaStore,
      getKnowledgeRoot
    })
    const linkedSvc = new KnowledgeSuggestionService({
      repo: new KnowledgeSuggestionsRepo(env.opened.db),
      sectionsRepo: env.sectionsRepo,
      getKnowledgeRoot,
      knowledge,
      itemsRepo: env.itemsRepo,
      emitChanged: () => undefined,
      logSessionEvent: () => undefined,
      publish: () => undefined
    })
    const { id } = await linkedSvc.suggest('s1', env.groupId, 'm1', newNote())
    await linkedSvc.accept(id)
    expect(await readFile(join(linked, 'Notes', 'Service map.md'), 'utf8')).toBe(
      'Checkout calls pricing twice.'
    )
    expect(git('status', '--porcelain')).toMatch(/\?\? "?Notes\/Service map\.md"?/)
    expect(git('log', '--oneline')).toBe(before)
  })

  it('keeps a non-md extension', async () => {
    const { id } = await suggest(newNote({ name: 'schema.sql', content: 'select 1;' }))
    const outcome = await svc.accept(id)
    expect(outcome.name).toBe('schema.sql')
    expect(await readFile(join(env.root, 'Notes', 'schema.sql'), 'utf8')).toBe('select 1;')
  })

  it('refuses a name taken since it was suggested and writes nothing', async () => {
    const { id } = await suggest()
    await writeFile(join(env.root, 'Notes', 'service map.md'), 'mine')
    logged.length = 0
    expect((await failure(svc.accept(id))).code).toBe('ITEM_NAME_TAKEN')
    expect(await readFile(join(env.root, 'Notes', 'service map.md'), 'utf8')).toBe('mine')
    expect(await readdir(join(env.root, 'Notes'))).toEqual(['service map.md'])
    expect(svc.listWaiting('s1').map((v) => v.id)).toEqual([id])
    expect(logged).toEqual([])
    expect(changed).toEqual([])
  })

  it('IO_FAILED with the location when the folder cannot be written; it stays waiting', async () => {
    const { id } = await suggest()
    await rm(join(env.root, 'Notes'), { recursive: true })
    const f = await failure(svc.accept(id))
    expect(f.code).toBe('IO_FAILED')
    expect(f.details?.location).toBe(join(env.root, 'Notes'))
    expect(svc.listWaiting('s1').map((v) => v.id)).toEqual([id])
    expect(changed).toEqual([])
    // Try again works once the folder is back.
    await mkdir(join(env.root, 'Notes'))
    await svc.accept(id)
    expect(svc.listWaiting('s1')).toEqual([])
  })

  it('KNOWLEDGE_ROOT_MISSING with the location when the root is gone', async () => {
    const { id } = await suggest()
    await rm(env.root, { recursive: true })
    const f = await failure(svc.accept(id))
    expect(f.code).toBe('KNOWLEDGE_ROOT_MISSING')
    expect(f.details?.location).toBe(join(env.root, 'Notes'))
    expect(svc.listWaiting('s1')).toHaveLength(1)
  })

  it('STORAGE_BUSY while a storage move runs, writing nothing', async () => {
    const { id } = await suggest()
    locked = true
    expect((await failure(svc.accept(id))).code).toBe('STORAGE_BUSY')
    expect(await readdir(join(env.root, 'Notes'))).toEqual([])
    expect(svc.listWaiting('s1')).toHaveLength(1)
  })

  it('SUGGESTION_NOT_FOUND for an unknown or already resolved id', async () => {
    expect((await failure(svc.accept('missing'))).code).toBe('SUGGESTION_NOT_FOUND')
    const a = await suggest()
    await svc.accept(a.id)
    expect((await failure(svc.accept(a.id))).code).toBe('SUGGESTION_NOT_FOUND')
    const b = await suggest(newNote({ name: 'B', content: 'b' }))
    svc.discard(b.id)
    expect((await failure(svc.accept(b.id))).code).toBe('SUGGESTION_NOT_FOUND')
  })

  it('refuses a tampered traversal name and writes nothing outside the root', async () => {
    const { id } = await suggest()
    env.opened.sqlite
      .prepare('UPDATE knowledge_suggestions SET proposed_name=? WHERE id=?')
      .run('../../escape.md', id)
    expect((await failure(svc.accept(id))).code).toBe('VALIDATION_FAILED')
    await expect(readFile(join(env.root, '..', '..', 'escape.md'))).rejects.toThrow()
    expect(await readdir(join(env.root, 'Notes'))).toEqual([])
    expect(svc.listWaiting('s1')).toHaveLength(1)
  })

  it('refuses a tampered non-text extension', async () => {
    const { id } = await suggest()
    env.opened.sqlite
      .prepare('UPDATE knowledge_suggestions SET proposed_name=? WHERE id=?')
      .run('x.pdf', id)
    expect((await failure(svc.accept(id))).code).toBe('VALIDATION_FAILED')
  })

  it('refuses when the section is no longer allowed or gone', async () => {
    const { id } = await suggest()
    env.opened.sqlite
      .prepare('UPDATE knowledge_suggestions SET section_id=? WHERE id=?')
      .run('nope', id)
    expect((await failure(svc.accept(id))).code).toBe('SECTION_NOT_FOUND')
    expect(svc.listWaiting('s1')).toHaveLength(1)
  })
})

describe('suggest an update to an existing note', () => {
  const schema = 'Orders\nare stored daily.\nShipments\nare stored weekly.\n'
  let itemId: string
  let notePath: string

  const edit = (old_text: string, new_text: string): { old_text: string; new_text: string } => ({
    old_text,
    new_text
  })
  const update = (over: Partial<SuggestUpdateInput> = {}): SuggestUpdateInput => ({
    kind: 'update',
    title: 'Orders table is partitioned by month',
    reason: 'Read in the schema dump',
    section: 'Notes',
    file: 'Schema',
    edits: [edit('are stored daily.', 'are partitioned by month.')],
    ...over
  })
  const row = (id: string): Record<string, string | null> =>
    env.opened.sqlite.prepare('SELECT * FROM knowledge_suggestions WHERE id=?').get(id) as Record<
      string,
      string | null
    >

  beforeEach(async () => {
    const item = await env.service.createWithContent(env.notesId, 'Schema.md', schema)
    itemId = item.id
    notePath = join(env.root, 'Notes', 'Schema.md')
  })

  it('stores the result, the diff and the revision, and leaves the file alone', async () => {
    const { id } = await svc.suggest('s1', env.groupId, 'm1', update())
    const stored = row(id)
    const current = await env.service.read(itemId)
    expect(current.type === 'text' && stored['base_revision'] === current.revision).toBe(true)
    expect(stored['action']).toBe('update')
    expect(stored['target_rel_path']).toBe('Notes/Schema.md')
    expect(stored['proposed_name']).toBeNull()
    expect(stored['proposed_content']).toBe(
      'Orders\nare partitioned by month.\nShipments\nare stored weekly.\n'
    )
    const hunks = JSON.parse(String(stored['hunks_json'])) as {
      lines: { kind: string; text: string }[]
    }[]
    const lines = hunks.flatMap((h) => h.lines)
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual([
      'are partitioned by month.'
    ])
    expect(lines.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['are stored daily.'])
    expect(await readFile(notePath, 'utf8')).toBe(schema)
  })

  it('shows the update in the view with the item id and no text', async () => {
    const { id } = await svc.suggest('s1', env.groupId, 'm1', update())
    const view = svc.listWaiting('s1').find((v) => v.id === id)
    expect(view?.kind).toBe('update')
    expect(view?.target).toEqual({ itemId, name: 'Schema.md', relPath: 'Notes/Schema.md' })
    expect(view?.text).toBeUndefined()
    expect(view?.hunks?.length).toBeGreaterThan(0)
  })

  it('applies two non-overlapping edits, given in any order', async () => {
    const { id } = await svc.suggest(
      's1',
      env.groupId,
      'm1',
      update({
        edits: [edit('are stored weekly.', 'are stored hourly.'), edit('Orders', 'Orders table')]
      })
    )
    expect(row(id)['proposed_content']).toBe(
      'Orders table\nare stored daily.\nShipments\nare stored hourly.\n'
    )
  })

  it('finds the file by name, case-insensitively, with or without .md', async () => {
    const spellings = ['schema.md', 'SCHEMA', 'Schema.md', 'Schema']
    for (const [i, file] of spellings.entries()) {
      await svc.suggest(
        's1',
        env.groupId,
        'm1',
        update({ file, edits: [edit('Orders', `Orders ${i}`)] })
      )
    }
    const paths = svc.listWaiting('s1').map((v) => v.target.relPath)
    expect(paths).toEqual(spellings.map(() => 'Notes/Schema.md'))
  })

  it('finds a file in a subfolder by its path within the section', async () => {
    await mkdir(join(env.root, 'Notes', 'db'), { recursive: true })
    await writeFile(join(env.root, 'Notes', 'db', 'Tables.md'), 'Orders\n')
    await svc.suggest(
      's1',
      env.groupId,
      'm1',
      update({ file: 'DB/tables', edits: [edit('Orders', 'Orders, monthly')] })
    )
    expect(svc.listWaiting('s1')[0]?.target.relPath).toBe('Notes/db/Tables.md')
  })

  it('file_not_found for a missing file', async () => {
    const r = await refusal(svc.suggest('s1', env.groupId, 'm1', update({ file: 'Nope' })))
    expect(r.code).toBe('file_not_found')
    expect(svc.listWaiting('s1')).toEqual([])
  })

  it('file_not_found for a path that climbs out of the section', async () => {
    await writeFile(join(env.root, 'secret.md'), 'x')
    for (const file of ['../secret.md', '../../secret', 'Notes/../../secret.md']) {
      expect((await refusal(svc.suggest('s1', env.groupId, 'm1', update({ file })))).code).toBe(
        'file_not_found'
      )
    }
  })

  it('applies the section rules to an update', async () => {
    expect(
      (await refusal(svc.suggest('s1', env.groupId, 'm1', update({ section: 'Nope' })))).code
    ).toBe('unknown_section')
    expect(
      (await refusal(svc.suggest('s1', env.groupId, 'm1', update({ section: 'Links' })))).code
    ).toBe('section_not_allowed')
  })

  it('not_text_file for a binary file in Docs', async () => {
    await writeFile(join(env.root, 'Docs', 'Diagram.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0]))
    const r = await refusal(
      svc.suggest('s1', env.groupId, 'm1', update({ section: 'Docs', file: 'Diagram.pdf' }))
    )
    expect(r.code).toBe('not_text_file')
  })

  it('not_text_file for a link item, which is never editable text', async () => {
    const spy = vi.spyOn(env.service, 'reconcileAndList').mockResolvedValue([
      {
        id: itemId,
        sectionId: env.notesId,
        title: 'Wiki',
        fileName: 'Wiki.md',
        description: '',
        kind: 'link',
        editable: true,
        revision: 'r'
      }
    ])
    const r = await refusal(svc.suggest('s1', env.groupId, 'm1', update({ file: 'Wiki' })))
    spy.mockRestore()
    expect(r.code).toBe('not_text_file')
  })

  it('edit_not_found when old_text does not occur, naming the edit', async () => {
    const r = await refusal(
      svc.suggest(
        's1',
        env.groupId,
        'm1',
        update({ edits: [edit('Orders', 'Orders!'), edit('missing text', 'x')] })
      )
    )
    expect(r.code).toBe('edit_not_found')
    expect(r.message).toContain('Edit 2')
    expect(svc.listWaiting('s1')).toEqual([])
  })

  it('edit_ambiguous when old_text occurs more than once', async () => {
    const r = await refusal(
      svc.suggest('s1', env.groupId, 'm1', update({ edits: [edit('are stored', 'are kept')] }))
    )
    expect(r.code).toBe('edit_ambiguous')
    expect(svc.listWaiting('s1')).toEqual([])
  })

  it('edit_ambiguous when two edits overlap', async () => {
    const r = await refusal(
      svc.suggest(
        's1',
        env.groupId,
        'm1',
        update({
          edits: [edit('Orders\nare stored', 'Orders\nare kept'), edit('stored daily.', 'x')]
        })
      )
    )
    expect(r.code).toBe('edit_ambiguous')
  })

  it('locates every edit against the original text, not the result of the edit before', async () => {
    // Applied one after the other, the second old_text would occur twice. Against the original it
    // occurs once, so both apply.
    const { id } = await svc.suggest(
      's1',
      env.groupId,
      'm1',
      update({
        edits: [
          edit('are stored daily.', 'are stored weekly.'),
          edit('are stored weekly.', 'are stored hourly.')
        ]
      })
    )
    expect(row(id)['proposed_content']).toBe(
      'Orders\nare stored weekly.\nShipments\nare stored hourly.\n'
    )
  })

  it('refuses a result identical to the file as a duplicate', async () => {
    const r = await refusal(
      svc.suggest('s1', env.groupId, 'm1', update({ edits: [edit('Orders', 'Orders')] }))
    )
    expect(r.code).toBe('duplicate')
    expect(r.message).toContain('already says this')
  })

  it('duplicate for the same update twice, already_discarded after a discard', async () => {
    const { id } = await svc.suggest('s1', env.groupId, 'm1', update())
    expect((await refusal(svc.suggest('s1', env.groupId, 'm1', update()))).code).toBe('duplicate')
    svc.discard(id)
    expect((await refusal(svc.suggest('s1', env.groupId, 'm1', update()))).code).toBe(
      'already_discarded'
    )
  })

  it('edits the body only: front matter stays out of the target and survives a later save', async () => {
    await writeFile(
      join(env.root, 'Notes', 'Titled.md'),
      '---\ntitle: "Pricing"\n---\nPricing is called twice.\n'
    )
    const titled = (await env.service.reconcileAndList(env.notesId)).find(
      (i) => i.fileName === 'Titled.md'
    )
    const hit = await refusal(
      svc.suggest(
        's1',
        env.groupId,
        'm1',
        update({ file: 'Titled', edits: [edit('title: "Pricing"', 'title: "x"')] })
      )
    )
    expect(hit.code).toBe('edit_not_found')
    const { id } = await svc.suggest(
      's1',
      env.groupId,
      'm1',
      update({ file: 'Titled', edits: [edit('twice', 'once')] })
    )
    const stored = row(id)
    expect(stored['proposed_content']).toBe('Pricing is called once.\n')
    await env.service.save(
      titled?.id ?? '',
      String(stored['proposed_content']),
      String(stored['base_revision'])
    )
    expect(await readFile(join(env.root, 'Notes', 'Titled.md'), 'utf8')).toBe(
      '---\ntitle: "Pricing"\n---\nPricing is called once.\n'
    )
  })

  it('stores no hunks but still the result for a file over 2,000 lines', async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n') + '\n'
    await env.service.createWithContent(env.notesId, 'Big.md', big)
    const { id } = await svc.suggest(
      's1',
      env.groupId,
      'm1',
      update({ file: 'Big', edits: [edit('line 1200\n', 'line twelve hundred\n')] })
    )
    const stored = row(id)
    expect(stored['hunks_json']).toBeNull()
    expect(stored['proposed_content']).toBe(big.replace('line 1200\n', 'line twelve hundred\n'))
    expect(stored['base_revision']).toEqual(expect.any(String))
  })

  it('logs knowledge-suggested with "{section} › {note}" and pushes the list', async () => {
    const { id } = await svc.suggest('s1', env.groupId, 'm1', update())
    expect(logged).toEqual([
      {
        sessionId: 's1',
        kind: 'knowledge-suggested',
        text: 'Orders table is partitioned by month · Notes › Schema',
        data: {
          id,
          action: 'update',
          section: { id: env.notesId, name: 'Notes' },
          target: { name: null, relPath: 'Notes/Schema.md' }
        }
      }
    ])
    expect(pushed.map((p) => p.waiting.map((v) => v.id))).toEqual([[id]])
  })
})

describe('accept an update', () => {
  const body = 'Orders\nare stored daily.\nShipments\nare stored weekly.\n'
  const file = `---\ntitle: "Schema"\n---\n${body}`
  let itemId: string
  let notePath: string

  const edit = (old_text: string, new_text: string): { old_text: string; new_text: string } => ({
    old_text,
    new_text
  })
  const update = (over: Partial<SuggestUpdateInput> = {}): SuggestUpdateInput => ({
    kind: 'update',
    title: 'Orders table is partitioned by month',
    reason: 'Read in the schema dump',
    section: 'Notes',
    file: 'Schema',
    edits: [edit('are stored daily.', 'are partitioned by month.')],
    ...over
  })
  const suggestUpdate = (over: Partial<SuggestUpdateInput> = {}): Promise<{ id: string }> =>
    svc.suggest('s1', env.groupId, 'm1', update(over))
  const status = (id: string): unknown =>
    env.opened.sqlite.prepare('SELECT status FROM knowledge_suggestions WHERE id=?').get(id)

  beforeEach(async () => {
    notePath = join(env.root, 'Notes', 'Schema.md')
    await writeFile(notePath, file)
    const item = (await env.service.reconcileAndList(env.notesId)).find(
      (i) => i.fileName === 'Schema.md'
    )
    itemId = item?.id ?? ''
  })

  it('applies the edits and leaves the rest, front matter included, byte-identical', async () => {
    const { id } = await suggestUpdate()
    logged.length = 0
    pushed.length = 0
    changed.length = 0
    const outcome = await svc.accept(id)
    const after = await readFile(notePath, 'utf8')
    expect(after).toBe(file.replace('are stored daily.', 'are partitioned by month.'))
    expect(after).not.toContain('are stored daily.')
    expect(status(id)).toEqual({ status: 'accepted' })
    expect(outcome).toEqual({
      groupId: env.groupId,
      sectionId: env.notesId,
      sectionName: 'Notes',
      itemId,
      name: 'Schema.md',
      edited: false
    })
    const current = await env.service.read(itemId)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({
      sessionId: 's1',
      kind: 'knowledge-accepted',
      text: 'Orders table is partitioned by month · Notes › Schema · Accepted'
    })
    expect(changed).toEqual([
      {
        groupId: env.groupId,
        sectionIds: [env.notesId],
        items: [
          {
            id: itemId,
            sectionId: env.notesId,
            revision: current.type === 'text' ? current.revision : 'none'
          }
        ],
        reason: 'suggestion'
      }
    ])
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.waiting).toEqual([])
  })

  it('EXTERNAL_MODIFIED when the file changed since; nothing is written and it stays waiting', async () => {
    const { id } = await suggestUpdate()
    const edited = file + 'My own line.\n'
    await writeFile(notePath, edited)
    expect((await failure(svc.accept(id))).code).toBe('EXTERNAL_MODIFIED')
    expect(await readFile(notePath, 'utf8')).toBe(edited)
    expect(svc.listWaiting('s1').map((v) => v.id)).toEqual([id])
    expect(status(id)).toEqual({ status: 'waiting' })
    expect(changed).toEqual([])
  })

  it('ITEM_NOT_FOUND on the first call after the file was deleted; it stays waiting', async () => {
    const { id } = await suggestUpdate()
    await rm(notePath)
    expect((await failure(svc.accept(id))).code).toBe('ITEM_NOT_FOUND')
    expect(svc.listWaiting('s1').map((v) => v.id)).toEqual([id])
    expect(changed).toEqual([])
  })

  it('the second of two updates to the same note fails with EXTERNAL_MODIFIED', async () => {
    const first = await suggestUpdate()
    const second = await suggestUpdate({
      title: 'Shipments are weekly',
      edits: [edit('are stored weekly.', 'are stored every week.')]
    })
    await svc.accept(first.id)
    expect((await failure(svc.accept(second.id))).code).toBe('EXTERNAL_MODIFIED')
    expect(svc.listWaiting('s1').map((v) => v.id)).toEqual([second.id])
    expect(await readFile(notePath, 'utf8')).toContain('are stored weekly.')
  })

  it('STORAGE_BUSY while a storage move runs, writing nothing', async () => {
    const { id } = await suggestUpdate()
    locked = true
    expect((await failure(svc.accept(id))).code).toBe('STORAGE_BUSY')
    expect(await readFile(notePath, 'utf8')).toBe(file)
    expect(svc.listWaiting('s1')).toHaveLength(1)
  })

  it('IO_FAILED with the location when the file cannot be written; it stays waiting', async () => {
    const { id } = await suggestUpdate()
    await chmod(join(env.root, 'Notes'), 0o555)
    let f: Failure
    try {
      f = await failure(svc.accept(id))
    } finally {
      await chmod(join(env.root, 'Notes'), 0o755)
    }
    expect(f.code).toBe('IO_FAILED')
    expect(f.details?.location).toBe(join(env.root, 'Notes'))
    expect(await readFile(notePath, 'utf8')).toBe(file)
    expect(svc.listWaiting('s1').map((v) => v.id)).toEqual([id])
    expect(changed).toEqual([])
  })

  it('makes no commit in a linked folder under git', async () => {
    const linked = join(dir(), 'linked')
    await mkdir(join(linked, 'Notes'), { recursive: true })
    await writeFile(join(linked, 'Notes', 'Schema.md'), file)
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
        cwd: linked,
        encoding: 'utf8'
      })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const before = git('rev-parse', 'HEAD')
    const linkedSvc = new KnowledgeSuggestionService({
      repo: new KnowledgeSuggestionsRepo(env.opened.db),
      sectionsRepo: env.sectionsRepo,
      getKnowledgeRoot: () => linked,
      knowledge: new KnowledgeService({
        sectionsRepo: env.sectionsRepo,
        itemsRepo: env.itemsRepo,
        index: new KnowledgeIndex({
          sectionsRepo: env.sectionsRepo,
          itemsRepo: env.itemsRepo,
          metaStore: env.metaStore,
          getKnowledgeRoot: () => linked
        }),
        metaStore: env.metaStore,
        getKnowledgeRoot: () => linked
      }),
      itemsRepo: env.itemsRepo,
      emitChanged: () => undefined,
      logSessionEvent: () => undefined,
      publish: () => undefined,
      newId: () => 'lk1'
    })
    const { id } = await linkedSvc.suggest('s1', env.groupId, 'm1', update())
    await linkedSvc.accept(id)
    expect(await readFile(join(linked, 'Notes', 'Schema.md'), 'utf8')).toContain(
      'are partitioned by month.'
    )
    expect(git('rev-parse', 'HEAD')).toBe(before)
    expect(git('status', '--porcelain')).toContain('Schema.md')
  })

  describe('add as a new note', () => {
    it('creates the note from the proposed content in the suggestion section when the file is gone', async () => {
      const { id } = await suggestUpdate()
      await rm(notePath)
      const outcome = await svc.accept(id, { name: 'Schema again' })
      expect(await readFile(join(env.root, 'Notes', 'Schema again.md'), 'utf8')).toBe(
        'Orders\nare partitioned by month.\nShipments\nare stored weekly.\n'
      )
      expect(outcome).toMatchObject({
        groupId: env.groupId,
        sectionId: env.notesId,
        sectionName: 'Notes',
        name: 'Schema again.md',
        edited: false
      })
      expect(env.itemsRepo.getById(outcome.itemId)).toBeDefined()
      expect(status(id)).toEqual({ status: 'accepted' })
      expect(changed.at(-1)).toMatchObject({ reason: 'suggestion', sectionIds: [env.notesId] })
      expect(logged.at(-1)).toMatchObject({ kind: 'knowledge-accepted' })
      expect(logged.at(-1)?.text.endsWith('· Accepted')).toBe(true)
    })

    it('goes to the given section', async () => {
      const runbooks = await env.sections.create(env.groupId, 'Runbooks')
      const { id } = await suggestUpdate()
      await rm(notePath)
      const outcome = await svc.accept(id, { name: 'Schema', sectionId: runbooks.id })
      expect(outcome.sectionId).toBe(runbooks.id)
      expect(outcome.sectionName).toBe('Runbooks')
      expect(await readFile(join(env.root, 'Runbooks', 'Schema.md'), 'utf8')).toContain(
        'are partitioned by month.'
      )
    })

    it('ITEM_NAME_TAKEN for a taken name; it stays waiting', async () => {
      const { id } = await suggestUpdate()
      await rm(notePath)
      await env.service.createWithContent(env.notesId, 'Taken.md', 'x')
      expect((await failure(svc.accept(id, { name: 'taken' }))).code).toBe('ITEM_NAME_TAKEN')
      expect(svc.listWaiting('s1').map((v) => v.id)).toEqual([id])
    })

    it('keeps a traversal name inside the section and refuses one with nothing usable', async () => {
      const { id } = await suggestUpdate()
      await rm(notePath)
      expect((await failure(svc.accept(id, { name: '../..' }))).code).toBe('VALIDATION_FAILED')
      expect(svc.listWaiting('s1')).toHaveLength(1)
      await svc.accept(id, { name: '../../escape' })
      expect(await readdir(join(env.root, 'Notes'))).toEqual(['escape.md'])
      expect((await readdir(env.root)).includes('escape.md')).toBe(false)
    })

    it('ignores the name when the target still exists and applies the update', async () => {
      const { id } = await suggestUpdate()
      await svc.accept(id, { name: 'Other name' })
      expect(await readFile(notePath, 'utf8')).toContain('are partitioned by month.')
      expect(await readdir(join(env.root, 'Notes'))).toEqual(['Schema.md'])
    })

    it('still ITEM_NOT_FOUND for a deleted file when no name is given', async () => {
      const { id } = await suggestUpdate()
      await rm(notePath)
      expect((await failure(svc.accept(id))).code).toBe('ITEM_NOT_FOUND')
    })
  })
})

describe('current', () => {
  const edits = [{ old_text: 'are stored daily.', new_text: 'are partitioned by month.' }]
  let notePath: string

  beforeEach(async () => {
    notePath = join(env.root, 'Notes', 'Schema.md')
    await env.service.createWithContent(env.notesId, 'Schema.md', 'Orders\nare stored daily.\n')
  })

  const suggestUpdate = (): Promise<{ id: string }> =>
    svc.suggest('s1', env.groupId, 'm1', {
      kind: 'update',
      title: 't',
      reason: 'r',
      section: 'Notes',
      file: 'Schema',
      edits
    })

  it('returns the present text, including an outside edit', async () => {
    const { id } = await suggestUpdate()
    expect(await svc.current(id)).toEqual({ text: 'Orders\nare stored daily.\n' })
    await writeFile(notePath, 'Edited outside.\n')
    expect(await svc.current(id)).toEqual({ text: 'Edited outside.\n' })
  })

  it('ITEM_NOT_FOUND when the file is gone', async () => {
    const { id } = await suggestUpdate()
    await rm(notePath)
    expect((await failure(svc.current(id))).code).toBe('ITEM_NOT_FOUND')
  })

  it('SUGGESTION_NOT_FOUND for an unknown or resolved id', async () => {
    expect((await failure(svc.current('nope'))).code).toBe('SUGGESTION_NOT_FOUND')
    const { id } = await suggestUpdate()
    svc.discard(id)
    expect((await failure(svc.current(id))).code).toBe('SUGGESTION_NOT_FOUND')
  })

  it('VALIDATION_FAILED for a new-note suggestion', async () => {
    const { id } = await suggest()
    expect((await failure(svc.current(id))).code).toBe('VALIDATION_FAILED')
  })
})

describe('accept after editing', () => {
  const row = (id: string): unknown =>
    env.opened.sqlite
      .prepare(
        'SELECT status, edited_content AS editedContent FROM knowledge_suggestions WHERE id=?'
      )
      .get(id)
  const notes = (): Promise<string[]> => readdir(join(env.root, 'Notes'))
  const unchanged = async (id: string): Promise<void> => {
    expect(await notes()).toEqual([])
    expect(svc.listWaiting('s1').map((v) => v.id)).toEqual([id])
    expect(row(id)).toEqual({ status: 'waiting', editedContent: null })
  }

  it('writes the edited text, not the brain text, and records accepted_edited', async () => {
    const { id } = await suggest()
    logged.length = 0
    const outcome = await svc.accept(id, { text: 'My own words.' })
    expect(await readFile(join(env.root, 'Notes', 'Service map.md'), 'utf8')).toBe('My own words.')
    expect(outcome).toMatchObject({ name: 'Service map.md', sectionName: 'Notes', edited: true })
    expect(row(id)).toEqual({ status: 'accepted_edited', editedContent: 'My own words.' })
    expect(logged[0]?.kind).toBe('knowledge-accepted')
    expect(logged[0]?.text).toBe(
      'Orders table is partitioned by month · Notes › New note: Service map · Accepted after editing'
    )
  })

  it('creates the edited name and not the suggested one', async () => {
    const { id } = await suggest()
    const outcome = await svc.accept(id, { name: 'Pricing calls' })
    expect(await notes()).toEqual(['Pricing calls.md'])
    expect(outcome).toMatchObject({ name: 'Pricing calls.md', edited: true })
    expect(row(id)).toEqual({
      status: 'accepted_edited',
      editedContent: 'Checkout calls pricing twice.'
    })
  })

  it('puts it in the edited section', async () => {
    const runbooks = await env.sections.create(env.groupId, 'Runbooks')
    const { id } = await suggest()
    const outcome = await svc.accept(id, { sectionId: runbooks.id })
    expect(await readdir(join(env.root, 'Runbooks'))).toEqual(['Service map.md'])
    expect(await notes()).toEqual([])
    expect(outcome).toMatchObject({ sectionId: runbooks.id, sectionName: 'Runbooks', edited: true })
  })

  it('applies text, name and section together and names the edited destination in the event', async () => {
    const runbooks = await env.sections.create(env.groupId, 'Runbooks')
    const { id } = await suggest()
    logged.length = 0
    const outcome = await svc.accept(id, {
      text: 'Fresh text',
      name: 'Pricing.txt',
      sectionId: runbooks.id
    })
    expect(await readFile(join(env.root, 'Runbooks', 'Pricing.txt'), 'utf8')).toBe('Fresh text')
    expect(outcome).toMatchObject({ name: 'Pricing.txt', sectionName: 'Runbooks', edited: true })
    expect(row(id)).toEqual({ status: 'accepted_edited', editedContent: 'Fresh text' })
    expect(logged[0]?.text).toBe(
      'Orders table is partitioned by month · Runbooks › New note: Pricing.txt · Accepted after editing'
    )
    expect(changed.at(-1)).toMatchObject({ sectionIds: [runbooks.id], reason: 'suggestion' })
  })

  it('edits equal to the suggestion are a plain accept', async () => {
    const { id } = await suggest()
    logged.length = 0
    const outcome = await svc.accept(id, {
      text: 'Checkout calls pricing twice.',
      name: 'Service map',
      sectionId: env.notesId
    })
    expect(outcome.edited).toBe(false)
    expect(row(id)).toEqual({ status: 'accepted', editedContent: null })
    expect(logged[0]?.text.endsWith('· Accepted')).toBe(true)
  })

  it('refuses empty or blank text, writing nothing', async () => {
    const { id } = await suggest()
    for (const text of ['', '   \n\t']) {
      const f = await failure(svc.accept(id, { text }))
      expect(f.code).toBe('VALIDATION_FAILED')
    }
    await unchanged(id)
  })

  it('refuses a name that sanitises to nothing', async () => {
    const { id } = await suggest()
    expect((await failure(svc.accept(id, { name: '../..' }))).code).toBe('VALIDATION_FAILED')
    expect((await failure(svc.accept(id, { name: '   ' }))).code).toBe('VALIDATION_FAILED')
    await unchanged(id)
  })

  it('refuses a non-text extension', async () => {
    const { id } = await suggest()
    expect((await failure(svc.accept(id, { name: 'tool.exe' }))).code).toBe('VALIDATION_FAILED')
    await unchanged(id)
  })

  it('refuses a section of another group', async () => {
    const other = (await env.sections.create(env.groupId, 'Elsewhere')).id
    env.opened.sqlite
      .prepare(
        "INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES ('g2','Other','other',1,1)"
      )
      .run()
    env.opened.sqlite.prepare('UPDATE sections SET group_id=? WHERE id=?').run('g2', other)
    const { id } = await suggest()
    expect((await failure(svc.accept(id, { sectionId: other }))).code).toBe('SECTION_NOT_FOUND')
    await unchanged(id)
  })

  it('refuses Projects and Links', async () => {
    const { id } = await suggest()
    for (const kind of ['projects', 'links']) {
      const section = env.sectionsRepo.listByGroup(env.groupId).find((s) => s.kind === kind)
      expect(section).toBeDefined()
      expect((await failure(svc.accept(id, { sectionId: section?.id }))).code).toBe(
        'VALIDATION_FAILED'
      )
    }
    await unchanged(id)
  })

  it('ITEM_NAME_TAKEN for a taken edited name', async () => {
    await env.service.create(env.notesId, 'Taken')
    const { id } = await suggest()
    expect((await failure(svc.accept(id, { name: 'taken' }))).code).toBe('ITEM_NAME_TAKEN')
    expect(await notes()).toEqual(['Taken.md'])
    expect(row(id)).toEqual({ status: 'waiting', editedContent: null })
  })

  describe('an update', () => {
    const file = '---\ntitle: "Schema"\n---\nOrders\nare stored daily.\n'
    let notePath: string
    const update = (): Promise<{ id: string }> =>
      svc.suggest('s1', env.groupId, 'm1', {
        kind: 'update',
        title: 'Orders partitioned',
        reason: 'Read in the dump',
        section: 'Notes',
        file: 'Schema',
        edits: [{ old_text: 'are stored daily.', new_text: 'are partitioned by month.' }]
      })

    beforeEach(async () => {
      notePath = join(env.root, 'Notes', 'Schema.md')
      await writeFile(notePath, file)
      await env.service.reconcileAndList(env.notesId)
    })

    it('saves the edited body, keeps the front matter and records the edit', async () => {
      const { id } = await update()
      logged.length = 0
      const outcome = await svc.accept(id, { text: 'Orders\nmy version\n' })
      expect(await readFile(notePath, 'utf8')).toBe(
        '---\ntitle: "Schema"\n---\nOrders\nmy version\n'
      )
      expect(outcome).toMatchObject({ name: 'Schema.md', edited: true })
      expect(row(id)).toEqual({ status: 'accepted_edited', editedContent: 'Orders\nmy version\n' })
      expect(logged[0]?.text).toBe('Orders partitioned · Notes › Schema · Accepted after editing')
    })

    it('still refuses with EXTERNAL_MODIFIED after an outside change, keeping that change', async () => {
      const { id } = await update()
      await writeFile(notePath, `${file}Outside line.\n`)
      expect((await failure(svc.accept(id, { text: 'Orders\nmy version\n' }))).code).toBe(
        'EXTERNAL_MODIFIED'
      )
      expect(await readFile(notePath, 'utf8')).toBe(`${file}Outside line.\n`)
      expect(row(id)).toEqual({ status: 'waiting', editedContent: null })
    })

    it('ignores name and sectionId while the target exists', async () => {
      const runbooks = await env.sections.create(env.groupId, 'Runbooks')
      const { id } = await update()
      const outcome = await svc.accept(id, {
        text: 'Orders\nmine\n',
        name: 'Else',
        sectionId: runbooks.id
      })
      expect(outcome).toMatchObject({ name: 'Schema.md', sectionId: env.notesId, edited: true })
      expect(await notes()).toEqual(['Schema.md'])
      expect(await readdir(join(env.root, 'Runbooks'))).toEqual([])
    })

    it('unchanged text on an update is a plain accept', async () => {
      const { id } = await update()
      const outcome = await svc.accept(id, { text: 'Orders\nare partitioned by month.\n' })
      expect(outcome.edited).toBe(false)
      expect(row(id)).toEqual({ status: 'accepted', editedContent: null })
    })

    it('add as a new note honours the edited text', async () => {
      const { id } = await update()
      await rm(notePath)
      const outcome = await svc.accept(id, { name: 'Schema copy', text: 'Rewritten' })
      expect(await readFile(join(env.root, 'Notes', 'Schema copy.md'), 'utf8')).toBe('Rewritten')
      expect(outcome).toMatchObject({ name: 'Schema copy.md', edited: true })
      expect(row(id)).toEqual({ status: 'accepted_edited', editedContent: 'Rewritten' })
    })

    it('resultText returns the full resulting body', async () => {
      const { id } = await update()
      expect(await svc.resultText(id)).toEqual({
        text: 'Orders\nare partitioned by month.\n'
      })
    })
  })

  describe('resultText', () => {
    it('returns the suggested text of a new note', async () => {
      const { id } = await suggest()
      expect(await svc.resultText(id)).toEqual({ text: 'Checkout calls pricing twice.' })
    })

    it('SUGGESTION_NOT_FOUND for an unknown or resolved id', async () => {
      expect((await failure(svc.resultText('nope'))).code).toBe('SUGGESTION_NOT_FOUND')
      const { id } = await suggest()
      svc.discard(id)
      expect((await failure(svc.resultText(id))).code).toBe('SUGGESTION_NOT_FOUND')
    })
  })
})

describe('accept all and discard all', () => {
  const body = 'Orders\nare stored daily.\nShipments\nare stored weekly.\n'
  const file = `---\ntitle: "Schema"\n---\n${body}`
  let notePath: string

  const edit = (old_text: string, new_text: string): { old_text: string; new_text: string } => ({
    old_text,
    new_text
  })
  const suggestUpdate = (over: Partial<SuggestUpdateInput> = {}): Promise<{ id: string }> =>
    svc.suggest('s1', env.groupId, 'm1', {
      kind: 'update',
      title: 'Orders table is partitioned by month',
      reason: 'Read in the schema dump',
      section: 'Notes',
      file: 'Schema',
      edits: [edit('are stored daily.', 'are partitioned by month.')],
      ...over
    })
  const statuses = (): unknown[] =>
    env.opened.sqlite
      .prepare('SELECT id, status FROM knowledge_suggestions ORDER BY created_at')
      .all()
  const addSecondSession = (): void => {
    env.opened.sqlite
      .prepare(
        `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
         VALUES ('s2',?,'Other','autonomous',2,'opus','sonnet','active',1,50)`
      )
      .run(env.groupId)
  }

  beforeEach(async () => {
    notePath = join(env.root, 'Notes', 'Schema.md')
    await writeFile(notePath, file)
    await env.service.reconcileAndList(env.notesId)
  })

  describe('acceptAll', () => {
    it('applies every waiting suggestion oldest first, with one push at the end', async () => {
      await suggest(newNote({ name: 'Alpha', content: 'a' }))
      await suggest(newNote({ name: 'Beta', content: 'b' }))
      await suggestUpdate()
      logged.length = 0
      pushed.length = 0
      changed.length = 0

      const { results } = await svc.acceptAll('s1')

      expect(results.map((r) => r.id)).toEqual(['k1', 'k2', 'k3'])
      expect(results.map((r) => ('outcome' in r ? r.outcome.name : 'error'))).toEqual([
        'Alpha.md',
        'Beta.md',
        'Schema.md'
      ])
      expect(statuses()).toEqual([
        { id: 'k1', status: 'accepted' },
        { id: 'k2', status: 'accepted' },
        { id: 'k3', status: 'accepted' }
      ])
      expect(logged.map((e) => e.kind)).toEqual([
        'knowledge-accepted',
        'knowledge-accepted',
        'knowledge-accepted'
      ])
      expect(changed).toHaveLength(3)
      expect(await readFile(join(env.root, 'Notes', 'Alpha.md'), 'utf8')).toBe('a')
      expect(await readFile(notePath, 'utf8')).toContain('are partitioned by month.')
      expect(pushed).toHaveLength(1)
      expect(pushed[0]?.sessionId).toBe('s1')
      expect(pushed[0]?.waiting).toEqual([])
    })

    it('continues past a failure, reports it, and leaves it waiting', async () => {
      await suggest(newNote({ name: 'Alpha', content: 'a' }))
      const second = await suggest(newNote({ name: 'Beta', content: 'b' }))
      await suggest(newNote({ name: 'Gamma', content: 'g' }))
      await env.service.create(env.notesId, 'Beta')
      pushed.length = 0

      const { results } = await svc.acceptAll('s1')

      expect(results).toHaveLength(3)
      expect(results[0]).toMatchObject({ id: 'k1', outcome: { name: 'Alpha.md' } })
      expect(results[1]).toEqual({ id: second.id, error: { code: 'ITEM_NAME_TAKEN' } })
      expect(results[2]).toMatchObject({ id: 'k3', outcome: { name: 'Gamma.md' } })
      expect(statuses()).toEqual([
        { id: 'k1', status: 'accepted' },
        { id: 'k2', status: 'waiting' },
        { id: 'k3', status: 'accepted' }
      ])
      expect(pushed).toHaveLength(1)
      expect(pushed[0]?.waiting.map((v) => v.id)).toEqual(['k2'])
    })

    it('carries the error details, as a single accept would', async () => {
      await suggest(newNote({ name: 'Alpha', content: 'a' }))
      locked = true
      const { results } = await svc.acceptAll('s1')
      expect(results).toEqual([{ id: 'k1', error: { code: 'STORAGE_BUSY' } }])
      expect(pushed.filter((p) => p.waiting.length === 0)).toEqual([])
    })

    it('two updates to the same note: the older applies, the newer is EXTERNAL_MODIFIED and waits', async () => {
      const first = await suggestUpdate()
      const second = await suggestUpdate({
        title: 'Shipments are weekly',
        edits: [edit('are stored weekly.', 'are stored every week.')]
      })
      pushed.length = 0

      const { results } = await svc.acceptAll('s1')

      expect(results.map((r) => r.id)).toEqual([first.id, second.id])
      expect(results[0]).toMatchObject({ outcome: { name: 'Schema.md' } })
      expect(results[1]).toEqual({ id: second.id, error: { code: 'EXTERNAL_MODIFIED' } })
      const after = await readFile(notePath, 'utf8')
      expect(after).toBe(file.replace('are stored daily.', 'are partitioned by month.'))
      expect(statuses()).toEqual([
        { id: first.id, status: 'accepted' },
        { id: second.id, status: 'waiting' }
      ])
      expect(pushed).toHaveLength(1)
      expect(pushed[0]?.waiting.map((v) => v.id)).toEqual([second.id])
    })

    it('with nothing waiting returns no results, does not throw, and leaves other sessions alone', async () => {
      addSecondSession()
      await svc.suggest('s2', env.groupId, 'm9', newNote({ name: 'Elsewhere', content: 'x' }))
      logged.length = 0
      pushed.length = 0

      expect(await svc.acceptAll('s1')).toEqual({ results: [] })
      expect(statuses()).toEqual([{ id: 'k1', status: 'waiting' }])
      expect(logged).toEqual([])
      expect(await readdir(join(env.root, 'Notes'))).not.toContain('Elsewhere.md')
    })

    it('only applies the given session', async () => {
      addSecondSession()
      await suggest(newNote({ name: 'Alpha', content: 'a' }))
      await svc.suggest('s2', env.groupId, 'm9', newNote({ name: 'Elsewhere', content: 'x' }))
      await svc.acceptAll('s1')
      expect(statuses()).toEqual([
        { id: 'k1', status: 'accepted' },
        { id: 'k2', status: 'waiting' }
      ])
    })
  })

  describe('discardAll', () => {
    it('discards every waiting suggestion with one event each and one push', async () => {
      await suggest(newNote({ name: 'Alpha', content: 'a' }))
      await suggest(newNote({ name: 'Beta', content: 'b' }))
      await suggestUpdate()
      const before = await readdir(env.root, { recursive: true })
      logged.length = 0
      pushed.length = 0

      const discarded = svc.discardAll('s1')

      expect(statuses()).toEqual([
        { id: 'k1', status: 'discarded' },
        { id: 'k2', status: 'discarded' },
        { id: 'k3', status: 'discarded' }
      ])
      expect(logged.map((e) => e.kind)).toEqual([
        'knowledge-discarded',
        'knowledge-discarded',
        'knowledge-discarded'
      ])
      expect(logged[0]?.text).toBe(
        'Orders table is partitioned by month · Notes › New note: Alpha · Discarded'
      )
      expect(pushed).toHaveLength(1)
      expect(pushed[0]?.waiting).toEqual([])
      expect(await readdir(env.root, { recursive: true })).toEqual(before)
      expect(await readFile(notePath, 'utf8')).toBe(file)
      expect(discarded).toEqual([
        { id: 'k1', title: 'Orders table is partitioned by month' },
        { id: 'k2', title: 'Orders table is partitioned by month' },
        { id: 'k3', title: 'Orders table is partitioned by month' }
      ])
    })

    it('leaves another session untouched and reports nothing when none wait', async () => {
      addSecondSession()
      await svc.suggest('s2', env.groupId, 'm9', newNote({ name: 'Elsewhere', content: 'x' }))
      logged.length = 0
      pushed.length = 0
      expect(svc.discardAll('s1')).toEqual([])
      expect(statuses()).toEqual([{ id: 'k1', status: 'waiting' }])
      expect(logged).toEqual([])
      expect(pushed).toEqual([])
    })

    it('does not touch suggestions that were already resolved', async () => {
      const a = await suggest(newNote({ name: 'Alpha', content: 'a' }))
      await suggest(newNote({ name: 'Beta', content: 'b' }))
      await svc.accept(a.id)
      expect(svc.discardAll('s1').map((d) => d.id)).toEqual(['k2'])
      expect(statuses()).toEqual([
        { id: 'k1', status: 'accepted' },
        { id: 'k2', status: 'discarded' }
      ])
    })
  })

  describe('the push count of the single calls is unchanged', () => {
    it('accept pushes once', async () => {
      const a = await suggest(newNote({ name: 'Alpha', content: 'a' }))
      pushed.length = 0
      await svc.accept(a.id)
      expect(pushed).toHaveLength(1)
    })

    it('discard pushes once', async () => {
      const a = await suggest(newNote({ name: 'Alpha', content: 'a' }))
      pushed.length = 0
      svc.discard(a.id)
      expect(pushed).toHaveLength(1)
    })

    it('a failed accept pushes nothing', async () => {
      const a = await suggest(newNote({ name: 'Alpha', content: 'a' }))
      locked = true
      pushed.length = 0
      await failure(svc.accept(a.id))
      expect(pushed).toEqual([])
    })
  })
})

describe('the cap per request', () => {
  const nth = (n: number): SuggestNewInput => newNote({ name: `Note ${n}`, content: `Fact ${n}.` })

  it('returns how many are left and refuses the sixth with cap_reached', async () => {
    const left: number[] = []
    for (let n = 1; n <= MAX_SUGGESTIONS_PER_REQUEST; n++) {
      left.push((await suggest(nth(n), 'm1')).remainingThisRequest)
    }
    expect(MAX_SUGGESTIONS_PER_REQUEST).toBe(5)
    expect(left).toEqual([4, 3, 2, 1, 0])
    expect((await refusal(suggest(nth(6), 'm1'))).code).toBe('cap_reached')
    expect(svc.listWaiting('s1')).toHaveLength(5)
  })

  it('counts per request: another request id has its own five', async () => {
    for (let n = 1; n <= 5; n++) await suggest(nth(n), 'm1')
    expect((await suggest(nth(6), 'm2')).remainingThisRequest).toBe(4)
  })

  it('checks the cap before the suggestion itself, and a refusal does not use a slot', async () => {
    for (let n = 1; n <= 4; n++) await suggest(nth(n), 'm1')
    expect((await refusal(suggest(newNote({ section: 'Wiki' }), 'm1'))).code).toBe(
      'unknown_section'
    )
    expect((await suggest(nth(5), 'm1')).remainingThisRequest).toBe(0)
    expect((await refusal(suggest(newNote({ section: 'Wiki' }), 'm1'))).code).toBe('cap_reached')
  })

  it('counts a discarded and an accepted suggestion', async () => {
    const first = await suggest(nth(1), 'm1')
    const second = await suggest(nth(2), 'm1')
    for (let n = 3; n <= 5; n++) await suggest(nth(n), 'm1')
    svc.discard(first.id)
    await svc.accept(second.id)
    expect((await refusal(suggest(nth(6), 'm1'))).code).toBe('cap_reached')
  })

  it('does not count a duplicate', async () => {
    await suggest(nth(1), 'm1')
    expect((await refusal(suggest(nth(1), 'm1'))).code).toBe('duplicate')
    expect((await suggest(nth(2), 'm1')).remainingThisRequest).toBe(3)
  })

  it('applies to updates too', async () => {
    for (let n = 1; n <= 5; n++) await suggest(nth(n), 'm1')
    const update: SuggestUpdateInput = {
      kind: 'update',
      title: 't',
      reason: 'r',
      section: 'Notes',
      file: 'Note 1',
      edits: [{ old_text: 'Fact 1.', new_text: 'Fact one.' }]
    }
    expect((await refusal(svc.suggest('s1', env.groupId, 'm1', update))).code).toBe('cap_reached')
  })
})

describe('the discard callback', () => {
  let told: { sessionId: string; titles: string[] }[]
  beforeEach(() => {
    told = []
    svc = new KnowledgeSuggestionService({
      repo: new KnowledgeSuggestionsRepo(env.opened.db),
      sectionsRepo: env.sectionsRepo,
      getKnowledgeRoot: () => env.root,
      knowledge: env.service,
      itemsRepo: env.itemsRepo,
      emitChanged: () => undefined,
      logSessionEvent: () => undefined,
      publish: () => undefined,
      onDiscarded: (sessionId, titles) => void told.push({ sessionId, titles }),
      newId: () => `d${(ids += 1)}`
    })
  })

  it('reports the title of a discarded suggestion', async () => {
    const made = await suggest()
    svc.discard(made.id)
    expect(told).toEqual([{ sessionId: 's1', titles: ['Orders table is partitioned by month'] }])
  })

  it('reports the titles of a discard all in one call, and nothing when none waited', async () => {
    await suggest(newNote({ title: 'One', name: 'One', content: 'a' }))
    await suggest(newNote({ title: 'Two', name: 'Two', content: 'b' }))
    svc.discardAll('s1')
    svc.discardAll('s1')
    expect(told).toEqual([{ sessionId: 's1', titles: ['One', 'Two'] }])
  })

  it('stays quiet for an accept and for a suggestion that is not waiting', async () => {
    const made = await suggest()
    await svc.accept(made.id)
    svc.discard(made.id)
    svc.discard('nope')
    expect(told).toEqual([])
  })
})
