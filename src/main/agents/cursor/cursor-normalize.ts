import type { NormalizedAction } from '../../policy/normalized-action'
import type { CursorApprovalRequest, JsonObject } from './cursor-types'

/**
 * What a Cursor permission request asks for, as the action Arc classifies (tech spec 2.4). The
 * request itself carries no `rawInput` (spike M1): the command, paths and MCP identity come from the
 * `tool_call` the adapter attaches as `request.tool`. Whatever cannot be read fails closed.
 */

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** "`git status`" -> "git status". */
function backticked(title: string): string | undefined {
  return str(/^`([\s\S]+)`$/.exec(title.trim())?.[1])
}

function commandOf(request: CursorApprovalRequest): string | null {
  const input: JsonObject = request.tool?.rawInput ?? {}
  return (
    str(input['command']) ??
    backticked(request.tool?.title ?? '') ??
    backticked(request.title) ??
    null
  )
}

function pathsOf(request: CursorApprovalRequest): string[] {
  const input: JsonObject = request.tool?.rawInput ?? {}
  const listed = Array.isArray(input['paths'])
    ? input['paths'].filter((p): p is string => typeof p === 'string' && p !== '')
    : []
  const single = [input['path'], input['filePath'], input['file_path']].flatMap((p) =>
    str(p) === undefined ? [] : [p as string]
  )
  const located = (request.tool?.locations ?? []).filter((p) => p !== '')
  return [...new Set([...listed, ...single.slice(0, 1), ...located])]
}

/** The server and tool of an MCP call: `rawInput` first, then a "server: tool" title. */
function mcpIdentity(
  request: CursorApprovalRequest
): { server: string; tool: string; args?: Record<string, unknown> } | undefined {
  const input = request.tool?.rawInput
  const server = str(input?.['providerIdentifier'])
  const tool = str(input?.['toolName'])
  if (server !== undefined && tool !== undefined) {
    const args = record(input?.['args'])
    return { server, tool, ...(args ? { args } : {}) }
  }
  // The tool call's updated title reads "arc: echo".
  const updated = /^(.+?): (.+)$/.exec(request.tool?.title ?? '')
  if (updated?.[1] !== undefined && updated[2] !== undefined && updated[1] !== 'MCP') {
    return { server: updated[1], tool: updated[2] }
  }
  // The request title reads "<server>-<tool>: <tool>".
  const asked = /^(.+): (.+)$/.exec(request.title)
  if (asked?.[1] !== undefined && asked[2] !== undefined) {
    const suffix = `-${asked[2]}`
    if (asked[1].endsWith(suffix) && asked[1].length > suffix.length) {
      return { server: asked[1].slice(0, -suffix.length), tool: asked[2] }
    }
  }
  return undefined
}

/**
 * The read-only hint a request carries, when it has any (`annotations` on the tool call or in its
 * input). Spike M1 saw none, so this is usually `unknown` and `McpToolCatalogue.cursorAction` asks the
 * server itself; the rule is the same: read-only and not destructive runs unasked.
 */
function annotatedReadOnly(request: CursorApprovalRequest): 'yes' | 'no' | 'unknown' {
  const call = record(request.raw['toolCall'])
  const found = record(call?.['annotations']) ?? record(request.tool?.rawInput['annotations'])
  if (!found) return 'unknown'
  if (found['destructiveHint'] === true) return 'no'
  return found['readOnlyHint'] === true ? 'yes' : 'unknown'
}

export function normalizeCursorApproval(request: CursorApprovalRequest): NormalizedAction {
  switch (request.kind) {
    case 'execute': {
      const cwd =
        str(request.tool?.rawInput['cwd']) ?? str(request.tool?.rawInput['workingDirectory'])
      return { kind: 'bash', command: commandOf(request), ...(cwd === undefined ? {} : { cwd }) }
    }
    case 'edit':
    case 'delete':
    case 'move': {
      const paths = pathsOf(request)
      return paths.length > 0
        ? { kind: 'edit', tool: 'Edit', paths }
        : { kind: 'edit', tool: 'Edit', paths: [], unknownPaths: true }
    }
    case 'read':
    case 'search':
    case 'think':
      return { kind: 'other', tool: request.kind, input: {} }
    case 'fetch':
      return { kind: 'other', tool: 'WebFetch', input: {} }
    default: {
      // `other` is an MCP call; any kind Arc does not know is treated the same way and asks.
      const mcp = mcpIdentity(request)
      return mcp
        ? { kind: 'mcp', ...mcp, readOnly: annotatedReadOnly(request) }
        : { kind: 'mcp', server: 'unknown', tool: 'unknown', readOnly: 'unknown' }
    }
  }
}
