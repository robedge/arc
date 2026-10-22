import type { HarnessApi } from '../../src/shared/ipc/harness-api'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    harness: HarnessApi
  }
}

test('groups:create then groups:list round-trips through the bridge', async ({ window: page }) => {
  const created = await page.evaluate(() =>
    window.harness.invoke('groups:create', { name: 'Storefront' })
  )
  expect(created.ok).toBe(true)

  const listed = await page.evaluate(() => window.harness.invoke('groups:list', {}))
  expect(listed.ok && listed.data.map((g) => g.name)).toEqual(['Storefront'])
})

test('a duplicate name returns GROUP_NAME_DUPLICATE', async ({ window: page }) => {
  await page.evaluate(() => window.harness.invoke('groups:create', { name: 'Storefront' }))
  const dup = await page.evaluate(() =>
    window.harness.invoke('groups:create', { name: 'storefront' })
  )
  expect(dup).toMatchObject({ ok: false, error: { code: 'GROUP_NAME_DUPLICATE' } })
})

test('groups:rename and groups:delete update the list', async ({ window: page }) => {
  const created = await page.evaluate(() =>
    window.harness.invoke('groups:create', { name: 'Storefront' })
  )
  if (!created.ok) throw new Error('create failed')
  const groupId = created.data.id

  const renamed = await page.evaluate(
    (id) => window.harness.invoke('groups:rename', { groupId: id, name: 'Shop' }),
    groupId
  )
  expect(renamed.ok && renamed.data.name).toBe('Shop')
  const afterRename = await page.evaluate(() => window.harness.invoke('groups:list', {}))
  expect(afterRename.ok && afterRename.data.map((g) => g.name)).toEqual(['Shop'])

  const deleted = await page.evaluate(
    (id) => window.harness.invoke('groups:delete', { groupId: id }),
    groupId
  )
  expect(deleted.ok).toBe(true)
  const afterDelete = await page.evaluate(() => window.harness.invoke('groups:list', {}))
  expect(afterDelete.ok && afterDelete.data).toEqual([])
})
