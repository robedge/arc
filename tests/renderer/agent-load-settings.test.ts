import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import type {
  AgentLoadOff,
  CodexLoadData,
  CursorLoadData,
  LoadCatalogueData
} from '../../src/shared/types/agent-load'
import type { AppSettings } from '../../src/shared/types/provider'
import AgentLoadSettings from '../../src/renderer/src/lib/components/settings/AgentLoadSettings.svelte'
import SettingsView from '../../src/renderer/src/lib/components/settings/SettingsView.svelte'
import { agentLoad } from '../../src/renderer/src/lib/stores/agent-load.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import { ui } from '../../src/renderer/src/lib/stores/ui.svelte'
import { mockHarness } from './helpers'

const CATALOGUE: LoadCatalogueData = {
  items: [
    {
      key: 'mcp:figma',
      kind: 'mcp',
      label: 'figma',
      detail: 'Your servers',
      tokens: 1200,
      note: 'Tool names only'
    },
    { key: 'mcp:trello', kind: 'mcp', label: 'trello', detail: 'Your servers', tokens: null },
    {
      key: 'plugin:alpha@m',
      kind: 'plugin',
      label: 'alpha',
      detail: 'alpha@m',
      tokens: 3000,
      note: "Its hooks' output is not counted"
    },
    {
      key: 'skill:planning',
      kind: 'skill',
      label: 'planning',
      detail: '~/.claude/skills',
      tokens: 40
    },
    {
      key: 'hook:SessionStart',
      kind: 'hook',
      label: 'SessionStart',
      detail: '~/.claude/settings.json',
      tokens: null,
      note: "What a hook adds (for example a SessionStart hook's text) can't be estimated"
    }
  ]
}

const CODEX: CodexLoadData = {
  state: 'ok',
  items: [
    {
      key: 'codex-mcp:figma',
      kind: 'codex-mcp',
      label: 'figma',
      detail: 'Your Codex configuration',
      tokens: null
    }
  ]
}

const CURSOR: CursorLoadData = {
  state: 'ok',
  items: [
    {
      key: 'cursor-mcp:shadowme',
      kind: 'cursor-mcp',
      label: 'shadowme',
      detail: '~/.cursor/mcp.json',
      tokens: 500
    }
  ]
}

let cursor: CursorLoadData
let catalogue: LoadCatalogueData
let codex: CodexLoadData
let stored: AgentLoadOff
let saved: unknown[]

function appSettings(): AppSettings {
  return {
    'providers.brain': { provider: 'claude', model: 'sonnet' },
    'providers.workers': { mode: 'auto' },
    'usage.checkClaudePlanOnLaunch': true,
    'agents.loadOff': stored
  }
}

beforeEach(() => {
  catalogue = CATALOGUE
  codex = CODEX
  cursor = CURSOR
  stored = { brain: [], workers: [] }
  saved = []
  agentLoad.reset()
  settings.reset()
  mockHarness((channel, request) => {
    if (channel === 'agent-load:get') return { ok: true, data: catalogue }
    if (channel === 'agent-load:codex') return { ok: true, data: codex }
    if (channel === 'agent-load:cursor') return { ok: true, data: cursor }
    if (channel === 'settings:get') return { ok: true, data: appSettings() }
    if (channel === 'settings:set') {
      // The IPC clones the request: reactive proxies in it would throw there.
      saved.push(structuredClone(request))
      stored = (request as { 'agents.loadOff': AgentLoadOff })['agents.loadOff']
      return { ok: true, data: appSettings() }
    }
    return { ok: true, data: {} }
  })
})
afterEach(cleanup)

const total = (role: 'brain' | 'workers'): string =>
  document.querySelector(`[data-load-total="${role}"]`)!.textContent!.replace(/\s+/g, ' ').trim()

async function ready(): Promise<void> {
  render(AgentLoadSettings)
  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'figma, MCP server, Brain' })).toBeTruthy()
  )
}

it('groups the items and shows a Brain and a Workers switch on every row, all on', async () => {
  await ready()
  for (const heading of [
    'MCP servers',
    'Plugins',
    'Skills',
    'Hooks',
    'Codex MCP servers',
    'Cursor MCP servers'
  ]) {
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
  }
  const switches = screen.getAllByRole('switch') as HTMLInputElement[]
  expect(switches).toHaveLength(
    (CATALOGUE.items.length + CODEX.items.length + CURSOR.items.length) * 2
  )
  expect(switches.every((s) => s.checked)).toBe(true)
  expect(screen.getByRole('switch', { name: 'alpha, Plugin, Workers' })).toBeTruthy()
})

