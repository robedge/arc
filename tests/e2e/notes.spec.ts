import { _electron as electron } from '@playwright/test'
import { e2eEnv, expect, test } from './fixtures'

test('create a note, autosave, preview, describe, and persist across relaunch', async ({
  app,
  window: page,
  userDataDir
}) => {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill('Shop')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('tab', { name: 'Notes' }).click()

  await page.getByRole('button', { name: 'New Note' }).click()
  await page.getByLabel('Title', { exact: true }).fill('Service map')
  await page.getByRole('button', { name: 'Create' }).click()

  const list = page.getByRole('list', { name: 'Items' })
  await expect(list.getByText('Service map')).toBeVisible()

  await page.locator('.cm-content').click()
  await page.keyboard.type('# Overview')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 2000 })

  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()

  await page.getByLabel('Description').fill('How services talk')
  await page.getByLabel('Description').blur()
  await expect(list.getByText('How services talk')).toBeVisible()

  await app.close()
  const relaunched = await electron.launch({
    args: ['out/main/index.js'],
    env: e2eEnv(userDataDir)
  })
  try {
    const again = await relaunched.firstWindow()
    await again.getByRole('button', { name: 'Shop' }).click()
    await again.getByRole('tab', { name: 'Notes' }).click()
    await again.getByRole('button', { name: /Service map/ }).click()
    await expect(again.locator('.cm-content')).toContainText('# Overview')
  } finally {
    await relaunched.close()
  }
})
