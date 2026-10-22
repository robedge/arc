import { describe, expect, it, vi } from 'vitest'
import type { McpServerTools } from '../../../src/main/agents/agent-adapter'
import {
  McpToolCatalogue,
  isReadOnlyTool,
  parseClaudeMcpToolName
} from '../../../src/main/personal/mcp-tool-catalogue'
import type { NormalizedAction } from '../../../src/main/policy/normalized-action'

type McpAction = Extract<NormalizedAction, { kind: 'mcp' }>

const tool = (
  name: string,
  readOnly = false,
  destructive = false
): McpServerTools['tools'][number] => ({
  name,
  readOnly,
  destructive
})
const server = (
  name: string,
  tools: McpServerTools['tools'],
  connected = true
): McpServerTools => ({
  name,
  connected,
  tools
})

describe('the read-only rule', () => {
  it.each([
    ['readOnlyHint true', { readOnly: true, destructive: false }, true],
    ['readOnlyHint true and destructiveHint true', { readOnly: true, destructive: true }, false],
    ['no readOnlyHint (false or absent)', { readOnly: false, destructive: false }, false],
    ['destructiveHint only', { readOnly: false, destructive: true }, false]
  ])('%s', (_name, hints, expected) => {
    expect(isReadOnlyTool(hints)).toBe(expected)
  })
})

describe('parseClaudeMcpToolName', () => {
  it('finds the server among the known ones, however many underscores it has', () => {
    const servers = ['figma', 'my_server', 'my', 'plugin_x_y']
    expect(parseClaudeMcpToolName('mcp__figma__get_file', servers)).toEqual({
      server: 'figma',
      tool: 'get_file'
    })
    expect(parseClaudeMcpToolName('mcp__my_server__do__it', servers)).toEqual({
      server: 'my_server',
      tool: 'do__it'
    })
    expect(parseClaudeMcpToolName('mcp__plugin_x_y__run', servers)).toEqual({
      server: 'plugin_x_y',
      tool: 'run'
    })
  })

  it('matches a server whose name Claude rewrites (spaces and dots become underscores)', () => {
    expect(parseClaudeMcpToolName('mcp__my_srv_1__read', ['my srv.1'])).toEqual({
      server: 'my srv.1',
      tool: 'read'
    })
  })

  it('takes the longest server when two share a prefix', () => {
    expect(parseClaudeMcpToolName('mcp__a__b__c', ['a', 'a__b'])).toEqual({
      server: 'a__b',
      tool: 'c'
    })
  })

  it('is null for an unknown server, a name without a tool and a non-MCP tool', () => {
    expect(parseClaudeMcpToolName('mcp__other__thing', ['figma'])).toBeNull()
    expect(parseClaudeMcpToolName('mcp__figma__', ['figma'])).toBeNull()
    expect(parseClaudeMcpToolName('Bash', ['figma'])).toBeNull()
  })
})

