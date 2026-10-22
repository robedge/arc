import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import MarkdownPreview from '../../src/renderer/src/lib/components/items/MarkdownPreview.svelte'
import { mockHarness } from './helpers'

afterEach(cleanup)

const source = [
  '[web](https://example.com/page)',
  '[plain](http://example.com)',
  '[anchor](#section)',
  '[file](file:///etc/passwd)',
  '[js](javascript:alert(1))'
].join('\n\n')

async function click(name: string): Promise<ReturnType<typeof mockHarness>> {
  const invoke = mockHarness(() => ({ ok: true, data: undefined }))
  render(MarkdownPreview, { source })
  const link = screen.queryByText(name)
  if (link) await fireEvent.click(link)
  return invoke
}

it('opens https links through shell:openUrl', async () => {
  const invoke = await click('web')
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('shell:openUrl', { url: 'https://example.com/page' })
  )
})

it('opens http links through shell:openUrl', async () => {
  const invoke = await click('plain')
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('shell:openUrl', { url: 'http://example.com' })
  )
})

it.each(['anchor', 'file', 'js'])('does nothing for the %s link', async (name) => {
  const invoke = await click(name)
  expect(invoke).not.toHaveBeenCalled()
})
