import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import AttachmentNotices from '../../src/renderer/src/lib/components/sessions/AttachmentNotices.svelte'
import Composer from '../../src/renderer/src/lib/components/sessions/Composer.svelte'
import NewSessionDialog from '../../src/renderer/src/lib/components/sessions/NewSessionDialog.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { attachments } from '../../src/renderer/src/lib/stores/attachments.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import type { AttachmentKind } from '../../src/shared/attachments'
import type { ProviderId } from '../../src/shared/types/provider'
import { mockArc } from './helpers'

const DRAFT = '01HZZZZZZZZZZZZZZZZZZZZZZA'
const idOf = (n: number) => `01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, '0')}`
const NAMES: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }
const PLURAL: Record<AttachmentKind, string> = { image: 'images', pdf: 'PDFs', text: 'text files' }
const sentence = (p: ProviderId, k: AttachmentKind) =>
  `${NAMES[p]} can't read ${PLURAL[k]}. It will be sent as a file the brain may not be able to open.`

let picked: { name: string; kind: AttachmentKind }[]

beforeEach(() => {
  picked = []
  mockArc((channel) => {
    if (channel === 'attachments:new-draft') return { ok: true, data: { draftId: DRAFT } }
    if (channel === 'attachments:pick') {
      return {
        ok: true,
        data: {
          attachments: picked.map((p, i) => ({
            id: idOf(i + 1),
            name: p.name,
            kind: p.kind,
            mime: 'x/y',
            size: 10
          })),
          refused: []
        }
      }
    }
    if (channel === 'commands:list') return { ok: true, data: [] }
    return { ok: true, data: undefined }
  })
  attachments.reset()
  activeSession.close()
  activeSession.sessionId = 's1'
  activeSession.setDraft('s1', '')
})
afterEach(() => {
  cleanup()
  settings.reset()
})

const warnings = () =>
  [...document.querySelectorAll('[data-notice-warning-text]')].map((e) => e.textContent)
const clip = () => screen.getByRole('button', { name: 'Attach files' })
async function attach(files: { name: string; kind: AttachmentKind }[]) {
  picked = files
  await fireEvent.click(clip())
  await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(files.length))
}
const withBrain = (provider: ProviderId) => {
  activeSession.header = { brainRunningOn: { provider, model: 'm' } } as never
}

const KINDS: AttachmentKind[] = ['image', 'pdf', 'text']
const PROVIDERS: ProviderId[] = ['claude', 'codex', 'cursor']
const cases = PROVIDERS.flatMap((p) => KINDS.map((k) => [p, k] as const))

it.each(cases)('AttachmentNotices: %s with a %s', (provider, kind) => {
  render(AttachmentNotices, { refused: [], ondismiss: () => {}, provider, kinds: [kind] })
  const expected = provider !== 'claude' && kind === 'pdf' ? [sentence(provider, kind)] : []
  expect(warnings()).toEqual(expected)
})

it('AttachmentNotices shows the exact sentence for a PDF on Codex and on Cursor', () => {
  const codex = render(AttachmentNotices, {
    refused: [],
    ondismiss: () => {},
    provider: 'codex',
    kinds: ['pdf']
  })
  expect(warnings()).toEqual([
    "Codex can't read PDFs. It will be sent as a file the brain may not be able to open."
  ])
  codex.unmount()
  render(AttachmentNotices, {
    refused: [],
    ondismiss: () => {},
    provider: 'cursor',
    kinds: ['pdf']
  })
  expect(warnings()).toEqual([
    "Cursor can't read PDFs. It will be sent as a file the brain may not be able to open."
  ])
})

it('is a polite status line, not an alert, with no dismiss button', () => {
  render(AttachmentNotices, { refused: [], ondismiss: () => {}, provider: 'codex', kinds: ['pdf'] })
  const region = document.querySelector('[data-attachment-notices]')!
  expect(region.getAttribute('role')).toBe('status')
  expect(region.querySelector('[data-notice-warning] button')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('Composer on a Codex brain warns once for two PDFs, keeps Send enabled, and clears on removal', async () => {
  withBrain('codex')
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await attach([
    { name: 'a.pdf', kind: 'pdf' },
    { name: 'b.pdf', kind: 'pdf' },
    { name: 'c.png', kind: 'image' }
  ])
  expect(warnings()).toEqual([sentence('codex', 'pdf')])
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  await fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }))
  expect(warnings()).toHaveLength(1)
  await fireEvent.click(screen.getByRole('button', { name: 'Remove b.pdf' }))
  expect(warnings()).toEqual([])
})

it('Composer on a Claude brain, or with no header, shows no warning for a PDF', async () => {
  withBrain('claude')
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await attach([{ name: 'a.pdf', kind: 'pdf' }])
  expect(warnings()).toEqual([])
})

it('Composer follows a brain that is handed off to another provider', async () => {
  withBrain('claude')
  render(Composer, { sessionId: 's1', brainState: 'idle' })
  await attach([{ name: 'a.pdf', kind: 'pdf' }])
  expect(warnings()).toEqual([])
  withBrain('cursor')
  await waitFor(() => expect(warnings()).toEqual([sentence('cursor', 'pdf')]))
})

it('New Session dialog follows the picker and never disables Start', async () => {
  settings.apply({
    'providers.brain': { provider: 'codex', model: 'gpt-5' },
    'providers.workers': { mode: 'auto' },
    'usage.checkClaudePlanOnLaunch': false,
    'agents.loadOff': { brain: [], workers: [] }
  } as never)
  render(NewSessionDialog, { groupId: 'g1', onclose: () => {}, oncreated: () => {} })
  await attach([{ name: 'a.pdf', kind: 'pdf' }])
  expect(warnings()).toEqual([sentence('codex', 'pdf')])
  expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false)
  await fireEvent.change(screen.getByLabelText('Brain'), { target: { value: 'claude:sonnet' } })
  await waitFor(() => expect(warnings()).toEqual([]))
  expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false)
})

it('a refusal and the warning coexist without duplication', () => {
  render(AttachmentNotices, {
    refused: [{ name: 'x.zip', reason: 'unsupported' }],
    ondismiss: () => {},
    provider: 'codex',
    kinds: ['pdf', 'pdf']
  })
  expect(document.querySelectorAll('[data-notice-line]')).toHaveLength(1)
  expect(warnings()).toEqual([sentence('codex', 'pdf')])
})
