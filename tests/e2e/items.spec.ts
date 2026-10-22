import type { HarnessApi } from '../../src/shared/ipc/harness-api'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    harness: HarnessApi
  }
}

test('items:* channels create, save and re-read a note', async ({ window: page }) => {
  const group = await page.evaluate(() => window.harness.invoke('groups:create', { name: 'Shop' }))
  if (!group.ok) throw new Error('group create failed')
  const sections = await page.evaluate(
    (id) => window.harness.invoke('sections:list', { groupId: id }),
    group.data.id
  )
  const notes = sections.ok ? sections.data.find((s) => s.kind === 'notes') : undefined
  if (!notes) throw new Error('no notes section')

  const created = await page.evaluate(
    (id) => window.harness.invoke('items:create', { sectionId: id, title: 'Service map' }),
    notes.id
  )
  expect(created).toMatchObject({ ok: true, data: { title: 'Service map', kind: 'note' } })
  if (!created.ok) return

  const saved = await page.evaluate(
    (a) =>
      window.harness.invoke('items:save', {
        itemId: a.id,
        content: '# Map\n',
        baseRevision: a.rev
      }),
    { id: created.data.id, rev: created.data.revision }
  )
  expect(saved.ok).toBe(true)

  const read = await page.evaluate(
    (id) => window.harness.invoke('items:read', { itemId: id }),
    created.data.id
  )
  expect(read).toMatchObject({ ok: true, data: { type: 'text', content: '# Map\n' } })

  const stale = await page.evaluate(
    (a) => window.harness.invoke('items:save', { itemId: a.id, content: 'x', baseRevision: a.rev }),
    { id: created.data.id, rev: created.data.revision }
  )
  expect(stale).toMatchObject({ ok: false, error: { code: 'EXTERNAL_MODIFIED' } })

  const listed = await page.evaluate(
    (id) => window.harness.invoke('items:list', { sectionId: id }),
    notes.id
  )
  expect(listed.ok && listed.data.map((i) => i.title)).toEqual(['Service map'])
})
