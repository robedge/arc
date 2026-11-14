import type { AttentionRequest, BranchChoiceValue } from '@shared/types/session'
import type { Surface, SurfaceNode } from '@shared/surface'

/** The permission shape of a request. */
export type PermissionView = Extract<AttentionRequest, { kind: 'permission' }>
type QuestionRequest = Extract<AttentionRequest, { kind: 'question' }>
type BranchRequest = Extract<AttentionRequest, { kind: 'branch' }>

export interface AttentionSurfaceOptions {
  /** Offers "Always allow this in this session"; never offered for a more-access request. */
  allowAlways: boolean
}

/** Longer argument text is cut here until the user asks for all of it. */
const ARGS_MAX_LINES = 10
const ARGS_MAX_CHARS = 400

/** The choices for unsaved changes, in the order they are offered. */
export const BRANCH_CHOICES: { value: BranchChoiceValue; label: string; hint: string }[] = [
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

const bind = (path: string): { '@path': string } => ({ '@path': path })

/** Collects the nodes of one surface; `body` is what the root column lists above the buttons. */
function collector(): {
  add: (node: SurfaceNode, inBody?: boolean) => void
  text: (id: string, value: string) => void
  button: (
    key: string,
    label: string,
    event: string,
    variant: 'primary' | 'default',
    extra?: { context?: Record<string, unknown>; requires?: unknown[] }
  ) => void
  finish: (surfaceId: string, dataModel?: Record<string, unknown>) => Surface
} {
  const nodes: SurfaceNode[] = []
  const body: string[] = []
  const buttons: string[] = []
  const add = (node: SurfaceNode, inBody = true): void => {
    nodes.push(node)
    if (inBody) body.push(node.id)
  }
  const text = (id: string, value: string): void =>
    add({ id, component: 'Text', text: value, variant: 'body' })
  const button: ReturnType<typeof collector>['button'] = (key, label, event, variant, extra) => {
    add({ id: `${key}-label`, component: 'Text', text: label, variant: 'body' }, false)
    add(
      {
        id: key,
        component: 'Button',
        child: `${key}-label`,
        action: {
          event: {
            name: event,
            ...(extra?.context ? { context: extra.context } : {})
          }
        },
        variant,
        ...(extra?.requires ? { requires: extra.requires } : {})
      },
      false
    )
    buttons.push(key)
  }
  const finish = (surfaceId: string, dataModel?: Record<string, unknown>): Surface => {
    add({ id: 'buttons', component: 'Row', children: buttons }, false)
    return {
      surfaceId,
      components: [{ id: 'root', component: 'Column', children: [...body, 'buttons'] }, ...nodes],
      ...(dataModel ? { dataModel } : {})
    }
  }
  return { add, text, button, finish }
}

/**
 * The body of a request as a surface: what it says or asks and its buttons. The frame, the kind
 * label and the `from` line belong to the dock and are not part of it. Pure and deterministic:
 * ids are fixed names, so the same input gives the same JSON.
 */
export function buildAttentionSurface(
  view: AttentionRequest,
  { allowAlways }: AttentionSurfaceOptions = { allowAlways: false }
): Surface {
  switch (view.kind) {
    case 'permission':
      return permissionSurface(view, allowAlways)
    case 'question':
      return view.questions && view.questions.length > 0
        ? choicesSurface(view, view.questions)
        : questionSurface(view)
    case 'branch':
      return branchSurface(view)
  }
}

function permissionSurface(view: PermissionView, allowAlways: boolean): Surface {
  const { add, text, button, finish } = collector()
  const tool = view.tool
  if (tool?.kind === 'mcp') {
    text('lead', 'Wants to use a tool from one of your MCP servers')
    add({
      id: 'tool',
      component: 'KeyValue',
      items: [
        { label: 'Server', value: tool.server },
        { label: 'Tool', value: tool.tool }
      ]
    })
    if (Object.keys(tool.args).length > 0) {
      add({
        id: 'args',
        component: 'CodeBlock',
        text: JSON.stringify(tool.args, null, 2),
        maxLines: ARGS_MAX_LINES,
        maxChars: ARGS_MAX_CHARS
      })
    } else {
      text('args-none', 'No arguments.')
    }
  } else if (tool?.kind === 'permissions') {
    text('lead', 'Wants more access than its sandbox gives')
    if (tool.reason) text('access-reason', tool.reason)
    const items: { label: string; value: string | string[] }[] = []
    if (tool.read && tool.read.length > 0) items.push({ label: 'Read', value: tool.read })
    if (tool.write && tool.write.length > 0) items.push({ label: 'Write', value: tool.write })
    if (tool.network !== undefined) {
      items.push({
        label: 'Network',
        value: tool.network ? 'Wants network access' : 'No network access'
      })
    }
    if (items.length > 0) add({ id: 'access', component: 'KeyValue', items })
  } else {
    text('lead', 'Wants to run')
    add({ id: 'action', component: 'CodeBlock', text: view.action })
  }
  if (view.reason) text('reason', view.reason)

  button('approve', 'Approve', 'approve', 'primary')
  button('deny', 'Deny', 'deny', 'default')
  if (allowAlways && tool?.kind !== 'permissions') {
    button('always', 'Always allow this in this session', 'always', 'default')
  }
  return finish(view.id)
}

/** A plain question: the text, a box for the answer and "Send" (Enter in the box sends too). */
function questionSurface(view: QuestionRequest): Surface {
  const { add, text, button, finish } = collector()
  text('question', view.question)
  add({
    id: 'answer',
    component: 'TextField',
    label: 'Your answer',
    value: bind('/answer'),
    submit: 'send'
  })
  button('send', 'Send', 'send', 'primary', {
    context: { text: bind('/answer') },
    requires: [bind('/answer')]
  })
  return finish(view.id, { answer: '' })
}

/** Questions with choices: per question the picks and an "Other" box that overrides them. */
function choicesSurface(
  view: QuestionRequest,
  questions: NonNullable<QuestionRequest['questions']>
): Surface {
  const { add, text, button, finish } = collector()
  const dataModel: Record<string, unknown> = {}
  const context: Record<string, unknown> = {}
  const requires: unknown[] = []
  questions.forEach((q, i) => {
    if (q.header) text(`q${i}-header`, q.header)
    add({
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
    add({ id: `q${i}-other`, component: 'TextField', label: 'Other', value: bind(`/o${i}`) })
    dataModel[`q${i}`] = []
    dataModel[`o${i}`] = ''
    context[`q${i}`] = bind(`/q${i}`)
    context[`o${i}`] = bind(`/o${i}`)
    requires.push([bind(`/q${i}`), bind(`/o${i}`)])
  })
  button('decline', 'Decline', 'decline', 'default')
  button('submit', 'Submit', 'submit', 'primary', { context, requires })
  return finish(view.id, dataModel)
}

/** Unsaved changes in a repository: what is changed and what to do about it. */
function branchSurface(view: BranchRequest): Surface {
  const { add, text, button, finish } = collector()
  if (view.message) {
    add({ id: 'message', component: 'Callout', title: view.message, tone: 'warning' })
  }
  if (view.workers.length > 0) text('workers', `Waiting to start: ${view.workers.join(', ')}`)
  const lines = [...view.files]
  if (view.moreFiles > 0) lines.push(`and ${view.moreFiles} more`)
  if (lines.length > 0) add({ id: 'files', component: 'CodeBlock', text: lines.join('\n') })
  // After a failed carry the other three choices are offered again.
  const offered = BRANCH_CHOICES.filter((c) => !(view.message && c.value === 'carry'))
  add({
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
  button('continue', 'Continue', 'continue', 'primary', {
    context: { choice: bind('/choice') },
    requires: [bind('/choice')]
  })
  return finish(view.id, { choice: [] })
}
