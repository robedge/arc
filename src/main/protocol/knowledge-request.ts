import { isRegularFileInside } from '../knowledge/knowledge-index'
import { binaryMimeOf, importClassOf } from '../knowledge/import-types'
import { resolveInRoot } from '../knowledge/knowledge-paths'

export const KNOWLEDGE_SCHEME = 'harness-knowledge'

const ID_SHAPE = /^[0-9A-Z]{26}$/
const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'"

export interface KnowledgeRequestDeps {
  getItem: (itemId: string) => { groupId: string; relPath: string } | undefined
  getKnowledgeRoot: (groupId: string) => string
  log?: { warn: (...args: unknown[]) => void }
}

export interface KnowledgeResponse {
  status: 200 | 404 | 405
  headers: Record<string, string>
  filePath?: string
}

const notFound = (status: 404 | 405 = 404): KnowledgeResponse => ({ status, headers: {} })

/**
 * Pure core of the `harness-knowledge://<groupId>/<itemId>` handler: decides the status, headers
 * and which file to read. GET only; the item must exist in the database and belong to the group;
 * the path is proven inside the group's root; only binary allowlist types are ever served.
 */
export async function resolveKnowledgeRequest(
  request: { method: string; url: string },
  deps: KnowledgeRequestDeps
): Promise<KnowledgeResponse> {
  if (request.method !== 'GET') return notFound(405)
  try {
    const url = new URL(request.url)
    // Standard schemes lower-case the host; ids are upper-case ULIDs.
    const groupId = url.hostname.toUpperCase()
    const itemId = url.pathname.slice(1)
    if (url.protocol !== `${KNOWLEDGE_SCHEME}:` || !ID_SHAPE.test(groupId)) return notFound()
    if (!ID_SHAPE.test(itemId)) return notFound()

    const item = deps.getItem(itemId)
    if (!item || item.groupId !== groupId) return notFound()
    const mime = binaryMimeOf(item.relPath)
    if (!mime || importClassOf(item.relPath) !== 'binary') return notFound()

    const root = deps.getKnowledgeRoot(groupId)
    const filePath = await resolveInRoot(root, item.relPath.split('/'))
    // resolveInRoot proves the parent; a symlinked leaf must be proven too.
    if (!(await isRegularFileInside(root, filePath))) return notFound()
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache'
    }
    if (mime === 'image/svg+xml') headers['Content-Security-Policy'] = SVG_CSP
    return { status: 200, headers, filePath }
  } catch (error: unknown) {
    deps.log?.warn('knowledge protocol request refused', error instanceof Error ? error.name : '')
    return notFound()
  }
}
