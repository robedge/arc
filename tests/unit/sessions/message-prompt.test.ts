import { describe, expect, it } from 'vitest'
import { compileExpress } from '../../../src/main/surface/express'
import { parsePrompt } from '../../../src/main/sessions/message-prompt'

describe('parsePrompt surface', () => {
  const surface = compileExpress('p', 'root = Column([Text("Hello"), Badge("1", "info")])')

  it('keeps a stored surface whose components are all in the catalog', () => {
    const prompt = parsePrompt(JSON.stringify({ kind: 'surface', surface }))
    expect(prompt).toEqual({ kind: 'surface', surface })
  })

  it('drops a stored surface that uses a component outside the catalog', () => {
    const stored = {
      ...surface,
      components: [...surface.components, { id: 'x', component: 'PieChart' }]
    }
    expect(parsePrompt(JSON.stringify({ kind: 'surface', surface: stored }))).toBeUndefined()
  })

  it('keeps a stored surface that uses the code and key-value parts', () => {
    const rich = compileExpress(
      'r',
      'root = Column([CodeBlock("ls", 10), KeyValue([{label: "Cwd", value: "/tmp"}])])'
    )
    expect(parsePrompt(JSON.stringify({ kind: 'surface', surface: rich }))).toEqual({
      kind: 'surface',
      surface: rich
    })
  })
})

describe('parsePrompt attention-record', () => {
  const record = {
    kind: 'attention-record',
    decision: 'answered',
    subject: 'Which repository?',
    answer: 'web',
    from: 'Brain'
  }

  it('round-trips a record, with and without an answer', () => {
    expect(parsePrompt(JSON.stringify(record))).toEqual(record)
    const declined = {
      kind: record.kind,
      decision: 'declined',
      subject: record.subject,
      from: record.from
    }
    expect(parsePrompt(JSON.stringify(declined))).toEqual(declined)
  })

  it('accepts every decision', () => {
    for (const decision of ['approved', 'denied', 'always', 'answered', 'declined', 'branch']) {
      expect(parsePrompt(JSON.stringify({ ...record, decision }))).toMatchObject({ decision })
    }
  })

  it('drops an unknown decision and missing or mistyped fields', () => {
    expect(parsePrompt(JSON.stringify({ ...record, decision: 'maybe' }))).toBeUndefined()
    expect(parsePrompt(JSON.stringify({ ...record, decision: undefined }))).toBeUndefined()
    expect(parsePrompt(JSON.stringify({ ...record, subject: undefined }))).toBeUndefined()
    expect(parsePrompt(JSON.stringify({ ...record, from: 3 }))).toBeUndefined()
    expect(parsePrompt(JSON.stringify({ ...record, answer: 4 }))).toBeUndefined()
  })

  it('round-trips failed: true on a branch record', () => {
    const failed = {
      kind: 'attention-record',
      decision: 'branch',
      subject: 'api',
      answer: 'Bring them along',
      from: 'Arc',
      failed: true
    }
    expect(parsePrompt(JSON.stringify(failed))).toEqual(failed)
  })

  it('rejects a failed that is not a boolean, and drops it from other decisions and from false', () => {
    const branch = { ...record, decision: 'branch' }
    expect(parsePrompt(JSON.stringify({ ...branch, failed: 'yes' }))).toBeUndefined()
    expect(parsePrompt(JSON.stringify({ ...branch, failed: 1 }))).toBeUndefined()
    expect(parsePrompt(JSON.stringify({ ...branch, failed: false }))).toEqual(branch)
    expect(parsePrompt(JSON.stringify({ ...record, failed: true }))).toEqual(record)
  })

  it('drops fields the record does not have', () => {
    expect(parsePrompt(JSON.stringify({ ...record, extra: 1 }))).toEqual(record)
  })
})
