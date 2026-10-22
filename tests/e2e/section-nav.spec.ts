import { expect, test } from './fixtures'

test('add, rename and delete a custom section from the tab bar', async ({ window: page }) => {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill('Shop')
  await page.getByRole('button', { name: 'Create' }).click()

  const tabs = page.getByRole('tablist', { name: 'Sections' }).getByRole('tab')
  await expect(tabs).toHaveText(['Sessions', 'Projects', 'Notes', 'Docs', 'Playbooks', 'Links'])
  await expect(page.getByRole('button', { name: 'Section options' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Add Section' }).click()
  await page.getByLabel('Section name').fill('Runbooks')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(tabs).toHaveText([
    'Sessions',
    'Projects',
    'Notes',
    'Docs',
    'Playbooks',
    'Links',
    'Runbooks'
  ])

  await page.getByRole('button', { name: 'Section options' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.getByLabel('Section name').fill('Runbook Notes')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(tabs.last()).toHaveText('Runbook Notes')

  await page.getByRole('button', { name: 'Section options' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(tabs).toHaveText(['Sessions', 'Projects', 'Notes', 'Docs', 'Playbooks', 'Links'])
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
})
