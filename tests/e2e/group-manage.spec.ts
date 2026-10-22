import { expect, test } from './fixtures'

test('rename and delete a group via the row menu', async ({ window: page }) => {
  const nav = page.getByRole('navigation', { name: 'Groups' })
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill('Storefront')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(nav.getByText('Storefront')).toBeVisible()

  await nav.getByRole('button', { name: 'Group options' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.getByLabel('Group name').fill('Shop')
  await page.getByRole('button', { name: 'Rename' }).click()
  await expect(nav.getByText('Shop')).toBeVisible()
  await expect(nav.getByText('Storefront')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible()

  await nav.getByRole('button', { name: 'Group options' }).click()
  await page.getByRole('menuitem', { name: 'Delete Group' }).click()
  await expect(page.getByText('Your project folders will not be touched.')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(nav.getByText('Shop')).toBeVisible()

  await nav.getByRole('button', { name: 'Group options' }).click()
  await page.getByRole('menuitem', { name: 'Delete Group' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(nav.getByText('Shop')).toHaveCount(0)
  await expect(page.getByText('Create a group to get started.')).toBeVisible()
})
