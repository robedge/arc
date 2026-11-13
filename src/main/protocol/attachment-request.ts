import { lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AttachmentKind } from '@shared/attachments'
import { THUMB_NAME, sentAttachmentsRoot } from '../attachments/attachment-paths'
import { isRegularFileInside } from '../knowledge/knowledge-index'
import { resolveInRoot } from '../knowledge/knowledge-paths'

export const ATTACHMENT_SCHEME = 'arc-attachment'

const ID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** What the resolver needs to know about one attachment, whichever store it comes from. */
export interface AttachmentFacts {
  kind: AttachmentKind
  mime: string
  storedName: string
}

export interface AttachmentRequestDeps {
  /** `userData/attachment-staging`. */
  stagingRoot: string
  getStaged: (id: string) => (AttachmentFacts & { draftId: string }) | undefined
  getSent: (id: string) => (AttachmentFacts & { sessionId: string }) | undefined
  /** `userData/sessions/<id>/`. */
  getSessionDir: (sessionId: string) => string
  log?: { warn: (...args: unknown[]) => void }
}

export interface AttachmentResponse {
  status: 200 | 404 | 405
  headers: Record<string, string>
  filePath?: string
}

const refuse = (status: 404 | 405 = 404): AttachmentResponse => ({ status, headers: {} })

/** True for a regular file that is not itself a symlink. */
async function isPlainFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Pure core of the `arc-attachment://staged|sent/<id>[?thumb=1]` handler. GET only; the id must be a
 * ULID found in the staging index or the database, never a path from the URL; only images are
 * served; the file must be a regular, non-symlink file inside the staging root or the session's
 * attachments folder. With `thumb=1` the thumbnail is served when it exists, else the original.
 */
export async function resolveAttachmentRequest(
  request: { method: string; url: string },
  deps: AttachmentRequestDeps
): Promise<AttachmentResponse> {
  if (request.method !== 'GET') return refuse(405)
  try {
    const url = new URL(request.url)
    if (url.protocol !== `${ATTACHMENT_SCHEME}:`) return refuse()
    const store = url.hostname
    const id = url.pathname.slice(1)
    if ((store !== 'staged' && store !== 'sent') || !ID_SHAPE.test(id)) return refuse()

    let facts: AttachmentFacts | undefined
    let root: string
    let segments: string[]
    if (store === 'staged') {
      const staged = deps.getStaged(id)
      if (!staged) return refuse()
      facts = staged
      root = deps.stagingRoot
      segments = [staged.draftId, id]
    } else {
      const sent = deps.getSent(id)
      if (!sent) return refuse()
      facts = sent
      root = sentAttachmentsRoot(deps.getSessionDir(sent.sessionId))
      segments = [id]
    }
    if (facts.kind !== 'image' || basename(facts.storedName) !== facts.storedName) return refuse()

    const dir = join(await resolveInRoot(root, segments))
    const original = join(dir, facts.storedName)
    const thumb = join(dir, THUMB_NAME)
    const wantThumb = url.searchParams.get('thumb') === '1'
    const useThumb =
      wantThumb && (await isPlainFile(thumb)) && (await isRegularFileInside(root, thumb))
    const filePath = useThumb ? thumb : original
    if (
      !useThumb &&
      !((await isPlainFile(filePath)) && (await isRegularFileInside(root, filePath)))
    )
      return refuse()
    return {
      status: 200,
      headers: {
        'Content-Type': useThumb ? 'image/png' : facts.mime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache'
      },
      filePath
    }
  } catch (error: unknown) {
    deps.log?.warn('attachment protocol request refused', error instanceof Error ? error.name : '')
    return refuse()
  }
}
