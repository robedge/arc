import { expect, test } from './fixtures'

test('creating a group lists it in the sidebar and opens it', async ({ window: page }) => {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill('Storefront')
  await page.getByRole('button', { name: 'Create' }).click()

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(
    page.getByRole('navigation', { name: 'Groups' }).getByText('Storefront')
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Storefront' })).toBeVisible()
})
