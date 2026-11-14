// SPIKE (A2UI), throwaway: Express text in, a stored surface out.
import { describe, expect, it } from 'vitest'
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

  it('lists every catalog component for the tool description', () => {
    const text = componentSignatures()
    expect(text).toContain('BarChart(title?, subtitle?, data')
    expect(text).toContain('Stat(label, value')
  })
})
