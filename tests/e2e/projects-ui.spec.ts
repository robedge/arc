import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('add projects via the picker, see rows and the not-git label, remove one', async ({
  app,
  window: page
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-projui-')))
  try {
    const repo = join(root, 'repo')
    const plain = join(root, 'plain')
    await mkdir(repo)
    await mkdir(plain)
    execFileSync('git', ['init', '-q'], { cwd: repo })

    await page.getByRole('button', { name: 'New Group' }).click()
    await page.getByLabel('Group name').fill('Shop')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('tab', { name: 'Projects' }).click()
    await expect(page.getByText('Add a project folder or drag one here')).toBeVisible()

    await app.evaluate(
      (_electron, paths) => {
        ;(
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog(paths)
      },
      [repo, plain]
    )
    await page.getByRole('button', { name: 'Add Project' }).click()

    const rows = page.getByRole('list', { name: 'Projects' }).getByRole('listitem')
    await expect(rows).toHaveCount(2)
    const repoRow = rows.filter({ hasText: repo })
    const plainRow = rows.filter({ hasText: plain })
    await expect(repoRow.getByText('repo', { exact: true })).toBeVisible()
    await expect(plainRow.getByText('plain', { exact: true })).toBeVisible()
    const label = 'Not a git repository — read-only in sessions'
    await expect(plainRow.getByText(label)).toBeVisible()
    await expect(repoRow.getByText(label)).toHaveCount(0)

    await plainRow.getByRole('button', { name: 'Remove project' }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(rows).toHaveCount(1)
    await expect(page.getByText(plain)).toHaveCount(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
