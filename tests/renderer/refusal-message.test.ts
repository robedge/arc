import { expect, it } from 'vitest'
import { refusalMessage } from '../../src/renderer/src/lib/attachments/refusal-message'

it('unsupported names the file and what Arc accepts', () => {
  expect(refusalMessage({ name: 'a.zip', reason: 'unsupported' })).toBe(
    "a.zip can't be attached. Arc accepts images, PDFs and text files."
  )
})

it('too_large names the file and the 20 MB limit', () => {
  expect(refusalMessage({ name: 'big.png', reason: 'too_large' })).toBe(
    'big.png is too large. The limit is 20 MB.'
  )
})

it('too_many states the per-message limit without a name', () => {
  expect(refusalMessage({ name: 'x', reason: 'too_many' })).toBe(
    'A message can have at most 10 attachments.'
  )
})

it('folder has no name', () => {
  expect(refusalMessage({ name: 'src', reason: 'folder' })).toBe("Folders can't be attached.")
})

it('unreadable names the file', () => {
  expect(refusalMessage({ name: 'x.log', reason: 'unreadable' })).toBe("x.log couldn't be read.")
})
