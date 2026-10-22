import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { estimateTokens } from '../../shared/types/agent-load'
import { splitFrontMatter } from '../knowledge/front-matter'

/**
 * What Claude lists per request for a skill, command or agent: its name and description (spec 009
 * tech spec 2.6). Read-only; only the front matter of the file is looked at.
 */

export interface Described {
  name?: string
  description?: string
}

const BLOCK_SCALAR = /^[>|][+-]?\d*$/

function unquote(value: string): string {
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1)
  }
  return value
}

/** The value of a front matter key, with folded (`>`), literal (`|`) and indented continuation lines joined by a space. */
export function frontMatterValue(lines: readonly string[], key: string): string | undefined {
  const start = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (start === -1) return undefined
  const first = (lines[start] ?? '').slice(key.length + 1).trim()
  const parts: string[] = BLOCK_SCALAR.test(first) || first === '' ? [] : [unquote(first)]
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() !== '' && !/^\s/.test(line)) break
    if (line.trim() !== '') parts.push(line.trim())
  }
  const joined = parts.join(' ').trim()
  return joined === '' ? undefined : joined
}

/** `name` and `description` of a markdown file's front matter; null when the file cannot be read. */
export async function describeMarkdown(path: string): Promise<Described | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const { lines } = splitFrontMatter(text)
  if (!lines) return {}
  const name = frontMatterValue(lines, 'name')
  const description = frontMatterValue(lines, 'description')
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) }
}

/** Tokens of a list of entries, one per line as Claude prints them. */
export function listingTokens(entries: readonly string[]): number {
  return estimateTokens(entries.reduce((n, e) => n + e.length + 1, 0))
}

export function listingEntry(name: string, description: string | undefined): string {
  return description ? `${name}: ${description}` : name
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** The skill folders of a `skills` directory: sub-folders (or links to them) that hold a `SKILL.md`. */
export async function skillFolders(skillsDir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue
    if (
      (await isDir(join(skillsDir, entry))) &&
      (await isFile(join(skillsDir, entry, 'SKILL.md')))
    ) {
      out.push(entry)
    }
  }
  return out
}

/** Every `*.md` below a folder as a path relative to it, nested folders included. */
export async function markdownFiles(root: string, prefix = ''): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await markdownFiles(root, rel)))
    else if (entry.name.endsWith('.md')) out.push(rel)
  }
  return out
}
