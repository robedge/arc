import { describe, expect, it } from 'vitest'
import { buildAttentionSurface } from '../../../src/main/surface/attention-surface'
import type { PermissionView } from '../../../src/main/surface/attention-surface'
import { ARC_COMPONENT_NAMES } from '../../../src/main/surface/arc-catalog'
import { surfaceProblem } from '../../../src/shared/surface'
import type { AttentionRequest } from '../../../src/shared/types/session'

const base: PermissionView = {
  id: 'req-1',
  route: 'queue',
  kind: 'permission',
  from: 'Brain',
  action: 'git push origin arc/fix'
}

const mcp = (args: Record<string, unknown>): PermissionView => ({
  ...base,
  action: 'x',
  tool: { kind: 'mcp', server: 'claude_ai_Figma', tool: 'use_figma', args }
})

const access: PermissionView = {
  ...base,
  action: 'Extra access',
  tool: {
    kind: 'permissions',
    reason: 'Needs the cache',
    read: ['/a', '/b'],
    write: [],
    network: false
  }
}

const label = (id: string, text: string) => ({ id, component: 'Text', text, variant: 'body' })
const button = (key: string, text: string, event: string, variant: string) => [
  label(`${key}-label`, text),
  {
    id: key,
    component: 'Button',
    child: `${key}-label`,
    action: { event: { name: event } },
    variant
  }
]

describe('buildAttentionSurface', () => {
  it('builds a command request', () => {
    const surface = buildAttentionSurface(
      { ...base, reason: 'Leaves the machine' },
      { allowAlways: true }
    )
    expect(surface).toEqual({
      surfaceId: 'req-1',
      components: [
        { id: 'root', component: 'Column', children: ['lead', 'action', 'reason', 'buttons'] },
        label('lead', 'Wants to run'),
        { id: 'action', component: 'CodeBlock', text: 'git push origin arc/fix' },
        label('reason', 'Leaves the machine'),
        ...button('approve', 'Approve', 'approve', 'primary'),
        ...button('deny', 'Deny', 'deny', 'default'),
        ...button('always', 'Always allow this in this session', 'always', 'default'),
        { id: 'buttons', component: 'Row', children: ['approve', 'deny', 'always'] }
      ]
    })
  })

  it('builds a tool from a connected server with its arguments limited', () => {
    const args = { fileKey: 'abc' }
    const surface = buildAttentionSurface(mcp(args), { allowAlways: true })
    expect(surface.components.slice(0, 4)).toEqual([
      { id: 'root', component: 'Column', children: ['lead', 'tool', 'args', 'buttons'] },
      label('lead', 'Wants to use a tool from one of your MCP servers'),
      {
        id: 'tool',
        component: 'KeyValue',
        items: [
          { label: 'Server', value: 'claude_ai_Figma' },
          { label: 'Tool', value: 'use_figma' }
        ]
      },
      {
        id: 'args',
        component: 'CodeBlock',
        text: JSON.stringify(args, null, 2),
        maxLines: 10,
        maxChars: 400
      }
    ])
  })

  it('says "No arguments." for a tool without arguments', () => {
    const surface = buildAttentionSurface(mcp({}), { allowAlways: true })
    expect(surface.components.find((c) => c.id === 'args-none')).toEqual(
      label('args-none', 'No arguments.')
    )
    expect(surface.components.some((c) => c.component === 'CodeBlock')).toBe(false)
  })

  it('carries the 10 line and 400 character limits on long arguments', () => {
    const long = mcp({ text: 'x'.repeat(2000), list: Array.from({ length: 30 }, (_, i) => i) })
    const block = buildAttentionSurface(long, { allowAlways: true }).components.find(
      (c) => c.component === 'CodeBlock'
    )
    expect(block).toMatchObject({ maxLines: 10, maxChars: 400 })
    expect(String(block?.['text']).length).toBeGreaterThan(400)
  })

  it('builds a more-access request without "always", listing only what is set', () => {
    const surface = buildAttentionSurface(access, { allowAlways: true })
    expect(surface.components.slice(0, 4)).toEqual([
      { id: 'root', component: 'Column', children: ['lead', 'access-reason', 'access', 'buttons'] },
      label('lead', 'Wants more access than its sandbox gives'),
      label('access-reason', 'Needs the cache'),
      {
        id: 'access',
        component: 'KeyValue',
        items: [
          { label: 'Read', value: ['/a', '/b'] },
          { label: 'Network', value: 'No network access' }
        ]
      }
    ])
    expect(surface.components.find((c) => c.id === 'buttons')).toMatchObject({
      children: ['approve', 'deny']
    })
    expect(surface.components.some((c) => c.id === 'always')).toBe(false)
  })

  it('says "Wants network access" when the network is asked for', () => {
    const view: PermissionView = {
      ...base,
      tool: { kind: 'permissions', reason: '', write: ['/w'], network: true }
    }
    const items = buildAttentionSurface(view, { allowAlways: false }).components.find(
      (c) => c.id === 'access'
    )?.['items']
    expect(items).toEqual([
      { label: 'Write', value: ['/w'] },
      { label: 'Network', value: 'Wants network access' }
    ])
  })

  it('offers no "always" for the terminal route', () => {
    const surface = buildAttentionSurface(base, { allowAlways: false })
    expect(surface.components.some((c) => c.id === 'always')).toBe(false)
    expect(surface.components.find((c) => c.id === 'buttons')).toMatchObject({
      children: ['approve', 'deny']
    })
  })

  it('gives identical JSON for identical input', () => {
    for (const view of [base, mcp({ a: 1 }), access]) {
      expect(JSON.stringify(buildAttentionSurface(view, { allowAlways: true }))).toBe(
        JSON.stringify(buildAttentionSurface(structuredClone(view), { allowAlways: true }))
      )
    }
  })

  it('is sound and catalog-only for every kind', () => {
    for (const view of all) {
      const surface = buildAttentionSurface(view, { allowAlways: true })
      expect(surface.components.every((c) => ARC_COMPONENT_NAMES.has(c.component))).toBe(true)
      expect(surfaceProblem(surface)).toBeNull()
    }
  })
})

