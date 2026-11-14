import { describe, expect, it } from 'vitest'
import { cutText, requiresMet } from '../../../src/shared/surface'

const a = { '@path': '/a' }
const b = { '@path': '/b' }
const c = { '@path': '/c' }

describe('requiresMet', () => {
  it('is met without requirements', () => {
    expect(requiresMet(undefined, {})).toBe(true)
    expect(requiresMet([], {})).toBe(true)
  })

  it('needs a single path to hold text or a list', () => {
    expect(requiresMet([a], { a: 'x' })).toBe(true)
    expect(requiresMet([a], { a: ['x'] })).toBe(true)
    expect(requiresMet([a], {})).toBe(false)
    expect(requiresMet([a], { a: '' })).toBe(false)
  })

  it('treats whitespace-only text and an empty list as empty', () => {
    expect(requiresMet([a], { a: '  \n ' })).toBe(false)
    expect(requiresMet([a], { a: [] })).toBe(false)
  })

  it('needs every entry', () => {
    expect(requiresMet([a, b], { a: 'x', b: 'y' })).toBe(true)
    expect(requiresMet([a, b], { a: 'x' })).toBe(false)
  })

  it('accepts any one path of an alternative', () => {
    const req = [[b, c]]
    expect(requiresMet(req, { b: 'y' })).toBe(true)
    expect(requiresMet(req, { c: ['z'] })).toBe(true)
    expect(requiresMet(req, { b: ' ', c: [] })).toBe(false)
    expect(requiresMet([a, [b, c]], { a: 'x', c: 'z' })).toBe(true)
    expect(requiresMet([a, [b, c]], { c: 'z' })).toBe(false)
  })
})

describe('cutText', () => {
  it('leaves short text alone', () => {
    expect(cutText('a\nb', 10, 400)).toBeNull()
  })
  it('cuts by lines then characters', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')
    expect(cutText(lines, 10, 400)).toBe(lines.split('\n').slice(0, 10).join('\n') + '\n…')
    expect(cutText('x'.repeat(1000), 10, 400)).toBe('x'.repeat(400) + '\n…')
  })
})