it('orders the switches row by row, Brain first, so the keyboard walks them in that order', async () => {
  await ready()
  const names = (screen.getAllByRole('switch') as HTMLInputElement[]).map((s) =>
    s.labels?.[0]?.textContent?.trim()
  )
  expect(names.slice(0, 4)).toEqual([
    'figma, MCP server, Brain',
    'figma, MCP server, Workers',
    'trello, MCP server, Brain',
    'trello, MCP server, Workers'
  ])
})

it('shows each size as about N tokens per request, or size unknown, and the hook note', async () => {
  await ready()
  const figma = document.querySelector('[data-load-item="mcp:figma"]')!
  expect(figma.textContent).toContain('about 1.2k tokens per request')
  expect(figma.textContent).toContain('Tool names only')
  expect(figma.querySelector('[data-load-size]')!.getAttribute('title')).toBe('1,200 tokens')
  expect(document.querySelector('[data-load-item="mcp:trello"]')!.textContent).toContain(
    'size unknown'
  )
  expect(document.querySelector('[data-load-item="hook:SessionStart"]')!.textContent).toContain(
    "can't be estimated"
  )
})

it('totals each column over the items that are on, and counts the ones without a size', async () => {
  await ready()
  // 1200 + 3000 + 40 on both; three items have no size (trello, the hook, the Codex server); Cursor adds 500.
  expect(total('brain')).toBe('Brain: about 4.7k tokens per request, plus 3 items of unknown size')
  expect(total('workers')).toBe(
    'Workers: about 4.7k tokens per request, plus 3 items of unknown size'
  )
})

it('switching an item off for Workers saves only the off item and lowers only that total', async () => {
  await ready()
  await fireEvent.click(screen.getByRole('switch', { name: 'alpha, Plugin, Workers' }))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]).toEqual({ 'agents.loadOff': { brain: [], workers: ['plugin:alpha@m'] } })
  await waitFor(() =>
    expect(total('workers')).toBe(
      'Workers: about 1.7k tokens per request, plus 3 items of unknown size'
    )
  )
  expect(total('brain')).toBe('Brain: about 4.7k tokens per request, plus 3 items of unknown size')
  expect(
    (screen.getByRole('switch', { name: 'alpha, Plugin, Brain' }) as HTMLInputElement).checked
  ).toBe(true)
  expect(
    (screen.getByRole('switch', { name: 'alpha, Plugin, Workers' }) as HTMLInputElement).checked
  ).toBe(false)
})

it('switching it back on removes it from the stored list', async () => {
  stored = { brain: ['skill:planning'], workers: ['plugin:alpha@m', 'mcp:figma'] }
  await ready()
  expect(
    (screen.getByRole('switch', { name: 'alpha, Plugin, Workers' }) as HTMLInputElement).checked
  ).toBe(false)
  await fireEvent.click(screen.getByRole('switch', { name: 'alpha, Plugin, Workers' }))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]).toEqual({
    'agents.loadOff': { brain: ['skill:planning'], workers: ['mcp:figma'] }
  })
})

it('keeps a stored key whose item is gone', async () => {
  stored = { brain: [], workers: ['mcp:uninstalled'] }
  await ready()
  await fireEvent.click(screen.getByRole('switch', { name: 'figma, MCP server, Brain' }))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]).toEqual({
    'agents.loadOff': { brain: ['mcp:figma'], workers: ['mcp:uninstalled'] }
  })
})

it('says when changes apply, that commands leave the list, and what is always loaded', async () => {
  await ready()
  const page = document.querySelector('[data-agent-load]')!.textContent!
  expect(page).toContain('Changes apply to agents started afterwards')
  expect(page).toContain('resumed agent')
  expect(page).toContain('removes its commands from Arc')
  expect(page).toContain("Arc's own tools are always loaded")
  expect(page).toContain('~/.claude/agents')
  expect(page).toContain('~/.claude/commands')
})

it('explains why the Codex group is empty', async () => {
  codex = { items: [], state: 'unavailable' }
  render(AgentLoadSettings)
  await waitFor(() => expect(screen.getByText(/Codex isn.t set up/)).toBeTruthy())
  cleanup()
  agentLoad.reset()
  codex = { items: [], state: 'unreadable' }
  render(AgentLoadSettings)
  await waitFor(() => expect(screen.getByText(/couldn.t read your Codex servers/)).toBeTruthy())
})

