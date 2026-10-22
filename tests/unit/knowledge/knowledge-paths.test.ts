import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  resolveInRoot,
  sanitizeName,
  uniqueName
} from '../../../src/main/knowledge/knowledge-paths'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()
let root: string

beforeEach(async () => {
  root = join(dir(), 'root')
  await mkdir(join(root, 'Notes'), { recursive: true })
})

describe('resolveInRoot', () => {
  it.each([['..'], ['../x'], ['a/b'], ['a\\b'], [''], ['.'], ['.hidden'], ['a\u0000b']])(
    'rejects %j',
    async (segment) => {
      await expect(resolveInRoot(root, [segment])).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_ROOT'
      })
    }
  )

  it('rejects an empty segment list', async () => {
    await expect(resolveInRoot(root, [])).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' })
  })

  it('accepts normal names, including a leaf that does not exist yet', async () => {
    expect(await resolveInRoot(root, ['Notes'])).toBe(join(root, 'Notes'))
    expect(await resolveInRoot(root, ['Notes', 'a.md'])).toBe(join(root, 'Notes', 'a.md'))
    expect(await resolveInRoot(root, ['New Section'])).toBe(join(root, 'New Section'))
  })

  it('allows .harness only with the option', async () => {
    await expect(resolveInRoot(root, ['.arc'])).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT'
    })
    expect(await resolveInRoot(root, ['.arc', 'meta.json'], { allowMetaDir: true })).toBe(
      join(root, '.arc', 'meta.json')
    )
    await expect(resolveInRoot(root, ['.other'], { allowMetaDir: true })).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT'
    })
  })

  it('rejects a symlink inside the root that points outside', async () => {
    const outside = join(dir(), 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'x')
    await symlink(outside, join(root, 'escape'))
    await expect(resolveInRoot(root, ['escape', 'secret.txt'])).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT'
    })
    await expect(resolveInRoot(root, ['escape', 'new', 'file.md'])).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT'
    })
  })

  it('reports a missing root', async () => {
    await expect(resolveInRoot(join(dir(), 'nope'), ['a'])).rejects.toMatchObject({
      code: 'KNOWLEDGE_ROOT_MISSING'
    })
  })
})

describe('sanitizeName', () => {
  it.each([
    ['Runbooks', 'Runbooks'],
    ['a/b:c\\d', 'abcd'],
    ['a\u0000b\u0007c', 'abc'],
    ['...hidden', 'hidden'],
    ['name. . ', 'name'],
    ['  many   spaces  ', 'many spaces'],
    ['Café', 'Café'],
    ['///', ''],
    ['...', ''],
    ['', '']
  ])('%j -> %j', (raw, expected) => {
    expect(sanitizeName(raw)).toBe(expected)
  })
})

describe('uniqueName', () => {
  it('returns the desired name when free', () => {
    expect(uniqueName(['a.md'], 'b.md')).toBe('b.md')
  })

  it('suffixes before the extension, case-insensitively', () => {
    expect(uniqueName(['Orders_Schema.sql'], 'orders_schema.sql')).toBe('orders_schema (2).sql')
  })

  it('continues to (3) and beyond', () => {
    expect(uniqueName(['a.sql', 'A (2).sql'], 'a.sql')).toBe('a (3).sql')
  })

  it('handles names without an extension', () => {
    expect(uniqueName(['Runbooks'], 'runbooks')).toBe('runbooks (2)')
    expect(uniqueName(['x', 'x (2)'], 'x')).toBe('x (3)')
  })

  it('compares NFC-normalized', () => {
    expect(uniqueName(['Café'], 'Café')).toBe('Café (2)')
  })
})
