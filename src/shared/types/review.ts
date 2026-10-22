/** Change review (spec 004): what a session changed, per repository, relative to where its branch started. */

export type ReviewFileStatus = 'A' | 'M' | 'D' | 'R'

export interface ReviewFile {
  /** Path in the session branch (the new path for a rename). */
  path: string
  /** Set only for renames: the path before the rename. */
  oldPath?: string
  status: ReviewFileStatus
  added: number
  removed: number
  /** Git reports no line counts (`-`): the diff cannot be shown as text. */
  binary: boolean
  /** More than 2,000 changed lines: shown only on request. */
  large: boolean
  /**
   * Who changed the file: worker labels ("W1", "W3") in worker-number order, then "You" for the user's own
   * commits and Arc's Undo commits. Never empty.
   */
  workers: string[]
  /** The user ticked the file as reviewed and it has not changed since. */
  reviewed: boolean
  /** The file was ticked as reviewed but changed afterwards, so it needs another look. */
  changedSinceReviewed: boolean
}

/** A change in the user's checkout that is not committed yet (staged and unstaged together, plus untracked files). */
export type ReviewUncommittedFile = Omit<
  ReviewFile,
  'workers' | 'reviewed' | 'changedSinceReviewed'
>

/**
 * The "Not committed" section of a repository. Only computed while the user's checkout is on the session
 * branch; otherwise `other-branch` with the branch it is on (`null` when HEAD is detached). `unavailable`
 * when git failed reading the checkout: the committed files of the repository are still returned.
 */
export type ReviewUncommitted =
  | { state: 'ok'; files: ReviewUncommittedFile[] }
  | { state: 'other-branch'; current: string | null }
  | { state: 'unavailable' }

export type ReviewFileSource = 'session' | 'uncommitted'

/**
 * Where the session branch stands with its remote. `waiting`: a merge is waiting for the user's checkout, and
 * a push sends the real branch only. `pushed`: `newerCommits` counts commits on the session branch after the
 * pushed one (0 when the pushed sha is unknown). `no-remote`: the repository has no remote to push to.
 */
export type ReviewPush =
  | { state: 'never' }
  | { state: 'pushed'; remote: string; at: number; newerCommits: number }
  | { state: 'no-remote' }
  | { state: 'waiting' }

export interface ReviewRepo {
  projectId: string
  projectName: string
  /** The session branch, `arc/<slug>`. */
  branch: string
  files: ReviewFile[]
  /** Recomputed on every `review:get`; never cached. */
  uncommitted: ReviewUncommitted
  push: ReviewPush
}

export type ReviewNoteSide = 'old' | 'new'

/** A note the user wrote on a line of the diff, for the brain (`review:note-*`). */
export interface ReviewNote {
  id: string
  projectId: string
  /** Path in the session branch. */
  path: string
  side: ReviewNoteSide
  /** Line number on that side of the diff. */
  line: number
  /** The line's text when the note was written (at most 500 characters). */
  lineText: string
  body: string
  /** `draft` until "Send notes to brain"; sent notes can no longer be edited or deleted. */
  state: 'draft' | 'sent'
  /** The diff no longer has `lineText` at `line` on `side`, or the file is no longer changed. */
  stale: boolean
  createdAt: number
  updatedAt: number
  /** The conversation message the note was sent in; set when `state` is `sent`. */
  messageId?: number
}

export interface ReviewSnapshot {
  sessionId: string
  /** Git projects of the session that have a session branch, in project order. */
  repos: ReviewRepo[]
  /** Every label that appears in any file's `workers` across the repos (worker order, "You" last): the filter dropdown. */
  workers: string[]
  /** Every note of the session, drafts and sent, oldest first. */
  notes: ReviewNote[]
}

export type DiffLineKind = 'ctx' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  /** Line number in the base version; absent on added lines. */
  oldNo?: number
  /** Line number in the session version; absent on deleted lines. */
  newNo?: number
  /** The line without its +/-/space marker; a trailing CR of a CRLF file is kept. */
  text: string
  /** Git marked the line "\ No newline at end of file". */
  noNewline?: true
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The hunk's `@@ -a,b +c,d @@ section` line. */
  header: string
  lines: DiffLine[]
}

/**
 * One file's change (`review:file`). `text` with no hunks means nothing to show (a pure rename, a mode-only
 * change, an empty file).
 */
export type ReviewFileDiff =
  | { kind: 'text'; hunks: DiffHunk[] }
  | { kind: 'binary' }
  /** More than 2,000 changed lines; send `showAnyway` to get the text. */
  | { kind: 'large'; changedLines: number }
  /** More than 50,000 changed lines: never shown. */
  | { kind: 'tooLarge'; changedLines: number }

/** `review:undo-preview`: who is still working on the file the user is about to undo. */
export interface ReviewUndoPreview {
  /** Worker labels ("W2") of running, non-resolver workers whose working copy changed the file. */
  activeWorkers: string[]
}

/** `review:push-preview`: the exact command the Push button will run, and the remote it goes to. */
export interface ReviewPushPreview {
  /** Always `git push -u <remote> <branch>`. */
  command: string
  remote: string
}

/** `review:push`: the branch reached the remote. */
export interface ReviewPushResult {
  pushedAt: number
  remote: string
  /** The sha the remote has for the branch. */
  sha: string
}
