import type { AppError, ErrorCode } from '@shared/errors'
import type { StorageBlockedReason } from '@shared/types/storage'

const GENERIC_FAILURE = 'Something went wrong. Please try again.'

type MessageEntry = string | ((error: AppError) => string)

/** The only place that maps error codes to user-facing strings. */
const MESSAGES: Record<ErrorCode, MessageEntry> = {
  GROUP_NAME_REQUIRED: 'Group name is required.',
  GROUP_NAME_TOO_LONG: 'Group name must be 60 characters or fewer.',
  GROUP_NAME_DUPLICATE: 'A group with this name already exists.',
  SECTION_NAME_INVALID: 'Section name must be 1–40 characters.',
  SECTION_NAME_DUPLICATE: 'A section with this name already exists in this group.',
  PROJECT_DUPLICATE: 'This folder is already in the group.',
  PROJECT_NOT_DIRECTORY: 'Only folders can be added as projects.',
  TITLE_REQUIRED: 'Title is required.',
  LINK_URL_INVALID: 'Enter a full web address starting with http:// or https://.',
  FILE_TOO_LARGE: (e) =>
    `'${e.details?.name ?? 'This file'}' is larger than 20 MB and was not added.`,
  FILE_UNSUPPORTED: (e) => `'${e.details?.name ?? 'This file'}' isn't a supported file type.`,
  FOLDER_MISSING: 'Folder not found',
  KNOWLEDGE_ROOT_MISSING: 'Knowledge folder not found',
  EXTERNAL_MODIFIED: 'This item changed on disk.',
  LINK_TARGET_INVALID: GENERIC_FAILURE,
  PATH_OUTSIDE_ROOT: GENERIC_FAILURE,
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
  IO_FAILED: GENERIC_FAILURE,
  INTERNAL: GENERIC_FAILURE,
  VALIDATION_FAILED: GENERIC_FAILURE
}

export function messageFor(error: AppError): string {
  const entry = MESSAGES[error.code]
  return typeof entry === 'function' ? entry(error) : entry
}

const BLOCKED_MESSAGES: Record<StorageBlockedReason, string> = {
  'not-a-folder': 'That is not a folder. Choose a different folder.',
  'not-writable': MESSAGES.STORAGE_TARGET_NOT_WRITABLE as string,
  'inside-app-storage': "That folder is inside Arc's own storage. Choose a different folder.",
  'contains-app-storage': "That folder contains Arc's own storage. Choose a different folder.",
  'inside-other-group':
    "That folder is inside another group's knowledge folder. Choose a different folder.",
  'contains-other-group':
    "That folder contains another group's knowledge folder. Choose a different folder."
}

/** Why a picked folder cannot be linked, as a user-facing sentence. */
export function blockedMessageFor(reason: StorageBlockedReason): string {
  return BLOCKED_MESSAGES[reason]
}
