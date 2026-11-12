import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROTECTED_PREFIXES } from '../protected-commands'
import { excludeFromGit } from '../worktree-git'

/**
 * `<worktree>/.codex/rules/arc.rules`: `prompt` rules for the commands Arc's classifier protects
 * (tech spec section 5, spike S2). Codex skips both its approval and its sandbox for a command that
 * a rule in the user's own `~/.codex/rules` allows, and the app-server cannot be told to ignore
 * rules. A `prompt` rule beats an `allow` rule and loads without the project being trusted, so a
 * Codex worker still asks Arc before it pushes, deletes, installs globally or reaches the network,
 * whatever the user's own rules say. Arc then decides, with its classifier, whether anyone is asked.
 */
/** The rules file, one `prompt` rule per protected prefix. */
export function arcRulesText(): string {
  const lines = [
    '# Written by Arc each time it starts this working copy. Edits are overwritten.',
    '# These rules make Codex ask Arc before a protected command, even where your own rules allow it.',
    ...PROTECTED_PREFIXES.map(
      (prefix) => `prefix_rule(pattern=${JSON.stringify(prefix)}, decision="prompt")`
    )
  ]
  return lines.join('\n') + '\n'
}

/** Where the rules live inside a working copy. */
export const ARC_RULES_RELATIVE_PATH = join('.codex', 'rules', 'arc.rules')

/** The line that keeps the rules file out of commits and out of Review changes. */
export const EXCLUDE_LINE = '.codex/'

/**
 * Writes `arc.rules` into a working copy and excludes it from git. Idempotent: a launch and a
 * relaunch both call it. It throws when the file cannot be written, so a worker never starts
 * without Arc's rules.
 */
export function writeArcRules(worktree: string): void {
  const file = join(worktree, ARC_RULES_RELATIVE_PATH)
  const text = arcRulesText()
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text)
  excludeFromGit(worktree, EXCLUDE_LINE)
}
