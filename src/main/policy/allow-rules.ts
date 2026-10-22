import { dirname, sep } from 'node:path'
import { commandPrefix } from './classify'
import type { Classification, PolicyCategory } from './classify'

/**
 * A session-scoped "always allow" rule (functional spec 2.7). It is derived from the request the
 * user approved: the same category and tool, the same normalized command prefix and, for a change
 * outside the working copy, the folder the target sits in (the rule covers that folder and below).
 */
export interface AllowRuleSpec {
  category: PolicyCategory
  tool: string
  /** `git push`, `curl`, ... for Bash; empty for the file tools. */
  prefix: string
  /** Set for outside-working-copy requests; the rule covers this folder and below. */
  folder: string | null
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** The deepest folder that holds every target. */
function commonFolder(paths: readonly string[]): string {
  const folders = paths.map((p) => dirname(p))
  let common = folders[0] ?? sep
  for (const folder of folders.slice(1)) {
    while (!isInside(folder, common)) {
      const parent = dirname(common)
      if (parent === common) break
      common = parent
    }
  }
  return common
}

function prefixOf(tool: string, input: Record<string, unknown>): string {
  const command = input['command']
  return tool === 'Bash' && typeof command === 'string' ? commandPrefix(command) : ''
}

/** `mcp__<server>__<tool>` with both parts present and no wildcard. */
function isExactMcpToolName(tool: string): boolean {
  return /^mcp__.+__[^*]+$/.test(tool) && !tool.includes('*')
}

/** The rule "always allow this" stands for, or null when the request is too broad to remember (a target at the root). */
export function deriveAllowRule(
  tool: string,
  input: Record<string, unknown>,
  verdict: Classification
): AllowRuleSpec | null {
  if (verdict.category === null) return null
  // More access than the sandbox gives is decided each time, never remembered.
  if (verdict.category === 'extra_permissions') return null
  // An MCP tool is remembered by its exact name, never as a whole server: `mcp__server` or
  // `mcp__server__*` would let every other tool of that server through.
  if (tool.startsWith('mcp__') && !isExactMcpToolName(tool)) return null
  let folder: string | null = null
  if (verdict.category === 'outside_worktree') {
    if (verdict.paths.length === 0) return null
    folder = commonFolder(verdict.paths)
    if (dirname(folder) === folder) return null
  }
  return { category: verdict.category, tool, prefix: prefixOf(tool, input), folder }
}

/** What the user reads for a rule: `git push`, `mkdir in /opt/app`, `Write in /srv/out`. */
export function allowRuleText(rule: AllowRuleSpec): string {
  const what = rule.prefix === '' ? rule.tool : rule.prefix
  return rule.folder === null ? what : `${what} in ${rule.folder}`
}

export function allowRuleMatches(
  rule: AllowRuleSpec,
  tool: string,
  input: Record<string, unknown>,
  verdict: Classification
): boolean {
  if (verdict.category !== rule.category || tool !== rule.tool) return false
  if (prefixOf(tool, input) !== rule.prefix) return false
  if (rule.folder === null) return true
  const folder = rule.folder
  return verdict.paths.length > 0 && verdict.paths.every((p) => isInside(p, folder))
}
