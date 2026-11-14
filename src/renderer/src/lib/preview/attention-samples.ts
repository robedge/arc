import type { Surface, SurfaceNode } from '@shared/surface'
import type { AttentionView } from '@shared/types/session'

// Sample requests for the Design Preview. The component JSON is written out here on purpose:
// the renderer never imports from the main process.

const text = (id: string, value: string): SurfaceNode => ({
  id,
  component: 'Text',
  text: value,
  variant: 'body'
})

function buttons(always: boolean): SurfaceNode[] {
  const nodes: SurfaceNode[] = [
    { id: 'approve-label', component: 'Text', text: 'Approve' },
    {
      id: 'approve',
      component: 'Button',
      child: 'approve-label',
      action: { event: { name: 'approve' } },
      variant: 'primary'
    },
    { id: 'deny-label', component: 'Text', text: 'Deny' },
    {
      id: 'deny',
      component: 'Button',
      child: 'deny-label',
      action: { event: { name: 'deny' } },
      variant: 'default'
    }
  ]
  if (always) {
    nodes.push(
      { id: 'always-label', component: 'Text', text: 'Always allow this in this session' },
      {
        id: 'always',
        component: 'Button',
        child: 'always-label',
        action: { event: { name: 'always' } },
        variant: 'default'
      }
    )
  }
  nodes.push({
    id: 'buttons',
    component: 'Row',
    children: always ? ['approve', 'deny', 'always'] : ['approve', 'deny']
  })
  return nodes
}

function surface(id: string, body: SurfaceNode[], always: boolean): Surface {
  return {
    surfaceId: id,
    components: [
      { id: 'root', component: 'Column', children: [...body.map((n) => n.id), 'buttons'] },
      ...body,
      ...buttons(always)
    ]
  }
}

const longArgs = JSON.stringify(
  Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`field${i + 1}`, `sample value ${i + 1}`])
  ),
  null,
  2
)

const command: AttentionView = {
  id: 'sample-command',
  route: 'queue',
  kind: 'permission',
  from: 'W1 api-retry · via brain',
  workerId: 'w1',
  action: 'git push origin arc/fix-order-sync',
  reason: 'Sample: pushes the worker branch.',
  surface: surface(
    'sample-command',
    [
      text('lead', 'Wants to run'),
      { id: 'action', component: 'CodeBlock', text: 'git push origin arc/fix-order-sync' },
      text('reason', 'Sample: pushes the worker branch.')
    ],
    true
  )
}

const tool: AttentionView = {
  id: 'sample-tool',
  route: 'queue',
  kind: 'permission',
  from: 'W2 order-sync · via brain',
  workerId: 'w2',
  action: 'mcp',
  tool: { kind: 'mcp', server: 'sample-tracker', tool: 'create_issue', args: { title: 'x' } },
  surface: surface(
    'sample-tool',
    [
      text('lead', 'Wants to use a tool from one of your MCP servers'),
      {
        id: 'tool',
        component: 'KeyValue',
        items: [
          { label: 'Server', value: 'sample-tracker' },
          { label: 'Tool', value: 'create_issue' }
        ]
      },
      { id: 'args', component: 'CodeBlock', text: longArgs, maxLines: 10, maxChars: 400 }
    ],
    true
  )
}

const access: AttentionView = {
  id: 'sample-access',
  route: 'queue',
  kind: 'permission',
  from: 'W3 web-fix · via brain',
  workerId: 'w3',
  action: 'permissions',
  tool: { kind: 'permissions', reason: 'Sample: needs the cache folder.', read: ['/sample/cache'] },
  surface: surface(
    'sample-access',
    [
      text('lead', 'Wants more access than its sandbox gives'),
      text('access-reason', 'Sample: needs the cache folder.'),
      {
        id: 'access',
        component: 'KeyValue',
        items: [
          { label: 'Read', value: ['/sample/cache'] },
          { label: 'Write', value: ['/sample/out'] },
          { label: 'Network', value: 'Wants network access' }
        ]
      }
    ],
    false
  )
}

const bind = (path: string): { '@path': string } => ({ '@path': path })

interface SampleButton {
  key: string
  label: string
  primary?: boolean
  context?: Record<string, unknown>
  requires?: unknown[]
}

