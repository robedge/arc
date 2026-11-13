import { describe, expect, it } from 'vitest'
import {
  WORKER_ATTACHMENTS_MAX,
  mergeWorkerAttachments,
  parseWorkerAttachments,
  resolveWorkerAttachments
} from '../../../src/main/attachments/worker-attachments'
import { BridgeToolError } from '../../../src/main/bridge/types'
import type { MessageAttachmentRow } from '../../../src/main/db/schema'

const row = (n: number, over: Partial<MessageAttachmentRow> = {}): MessageAttachmentRow => ({
  id: `att${n}`,
  messageId: 1,
  sessionId: 's1',
  position: n,
  kind: 'text',
  mime: 'text/plain',
  sizeBytes: 10 + n,
  name: `file${n}.txt`,
  storedName: `file${n}.txt`,
  createdAt: n,
  ...over
})

const repoOf = (rows: MessageAttachmentRow[]) => ({
  getMany: (ids: string[], sessionId: string) =>
    ids.flatMap((id) => rows.filter((r) => r.id === id && r.sessionId === sessionId)),
  listForSession: (sessionId: string) => rows.filter((r) => r.sessionId === sessionId)
})

describe('resolveWorkerAttachments', () => {
  it('maps ids to refs with the derived path, in the order of the ids', () => {
    const refs = resolveWorkerAttachments({
      repo: repoOf([row(1), row(2, { kind: 'image', mime: 'image/png', storedName: 'p.png' })]),
      sessionDir: '/data/sessions/s1',
      sessionId: 's1',
      ids: ['att2', 'att1']
    })
    expect(refs).toEqual([
      {
        id: 'att2',
        name: 'file2.txt',
        kind: 'image',
        mime: 'image/png',
        size: 12,
        path: '/data/sessions/s1/attachments/att2/p.png'
      },
      {
        id: 'att1',
        name: 'file1.txt',
        kind: 'text',
        mime: 'text/plain',
        size: 11,
        path: '/data/sessions/s1/attachments/att1/file1.txt'
      }
    ])
  })

  it('refuses an unknown id with unknown_attachment, naming it and listing the valid ids with names', () => {
    const run = (): unknown =>
      resolveWorkerAttachments({
        repo: repoOf([row(1), row(2)]),
        sessionDir: '/d',
        sessionId: 's1',
        ids: ['att1', 'nope']
      })
    expect(run).toThrow(BridgeToolError)
    try {
      run()
    } catch (error: unknown) {
      const e = error as BridgeToolError
      expect(e.code).toBe('unknown_attachment')
      expect(e.message).toContain('"nope"')
      expect(e.message).not.toContain('"att1" is not')
      expect(e.message).toContain('att1 (file1.txt)')
      expect(e.message).toContain('att2 (file2.txt)')
    }
  })

  it('refuses an id of another session as unknown and does not list it', () => {
    const rows = [row(1), row(2, { sessionId: 'other' })]
    try {
      resolveWorkerAttachments({
        repo: repoOf(rows),
        sessionDir: '/d',
        sessionId: 's1',
        ids: ['att2']
      })
      expect.unreachable()
    } catch (error: unknown) {
      const e = error as BridgeToolError
      expect(e.code).toBe('unknown_attachment')
      expect(e.message).toContain('"att2"')
      expect(e.message).toContain('att1 (file1.txt)')
      expect(e.message).not.toContain('att2 (')
    }
  })

  it('lists at most the 30 most recent ids, newest first', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1))
    try {
      resolveWorkerAttachments({
        repo: repoOf(rows),
        sessionDir: '/d',
        sessionId: 's1',
        ids: ['x']
      })
      expect.unreachable()
    } catch (error: unknown) {
      const message = (error as BridgeToolError).message
      expect(message).toContain('att40 (file40.txt)')
      expect(message).toContain('att11 (file11.txt)')
      expect(message).not.toContain('att10 (')
      expect(message.indexOf('att40')).toBeLessThan(message.indexOf('att39'))
    }
  })

  it('says so when the session has no attachments', () => {
    try {
      resolveWorkerAttachments({ repo: repoOf([]), sessionDir: '/d', sessionId: 's1', ids: ['x'] })
      expect.unreachable()
    } catch (error: unknown) {
      expect((error as BridgeToolError).message).toContain('no attachments')
    }
  })

  it('takes no ids as nothing to resolve', () => {
    expect(
      resolveWorkerAttachments({
        repo: repoOf([row(1)]),
        sessionDir: '/d',
        sessionId: 's1',
        ids: []
      })
    ).toEqual([])
  })
})

describe('parseWorkerAttachments', () => {
  it('reads the stored list', () => {
    const json = JSON.stringify([{ id: 'a', name: 'n.png', kind: 'image', size: 5 }])
    expect(parseWorkerAttachments(json)).toEqual([
      { id: 'a', name: 'n.png', kind: 'image', size: 5 }
    ])
  })

  it('gives an empty list for null, bad JSON and anything that is not a list', () => {
    expect(parseWorkerAttachments(null)).toEqual([])
    expect(parseWorkerAttachments('{not json')).toEqual([])
    expect(parseWorkerAttachments('{"id":"a"}')).toEqual([])
    expect(parseWorkerAttachments('"text"')).toEqual([])
  })

  it('drops entries with a missing or wrong field and keeps the good ones', () => {
    const json = JSON.stringify([
      { id: 'a', name: 'ok.txt', kind: 'text', size: 1 },
      { id: 'b', name: 'x', kind: 'video', size: 1 },
      { id: 'c', name: 'x', kind: 'text' },
      null,
      7,
      { id: 'd', name: 'ok.pdf', kind: 'pdf', size: 2, extra: true }
    ])
    expect(parseWorkerAttachments(json)).toEqual([
      { id: 'a', name: 'ok.txt', kind: 'text', size: 1 },
      { id: 'd', name: 'ok.pdf', kind: 'pdf', size: 2 }
    ])
  })
})

describe('mergeWorkerAttachments', () => {
  const a = { id: 'a', name: 'a.txt', kind: 'text' as const, size: 1 }
  const b = { id: 'b', name: 'b.png', kind: 'image' as const, size: 2 }

  it('starts a list from null', () => {
    expect(JSON.parse(mergeWorkerAttachments(null, [a]))).toEqual([a])
  })

  it('unions by id, keeping the earlier entries first', () => {
    const merged = mergeWorkerAttachments(JSON.stringify([a]), [b, a])
    expect(JSON.parse(merged)).toEqual([a, b])
  })

  it('replaces an unreadable stored list', () => {
    expect(JSON.parse(mergeWorkerAttachments('garbage', [b]))).toEqual([b])
  })

  it('exports the limit the tools use', () => {
    expect(WORKER_ATTACHMENTS_MAX).toBe(10)
  })
})
