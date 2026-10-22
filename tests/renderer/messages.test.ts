import { describe, expect, it } from 'vitest'
import { ERROR_CODES } from '@shared/errors'
import { blockedMessageFor, messageFor } from '../../src/renderer/src/lib/ipc/messages'

const GENERIC = 'Something went wrong. Please try again.'

const expected: Record<string, string> = {
  GROUP_NAME_REQUIRED: 'Group name is required.',
  GROUP_NAME_TOO_LONG: 'Group name must be 60 characters or fewer.',
  GROUP_NAME_DUPLICATE: 'A group with this name already exists.',
  SECTION_NAME_INVALID: 'Section name must be 1–40 characters.',
  SECTION_NAME_DUPLICATE: 'A section with this name already exists in this group.',
  PROJECT_DUPLICATE: 'This folder is already in the group.',
  PROJECT_NOT_DIRECTORY: 'Only folders can be added as projects.',
  TITLE_REQUIRED: 'Title is required.',
  LINK_URL_INVALID: 'Enter a full web address starting with http:// or https://.',
  FILE_TOO_LARGE: "'big_dump.sql' is larger than 20 MB and was not added.",
  FILE_UNSUPPORTED: "'big_dump.sql' isn't a supported file type.",
  FOLDER_MISSING: 'Folder not found',
  KNOWLEDGE_ROOT_MISSING: 'Knowledge folder not found',
  LINK_TARGET_INVALID: GENERIC,
  PATH_OUTSIDE_ROOT: GENERIC,
  STORAGE_BUSY: 'Another storage change is already running for this group.',
  STORAGE_OP_PENDING: 'An earlier storage change did not finish. Restart Arc to recover it.',
  STORAGE_ALREADY_LINKED: 'This group already has a linked folder.',
  STORAGE_TARGET_INVALID: 'That folder is not available. Choose it again.',
  STORAGE_TARGET_NESTED:
    "That folder overlaps Arc's own storage or another group's knowledge folder. Choose a different folder.",
  STORAGE_TARGET_NOT_WRITABLE: "Arc can't write to that folder. Choose a different folder.",
  STORAGE_KEPT_ASIDE_EXISTS:
    'Earlier in-app knowledge is already kept aside. Restore or discard it before using a folder only.',
  STORAGE_NOT_LINKED: 'This group is already stored in the app.',
  STORAGE_NO_KEPT_ASIDE: 'There is no earlier in-app knowledge to restore.',
  STORAGE_ROOT_AVAILABLE: 'The knowledge folder is available again. Unlink it instead.',
  EXPORT_FAILED: "Couldn't export the knowledge, so nothing was deleted. Try a different folder.",
  CLI_UNAVAILABLE:
    "Claude Code isn't available, so the message wasn't sent. Fix it from the banner, then send it again.",
  SESSION_NOT_FOUND: 'That session no longer exists.',
  REVIEW_FILE_NOT_FOUND: 'That file is no longer part of the session changes.',
  BRANCH_DIVERGED: 'The session branch changed outside Arc. Reopen the review and try again.',
  NO_REMOTE: 'No remote configured',
  WAITING_FOR_CHECKOUT: 'Waiting for your checkout',
  PUSH_FAILED: 'The push failed.',
  PLUGIN_FAILED: 'The plugin change failed.',
  PLUGIN_BUSY: 'Another plugin change is in progress.',
  NOTE_NOT_FOUND: 'That note no longer exists.',
  NOT_DRAFT: 'This note was already sent.',
  TOO_MANY_NOTES: 'You can send up to 50 notes at a time.',
  IO_FAILED: GENERIC,
  INTERNAL: GENERIC,
  VALIDATION_FAILED: GENERIC
}

describe('messageFor', () => {
  for (const [code, message] of Object.entries(expected)) {
    it(`maps ${code}`, () => {
      expect(
        messageFor({
          code: code as (typeof ERROR_CODES)[number],
          details: { name: 'big_dump.sql' }
        })
      ).toBe(message)
    })
  }

  it('covers every error code except EXTERNAL_MODIFIED (banner, not a message)', () => {
    const covered = new Set(Object.keys(expected))
    const missing = ERROR_CODES.filter((c) => c !== 'EXTERNAL_MODIFIED' && !covered.has(c))
    expect(missing).toEqual([])
  })
})

describe('blockedMessageFor', () => {
  const reasons = [
    'not-a-folder',
    'not-writable',
    'inside-app-storage',
    'contains-app-storage',
    'inside-other-group',
    'contains-other-group'
  ] as const
  for (const reason of reasons) {
    it(`maps ${reason} to a sentence ending with a next step`, () => {
      expect(blockedMessageFor(reason)).toMatch(/Choose a different folder\.$|can't write/)
    })
  }
})
