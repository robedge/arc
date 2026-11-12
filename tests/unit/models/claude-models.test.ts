import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ClaudeModelProbe,
  claudeTier,
  mapClaudeModels
} from '../../../src/main/models/claude-models'

// The list the real CLI 2.1.322 sent in its `initialize` answer, trimmed to the fields Arc reads.
const CLI_LIST = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5' },
  { value: 'opus', displayName: 'Opus 5.5', description: '' },
  { value: 'fable', displayName: 'Fable 5.2', description: '' },
  { value: 'sonnet', displayName: 'Sonnet 5.5', description: '' },
  { value: 'haiku', displayName: 'Haiku 5.5', description: '' },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: '' },
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' }
]

describe('mapClaudeModels', () => {
  it('keeps the aliases in the CLI order, drops default and pinned ids, and marks sonnet default', () => {
    expect(mapClaudeModels(CLI_LIST)).toEqual([
      { model: 'opus', displayName: 'Opus 5.5', isDefault: false },
      { model: 'fable', displayName: 'Fable 5.2', isDefault: false },
      { model: 'sonnet', displayName: 'Sonnet 5.5', isDefault: true },
      { model: 'haiku', displayName: 'Haiku 5.5', isDefault: false }
    ])
  })

  it('lists an alias once, in lower case', () => {
    expect(
      mapClaudeModels([
        { value: 'Opus', displayName: 'Opus', description: '' },
        { value: 'opus', displayName: 'Opus again', description: '' }
      ])
    ).toEqual([{ model: 'opus', displayName: 'Opus', isDefault: false }])
  })
})

describe('claudeTier', () => {
  it.each([
    ['haiku', 'fast'],
    ['claude-haiku-5-5', 'fast'],
    ['opus', 'deep'],
    ['fable', 'deep'],
    ['claude-fable-5-2', 'deep'],
    ['sonnet', 'balanced'],
    ['nova', 'balanced']
  ] as const)('%s is %s', (model, tier) => {
    expect(claudeTier(model)).toBe(tier)
  })
})

describe('ClaudeModelProbe', () => {
  it('asks in its own folder, creating it, and maps the answer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'arc-claude-models-'))
    try {
      const folder = join(root, 'claude-probe')
      const asked: string[] = []
      const probe = new ClaudeModelProbe({
        probe: {
          listModels: (cwd) => {
            asked.push(cwd)
            return Promise.resolve(CLI_LIST)
          }
        },
        dir: folder
      })
      expect((await probe.listModels()).map((m) => m.model)).toEqual([
        'opus',
        'fable',
        'sonnet',
        'haiku'
      ])
      expect(asked).toEqual([folder])
      expect(statSync(folder).isDirectory()).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
