// Express text in, a stored surface out.
import { beforeAll, describe, expect, it } from 'vitest'
import { showSurfaceTool } from '../../src/main/bridge/tools/show-surface'
import { compileExpress, componentSignatures, ExpressError } from '../../src/main/surface/express'

const DASHBOARD = `
$/reviews = [{label: "Sarah Chen", value: 18}, {label: "Elena Rostova", value: 15}, {label: "Marcus Vance", value: 12}]
$/trend = [{label: "Mon", value: 40}, {label: "Tue", value: 62}, {label: "Wed", value: 51}]
$/note = ""
kpi_commits = Stat("Weekly Commits", "342", "+18%", "up", "vs 290 prior week", "positive")
kpi_prs = Stat("Open PRs", "19", "-4", "down", "5 awaiting initial review", "info")
kpis = Grid([kpi_commits, kpi_prs], columns=2)
chart = BarChart("Code Reviews Completed (7d)", "Per contributor", $/reviews, "reviews")
ping = Button(Text("Ping Reviewers"), Event("ping", {note: $/note}), "primary")
alert = Callout("Review Bottleneck Alert", "3 pull requests have waited over 24 hours.", "warning", ping)
table = Table(["PR", "Age"], [["#412 retry", "31h"], ["#409 cache", "26h"]])
root = Column([Text("Engineering", "h2"), kpis, chart, LineChart("Commits per day", data=$/trend), alert, Row([Badge("19 Open", "info")]), table, TextField("Note", $/note)])
`

describe('compileExpress', () => {
  it('compiles a dashboard into flat components and a data model', () => {
    const surface = compileExpress('eng', DASHBOARD)
    expect(surface.surfaceId).toBe('eng')
    const kinds = new Set(surface.components.map((c) => c.component))
    for (const kind of [
      'Column',
      'Grid',
      'Stat',
      'BarChart',
      'LineChart',
      'Callout',
      'Badge',
      'Table',
      'TextField',
      'Button'
    ]) {
      expect(kinds.has(kind), kind).toBe(true)
    }
    const chart = surface.components.find((c) => c.component === 'BarChart')
    expect(chart?.['data']).toEqual({ '@path': '/reviews' })
    expect(chart?.['unit']).toBe('reviews')
    expect((surface.dataModel?.['reviews'] as unknown[]).length).toBe(3)
    const button = surface.components.find((c) => c.component === 'Button')
    expect(button?.['action']).toEqual({
      event: { name: 'ping', context: { note: { '@path': '/note' } } }
    })
  })

  it('accepts text the model wrapped in tags or a code fence', () => {
    expect(
      compileExpress('a', '```\n<a2ui>\nroot = Text("hi")\n</a2ui>\n```').components
    ).toHaveLength(1)
  })

  it.each([
    ['an unknown component', 'root = PieChart("x")'],
    ['a missing root', 'title = Text("x")'],
    ['an unknown property', 'root = Text("x", wobble=true)'],
    ['a bad enum value', 'root = Text("x", "huge")'],
    ['a syntax error', 'root = Column([Text("x")']
  ])('refuses %s with a message', (_name, express) => {
    let message = ''
    try {
      compileExpress('a', express)
    } catch (error) {
      expect(error).toBeInstanceOf(ExpressError)
      message = (error as Error).message
    }
    expect(message.length).toBeGreaterThan(10)
    console.log(`${_name}: ${message.slice(0, 200)}`)
  })

  it('refuses an unknown component and names it', () => {
    expect(() => compileExpress('a', 'root = PieChart("x")')).toThrow(ExpressError)
    expect(() => compileExpress('a', 'root = PieChart("x")')).toThrow(/PieChart/)
  })

  it('refuses an unknown property and names it', () => {
    expect(() => compileExpress('a', 'root = Text("x", wobble=true)')).toThrow(ExpressError)
    expect(() => compileExpress('a', 'root = Text("x", wobble=true)')).toThrow(/wobble/)
  })

  it('lists every catalog component for the tool description', () => {
    const text = componentSignatures()
    expect(text).toContain('BarChart(title?, subtitle?, data')
    expect(text).toContain('Stat(label, value')
  })

  it('lists the new parts in the signatures', () => {
    const text = componentSignatures()
    expect(text).toContain('CodeBlock(text, maxLines?')
    expect(text).toContain('KeyValue(items')
  })
})

