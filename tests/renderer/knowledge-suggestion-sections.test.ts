import { expect, it } from 'vitest'
import { eligibleSuggestionSections } from '../../src/renderer/src/lib/knowledge-suggestions/sections'
import type { SectionKind } from '../../src/shared/sections'

const section = (id: string, kind: SectionKind, name: string) => ({ id, kind, name })

it('keeps Notes, Docs, Playbooks and custom sections and drops Projects and Links', () => {
  const all = [
    section('p', 'projects', 'Projects'),
    section('n', 'notes', 'Notes'),
    section('d', 'docs', 'Docs'),
    section('b', 'playbooks', 'Playbooks'),
    section('l', 'links', 'Links'),
    section('c', 'custom', 'Runbooks')
  ]
  expect(eligibleSuggestionSections(all).map((s) => s.id)).toEqual(['n', 'd', 'b', 'c'])
})

it('returns an empty list for no sections', () => {
  expect(eligibleSuggestionSections([])).toEqual([])
})