it('shows the Claude items while Codex is still starting, then adds the Codex servers', async () => {
  let release: (data: CodexLoadData) => void = () => undefined
  const pending = new Promise<CodexLoadData>((resolve) => (release = resolve))
  mockHarness(async (channel) => {
    if (channel === 'agent-load:get') return { ok: true, data: catalogue }
    if (channel === 'agent-load:codex') return { ok: true, data: await pending }
    return { ok: true, data: appSettings() }
  })
  render(AgentLoadSettings)
  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'trello, MCP server, Brain' })).toBeTruthy()
  )
  expect(screen.getByText(/Loading Codex servers/)).toBeTruthy()
  expect(screen.queryByRole('switch', { name: 'figma, Codex MCP server, Brain' })).toBeNull()
  release(CODEX)
  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'figma, Codex MCP server, Brain' })).toBeTruthy()
  )
})

it('lists Cursor servers with named switches and saves cursor-mcp keys', async () => {
  await ready()
  const group = document.querySelector('[data-load-group="cursor-mcp"]')!
  expect(
    within(group as HTMLElement).getByRole('heading', { name: 'Cursor MCP servers' })
  ).toBeTruthy()
  expect(group.textContent).toContain('~/.cursor/mcp.json')
  expect(screen.getByRole('switch', { name: 'shadowme, Cursor MCP server, Brain' })).toBeTruthy()
  await fireEvent.click(
    screen.getByRole('switch', { name: 'shadowme, Cursor MCP server, Workers' })
  )
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]).toEqual({ 'agents.loadOff': { brain: [], workers: ['cursor-mcp:shadowme'] } })
  await waitFor(() =>
    expect(total('workers')).toBe(
      'Workers: about 4.2k tokens per request, plus 3 items of unknown size'
    )
  )
  expect(total('brain')).toBe('Brain: about 4.7k tokens per request, plus 3 items of unknown size')
  const codexGroup = document.querySelector('[data-load-group="codex-mcp"]')!
  expect(
    (
      within(codexGroup as HTMLElement).getByRole('switch', {
        name: 'figma, Codex MCP server, Workers'
      }) as HTMLInputElement
    ).checked
  ).toBe(true)
})

it('orders the Cursor group after the Codex group', async () => {
  await ready()
  const kinds = [...document.querySelectorAll('[data-load-group]')].map((g) =>
    g.getAttribute('data-load-group')
  )
  expect(kinds.slice(-2)).toEqual(['codex-mcp', 'cursor-mcp'])
})

it('explains why the Cursor group is empty, and says so when there are no servers', async () => {
  for (const [state, text] of [
    ['unavailable', /Cursor isn.t set up, so its servers can.t be listed/],
    ['unreadable', /couldn.t read your Cursor servers/],
    ['ok', /No Cursor MCP servers/]
  ] as const) {
    cursor = { items: [], state }
    render(AgentLoadSettings)
    await waitFor(() => expect(screen.getByText(text)).toBeTruthy())
    // The Codex group is untouched by Cursor's state.
    expect(screen.getByRole('switch', { name: 'figma, Codex MCP server, Brain' })).toBeTruthy()
    cleanup()
    agentLoad.reset()
  }
})

it('shows the Cursor group loading without holding back Codex or Claude', async () => {
  let release: (data: CursorLoadData) => void = () => undefined
  const pending = new Promise<CursorLoadData>((resolve) => (release = resolve))
  mockHarness(async (channel) => {
    if (channel === 'agent-load:get') return { ok: true, data: catalogue }
    if (channel === 'agent-load:codex') return { ok: true, data: codex }
    if (channel === 'agent-load:cursor') return { ok: true, data: await pending }
    return { ok: true, data: appSettings() }
  })
  render(AgentLoadSettings)
  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'figma, Codex MCP server, Brain' })).toBeTruthy()
  )
  expect(screen.getByText(/Loading Cursor servers/)).toBeTruthy()
  release(CURSOR)
  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'shadowme, Cursor MCP server, Brain' })).toBeTruthy()
  )
})

it('shows an error and no switches when the list cannot be loaded', async () => {
  mockHarness((channel) =>
    channel === 'agent-load:get'
      ? { ok: false, error: { code: 'INTERNAL' } }
      : { ok: true, data: appSettings() }
  )
  render(AgentLoadSettings)
  await waitFor(() => expect(screen.getByText(/Couldn.t list what agents load/)).toBeTruthy())
  expect(screen.queryAllByRole('switch')).toHaveLength(0)
})

it('opens on this page from the settings navigation and from ui.openSettings', async () => {
  ui.openSettings('agent-load')
  render(SettingsView)
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Agent loading' })).toBeTruthy())
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  expect(nav.getByRole('button', { name: 'Agent loading' }).getAttribute('aria-current')).toBe(
    'page'
  )
  ui.openSettings()
  expect(ui.settingsPage).toBe('providers')
})