type QuestionRequest = Extract<AttentionRequest, { kind: 'question' }>
type BranchRequest = Extract<AttentionRequest, { kind: 'branch' }>

const plain: QuestionRequest = {
  id: 'q-1',
  route: 'queue',
  kind: 'question',
  from: 'Brain',
  question: 'Which branch?'
}

const structured: QuestionRequest = {
  ...plain,
  id: 'q-2',
  questions: [
    {
      question: 'Which library?',
      header: 'Library',
      options: [{ label: 'zod', description: 'Schemas' }, { label: 'valibot' }],
      multiSelect: false
    },
    {
      question: 'Which checks?',
      header: '',
      options: [{ label: 'lint' }, { label: 'types' }],
      multiSelect: true
    }
  ]
}

const branch: BranchRequest = {
  id: 'b-1',
  route: 'queue',
  kind: 'branch',
  from: 'Arc',
  projectId: 'p1',
  projectName: 'web',
  files: ['src/a.ts', 'src/b.ts'],
  moreFiles: 0,
  workers: []
}

const hints = {
  stash: 'Puts the changes in a git stash. Nothing is lost and you can bring them back later.',
  commit: 'Saves them as a commit on the branch you are on now.',
  carry: 'Takes the changes onto the session branch.',
  skip: 'The worker is not started and web is left as it is.'
}
const bind = (path: string) => ({ '@path': path })
const byId = (view: AttentionRequest, id: string) =>
  buildAttentionSurface(view).components.find((c) => c.id === id)

const all: AttentionRequest[] = [
  base,
  mcp({ a: 1 }),
  access,
  plain,
  structured,
  branch,
  { ...branch, message: 'Could not carry', files: [], workers: ['W3 web-fix'], moreFiles: 4 }
]

describe('buildAttentionSurface, a plain question', () => {
  it('builds the text, the answer box and Send', () => {
    expect(buildAttentionSurface(plain)).toEqual({
      surfaceId: 'q-1',
      dataModel: { answer: '' },
      components: [
        { id: 'root', component: 'Column', children: ['question', 'answer', 'buttons'] },
        label('question', 'Which branch?'),
        {
          id: 'answer',
          component: 'TextField',
          label: 'Your answer',
          value: bind('/answer'),
          submit: 'send'
        },
        label('send-label', 'Send'),
        {
          id: 'send',
          component: 'Button',
          child: 'send-label',
          action: { event: { name: 'send', context: { text: bind('/answer') } } },
          variant: 'primary',
          requires: [bind('/answer')]
        },
        { id: 'buttons', component: 'Row', children: ['send'] }
      ]
    })
  })

  it('treats an empty question list as a plain question', () => {
    const surface = buildAttentionSurface({ ...plain, questions: [] })
    expect(surface.components.some((c) => c.id === 'send')).toBe(true)
  })
})

