export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'GROUP_NAME_REQUIRED',
  'GROUP_NAME_TOO_LONG',
  'GROUP_NAME_DUPLICATE',
  'SECTION_NAME_INVALID',
  'SECTION_NAME_DUPLICATE',
  'PROJECT_DUPLICATE',
  'PROJECT_NOT_DIRECTORY',
  'TITLE_REQUIRED',
  'LINK_URL_INVALID',
  'FILE_TOO_LARGE',
  'FILE_UNSUPPORTED',
  'FOLDER_MISSING',
  'KNOWLEDGE_ROOT_MISSING',
  'EXTERNAL_MODIFIED',
  'LINK_TARGET_INVALID',
  'PATH_OUTSIDE_ROOT',
  'STORAGE_BUSY',
  'STORAGE_OP_PENDING',
  'STORAGE_ALREADY_LINKED',
  'STORAGE_TARGET_INVALID',
  'STORAGE_TARGET_NESTED',
  'STORAGE_TARGET_NOT_WRITABLE',
  'STORAGE_KEPT_ASIDE_EXISTS',
  'STORAGE_NOT_LINKED',
  'STORAGE_NO_KEPT_ASIDE',
  'STORAGE_ROOT_AVAILABLE',
  'EXPORT_FAILED',
  'CLI_UNAVAILABLE',
  'SESSION_NOT_FOUND',
  'REVIEW_FILE_NOT_FOUND',
  'BRANCH_DIVERGED',
  'NO_REMOTE',
  'WAITING_FOR_CHECKOUT',
  'PUSH_FAILED',
  'PLUGIN_FAILED',
  'PLUGIN_BUSY',
  'NOTE_NOT_FOUND',
  'NOT_DRAFT',
  'TOO_MANY_NOTES',
  'IO_FAILED',
  'INTERNAL'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorDetails {
  name?: string
  count?: number
  /**
   * Why a request was refused or failed, text the UI can show: a sentence (`workers:continue`), or git's own
   * trimmed stderr for `PUSH_FAILED`, the CLI's own message for `PLUGIN_FAILED`.
   */
  reason?: string
}

export interface AppError {
  code: ErrorCode
  details?: ErrorDetails
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function err(code: ErrorCode, details?: ErrorDetails): Result<never> {
  return { ok: false, error: details ? { code, details } : { code } }
}

/** Thrown by main-process services; `handle()` turns it into an `{ ok: false }` Result. */
export class AppErrorException extends Error {
  readonly code: ErrorCode
  readonly details: ErrorDetails | undefined

  constructor(code: ErrorCode, details?: ErrorDetails) {
    super(code)
    this.name = 'AppErrorException'
    this.code = code
    this.details = details
  }
}
