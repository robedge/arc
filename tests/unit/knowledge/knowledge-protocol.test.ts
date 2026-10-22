import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveKnowledgeRequest } from '../../../src/main/protocol/knowledge-request'
import type { KnowledgeRequestDeps } from '../../../src/main/protocol/knowledge-request'
import { useTempDir } from '../helpers/temp-dir'
import { createEnv } from './knowledge-test-env'
import type { KnowledgeEnv } from './knowledge-test-env'

const dir = useTempDir()
let env: KnowledgeEnv
let docsId: string
let deps: KnowledgeRequestDeps

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8)
])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')

beforeEach(async () => {
  env = await createEnv(dir())
  const docs = (await env.sections.list(env.groupId)).find((s) => s.kind === 'docs')
  if (!docs) throw new Error('no docs section')
  docsId = docs.id
  deps = {
    getItem: (id) => env.itemsRepo.getById(id),
    getKnowledgeRoot: () => env.root
  }
})
afterEach(() => env.opened.sqlite.close())

async function importFile(name: string, content: Buffer | string): Promise<string> {
  const src = join(dir(), 'src')
  await mkdir(src, { recursive: true })
  const path = join(src, name)
  await writeFile(path, content)
  const report = await env.service.importFiles(docsId, [path])
  const id = report.added[0]?.id
  if (!id) throw new Error(`import failed: ${JSON.stringify(report.failed)}`)
  return id
}

const get = (url: string, method = 'GET') => resolveKnowledgeRequest({ method, url }, deps)
const urlFor = (groupId: string, itemId: string): string =>
  `harness-knowledge://${groupId.toLowerCase()}/${itemId}?rev=1`

describe('resolveKnowledgeRequest', () => {
  it('serves a png with its type and nosniff', async () => {
    const id = await importFile('pic.png', PNG)
    const res = await get(urlFor(env.groupId, id))
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('image/png')
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(res.filePath).toBe(join(env.root, 'Docs', 'pic.png'))
  })

  it('serves svg with a sandbox CSP', async () => {
    const id = await importFile('logo.svg', SVG)
    const res = await get(urlFor(env.groupId, id))
    expect(res.status).toBe(200)
    expect(res.headers['Content-Security-Policy']).toContain('sandbox')
  })

  it('never serves a text item', async () => {
    const id = await importFile('schema.sql', 'select 1;')
    expect((await get(urlFor(env.groupId, id))).status).toBe(404)
  })

  it('404s an unknown item', async () => {
    expect((await get(urlFor(env.groupId, '01ARZ3NDEKTSV4RRFFQ69G5FAV'))).status).toBe(404)
  })

  it('404s an item requested through another group', async () => {
    const id = await importFile('pic.png', PNG)
    expect((await get(urlFor('01ARZ3NDEKTSV4RRFFQ69G5FAV', id))).status).toBe(404)
  })

  it('refuses non-GET methods', async () => {
    const id = await importFile('pic.png', PNG)
    expect((await get(urlFor(env.groupId, id), 'POST')).status).not.toBe(200)
  })

  it.each(['harness-knowledge://abc/../x', 'harness-knowledge://../..', 'not a url'])(
    'rejects malformed url %s',
    async (url) => {
      expect((await get(url)).status).toBe(404)
    }
  )

  it('404s an item whose file is a symlink pointing outside the root', async () => {
    const id = await importFile('pic.png', PNG)
    const outside = join(dir(), 'outside.png')
    await writeFile(outside, PNG)
    await rm(join(env.root, 'Docs', 'pic.png'))
    await symlink(outside, join(env.root, 'Docs', 'pic.png'))
    const res = await get(urlFor(env.groupId, id))
    expect(res.status).toBe(404)
  })
})
