import type { ArcApi } from '../../src/shared/ipc/arc-api'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    arc: ArcApi
  }
}

test('sections:* channels list built-ins and manage a custom section', async ({ window: page }) => {
  const group = await page.evaluate(() => window.arc.invoke('groups:create', { name: 'Shop' }))
  if (!group.ok) throw new Error('group create failed')
  const groupId = group.data.id

  const listed = await page.evaluate(
    (id) => window.arc.invoke('sections:list', { groupId: id }),
    groupId
  )
  expect(listed.ok && listed.data.map((s) => s.name)).toEqual([
    'Projects',
    'Notes',
    'Docs',
    'Playbooks',
    'Links'
  ])

  const created = await page.evaluate(
    (id) => window.arc.invoke('sections:create', { groupId: id, name: 'Runbooks' }),
    groupId
  )
  expect(created).toMatchObject({
    ok: true,
    data: { name: 'Runbooks', builtIn: false, itemCount: 0 }
  })
  if (!created.ok) return

  const dup = await page.evaluate(
    (id) => window.arc.invoke('sections:create', { groupId: id, name: 'runbooks' }),
    groupId
  )
  expect(dup).toMatchObject({ ok: false, error: { code: 'SECTION_NAME_DUPLICATE' } })

  const renamed = await page.evaluate(
    (id) => window.arc.invoke('sections:rename', { sectionId: id, name: 'RUNBOOKS' }),
    created.data.id
  )
  expect(renamed).toMatchObject({ ok: true, data: { name: 'RUNBOOKS' } })

  const removed = await page.evaluate(
    (id) => window.arc.invoke('sections:delete', { sectionId: id }),
    created.data.id
  )
  expect(removed).toEqual({ ok: true, data: { removed: 0 } })

  const after = await page.evaluate(
    (id) => window.arc.invoke('sections:list', { groupId: id }),
    groupId
  )
  expect(after.ok && after.data).toHaveLength(5)
})
