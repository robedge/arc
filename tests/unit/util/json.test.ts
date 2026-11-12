import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  asRecord,
  isRecord,
  nonBlankString,
  nonEmptyString,
  oneLine,
  parseJsonObject,
  readJsonFile,
  recordOrUndefined,
  stringArray
} from '../../../src/main/util/json'

describe('guards', () => {
  it('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  it('asRecord and recordOrUndefined narrow or fall back', () => {
    const value = { a: 1 }
    expect(asRecord(value)).toBe(value)
    expect(asRecord([1])).toEqual({})
    expect(recordOrUndefined(value)).toBe(value)
    expect(recordOrUndefined(3)).toBeUndefined()
  })

  it('the string guards differ only on whitespace', () => {
    expect(nonEmptyString('a')).toBe('a')
    expect(nonEmptyString('')).toBeUndefined()
    expect(nonEmptyString(' ')).toBe(' ')
    expect(nonBlankString(' ')).toBeUndefined()
    expect(nonBlankString(' a ')).toBe(' a ')
    expect(nonBlankString(4)).toBeUndefined()
  })

  it('stringArray keeps the strings of an array', () => {
    expect(stringArray(['a', 1, 'b', null])).toEqual(['a', 'b'])
    expect(stringArray('a')).toEqual([])
  })
})

describe('parseJsonObject', () => {
  it('returns objects and nothing else', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObject('[1]')).toBeUndefined()
    expect(parseJsonObject('3')).toBeUndefined()
    expect(parseJsonObject('null')).toBeUndefined()
    expect(parseJsonObject('not json')).toBeUndefined()
  })
})

describe('oneLine', () => {
  it('collapses whitespace', () => {
    expect(oneLine('  a \n\n b\tc ', 20)).toBe('a b c')
  })

  it('cuts to max characters with an ellipsis', () => {
    expect(oneLine('abcdefghij', 5)).toBe('abcd…')
    expect(oneLine('abcde', 5)).toBe('abcde')
  })
})

describe('readJsonFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'arc-json-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('parses a file', async () => {
    writeFileSync(join(dir, 'a.json'), '{"a":1}')
    expect(await readJsonFile(join(dir, 'a.json'))).toEqual({ a: 1 })
  })

  it('returns undefined without a warning for a missing file', async () => {
    const log = { warn: vi.fn() }
    expect(await readJsonFile(join(dir, 'none.json'), log)).toBeUndefined()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('warns, naming the file but not its contents, for a malformed file', async () => {
    const path = join(dir, 'bad.json')
    writeFileSync(path, '{"token": "s3cret",')
    const log = { warn: vi.fn() }
    expect(await readJsonFile(path, log)).toBeUndefined()
    expect(log.warn).toHaveBeenCalledOnce()
    const message = String(log.warn.mock.calls[0]?.[0])
    expect(message).toContain(path)
    expect(message).not.toContain('s3cret')
  })

  it('warns for a path that cannot be read as a file', async () => {
    const log = { warn: vi.fn() }
    expect(await readJsonFile(dir, log)).toBeUndefined()
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('is silent without a log', async () => {
    writeFileSync(join(dir, 'bad.json'), '{')
    expect(await readJsonFile(join(dir, 'bad.json'))).toBeUndefined()
  })
})