function withButtons(
  id: string,
  body: SurfaceNode[],
  buttonList: SampleButton[],
  dataModel?: Record<string, unknown>
): Surface {
  const nodes = buttonList.flatMap((b): SurfaceNode[] => [
    { id: `${b.key}-label`, component: 'Text', text: b.label, variant: 'body' },
    {
      id: b.key,
      component: 'Button',
      child: `${b.key}-label`,
      action: { event: { name: b.key, ...(b.context ? { context: b.context } : {}) } },
      variant: b.primary ? 'primary' : 'default',
      ...(b.requires ? { requires: b.requires } : {})
    }
  ])
  return {
    surfaceId: id,
    components: [
      { id: 'root', component: 'Column', children: [...body.map((n) => n.id), 'buttons'] },
      ...body,
      ...nodes,
      { id: 'buttons', component: 'Row', children: buttonList.map((b) => b.key) }
    ],
    ...(dataModel ? { dataModel } : {})
  }
}

const question: AttentionView = {
  id: 'sample-question',
  route: 'queue',
  kind: 'question',
  from: 'W2 order-sync · via brain',
  workerId: 'w2',
  question: 'Sample: which retry limit should the worker use?',
  surface: withButtons(
    'sample-question',
    [
      text('question', 'Sample: which retry limit should the worker use?'),
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
        primary: true,
        context: { text: bind('/answer') },
        requires: [bind('/answer')]
      }
    ],
    { answer: '' }
  )
}

const choices: AttentionView = {
  id: 'sample-choices',
  route: 'queue',
  kind: 'question',
  from: 'W1 api-retry · /awos:spec',
  workerId: 'w1',
  question: 'Sample: where should the review open?',
  questions: [
    {
      question: 'Sample: where should the review open?',
      header: 'Review',
      multiSelect: false,
      options: [{ label: 'In the app', description: 'Opens in Arc.' }, { label: 'In the editor' }]
    }
  ],
  surface: withButtons(
    'sample-choices',
    [
      text('q0-header', 'Review'),
      {
        id: 'q0-pick',
        component: 'ChoicePicker',
        label: 'Sample: where should the review open?',
        options: [
          { label: 'In the app', value: 'In the app', description: 'Opens in Arc.' },
          { label: 'In the editor', value: 'In the editor' }
        ],
        value: bind('/q0'),
        variant: 'mutuallyExclusive',
        display: 'buttons',
        overriddenBy: bind('/o0')
      },
      { id: 'q0-other', component: 'TextField', label: 'Other', value: bind('/o0') }
    ],
    [
      { key: 'decline', label: 'Decline' },
      {
        key: 'submit',
        label: 'Submit',
        primary: true,
        context: { q0: bind('/q0'), o0: bind('/o0') },
        requires: [[bind('/q0'), bind('/o0')]]
      }
    ],
    { q0: [], o0: '' }
  )
}

const CARRY_FAILED = 'Sample: could not bring the changes along. Pick another choice.'

function branchSample(id: string, failed: boolean): AttentionView {
  const options = [
    {
      label: 'Set aside',
      value: 'stash',
      description:
        'Puts the changes in a git stash. Nothing is lost and you can bring them back later.'
    },
    {
      label: 'Commit them first',
      value: 'commit',
      description: 'Saves them as a commit on the branch you are on now.'
    },
    ...(failed
      ? []
      : [
          {
            label: 'Bring them along',
            value: 'carry',
            description: 'Takes the changes onto the session branch.'
          }
        ]),
    {
      label: "Don't start",
      value: 'skip',
      description: 'The worker is not started and web is left as it is.'
    }
  ]
  return {
    id,
    route: 'queue',
    kind: 'branch',
    from: 'Arc',
    projectId: 'web',
    projectName: 'web',
    files: ['src/routes/orders.ts', 'src/lib/retry.ts'],
    moreFiles: 0,
    workers: ['W3 web-fix'],
    ...(failed ? { message: CARRY_FAILED } : {}),
    surface: withButtons(
      id,
      [
        ...(failed
          ? [{ id: 'message', component: 'Callout', title: CARRY_FAILED, tone: 'warning' }]
          : []),
        text('workers', 'Waiting to start: W3 web-fix'),
        { id: 'files', component: 'CodeBlock', text: 'src/routes/orders.ts\nsrc/lib/retry.ts' },
        {
          id: 'choice',
          component: 'ChoicePicker',
          label: 'What to do with these changes',
          options,
          value: bind('/choice'),
          variant: 'mutuallyExclusive',
          display: 'radio'
        }
      ],
      [
        {
          key: 'continue',
          label: 'Continue',
          primary: true,
          context: { choice: bind('/choice') },
          requires: [bind('/choice')]
        }
      ],
      { choice: [] }
    )
  }
}

export const sampleRequests: AttentionView[] = [
  command,
  tool,
  access,
  question,
  choices,
  branchSample('sample-branch', false),
  branchSample('sample-branch-failed', true)
]
