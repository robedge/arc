import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTempDir } from '../helpers/temp-dir'
import { codeOf, createEnv } from './knowledge-test-env'
import type { KnowledgeEnv } from './knowledge-test-env'

const dir = useTempDir()
let env: KnowledgeEnv
let linksId: string

beforeEach(async () => {
  env = await createEnv(dir())
  const links = (await env.sections.list(env.groupId)).find((s) => s.kind === 'links')
  if (!links) throw new Error('no links section')
  linksId = links.id
})
afterEach(() => env.opened.sqlite.close())

const linkPath = (name: string): string => join(env.root, 'Links', name)

describe('links:upsert create', () => {
  it('writes Links/<title>.md with url/title front matter and lists it', async () => {
    const item = await env.service.upsertLink({
      sectionId: linksId,
      url: ' https://wiki.example.com/orders ',
      title: 'Orders wiki'
    })
    expect(await readFile(linkPath('Orders wiki.md'), 'utf8')).toBe(
      '---\nurl: "https://wiki.example.com/orders"\ntitle: "Orders wiki"\n---\n'
    )
    expect(item).toMatchObject({
      title: 'Orders wiki',
      url: 'https://wiki.example.com/orders',
      kind: 'link'
    })
    const listed = await env.service.list(linksId)
    expect(listed.map((i) => [i.title, i.url])).toEqual([
      ['Orders wiki', 'https://wiki.example.com/orders']
    ])
  })

  it('defaults the title to the address and sanitizes the file name', async () => {
    const url = 'https://wiki.example.com/orders'
    const item = await env.service.upsertLink({ sectionId: linksId, url })
    expect(item.title).toBe(url)
    const names = await readdir(join(env.root, 'Links'))
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^[^/:\\]+\.md$/)
    expect((await env.service.list(linksId))[0]?.title).toBe(url)
  })

  it.each(['wiki.example.com', 'ftp://x', 'javascript:alert(1)', 'file:///etc/passwd'])(
    'rejects %s with LINK_URL_INVALID',
    async (url) => {
      expect(await codeOf(env.service.upsertLink({ sectionId: linksId, url }))).toBe(
        'LINK_URL_INVALID'
      )
      expect(await readdir(join(env.root, 'Links'))).toEqual([])
    }
  )

  it('rejects other sections and over-long fields', async () => {
    const url = 'https://a.example.com'
    expect(await codeOf(env.service.upsertLink({ sectionId: env.notesId, url }))).toBe(
      'VALIDATION_FAILED'
    )
    expect(
      await codeOf(env.service.upsertLink({ sectionId: linksId, url, title: 'x'.repeat(101) }))
    ).toBe('VALIDATION_FAILED')
    expect(
      await codeOf(
        env.service.upsertLink({ sectionId: linksId, url, description: 'x'.repeat(201) })
      )
    ).toBe('VALIDATION_FAILED')
  })

  it('numbers colliding titles', async () => {
    const url = 'https://a.example.com'
    await env.service.upsertLink({ sectionId: linksId, url, title: 'Wiki' })
    await env.service.upsertLink({ sectionId: linksId, url, title: 'wiki' })
    expect(await readdir(join(env.root, 'Links'))).toContain('wiki (2).md')
  })
})

describe('links:upsert description and update', () => {
  it('stores the description in the body and returns it', async () => {
    const item = await env.service.upsertLink({
      sectionId: linksId,
      url: 'https://a.example.com',
      title: 'A',
      description: 'The A site'
    })
    expect(item.description).toBe('The A site')
    expect(await readFile(linkPath('A.md'), 'utf8')).toBe(
      '---\nurl: "https://a.example.com"\ntitle: "A"\n---\nThe A site'
    )
    expect((await env.service.list(linksId))[0]?.description).toBe('The A site')
  })

  it('updates url/title/description, renames the file and keeps the id', async () => {
    const first = await env.service.upsertLink({
      sectionId: linksId,
      url: 'https://a.example.com',
      title: 'A'
    })
    const next = await env.service.upsertLink({
      sectionId: linksId,
      itemId: first.id,
      url: 'https://b.example.com/x',
      title: 'B',
      description: 'now B'
    })
    expect(next).toMatchObject({
      id: first.id,
      title: 'B',
      url: 'https://b.example.com/x',
      description: 'now B'
    })
    expect(await readdir(join(env.root, 'Links'))).toEqual(['B.md'])
    expect(await env.service.list(linksId)).toHaveLength(1)
  })

  it('lists a link whose url was broken on disk, and items:delete removes it', async () => {
    const item = await env.service.upsertLink({
      sectionId: linksId,
      url: 'https://a.example.com',
      title: 'A'
    })
    await writeFile(linkPath('A.md'), '---\nurl: "nope"\ntitle: "A"\n---\n')
    const listed = await env.service.list(linksId)
    expect(listed.map((i) => i.url)).toEqual(['nope'])
    await env.service.delete(item.id)
    expect(await readdir(join(env.root, 'Links'))).toEqual([])
    expect(await env.service.list(linksId)).toEqual([])
  })

  it('refuses generic items:create in the Links section', async () => {
    expect(await codeOf(env.service.create(linksId, 'x'))).toBe('VALIDATION_FAILED')
  })
})
