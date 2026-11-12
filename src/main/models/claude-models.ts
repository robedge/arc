import { mkdir } from 'node:fs/promises'
import type { ModelTier } from '@shared/types/provider'
import type { CommandProbe, RawModel } from '../agents/command-probe'
import { DEFAULT_WORKER_MODEL } from './claude-aliases'

/**
 * The Claude models come from the CLI's answer to `initialize` (the same no-model exchange the command
 * catalogue uses). The CLI lists its aliases (`opus`, `fable`, `sonnet`, `haiku`), which always point
 * at the latest version, then pinned full ids of older versions and a `default` entry. Arc offers the
 * aliases only: a pinned id can still be chosen by typing it, and `default` is one of the aliases.
 */

/** One Claude model in the shape the registry caches. */
export interface ClaudeModelInfo {
  /** The alias `--model` takes (`fable`). */
  model: string
  /** The CLI's name for it (`Fable 5.2`). */
  displayName: string
  /** Arc's default, `sonnet`; the CLI's own `default` entry is not Arc's choice. */
  isDefault: boolean
}

/** Where the registry gets the Claude models from. `ClaudeModelProbe` is the real one. */
export interface ClaudeModelSource {
  listModels(): Promise<ClaudeModelInfo[]>
}

/** True for a full model id the CLI lists next to its aliases (`claude-opus-4-8`). */
function isPinnedId(value: string): boolean {
  return value.toLowerCase().startsWith('claude-')
}

/** The CLI's list as the registry's entries: the aliases, in the CLI's order, each once. */
export function mapClaudeModels(raw: readonly RawModel[]): ClaudeModelInfo[] {
  const seen = new Set<string>()
  const out: ClaudeModelInfo[] = []
  for (const entry of raw) {
    const model = entry.value.toLowerCase()
    if (model === 'default' || isPinnedId(model) || seen.has(model)) continue
    seen.add(model)
    out.push({
      model,
      displayName: entry.displayName,
      isDefault: model === DEFAULT_WORKER_MODEL
    })
  }
  return out
}

/**
 * The tier of a Claude model by its family name: Haiku is fast, Opus and Fable are deep, anything
 * else (Sonnet, a family Arc does not know yet) is balanced.
 */
export function claudeTier(model: string): ModelTier {
  const name = model.toLowerCase()
  if (name.includes('haiku')) return 'fast'
  if (name.includes('opus') || name.includes('fable')) return 'deep'
  return 'balanced'
}

export interface ClaudeModelProbeDeps {
  probe: Pick<CommandProbe, 'listModels'>
  /** The empty folder the CLI is started in (`userData/claude-probe`), so no repository hooks run. */
  dir: string
}

/** Asks the Claude CLI for its models. Rejects when the CLI cannot be started or does not answer. */
export class ClaudeModelProbe implements ClaudeModelSource {
  constructor(private readonly deps: ClaudeModelProbeDeps) {}

  async listModels(): Promise<ClaudeModelInfo[]> {
    await mkdir(this.deps.dir, { recursive: true })
    return mapClaudeModels(await this.deps.probe.listModels(this.deps.dir))
  }
}
