import type { Surface, SurfaceNode } from '../../src/shared/surface'
import type { AttentionRequest, AttentionView } from '../../src/shared/types/session'

type Permission = Extract<AttentionRequest, { kind: 'permission' }>

// The renderer tests cannot import from src/main, so this writes out the component JSON that
// `buildAttentionSurface` produces for the three permission shapes (same ids, same buttons).
function surfaceFor(view: Permission, allowAlways: boolean): Surface {
  const body: SurfaceNode[] = []
  const text = (id: string, value: string): void => {
    body.push({ id, component: 'Text', text: value, variant: 'body' })
  }
  const tool = view.tool
  if (tool?.kind === 'mcp') {
    text('lead', 'Wants to use a tool from one of your MCP servers')
    body.push({
      id: 'tool',
      component: 'KeyValue',
      items: [
        { label: 'Server', value: tool.server },
        { label: 'Tool', value: tool.tool }
      ]
    })
    if (Object.keys(tool.args).length > 0) {
      body.push({
        id: 'args',
        component: 'CodeBlock',
        text: JSON.stringify(tool.args, null, 2),
        maxLines: 10,
        maxChars: 400
      })
    } else text('args-none', 'No arguments.')
  } else if (tool?.kind === 'permissions') {
    text('lead', 'Wants more access than its sandbox gives')
    if (tool.reason) text('access-reason', tool.reason)
    const items: { label: string; value: string | string[] }[] = []
    if (tool.read?.length) items.push({ label: 'Read', value: tool.read })
    if (tool.write?.length) items.push({ label: 'Write', value: tool.write })
    if (tool.network !== undefined) {
      items.push({
        label: 'Network',
        value: tool.network ? 'Wants network access' : 'No network access'
      })
    }
    body.push({ id: 'access', component: 'KeyValue', items })
  } else {
    text('lead', 'Wants to run')
    body.push({ id: 'action', component: 'CodeBlock', text: view.action })
  }
  if (view.reason) text('reason', view.reason)

  const buttons: [string, string, 'primary' | 'default'][] = [
    ['approve', 'Approve', 'primary'],
    ['deny', 'Deny', 'default']
  ]
  if (allowAlways) buttons.push(['always', 'Always allow this in this session', 'default'])
  const nodes: SurfaceNode[] = buttons.flatMap(([key, label, variant]) => [
    { id: `${key}-label`, component: 'Text', text: label },
    {
      id: key,
      component: 'Button',
      child: `${key}-label`,
      action: { event: { name: key } },
      variant
    }
  ])
  return {
    surfaceId: view.id,
    components: [
      { id: 'root', component: 'Column', children: [...body.map((n) => n.id), 'buttons'] },
      ...body,
      ...nodes,
      { id: 'buttons', component: 'Row', children: buttons.map(([key]) => key) }
    ]
  }
}

/** A surface with nothing but a root, for views whose surface the test does not read. */
export function plainSurface(id: string): Surface {
  return { surfaceId: id, components: [{ id: 'root', component: 'Column', children: [] }] }
}

const bind = (path: string): { '@path': string } => ({ '@path': path })

/** The buttons row and root column, as the main process's collector closes a surface. */
function close(
  surfaceId: string,
  body: SurfaceNode[],
  buttons: {
    key: string
    label: string
    variant: 'primary' | 'default'
    context?: Record<string, unknown>
    requires?: unknown[]
  }[],
  dataModel?: Record<string, unknown>
): Surface {
  const nodes: SurfaceNode[] = buttons.flatMap((b) => [
    { id: `${b.key}-label`, component: 'Text', text: b.label, variant: 'body' },
    {
      id: b.key,
      component: 'Button',
      child: `${b.key}-label`,
      action: { event: { name: b.key, ...(b.context ? { context: b.context } : {}) } },
      variant: b.variant,
      ...(b.requires ? { requires: b.requires } : {})
    }
  ])
  return {
    surfaceId,
    components: [
      { id: 'root', component: 'Column', children: [...body.map((n) => n.id), 'buttons'] },
      ...body,
      ...nodes,
      { id: 'buttons', component: 'Row', children: buttons.map((b) => b.key) }
    ],
    ...(dataModel ? { dataModel } : {})
  }
}

const bodyText = (id: string, value: string): SurfaceNode => ({
  id,
  component: 'Text',
  text: value,
  variant: 'body'
})

/** A plain question with the surface the main process would attach (written out, as above). */
export function questionSurface(id: string, question: string): Surface {
  return close(
    id,
    [
      bodyText('question', question),
      {
        id: 'answer',
        component: 'TextField',
        label: 'Your answer',
        value: bind('/answer'),
        submit: 'send'
      }
    ],
    [
      {
        key: 'send',
        label: 'Send',
        variant: 'primary',
        context: { text: bind('/answer') },
        requires: [bind('/answer')]
      }
    ],
    { answer: '' }
  )
}

/** The questions a command or the brain asks with choices (`AttentionQuestion`). */
export type QuestionSpec = NonNullable<Extract<AttentionRequest, { kind: 'question' }>['questions']>