// Compiled shape of the properties added for spec 014. A path-valued property compiles to
// `{ "@path": "/x" }` like every other binding; `submit` is a plain component id string;
// `requires` is a list whose entries are a binding or a list of alternative bindings.
const NEW_PARTS = `
$/choice = []
$/other = ""
go = Button(Text("Go"), Event("go", {choice: $/choice}), "primary", [$/choice, [$/other, $/choice]])
pick = ChoicePicker("Pick one", [{label: "Set aside", value: "aside", description: "Keep them"}, {label: "Bring along", value: "carry"}], $/choice, "mutuallyExclusive", "radio", $/other)
files = KeyValue([{label: "Command", value: "pnpm test"}, {label: "Files", value: ["a.ts", "b.ts"]}])
code = CodeBlock("line 1\\nline 2", 10, 400)
root = Column([Text("A long note", maxLines=3), code, files, pick, TextField("Other", $/other, submit="go"), go])
`

describe('compileExpress, parts for the request panels', () => {
  let surface: ReturnType<typeof compileExpress>
  beforeAll(() => {
    surface = compileExpress('new', NEW_PARTS)
  })
  const find = (kind: string): Record<string, unknown> | undefined =>
    surface.components.find((c) => c.component === kind)

  it('compiles CodeBlock with its limits', () => {
    expect(find('CodeBlock')).toMatchObject({ text: 'line 1\nline 2', maxLines: 10, maxChars: 400 })
  })

  it('compiles KeyValue with string and list values', () => {
    expect(find('KeyValue')?.['items']).toEqual([
      { label: 'Command', value: 'pnpm test' },
      { label: 'Files', value: ['a.ts', 'b.ts'] }
    ])
  })

  it('compiles Text maxLines', () => {
    expect(surface.components.find((c) => c['maxLines'] === 3)).toMatchObject({
      component: 'Text',
      text: 'A long note'
    })
  })

  it('compiles ChoicePicker description, display and overriddenBy', () => {
    const picker = find('ChoicePicker')
    expect(picker?.['options']).toEqual([
      { label: 'Set aside', value: 'aside', description: 'Keep them' },
      { label: 'Bring along', value: 'carry' }
    ])
    expect(picker?.['display']).toBe('radio')
    expect(picker?.['overriddenBy']).toEqual({ '@path': '/other' })
    expect(picker?.['value']).toEqual({ '@path': '/choice' })
  })

  it('compiles TextField submit as the id of a Button', () => {
    const field = find('TextField')
    expect(field?.['submit']).toBe('go')
    expect(surface.components.find((c) => c.id === 'go')?.component).toBe('Button')
  })

  it('compiles Button requires as bindings and lists of alternative bindings', () => {
    expect(find('Button')?.['requires']).toEqual([
      { '@path': '/choice' },
      [{ '@path': '/other' }, { '@path': '/choice' }]
    ])
  })

  it('refuses requires written as plain strings and a maxLines below one', () => {
    expect(() =>
      compileExpress('a', 'root = Button(Text("Go"), Event("go"), requires=["/c"])')
    ).toThrow(ExpressError)
    expect(() => compileExpress('a', 'root = Text("x", maxLines=0)')).toThrow(/maxLines/)
  })
})

describe('show_surface description', () => {
  // The description was 4570 characters before spec 014 added six parts and properties.
  it('stays within its length bound', () => {
    expect(showSurfaceTool.description.length).toBeLessThanOrEqual(4600)
  })

  it('has an example that compiles', () => {
    const text = showSurfaceTool.description
    const example = text.slice(text.indexOf('Example:\n') + 9, text.indexOf('\n\nComponents:'))
    expect(compileExpress('ex', example).components.length).toBeGreaterThan(3)
  })
})
