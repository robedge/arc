import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'
import { e2eEnv, expect, test } from './fixtures'

async function findFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await findFiles(p, out)
    else out.push(p)
  }
  return out
}

test('text typed right before closing the window is flushed to disk', async ({
  app,
  window: page,
  userDataDir
}) => {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill('Shop')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('tab', { name: 'Notes' }).click()
  await page.getByRole('button', { name: 'New Note' }).click()
  await page.getByLabel('Title', { exact: true }).fill('Tail')
  await page.getByRole('button', { name: 'Create' }).click()

  await page.locator('.cm-content').click()
  await page.keyboard.type('head ')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 2000 })
  await page.keyboard.type('FLUSHTAIL')
  await app.close()

  const files = (await findFiles(userDataDir)).filter((f) => f.endsWith('.md'))
  const bodies = await Promise.all(files.map((f) => readFile(f, 'utf8')))
  expect(bodies.some((b) => b.includes('FLUSHTAIL'))).toBe(true)

  const relaunched = await electron.launch({
    args: ['out/main/index.js'],
    env: e2eEnv(userDataDir)
  })
  try {
    const again = await relaunched.firstWindow()
    await again.getByRole('button', { name: 'Shop' }).click()
    await again.getByRole('tab', { name: 'Notes' }).click()
    await again.getByRole('button', { name: /Tail/ }).click()
    await expect(again.locator('.cm-content')).toContainText('FLUSHTAIL')
  } finally {
    await relaunched.close()
  }
})