/** A question with choices, with the surface the main process would attach. */
export function choicesSurface(id: string, questions: QuestionSpec): Surface {
  const body: SurfaceNode[] = []
  const dataModel: Record<string, unknown> = {}
  const context: Record<string, unknown> = {}
  const requires: unknown[] = []
  questions.forEach((q, i) => {
    if (q.header) body.push(bodyText(`q${i}-header`, q.header))
    body.push({
      id: `q${i}-pick`,
      component: 'ChoicePicker',
      label: q.question,
      options: q.options.map((o) => ({
        label: o.label,
        value: o.label,
        ...(o.description ? { description: o.description } : {})
      })),
      value: bind(`/q${i}`),
      variant: q.multiSelect ? 'multipleSelection' : 'mutuallyExclusive',
      display: 'buttons',
      overriddenBy: bind(`/o${i}`)
    })
    body.push({ id: `q${i}-other`, component: 'TextField', label: 'Other', value: bind(`/o${i}`) })
    dataModel[`q${i}`] = []
    dataModel[`o${i}`] = ''
    context[`q${i}`] = bind(`/q${i}`)
    context[`o${i}`] = bind(`/o${i}`)
    requires.push([bind(`/q${i}`), bind(`/o${i}`)])
  })
  return close(
    id,
    body,
    [
      { key: 'decline', label: 'Decline', variant: 'default' },
      { key: 'submit', label: 'Submit', variant: 'primary', context, requires }
    ],
    dataModel
  )
}

export const BRANCH_CHOICE_OPTIONS = [
  {
    value: 'stash',
    label: 'Set aside',
    hint: 'Puts the changes in a git stash. Nothing is lost and you can bring them back later.'
  },
  {
    value: 'commit',
    label: 'Commit them first',
    hint: 'Saves them as a commit on the branch you are on now.'
  },
  { value: 'carry', label: 'Bring them along', hint: 'Takes the changes onto the session branch.' },
  {
    value: 'skip',
    label: "Don't start",
    hint: 'The worker is not started and {project} is left as it is.'
  }
]

type BranchRequest = Extract<AttentionRequest, { kind: 'branch' }>

/** An unsaved-changes surface, as the main process builds it. */
export function branchSurface(view: BranchRequest): Surface {
  const body: SurfaceNode[] = []
  if (view.message) {
    body.push({ id: 'message', component: 'Callout', title: view.message, tone: 'warning' })
  }
  if (view.workers.length > 0) {
    body.push(bodyText('workers', `Waiting to start: ${view.workers.join(', ')}`))
  }
  const lines = [...view.files]
  if (view.moreFiles > 0) lines.push(`and ${view.moreFiles} more`)
  if (lines.length > 0) body.push({ id: 'files', component: 'CodeBlock', text: lines.join('\n') })
  const offered = BRANCH_CHOICE_OPTIONS.filter((c) => !(view.message && c.value === 'carry'))
  body.push({
    id: 'choice',
    component: 'ChoicePicker',
    label: 'What to do with these changes',
    options: offered.map((c) => ({
      label: c.label,
      value: c.value,
      description: c.hint.replace('{project}', view.projectName)
    })),
    value: bind('/choice'),
    variant: 'mutuallyExclusive',
    display: 'radio'
  })
  return close(
    view.id,
    body,
    [
      {
        key: 'continue',
        label: 'Continue',
        variant: 'primary',
        context: { choice: bind('/choice') },
        requires: [bind('/choice')]
      }
    ],
    { choice: [] }
  )
}

/** An unsaved-changes request with the surface the main process would attach. */
export function branchView(
  over: Partial<BranchRequest> & Pick<BranchRequest, 'id'>
): Extract<AttentionView, { kind: 'branch' }> {
  const view: BranchRequest = {
    route: 'queue',
    kind: 'branch',
    from: 'Arc',
    projectId: 'web',
    projectName: 'web',
    files: ['src/a.ts', 'src/b.ts'],
    moreFiles: 0,
    workers: ['W3 web-fix'],
    ...over
  }
  return { ...view, surface: branchSurface(view) }
}

type QuestionRequest = Extract<AttentionRequest, { kind: 'question' }>

/** A question request (plain, or with choices when `questions` is given) with its surface. */
export function questionView(
  over: Partial<QuestionRequest> & Pick<QuestionRequest, 'id'>
): Extract<AttentionView, { kind: 'question' }> {
  const view: QuestionRequest = {
    route: 'queue',
    kind: 'question',
    from: 'W2 docs · via brain',
    workerId: 'w2',
    question: 'Which branch?',
    ...over
  }
  const surface =
    view.questions && view.questions.length > 0
      ? choicesSurface(view.id, view.questions)
      : questionSurface(view.id, view.question)
  return { ...view, surface }
}

/** A queue permission request with the surface the main process would attach. */
export function permissionView(
  over: Partial<Permission> & Pick<Permission, 'id'>,
  allowAlways = over.tool?.kind !== 'permissions'
): Extract<AttentionView, { kind: 'permission' }> {
  const view: Permission = {
    route: 'queue',
    kind: 'permission',
    from: 'W1 api · via brain',
    workerId: 'w1',
    action: 'git push',
    ...over
  }
  return { ...view, surface: surfaceFor(view, allowAlways) }
}
