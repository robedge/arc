import { expect, it } from 'vitest'
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_SUPPORT,
  unreadableKinds,
  type AttachmentKind
} from '../../../src/shared/attachments'
import { PROVIDER_IDS, type ProviderId } from '../../../src/shared/types/provider'

const EXPECTED: Record<ProviderId, Record<AttachmentKind, boolean>> = {
  claude: { image: true, pdf: true, text: true },
  codex: { image: true, pdf: false, text: true },
  cursor: { image: true, pdf: false, text: true }
}

const cases = PROVIDER_IDS.flatMap((p) => ATTACHMENT_KINDS.map((k) => [p, k] as const))

it.each(cases)('%s reading %s matches the confirmed table', (provider, kind) => {
  expect(ATTACHMENT_SUPPORT[provider][kind]).toBe(EXPECTED[provider][kind])
  expect(unreadableKinds(provider, [kind])).toEqual(EXPECTED[provider][kind] ? [] : [kind])
})

it('lists each unreadable kind once, in image, PDF, text order, ignoring unknown kinds', () => {
  const none = { image: false, pdf: false, text: false }
  const table = { claude: none, codex: none, cursor: none }
  expect(unreadableKinds('codex', ['text', 'pdf', undefined, 'pdf', 'image'], table)).toEqual([
    'image',
    'pdf',
    'text'
  ])
  expect(unreadableKinds('codex', [])).toEqual([])
})
