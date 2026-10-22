/**
 * What an agent wants to do, spelled the same for every provider (tech spec 2.2). The classifier,
 * the allow rules and the attention coordinator work on this; the provider-specific request
 * (Claude's `request_permission` call, Codex's server request) is turned into it at the edge.
 */

export type NormalizedAction =
  /** A shell command. `command` is null when the input held no readable command (Arc then asks). */
  | { kind: 'bash'; command: string | null; cwd?: string }
  /**
   * A change to files. `tool` is the name the user reads (`Edit`, `Write`, `NotebookEdit`). With
   * `unknownPaths` Arc could not tell which files change, so the request always needs the user.
   */
  | { kind: 'edit'; tool: string; paths: readonly string[]; unknownPaths?: boolean }
  /** A tool of an MCP server. `readOnly: 'unknown'` means ask. */
  | {
      kind: 'mcp'
      server: string
      tool: string
      args?: Record<string, unknown>
      readOnly: 'yes' | 'no' | 'unknown'
    }
  /** Codex asks for more access than its sandbox gives (extra folders or the network). */
  | {
      kind: 'permission'
      reason: string
      fileSystem?: { read?: string[]; write?: string[] }
      network?: boolean
    }
  /** Anything else: a read-only tool, a web tool, an unknown tool. Not one of the protected kinds. */
  | { kind: 'other'; tool: string; input: Record<string, unknown> }

/** The `tool_name` the stored rows use for a Codex permission request. */
export const CODEX_PERMISSIONS_TOOL = 'CodexPermissions'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((v): v is string => typeof v === 'string')
  return list.length > 0 ? list : undefined
}

/**
 * A Claude tool call (or a stored row, which is Claude-shaped, see `toStoredCall`) as an action.
 * `Bash`, the file tools and `CodexPermissions` are protected kinds; every other tool is `other`
 * and not one of the policy categories. An `mcp__<server>__<tool>` name stays `other` here: telling
 * the server from the tool, and whether the tool only reads, needs the running agent's list of
 * servers, so the coordinator asks `McpToolCatalogue.claudeAction` first and only falls back to this.
 */
export function normalizeClaudeCall(
  tool: string,
  input: Record<string, unknown>
): NormalizedAction {
  if (tool === 'Bash') {
    const command = input['command']
    const cwd = nonEmpty(input['cwd'])
    return {
      kind: 'bash',
      command: typeof command === 'string' ? command : null,
      ...(cwd === null ? {} : { cwd })
    }
  }
  if (EDIT_TOOLS.has(tool)) {
    // A stored multi-file change keeps its list in `paths`; a Claude call has one `file_path`.
    const listed = stringList(input['paths'])
    const single = nonEmpty(
      tool === 'NotebookEdit' ? (input['notebook_path'] ?? input['file_path']) : input['file_path']
    )
    const paths = listed ?? (single === null ? [] : [single])
    const unknownPaths = input['unknownPaths'] === true || paths.length === 0
    return { kind: 'edit', tool, paths, ...(unknownPaths ? { unknownPaths: true } : {}) }
  }
  if (tool === CODEX_PERMISSIONS_TOOL) {
    const fs = input['fileSystem']
    const record =
      typeof fs === 'object' && fs !== null && !Array.isArray(fs)
        ? (fs as Record<string, unknown>)
        : null
    const read = stringList(record?.['read'])
    const write = stringList(record?.['write'])
    const fileSystem = record
      ? { ...(read ? { read } : {}), ...(write ? { write } : {}) }
      : undefined
    const reason = input['reason']
    return {
      kind: 'permission',
      reason: typeof reason === 'string' ? reason : '',
      ...(fileSystem ? { fileSystem } : {}),
      ...(typeof input['network'] === 'boolean' ? { network: input['network'] } : {})
    }
  }
  return { kind: 'other', tool, input }
}

/**
 * The Claude-shaped `tool_name` and input a request is stored under (`attention_requests`). This
 * keeps the allow rules, the dialog cards and the rows of older sessions working for both providers.
 */
export function toStoredCall(action: NormalizedAction): {
  toolName: string
  input: Record<string, unknown>
} {
  switch (action.kind) {
    case 'bash':
      return {
        toolName: 'Bash',
        input: { command: action.command ?? '', ...(action.cwd ? { cwd: action.cwd } : {}) }
      }
    case 'edit': {
      const first = action.paths[0]
      const pathKey = action.tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      return {
        toolName: action.tool,
        input: {
          ...(first === undefined ? {} : { [pathKey]: first }),
          ...(action.paths.length > 1 ? { paths: [...action.paths] } : {}),
          ...(action.unknownPaths ? { unknownPaths: true } : {})
        }
      }
    }
    case 'mcp':
      return { toolName: `mcp__${action.server}__${action.tool}`, input: action.args ?? {} }
    case 'permission':
      return {
        toolName: CODEX_PERMISSIONS_TOOL,
        input: {
          reason: action.reason,
          ...(action.fileSystem ? { fileSystem: action.fileSystem } : {}),
          ...(action.network === undefined ? {} : { network: action.network })
        }
      }
    case 'other':
      return { toolName: action.tool, input: action.input }
  }
}

/** The coordinator's decision on one action, whichever provider asked. */
export type ActionDecision =
  | { allow: true }
  | {
      allow: false
      /** Why it was refused; the agent is told. */
      message?: string | undefined
      /** End the agent's turn as well (Codex `cancel`). */
      cancelTurn?: boolean | undefined
    }

export interface ActionMeta {
  /** The Claude tool use the request belongs to; tells a helper's request from the worker's own. */
  toolUseId?: string | undefined
  /** The call exactly as the agent sent it. Stored in place of the normalized form (Claude returns it as `updatedInput`). */
  stored?: { toolName: string; input: Record<string, unknown> } | undefined
}
