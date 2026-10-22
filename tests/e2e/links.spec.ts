import type { HarnessApi } from '../../src/shared/ipc/harness-api'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    harness: HarnessApi
  }
}

test('links:upsert lists a link and shell:openLink records the call', async ({
  app,
  window: page
}) => {
  const group = await page.evaluate(() => window.harness.invoke('groups:create', { name: 'Shop' }))
  if (!group.ok) throw new Error('group create failed')
  const sections = await page.evaluate(
    (id) => window.harness.invoke('sections:list', { groupId: id }),
    group.data.id
  )
  const links = sections.ok ? sections.data.find((s) => s.kind === 'links') : undefined
  if (!links) throw new Error('no links section')

  const bad = await page.evaluate(
    (id) => window.harness.invoke('links:upsert', { sectionId: id, url: 'wiki.example.com' }),
    links.id
  )
  expect(bad).toMatchObject({ ok: false, error: { code: 'LINK_URL_INVALID' } })

  const created = await page.evaluate(
    (id) =>
      window.harness.invoke('links:upsert', {
        sectionId: id,
        url: 'https://wiki.example.com/orders',
        title: 'Orders wiki',
        description: 'Order flows'
      }),
    links.id
  )
  expect(created).toMatchObject({
    ok: true,
    data: { title: 'Orders wiki', kind: 'link', url: 'https://wiki.example.com/orders' }
  })
  if (!created.ok) return

  const listed = await page.evaluate(
    (id) => window.harness.invoke('items:list', { sectionId: id }),
    links.id
  )
  expect(listed.ok && listed.data.map((i) => i.title)).toEqual(['Orders wiki'])

  const opened = await page.evaluate(
    (id) => window.harness.invoke('shell:openLink', { itemId: id }),
    created.data.id
  )
  expect(opened.ok).toBe(true)
  const calls = await app.evaluate(() =>
    (globalThis as unknown as { __e2e: { getShellCalls(): unknown[] } }).__e2e.getShellCalls()
  )
  expect(calls).toEqual([{ kind: 'openLink', url: 'https://wiki.example.com/orders' }])
})

test('Links section: add, validate, open, edit, and delete through the UI', async ({
  app,
  window: page
}) => {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill('Shop')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('tab', { name: 'Links' }).click()

  const dialog = page.getByRole('dialog')
  const list = page.getByRole('list', { name: 'Links' })

  await page.getByRole('button', { name: 'Add Link' }).click()
  await dialog.getByLabel('Address').fill('wiki.example.com')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(
    'Enter a full web address starting with http:// or https://.'
  )

  await dialog.getByLabel('Address').fill('https://wiki.example.com/orders')
  await dialog.getByLabel('Title (optional)').fill('Orders wiki')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(list.getByText('Orders wiki', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Add Link' }).click()
  await dialog.getByLabel('Address').fill('https://example.com/plain')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(list.getByText('https://example.com/plain')).toHaveCount(2)

  await list.getByRole('button', { name: 'https://wiki.example.com/orders' }).click()
  await expect
    .poll(() =>
      app.evaluate(() =>
        (globalThis as unknown as { __e2e: { getShellCalls(): unknown[] } }).__e2e.getShellCalls()
      )
    )
    .toEqual([{ kind: 'openLink', url: 'https://wiki.example.com/orders' }])

  await list
    .getByRole('listitem')
    .filter({ hasText: 'Orders wiki' })
    .getByRole('button', { name: 'Edit' })
    .click()
  await dialog.getByLabel('Title (optional)').fill('Orders handbook')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(list.getByText('Orders handbook', { exact: true })).toBeVisible()
  await expect(list.getByText('Orders wiki', { exact: true })).toHaveCount(0)

  await list
    .getByRole('listitem')
    .filter({ hasText: 'Orders handbook' })
    .getByRole('button', { name: 'Delete' })
    .click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(list.getByText('Orders handbook')).toHaveCount(0)
})
