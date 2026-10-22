import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import Radio from '../../src/renderer/src/lib/components/ui/Radio.svelte'

afterEach(cleanup)

it('Radio drops the native control look so it cannot render as a grey disc', () => {
  render(Radio, { id: 'r', name: 'g', label: 'One', value: 'a', group: 'b' })
  const cls = screen.getByRole('radio').className
  expect(cls).toContain('appearance-none')
  expect(cls).toContain('border-border-strong')
})