describe('Claude tool calls', () => {
  const report = [
    server('fig_ma', [
      tool('figma_read', true),
      tool('figma_write'),
      tool('both', true, true),
      tool('destr', false, true)
    ]),
    server('down', [], false)
  ]

  function catalogue(
    list: () => Promise<McpServerTools[]> = () => Promise.resolve(report),
    options: ConstructorParameters<typeof McpToolCatalogue>[0] = {}
  ): {
    catalogue: McpToolCatalogue
    list: ReturnType<typeof vi.fn<() => Promise<McpServerTools[]>>>
  } {
    const fn = vi.fn(list)
    const c = new McpToolCatalogue(options)
    c.attach('a1', fn)
    return { catalogue: c, list: fn }
  }

  const call = (c: McpToolCatalogue, name: string): Promise<NormalizedAction | null> =>
    c.claudeAction('a1', name, { id: 'x' })

  it('runs only a tool that says readOnlyHint true and not destructiveHint true', async () => {
    const { catalogue: c } = catalogue()
    expect(await call(c, 'mcp__fig_ma__figma_read')).toEqual({
      kind: 'mcp',
      server: 'fig_ma',
      tool: 'figma_read',
      args: { id: 'x' },
      readOnly: 'yes'
    })
  })

  it('asks for a tool with no annotation, a destructive one and one both read-only and destructive', async () => {
    const { catalogue: c } = catalogue()
    expect(await call(c, 'mcp__fig_ma__figma_write')).toMatchObject({ readOnly: 'unknown' })
    expect(await call(c, 'mcp__fig_ma__destr')).toMatchObject({ readOnly: 'no' })
    expect(await call(c, 'mcp__fig_ma__both')).toMatchObject({ readOnly: 'no' })
  })

  it('asks for a tool the server does not list, and for any tool of a server that is down', async () => {
    const { catalogue: c } = catalogue()
    expect(await call(c, 'mcp__fig_ma__ghost')).toMatchObject({
      server: 'fig_ma',
      tool: 'ghost',
      readOnly: 'unknown'
    })
    expect(await call(c, 'mcp__down__anything')).toMatchObject({
      server: 'down',
      readOnly: 'unknown'
    })
  })

  it('asks when the agent cannot report its servers: it fails, hangs or is not attached', async () => {
    const failing = catalogue(() => Promise.reject(new Error('gone')))
    expect(await call(failing.catalogue, 'mcp__fig_ma__figma_read')).toMatchObject({
      kind: 'mcp',
      server: 'fig_ma',
      tool: 'figma_read',
      readOnly: 'unknown'
    })
    const hanging = catalogue(() => new Promise(() => undefined), { timeoutMs: 20 })
    expect(await call(hanging.catalogue, 'mcp__fig_ma__figma_read')).toMatchObject({
      readOnly: 'unknown'
    })
    expect(
      await new McpToolCatalogue().claudeAction('nobody', 'mcp__fig_ma__figma_read', {})
    ).toMatchObject({ kind: 'mcp', readOnly: 'unknown' })
  })

  it('asks for a server it has never heard of instead of letting it through', async () => {
    const { catalogue: c } = catalogue()
    expect(await call(c, 'mcp__stranger__do')).toMatchObject({
      kind: 'mcp',
      server: 'stranger',
      tool: 'do',
      readOnly: 'unknown'
    })
  })

  it('leaves Arc’s own tools and non-MCP tools alone', async () => {
    const { catalogue: c, list } = catalogue()
    expect(await call(c, 'mcp__arc__ask_brain')).toBeNull()
    expect(await call(c, 'Bash')).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('asks the agent once for several calls, and again only after the cache runs out', async () => {
    let now = 1_000
    const { catalogue: c, list } = catalogue(undefined, { now: () => now, cacheMs: 60_000 })
    await call(c, 'mcp__fig_ma__figma_read')
    await call(c, 'mcp__fig_ma__figma_read')
    expect(list).toHaveBeenCalledTimes(1)
    now += 61_000
    await call(c, 'mcp__fig_ma__figma_read')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('looks again when a tool is missing from an older report (a server may have connected since)', async () => {
    let now = 1_000
    let current = [server('fig_ma', [])]
    const { catalogue: c, list } = catalogue(() => Promise.resolve(current), { now: () => now })
    expect(await call(c, 'mcp__fig_ma__figma_read')).toMatchObject({ readOnly: 'unknown' })
    current = report
    now += 10_000
    expect(await call(c, 'mcp__fig_ma__figma_read')).toMatchObject({ readOnly: 'yes' })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('forgets a detached agent, and a detach of an older handle keeps the newer one', async () => {
    const c = new McpToolCatalogue()
    const first = c.attachHandle('a1', { mcpTools: () => Promise.resolve(report) })
    const second = c.attachHandle('a1', { mcpTools: () => Promise.resolve(report) })
    first()
    expect(await call(c, 'mcp__fig_ma__figma_read')).toMatchObject({ readOnly: 'yes' })
    second()
    expect(await call(c, 'mcp__fig_ma__figma_read')).toMatchObject({ readOnly: 'unknown' })
  })
})

describe('Codex tool approvals', () => {
  const base = (readOnly: McpAction['readOnly']): McpAction => ({
    kind: 'mcp',
    server: 'figma',
    tool: 'set_node',
    readOnly
  })
  const covered = new Set(['figma'])

  function catalogue(report: McpServerTools[] | Error): McpToolCatalogue {
    const c = new McpToolCatalogue()
    c.attach('a1', () =>
      report instanceof Error ? Promise.reject(report) : Promise.resolve(report)
    )
    return c
  }

  it('asks about a server Arc did not put into prompt mode, whatever the hint says', async () => {
    const c = catalogue([server('figma', [tool('set_node', true)])])
    expect(await c.codexAction('a1', base('yes'), new Set())).toMatchObject({ readOnly: 'unknown' })
    expect(await c.codexAction('a1', base('yes'), new Set(['other']))).toMatchObject({
      readOnly: 'unknown'
    })
  })

  it('keeps the item’s hint when the tool list agrees or cannot be read', async () => {
    const listed = catalogue([server('figma', [tool('set_node', true)])])
    expect(await listed.codexAction('a1', base('yes'), covered)).toMatchObject({ readOnly: 'yes' })
    const unreadable = catalogue(new Error('no answer'))
    expect(await unreadable.codexAction('a1', base('yes'), covered)).toMatchObject({
      readOnly: 'yes'
    })
    expect(await unreadable.codexAction('a1', base('unknown'), covered)).toMatchObject({
      readOnly: 'unknown'
    })
  })

  it('asks when the hint says read-only but the tool is also destructive', async () => {
    const c = catalogue([server('figma', [tool('set_node', true, true)])])
    expect(await c.codexAction('a1', base('yes'), covered)).toMatchObject({ readOnly: 'no' })
  })

  it('never runs a tool whose item says it changes something', async () => {
    const c = catalogue([server('figma', [tool('set_node', true)])])
    expect(await c.codexAction('a1', base('no'), covered)).toMatchObject({ readOnly: 'no' })
  })

  it('fills in a missing hint from the tool list (read-only), and asks when the list says it is not', async () => {
    const readOnly = catalogue([server('figma', [tool('set_node', true)])])
    expect(await readOnly.codexAction('a1', base('unknown'), covered)).toMatchObject({
      readOnly: 'yes'
    })
    const writing = catalogue([server('figma', [tool('set_node')])])
    expect(await writing.codexAction('a1', base('unknown'), covered)).toMatchObject({
      readOnly: 'unknown'
    })
    expect(await writing.codexAction('a1', base('yes'), covered)).toMatchObject({ readOnly: 'no' })
  })

  it('leaves Arc’s own server alone', async () => {
    const c = catalogue([])
    const own: McpAction = { kind: 'mcp', server: 'arc', tool: 'ask_brain', readOnly: 'unknown' }
    expect(await c.codexAction('a1', own, new Set())).toEqual(own)
  })
})