describe('buildAttentionSurface, questions with choices', () => {
  const surface = buildAttentionSurface(structured)

  it('starts with empty picks and empty Other text', () => {
    expect(surface.dataModel).toEqual({ q0: [], o0: '', q1: [], o1: '' })
  })

  it('draws header, question, picker and Other per question', () => {
    expect(surface.components[0]).toEqual({
      id: 'root',
      component: 'Column',
      children: ['q0-header', 'q0-pick', 'q0-other', 'q1-pick', 'q1-other', 'buttons']
    })
    expect(byId(structured, 'q0-header')).toEqual(label('q0-header', 'Library'))
    expect(byId(structured, 'q1-header')).toBeUndefined()
    expect(byId(structured, 'q0-pick')).toEqual({
      id: 'q0-pick',
      component: 'ChoicePicker',
      label: 'Which library?',
      options: [
        { label: 'zod', value: 'zod', description: 'Schemas' },
        { label: 'valibot', value: 'valibot' }
      ],
      value: bind('/q0'),
      variant: 'mutuallyExclusive',
      display: 'buttons',
      overriddenBy: bind('/o0')
    })
    expect(byId(structured, 'q1-pick')).toMatchObject({
      variant: 'multipleSelection',
      value: bind('/q1'),
      overriddenBy: bind('/o1')
    })
    expect(byId(structured, 'q1-other')).toEqual({
      id: 'q1-other',
      component: 'TextField',
      label: 'Other',
      value: bind('/o1')
    })
  })

  it('has Decline without requirements and Submit requiring every question', () => {
    expect(byId(structured, 'decline')).toEqual({
      id: 'decline',
      component: 'Button',
      child: 'decline-label',
      action: { event: { name: 'decline' } },
      variant: 'default'
    })
    expect(byId(structured, 'submit')).toEqual({
      id: 'submit',
      component: 'Button',
      child: 'submit-label',
      action: {
        event: {
          name: 'submit',
          context: {
            q0: bind('/q0'),
            o0: bind('/o0'),
            q1: bind('/q1'),
            o1: bind('/o1')
          }
        }
      },
      variant: 'primary',
      requires: [
        [bind('/q0'), bind('/o0')],
        [bind('/q1'), bind('/o1')]
      ]
    })
    expect(byId(structured, 'buttons')).toMatchObject({ children: ['decline', 'submit'] })
  })
})

describe('buildAttentionSurface, unsaved changes', () => {
  it('lists the files and offers four choices with hints naming the project', () => {
    const surface = buildAttentionSurface({ ...branch, workers: ['W3 web-fix', 'W4 api'] })
    expect(surface.dataModel).toEqual({ choice: [] })
    expect(surface.components[0]).toMatchObject({
      children: ['workers', 'files', 'choice', 'buttons']
    })
    expect(byId({ ...branch, workers: ['W3 web-fix', 'W4 api'] }, 'workers')).toEqual(
      label('workers', 'Waiting to start: W3 web-fix, W4 api')
    )
    expect(byId(branch, 'files')).toEqual({
      id: 'files',
      component: 'CodeBlock',
      text: 'src/a.ts\nsrc/b.ts'
    })
    expect(byId(branch, 'choice')).toEqual({
      id: 'choice',
      component: 'ChoicePicker',
      label: 'What to do with these changes',
      options: [
        { label: 'Set aside', value: 'stash', description: hints.stash },
        { label: 'Commit them first', value: 'commit', description: hints.commit },
        { label: 'Bring them along', value: 'carry', description: hints.carry },
        { label: "Don't start", value: 'skip', description: hints.skip }
      ],
      value: bind('/choice'),
      variant: 'mutuallyExclusive',
      display: 'radio'
    })
    expect(byId(branch, 'continue')).toEqual({
      id: 'continue',
      component: 'Button',
      child: 'continue-label',
      action: { event: { name: 'continue', context: { choice: bind('/choice') } } },
      variant: 'primary',
      requires: [bind('/choice')]
    })
  })

  it('leaves out the waiting line without workers', () => {
    expect(byId(branch, 'workers')).toBeUndefined()
  })

  it('says "and N more" after the listed files', () => {
    expect(byId({ ...branch, moreFiles: 7 }, 'files')).toMatchObject({
      text: 'src/a.ts\nsrc/b.ts\nand 7 more'
    })
  })

  it('after a failed carry shows a warning Callout and offers three choices', () => {
    const failed = { ...branch, message: 'Could not apply the changes' }
    expect(byId(failed, 'message')).toEqual({
      id: 'message',
      component: 'Callout',
      title: 'Could not apply the changes',
      tone: 'warning'
    })
    expect(buildAttentionSurface(failed).components[0]).toMatchObject({
      children: ['message', 'files', 'choice', 'buttons']
    })
    const options = byId(failed, 'choice')?.['options'] as { value: string }[]
    expect(options.map((o) => o.value)).toEqual(['stash', 'commit', 'skip'])
  })
})

describe('buildAttentionSurface, all kinds', () => {
  it('gives identical JSON for identical input', () => {
    for (const view of all) {
      expect(JSON.stringify(buildAttentionSurface(view))).toBe(
        JSON.stringify(buildAttentionSurface(structuredClone(view)))
      )
    }
  })
})
