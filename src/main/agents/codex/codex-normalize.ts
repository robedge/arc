import type { NormalizedAction } from '../../policy/normalized-action'
import type { CodexApprovalRequest } from './codex-types'

/**
 * Codex reports a command as the shell wrapper it runs: `/bin/zsh -lc 'cat hello.txt'`. Everything
 * that shows or classifies a command wants the script inside.
 */

const SHELL_WRAPPER = /^(?:\S*\/)?(?:bash|zsh|sh|dash|ksh|fish)\s+-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/

/** Removes one level of shell quoting from a single quoted word; anything else is returned as is. */
function unquote(word: string): string {
  const text = word.trim()
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("'\\''", "'")
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  }
  return text
}

/**
 * `/bin/zsh -lc 'cat hello.txt'` -> `cat hello.txt`. A path in front of the shell, any of the
 * common shells and any `-c` flag cluster (`-c`, `-lc`, `-ic`) are accepted. A command that is not
 * a shell wrapper is returned unchanged.
 */
export function unwrapShell(command: string): string {
  const match = SHELL_WRAPPER.exec(command.trim())
  const rest = match?.[1]
  if (rest === undefined) return command
  return unquote(rest)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The files a `fileChange` item changes; empty when the item is unknown. */
function changedPaths(item: Record<string, unknown> | undefined): string[] {
  const changes = item?.['changes']
  if (!Array.isArray(changes)) return []
  return changes.flatMap((c) => {
    const path = str(record(c)?.['path'])
    return path === undefined ? [] : [path]
  })
}

/**
 * What a Codex approval request asks for, as the action Arc classifies (tech spec 2.2).
 * - A command is the script inside its shell wrapper, with the directory Codex runs it in.
 * - A file change takes its files from the `fileChange` item announced just before the request. Without
 *   it Arc cannot tell which files change, so the action fails closed (`unknownPaths`).
 * - A permissions request carries the extra folders and network Codex wants.
 * - An MCP tool approval takes the tool and its read-only hint from the `mcpToolCall` item announced just
 *   before; without it the tool is unknown and counts as not read-only.
 */
export function normalizeCodexApproval(request: CodexApprovalRequest): NormalizedAction {
  const params = request.raw
  switch (request.kind) {
    case 'command': {
      const command = str(params['command'])
      const cwd = str(params['cwd'])
      return {
        kind: 'bash',
        command: command === undefined ? null : unwrapShell(command),
        ...(cwd === undefined ? {} : { cwd })
      }
    }
    case 'file-change': {
      const paths = changedPaths(request.item)
      if (paths.length > 0) return { kind: 'edit', tool: 'Edit', paths }
      const grantRoot = str(params['grantRoot'])
      return {
        kind: 'edit',
        tool: 'Edit',
        paths: grantRoot === undefined ? [] : [grantRoot],
        unknownPaths: true
      }
    }
    case 'permissions': {
      const permissions = record(params['permissions'])
      const fileSystem = record(permissions?.['fileSystem'])
      const read = strings(fileSystem?.['read'])
      const write = strings(fileSystem?.['write'])
      const network = record(permissions?.['network'])?.['enabled']
      return {
        kind: 'permission',
        reason: str(params['reason']) ?? '',
        ...(read.length > 0 || write.length > 0
          ? {
              fileSystem: {
                ...(read.length > 0 ? { read } : {}),
                ...(write.length > 0 ? { write } : {})
              }
            }
          : {}),
        ...(typeof network === 'boolean' ? { network } : {})
      }
    }
    case 'mcp-elicitation': {
      const item = request.item
      const server = str(item?.['server']) ?? str(params['serverName']) ?? 'unknown'
      const tool = str(item?.['tool']) ?? toolFromMessage(str(params['message'])) ?? 'unknown'
      const hint = item?.['readOnlyHint']
      const args = record(item?.['arguments'])
      return {
        kind: 'mcp',
        server,
        tool,
        ...(args ? { args } : {}),
        readOnly: hint === true ? 'yes' : hint === false ? 'no' : 'unknown'
      }
    }
  }
}

/** `Allow the arc MCP server to run tool "echo"?` -> `echo`. */
function toolFromMessage(message: string | undefined): string | undefined {
  return message === undefined ? undefined : /run tool "([^"]+)"/.exec(message)?.[1]
}
