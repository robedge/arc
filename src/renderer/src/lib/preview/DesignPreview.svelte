<script lang="ts">
  // Design Preview: a catalog of the ui/ building blocks with local state only.
  // No IPC, no preload, no global stores except the motion store (reduced-motion).
  import { onMount } from 'svelte'
  import type { Snippet } from 'svelte'
  import { motion } from '../stores/motion.svelte'
  import type { DraftStatus } from '../stores/item-draft.svelte'
  import Panel from '../components/ui/Panel.svelte'
  import Wordmark from '../components/ui/Wordmark.svelte'
  import RingLogo from '../components/ui/RingLogo.svelte'
  import Button from '../components/ui/Button.svelte'
  import IconButton from '../components/ui/IconButton.svelte'
  import TextField from '../components/ui/TextField.svelte'
  import TextArea from '../components/ui/TextArea.svelte'
  import Select from '../components/ui/Select.svelte'
  import Toggle from '../components/ui/Toggle.svelte'
  import Checkbox from '../components/ui/Checkbox.svelte'
  import Radio from '../components/ui/Radio.svelte'
  import Modal from '../components/ui/Modal.svelte'
  import RemovePluginDialog from '../components/settings/RemovePluginDialog.svelte'
  import Banner from '../components/ui/Banner.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import SaveIndicator from '../components/ui/SaveIndicator.svelte'
  import CliBanner from '../components/sessions/CliBanner.svelte'
  import UpdateNotices from '../components/banners/UpdateNotices.svelte'
  import RestartPrompt from '../components/banners/RestartPrompt.svelte'
  import ProviderNote from '../components/sessions/ProviderNote.svelte'
  import SessionRow from '../components/sessions/SessionRow.svelte'
  import BrainCard from '../components/sessions/BrainCard.svelte'
  import ContinueWorkersPrompt from '../components/sessions/ContinueWorkersPrompt.svelte'
  import MessageBubble from '../components/sessions/MessageBubble.svelte'
  import Composer from '../components/sessions/Composer.svelte'
  import CommandMenu from '../components/sessions/CommandMenu.svelte'
  import type { CommandInfo } from '@shared/types/commands'
  import DeleteSessionDialog from '../components/sessions/DeleteSessionDialog.svelte'
  import DirtyTreeDialog from '../components/sessions/DirtyTreeDialog.svelte'
  import ReviewFileList from '../components/review/ReviewFileList.svelte'
  import SessionHeader from '../components/sessions/SessionHeader.svelte'
  import NewSessionDialog from '../components/sessions/NewSessionDialog.svelte'
  import type { SessionEventEntry, SessionMessage } from '@shared/types/session'
  import HeaderMenu from '../components/sessions/HeaderMenu.svelte'
  import { workersEntries } from '../model-options'
  import type { AppSettings, ProviderModels } from '@shared/types/provider'
  import type { LoadItem } from '@shared/types/agent-load'
  import PlanCard from '../components/sessions/PlanCard.svelte'
  import EventLog from '../components/sessions/EventLog.svelte'
  import TerminalPanel from '../components/sessions/TerminalPanel.svelte'
  import StepInBar from '../components/sessions/StepInBar.svelte'
  import { TerminalBuffer } from '../stores/worker-terminals.svelte'
  import WorkerCard from '../components/sessions/WorkerCard.svelte'
  import WorkerDetailsDialog from '../components/sessions/WorkerDetails.svelte'
  import type { PlanStatus, PlanView, WorkerStatus, WorkerView } from '@shared/types/session'
  import SessionsTab from '../components/sessions/SessionsTab.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import Menu from '../components/ui/Menu.svelte'
  import MenuItem from '../components/ui/MenuItem.svelte'
  import AttentionBadge from '../components/ui/AttentionBadge.svelte'
  import PermissionCard from '../components/ui/attention/PermissionCard.svelte'
  import AttentionDialog from '../components/ui/attention/AttentionDialog.svelte'
  import type { AttentionRequest } from '../components/ui/attention/types'
  import { messageKinds, type MessageKind } from '../components/ui/kinds'
  import UndoDialog from '../components/review/UndoDialog.svelte'
  import PushDialog from '../components/review/PushDialog.svelte'
  import DiffLine from '../components/review/DiffLine.svelte'
  import DiffSplit from '../components/review/DiffSplit.svelte'
  import NoteComposer from '../components/review/NoteComposer.svelte'
  import NoteThread from '../components/review/NoteThread.svelte'
  import { toSplitRows, toUnifiedRows } from '../review/diff-rows'
  import type { ReviewNote } from '@shared/types/review'
  import AgentLoadSettings from '../components/settings/AgentLoadSettings.svelte'
  import PluginsSettings from '../components/settings/PluginsSettings.svelte'
  import ProvidersSettings from '../components/settings/ProvidersSettings.svelte'
  import type { PluginRow } from '@shared/types/plugins'
  import StorageProgress from '../components/settings/StorageProgress.svelte'

  onMount(() => motion.start())

  const sampleCommands: CommandInfo[] = [
    {
      id: 'claude:awos:spec',
      provider: 'claude',
      kind: 'command',
      name: 'awos:spec',
      description: 'Write a functional spec',
      argumentHint: '<feature>',
      source: 'repo:api'
    },
    {
      id: 'claude:user:agent-browser',
      provider: 'claude',
      kind: 'command',
      name: 'user:agent-browser',
      description: 'Drive a browser from the CLI',
      source: 'user'
    },
    {
      id: 'claude:superpowers:brainstorming',
      provider: 'claude',
      kind: 'command',
      name: 'superpowers:brainstorming',
      description: 'Explore an idea before building',
      source: 'plugin:superpowers'
    },
    {
      id: 'codex:publish-release',
      provider: 'codex',
      kind: 'skill',
      name: 'publish-release',
      description: 'Publish the release notes',
      source: 'codex'
    },
    {
      id: 'claude:review',
      provider: 'claude',
      kind: 'command',
      name: 'review',
      description: 'Review the current changes',
      source: 'user'
    },
    {
      id: 'codex:review',
      provider: 'codex',
      kind: 'prompt',
      name: 'review',
      description: 'Review the current changes',
      source: 'codex'
    }
  ]

  const colors = [
    ['ground', 'bg-ground'],
    ['surface-panel', 'bg-surface-panel'],
    ['surface-raised', 'bg-surface-raised'],
    ['surface-code', 'bg-surface-code'],
    ['accent', 'bg-accent'],
    ['attention', 'bg-attention'],
    ['success', 'bg-success'],
    ['danger', 'bg-danger'],
    ['text', 'bg-text'],
    ['text-muted', 'bg-text-muted']
  ] as const

  let removePluginOpen = $state(false)

  const samplePlugins: PluginRow[] = [
    {
      id: 'superpowers@marketplace',
      name: 'superpowers',
      marketplace: 'marketplace',
      version: '5.0.7',
      description: 'Planning, debugging and review skills.',
      enabled: true,
      source: 'github.com/example/superpowers',
      counts: { commands: 5, skills: 2, agents: 1 },
      hasMcp: false,
      hasHooks: false
    },
    {
      id: 'toolbox@marketplace',
      name: 'toolbox',
      marketplace: 'marketplace',
      version: '1.2.0',
      description: 'Ships an MCP server and session hooks.',
      enabled: true,
      counts: { commands: 3, skills: 0, agents: 0 },
      hasMcp: true,
      hasHooks: true,
      updateAvailable: '1.3.0'
    },
    {
      id: 'idle@marketplace',
      name: 'idle',
      marketplace: 'marketplace',
      version: '0.1.0',
      description: 'Turned off in the terminal.',
      enabled: false,
      counts: { commands: 0, skills: 0, agents: 0 },
      hasMcp: false,
      hasHooks: false
    }
  ]

  const cliMessages = {
    missing:
      "Claude Code isn't installed. Install it from claude.com/claude-code, then click Retry.",
    signedOut:
      "Claude Code isn't signed in. Open Terminal, run claude, and sign in, then click Retry.",
    error: "Couldn't check Claude Code. Click Retry. Details are in the logs."
  }
  let name = $state('Sample group')
  let nameEmpty = $state('')
  let notes = $state('Sample notes for the text area.')
  let choice = $state('b')
  let groupedChoice = $state('claude:sonnet')
  const sampleModels: ProviderModels = {
    claude: [
      { ref: { provider: 'claude', model: 'opus' }, label: 'Opus', tier: 'deep', isDefault: false },
      {
        ref: { provider: 'claude', model: 'sonnet' },
        label: 'Sonnet',
        tier: 'balanced',
        isDefault: true
      }
    ],
    codex: [
      {
        ref: { provider: 'codex', model: 'gpt-5.5' },
        label: 'gpt-5.5',
        tier: 'deep',
        isDefault: true
      }
    ],
    cursor: []
  }
  const sampleLoadItems: LoadItem[] = [
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
      key: 'plugin:superpowers@market',
      kind: 'plugin',
      label: 'superpowers',
      detail: 'superpowers@market',
      tokens: 5200,
      note: "Its hooks' output is not counted"
    },
    {
      key: 'skill:planning',
      kind: 'skill',
      label: 'planning',
      detail: '~/.claude/skills',
      tokens: 60
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
  const sampleLoadOff = {
    brain: ['mcp:trello'],
    workers: ['plugin:superpowers@market', 'hook:SessionStart']
  }
  const noCodex: ProviderModels = { ...sampleModels, codex: [] }
  const sampleDefaults: { settings: AppSettings; models: ProviderModels } = {
    settings: {
      'providers.brain': { provider: 'claude', model: 'sonnet' },
      'providers.workers': { mode: 'provider', provider: 'codex' },
      'usage.checkClaudePlanOnLaunch': true,
      'agents.loadOff': { brain: [], workers: [] }
    },
    models: sampleModels
  }
  const downDefaults = { ...sampleDefaults, models: noCodex }
  let toggleOn = $state(true)
  let checked = $state(true)
  let radio = $state('one')

  let modalOpen = $state(false)
  let restartOpen = $state(false)
  const updateSample = {
    codex: {
      provider: 'codex',
      state: 'ok',
      version: '0.162.1',
      message: '',
      checkedAt: 1,
      latestVersion: '0.170.0',
      updateAvailable: true,
      updateCommand: 'codex update'
    }
  } as const
  const restartSample = {
    codex: {
      ...updateSample.codex,
      restartRequired: true,
      restartReason: 'The Codex app on this Mac was replaced while agents were running.'
    }
  } as const
  let newSessionOpen = $state(false)
  let dirtyOpen = $state(false)
  let undoPreview = $state<'plain' | 'warning' | 'busy' | null>(null)
  let pushPreview = $state<'idle' | 'busy' | 'error' | null>(null)
  const previewCodexHeader = () => ({
    ...previewHeader,
    id: 'preview-codex',
    workers: { mode: 'provider', provider: 'codex' } as const
  })
  const previewCursorHeader = () => ({
    ...previewHeader,
    id: 'preview-cursor',
    workers: { mode: 'provider', provider: 'cursor' } as const
  })
  const previewHeader = {
    id: 'preview',
    groupId: 'g',
    name: 'Fix order sync',
    mode: 'plan_first' as const,
    workerLimit: 3,
    model: 'auto',
    brainModel: 'sonnet',
    autoApprove: false,
    allowRules: [],
    status: 'active' as const,
    createdAt: 1,
    lastActiveAt: 1,
    branches: [
      {
        projectId: 'api',
        projectName: 'api',
        branchName: 'arc/fix-order-sync',
        baseBranch: 'dev',
        readOnly: false
      },
      {
        projectId: 'web',
        projectName: 'web',
        branchName: 'arc/fix-order-sync',
        baseBranch: 'main',
        readOnly: false
      },
      { projectId: 'docs', projectName: 'docs', branchName: null, baseBranch: null, readOnly: true }
    ]
  }
  let deleteSessionOpen = $state(false)
  let workerDetailsOpen = $state(false)
  let stoppedDetailsOpen = $state(false)
  const planStatuses: PlanStatus[] = ['proposed', 'approved', 'replaced', 'rejected']
  function samplePlan(status: PlanStatus, changesRequested = false): PlanView {
    return {
      id: `plan-${status}${changesRequested ? '-wait' : ''}`,
      sessionId: 'preview',
      status,
      workers: [
        {
          name: 'api-retry',
          task: 'Add retry with backoff to the order sync client.',
          repos: ['api'],
          model: 'opus',
          rationale: '',
          approvedModel: status === 'approved' ? 'opus' : undefined,
          runningOn: { provider: 'claude', model: 'opus' }
        },
        {
          name: 'web-status',
          task: 'Show the retry status in the orders table.',
          repos: ['web'],
          model: 'haiku',
          rationale: '',
          provider: 'codex',
          approvedModel: status === 'approved' ? 'haiku' : undefined,
          runningOn: {
            provider: 'claude',
            model: 'haiku',
            requestedProvider: 'codex',
            fallbackReason: 'Codex is not signed in. Run codex login, then start the worker again.'
          }
        },
        {
          name: 'retry-spec',
          task: 'Write the spec for retry settings.',
          repos: ['api'],
          model: 'sonnet',
          rationale: '',
          command: '/awos:spec retry settings',
          approvedModel: status === 'approved' ? 'sonnet' : undefined,
          runningOn: { provider: 'codex', model: 'gpt-5.5' }
        }
      ],
      messageId: 1,
      replacedById: null,
      changesRequested,
      createdAt: 0,
      resolvedAt: null
    }
  }
  const terminalSample = new TerminalBuffer()
  terminalSample.ready = true
  terminalSample.append(
    Array.from({ length: 40 }, (_, i) =>
      i % 7 === 0 ? `$ pnpm test --filter api (${i})` : `  PASS  src/sync/retry-${i}.test.ts`
    )
      .concat([
        '  ↳ helper (Review api client): Read src/sync/retry.ts',
        '  ↳ helper (Review api client): Grep backoff'
      ])
      .join('\n')
  )
  const workerStatuses: WorkerStatus[] = [
    'queued',
    'starting',
    'working',
    'needs_approval',
    'has_question',
    'done',
    'merged',
    'failed',
    'stopped'
  ]
  function sampleWorker(status: WorkerStatus, number: number): WorkerView {
    return {
      id: `w-${status}`,
      sessionId: 'preview',
      number,
      slug: 'api-retry',
      role: 'worker',
      task: 'Add retry with backoff to the order sync client.',
      projectIds: ['api'],
      model: 'sonnet',
      runningOn:
        number % 3 === 0
          ? { provider: 'codex', model: 'gpt-5.5' }
          : number === 5
            ? {
                provider: 'claude',
                model: 'sonnet',
                requestedProvider: 'codex',
                fallbackReason:
                  'Codex is not signed in. Run codex login, then start the worker again.'
              }
            : { provider: 'claude', model: 'sonnet' },
      status,
      activity:
        status === 'working' ? 'Running tests in api' : status === 'queued' ? 'Queued' : null,
      failureReason: status === 'failed' ? 'The process exited with code 1.' : null,
      summary: null,
      stoppedBy: status === 'stopped' ? 'quit' : null,
      worktrees: [],
      hasWorkingCopy: status === 'working' || status === 'stopped',
      unmergedCommits: 0,
      ...(status === 'working' && number === 3 ? { helpersRunning: 2 } : {}),
      ...(number === 3 ? { command: '/awos:spec retry settings for the orders client' } : {}),
      createdAt: 0,
      updatedAt: 0
    }
  }
  const sampleEvents: SessionEventEntry[] = (
    [
      ['merge', 'Merged W1 api-retry into arc/order-sync'],
      ['merge-resolved', 'Resolved conflict in src/sync/queue.ts'],
      ['merge-conflict', 'Merging W2 web-status hit a conflict in src/status.ts'],
      ['shared', 'Shared W1 → W3: retry helper in src/sync/retry.ts'],
      ['merge-waiting', 'Session branch update waiting: your checkout of api has unsaved changes']
    ] as const
  ).map(([kind, text], i) => ({
    id: i + 1,
    sessionId: 'preview',
    at: 0,
    kind,
    text,
    workerId: null
  }))
  const sampleBrain: SessionMessage = {
    id: 1,
    sessionId: 'preview',
    role: 'brain',
    content: 'Here is a sample:\n\n```ts\nconst answer = 42\n```',
    state: 'complete',
    planId: null,
    createdAt: 0,
    updatedAt: 0
  }
  function samplePrompt(status: 'open' | 'continued'): SessionMessage {
    return {
      id: status === 'open' ? 2 : 3,
      sessionId: 'preview',
      role: 'system',
      content: '2 workers were stopped when Arc closed. Continue them?',
      state: 'complete',
      planId: null,
      prompt: { kind: 'continue-workers', workerIds: ['w-1', 'w-2'], status },
      createdAt: 0,
      updatedAt: 0
    }
  }
  let menuOpen = $state(false)
  let selectedRow = $state(1)
  let selectedTab = $state('Overview')
  let lastAction = $state('none')
  let busyDemo = $state(false)

  interface LocalToast {
    id: number
    kind: MessageKind
    message: string
  }
  let toastList = $state<LocalToast[]>([])
  let toastId = 0
  function showToast(kind: MessageKind): void {
    const id = ++toastId
    toastList.push({ id, kind, message: `Sample: ${kind} toast` })
    setTimeout(() => (toastList = toastList.filter((t) => t.id !== id)), 4000)
  }

  const sampleBypass = {
    claudeHookEvents: ['PreToolUse', 'PermissionRequest'],
    codexAllowPrefixes: [
      'git commit',
      'git merge',
      'git rebase',
      'git checkout',
      'git stash',
      'npm install',
      'npm run build',
      'pnpm add',
      'pnpm install',
      'cargo build',
      'cargo run',
      'curl -L',
      'curl -sS',
      'docker compose up',
      'docker build',
      'make deploy',
      'rm -rf node_modules',
      'terraform apply',
      'kubectl apply',
      'kubectl delete',
      'brew install',
      'pip install',
      'python3 manage.py migrate',
      'ssh deploy@host',
      'scp -r',
      'rsync -av'
    ],
    codexRulesCovered: 12
  }
  const mcpCall = {
    kind: 'mcp' as const,
    server: 'claude_ai_Figma',
    tool: 'use_figma',
    args: {
      fileKey: 'abc123',
      nodeId: '12:34',
      description: 'Sample: move the checkout button to the header and recolor it.',
      options: { dryRun: false, layers: ['Header', 'Footer', 'Buttons', 'Icons', 'Badges'] }
    }
  }

  const saveStates: DraftStatus[] = ['idle', 'saving', 'saved', 'error']

  let attentionOpen = $state(false)
  const attentionCount = 2
  let structuredOpen = $state(false)
  const requests: AttentionRequest[] = [
    {
      id: 'p1',
      kind: 'permission',
      from: 'W1 api-retry · via brain',
      action: 'git push origin arc/fix-order-sync',
      reason: 'Sample: pushes the worker branch.'
    },
    {
      id: 'q1',
      kind: 'question',
      from: 'W2 order-sync · via brain',
      question: 'Sample: which retry limit should the worker use?'
    }
  ]
  const structuredRequests: AttentionRequest[] = [
    {
      id: 'sq-single',
      kind: 'question',
      from: 'W3 · /awos:spec',
      question: 'Sample: where should the review open?',
      questions: [
        {
          question: 'Sample: where should the review open?',
          header: 'Review',
          multiSelect: false,
          options: [
            { label: 'In the app', description: 'Opens the diff view in Arc.' },
            { label: 'In the editor', description: 'Opens the changed files.' }
          ]
        }
      ]
    },
    {
      id: 'sq-multi',
      kind: 'question',
      from: 'W3 · /awos:spec',
      question: 'Sample: which colors?',
      questions: [
        {
          question: 'Sample: which colors?',
          header: 'Colors',
          multiSelect: true,
          options: [
            { label: 'Red' },
            { label: 'Blue', description: 'Cool tone.' },
            { label: 'Green' }
          ]
        }
      ]
    },
    {
      id: 'sq-two',
      kind: 'question',
      from: 'W4 api-retry (helper)',
      question: 'Sample: library?',
      questions: [
        {
          question: 'Sample: which library?',
          header: 'Library',
          multiSelect: false,
          options: [{ label: 'zod' }, { label: 'valibot' }]
        },
        {
          question: 'Sample: which checks?',
          header: 'Checks',
          multiSelect: true,
          options: [{ label: 'lint' }, { label: 'types' }]
        }
      ]
    },
    {
      id: 'sq-brain',
      kind: 'question',
      from: 'Brain',
      question: 'Which repository?',
      questions: [
        {
          question: 'Which repository?',
          header: '',
          multiSelect: false,
          options: [{ label: 'api' }, { label: 'web' }]
        }
      ]
    }
  ]
</script>

{#snippet noteParts()}
  {@const base = {
    projectId: 'api',
    path: 'src/orders/sync.ts',
    side: 'new' as const,
    line: 11,
    lineText: 'await sendWithBackoff(order, attempts)',
    createdAt: 1,
    updatedAt: 1
  }}
  {@const notes: ReviewNote[] = [
    { ...base, id: 'n1', body: 'This retry limit should come from config.', state: 'draft', stale: false },
    { ...base, id: 'n2', body: 'Sent to the brain already.', state: 'sent', stale: false, messageId: 4 },
    { ...base, id: 'n3', body: 'The line changed after I wrote this.', state: 'draft', stale: true },
    { ...base, id: 'n4', body: 'Sent, then the line changed.', state: 'sent', stale: true, messageId: 4 }
  ]}
  <!-- inert: Edit, Delete and Save would call the main process, which the preview never reaches -->
  <div inert class="flex flex-col gap-3" data-preview-notes>
    <NoteComposer
      id="preview-note-composer"
      label="Note on line 11 (new)"
      onsave={async () => null}
      oncancel={() => {}}
    />
    <NoteThread {notes} />
  </div>
{/snippet}

{#snippet diffParts()}
  {@const sample = [
    {
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 3,
      header: '@@ -10,3 +10,3 @@ function retry()',
      lines: [
        { kind: 'ctx' as const, oldNo: 10, newNo: 10, text: 'const attempts = 3' },
        { kind: 'del' as const, oldNo: 11, text: 'await send(order)' },
        {
          kind: 'add' as const,
          newNo: 11,
          text: 'await sendWithBackoff(order, attempts)',
          noNewline: true as const
        }
      ]
    }
  ]}
  {@const rows = toUnifiedRows(sample)}
  <div class="flex flex-col" data-preview-diff>
    {#each rows as row, i (i)}
      <div class="h-5"><DiffLine {row} /></div>
    {/each}
  </div>
  <div class="flex h-24 flex-col" data-preview-diff-split>
    <DiffSplit rows={toSplitRows(sample)} label="Side-by-side sample" />
  </div>
  {@render noteParts()}
  <p class="text-sm text-text-muted">Binary file changed</p>
  <div class="flex flex-col items-start gap-3">
    <p class="text-sm text-text">Large change: 2,431 lines</p>
    <Button onclick={() => {}}>Show anyway</Button>
  </div>
  <p class="text-sm text-text-muted">Too large to display (60,000 lines)</p>
{/snippet}

{#snippet tag()}
  <span class="font-mono text-xs tracking-label text-text-muted uppercase">Sample</span>
{/snippet}

{#snippet block(title: string, body: Snippet)}
  <Panel {title}>
    <div class="flex flex-col gap-3 p-4">
      {@render tag()}
      {@render body()}
    </div>
  </Panel>
{/snippet}

<div class="h-screen overflow-y-auto bg-ground text-text" data-preview-scroll>
  <main class="mx-auto flex max-w-4xl flex-col gap-6 p-6">
    <header class="flex items-center justify-between gap-4">
      <h1 class="font-display text-2xl tracking-label text-text-bright uppercase">
        Design Preview
      </h1>
      <p class="font-mono text-xs text-text-muted" data-motion-state>
        Sample: motion.reduced = {motion.reduced}
      </p>
    </header>

    {#snippet brand()}
      <div class="flex flex-wrap items-center gap-6">
        <Wordmark />
        <RingLogo size={28} />
        <RingLogo size={56} />
      </div>
    {/snippet}
    {@render block('Wordmark and ring', brand)}

    {#snippet swatches()}
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {#each colors as [label, cls] (label)}
          <div class="flex flex-col gap-1">
            <div class="h-8 rounded-control border border-border {cls}"></div>
            <span class="font-mono text-xs text-text-muted">{label}</span>
          </div>
        {/each}
      </div>
      <p class="font-display text-lg tracking-label text-text-bright uppercase">Display font</p>
      <p class="font-sans text-base">Sans body text (Rajdhani) for labels and prose.</p>
      <p class="font-mono text-sm">Mono text for code and paths</p>
    {/snippet}
    {@render block('Color and type', swatches)}

    {#snippet panels()}
      <div class="grid gap-3 sm:grid-cols-3">
        <Panel title="Default"><p class="p-3 text-sm">Sample default panel</p></Panel>
        <Panel title="Accent" tone="accent"><p class="p-3 text-sm">Sample accent panel</p></Panel>
        <Panel title="Attention" tone="attention"
          ><p class="p-3 text-sm">Sample attention panel</p></Panel
        >
      </div>
      <Panel title="Scrolling" scroll class="max-h-28">
        <ul class="flex flex-col gap-1 p-3 text-sm">
          {#each Array.from({ length: 12 }, (_, i) => i + 1) as n (n)}
            <li>Sample scrolling line {n}</li>
          {/each}
        </ul>
      </Panel>
    {/snippet}
    {@render block('Panels', panels)}

    {#snippet buttons()}
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="attention">Attention</Button>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled>Disabled</Button>
        <Button variant="secondary" busy>Busy</Button>
        <Button variant="primary" busy={busyDemo} onclick={() => (busyDemo = !busyDemo)}
          >Toggle busy</Button
        >
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <IconButton label="Sample add" icon="info" />
        <IconButton label="Sample disabled" icon="info" disabled />
        <IconButton label="Sample busy" icon="info" busy />
      </div>
    {/snippet}
    {@render block('Buttons', buttons)}

    {#snippet fields()}
      <TextField id="pv-name" label="Group name" bind:value={name} />
      <TextField
        id="pv-name-err"
        label="Group name (error)"
        bind:value={nameEmpty}
        error="Group name is required."
      />
      <TextArea id="pv-notes" label="Notes" bind:value={notes} />
      <Select
        id="pv-select"
        label="Model"
        bind:value={choice}
        options={[
          { value: 'a', label: 'Sample option A' },
          { value: 'b', label: 'Sample option B' }
        ]}
      />
      <Select
        id="pv-select-grouped"
        label="Model (grouped)"
        bind:value={groupedChoice}
        options={[
          {
            group: 'Claude',
            options: [
              { value: 'claude:opus', label: 'Opus' },
              { value: 'claude:sonnet', label: 'Sonnet' }
            ]
          },
          { group: 'Codex', options: [{ value: 'codex:gpt-5.5', label: 'gpt-5.5' }] }
        ]}
      />
      <HeaderMenu
        label="Sample workers menu"
        text="Workers · Codex"
        options={workersEntries(
          sampleModels,
          { claude: true, codex: true, cursor: false },
          { mode: 'provider', provider: 'codex' }
        )}
        current="provider:codex"
        onselect={() => {}}
      />
      <Toggle id="pv-toggle" label="Sample toggle" bind:checked={toggleOn} />
      <Checkbox id="pv-check" label="Sample checkbox" bind:checked />
      <div class="flex flex-col gap-2" role="radiogroup" aria-label="Sample radios">
        <Radio id="pv-r1" name="pv-radio" label="Sample radio one" value="one" bind:group={radio} />
        <Radio
          id="pv-r2"
          name="pv-radio"
          label="Sample radio two"
          description="With a description"
          value="two"
          bind:group={radio}
        />
      </div>
    {/snippet}
    {@render block('Fields', fields)}

    {#snippet banners()}
      <Banner kind="info" title="Sample info">Sample informational banner.</Banner>
      <Banner kind="warning" title="Sample warning">Sample warning banner.</Banner>
      <Banner kind="error" title="Sample error">Sample error banner.</Banner>
    {/snippet}
    {@render block('Banners', banners)}

    {#snippet cliBanners()}
      <CliBanner status={{ state: 'missing', message: cliMessages.missing }} />
      <CliBanner status={{ state: 'signed_out', message: cliMessages.signedOut }} />
      <CliBanner status={{ state: 'error', message: cliMessages.error }} />
    {/snippet}
    {@render block('CLI banner', cliBanners)}

    {#snippet codexNotes()}
      <ProviderNote
        header={previewCodexHeader()}
        workers={[]}
        status={{
          provider: 'codex',
          state: 'signed_out',
          message: 'Run codex login in Terminal.',
          loginCommand: 'codex login',
          checkedAt: 1
        }}
      />
    {/snippet}
    {@render block('Codex note', codexNotes)}

    {#snippet cursorNotes()}
      <ProviderNote
        header={previewCursorHeader()}
        workers={[]}
        status={{
          provider: 'cursor',
          state: 'signed_out',
          message: 'Run agent login in Terminal to use Cursor.',
          loginCommand: 'agent login',
          checkedAt: 1
        }}
      />
    {/snippet}
    {@render block('Cursor note', cursorNotes)}

    {#snippet providersStates()}
      <ProvidersSettings
        preview={{
          claude: {
            provider: 'claude',
            state: 'ok',
            version: '2.1.302',
            message: '',
            checkedAt: 1
          },
          codex: {
            provider: 'codex',
            state: 'signed_out',
            version: '0.162.1',
            message: "Codex isn't signed in.",
            loginCommand: 'codex login',
            checkedAt: 1
          }
        }}
        previewDefaults={downDefaults}
        previewBypass={sampleBypass}
      />
      <ProvidersSettings
        previewDefaults={sampleDefaults}
        preview={{
          codex: {
            provider: 'codex',
            state: 'ok',
            version: '0.162.1',
            message: '',
            account: { kind: 'api_key' },
            checkedAt: 1
          }
        }}
      />
    {/snippet}
    {#snippet mcpCards()}
      <PermissionCard
        id="mcp-1"
        from="W1 api-retry · via brain"
        action="mcp__claude_ai_Figma__use_figma"
        reason="Sample: this tool changes a file."
        tool={mcpCall}
        onApprove={() => {}}
        onDeny={() => {}}
        onAlwaysAllow={() => {}}
      />
      <PermissionCard
        id="mcp-2"
        from="W2 order-sync"
        action="mcp__notes__add_note"
        tool={{ kind: 'mcp', server: 'notes', tool: 'add_note', args: { title: 'Sample' } }}
        onApprove={() => {}}
        onDeny={() => {}}
        onAlwaysAllow={() => {}}
      />
      <PermissionCard
        id="perm-1"
        from="W3 deploy"
        action="Extra access: needs to read the build cache"
        reason="Sample: more access than the sandbox gives."
        tool={{
          kind: 'permissions',
          reason: 'Needs to read the build cache and fetch packages.',
          read: ['/Users/sample/.cache/build'],
          write: ['/Users/sample/Projects/out'],
          network: true
        }}
        onApprove={() => {}}
        onDeny={() => {}}
        onAlwaysAllow={() => {}}
      />
    {/snippet}
    {@render block('MCP and extra access cards', mcpCards)}

    {@render block('Providers settings', providersStates)}

    {#snippet agentLoadStates()}
      <AgentLoadSettings preview={{ items: sampleLoadItems, off: sampleLoadOff }} />
    {/snippet}
    {@render block('Agent loading settings', agentLoadStates)}

    {#snippet updateStates()}
      <ProvidersSettings preview={updateSample} previewDefaults={sampleDefaults} />
      <UpdateNotices preview={updateSample} />
      <Button onclick={() => (restartOpen = true)}>Open restart prompt</Button>
    {/snippet}
    {@render block('Provider update', updateStates)}

    {#snippet pluginsStates()}
      <PluginsSettings preview={{ status: 'ready', rows: samplePlugins }} />
      <PluginsSettings preview={{ status: 'loading', rows: [] }} />
      <PluginsSettings preview={{ status: 'ready', rows: [] }} />
      <PluginsSettings
        preview={{
          status: 'error',
          rows: [],
          reason: 'plugin list failed: marketplace unreachable'
        }}
      />
      <PluginsSettings
        preview={{
          status: 'ready',
          rows: samplePlugins,
          op: { kind: 'install', target: 'superpowers' }
        }}
      />
      <PluginsSettings
        preview={{
          status: 'ready',
          rows: samplePlugins,
          failure: 'Plugin "nope" was not found in any marketplace.'
        }}
      />
      <div>
        <Button onclick={() => (removePluginOpen = true)}>Open Remove plugin dialog</Button>
      </div>
      {#if removePluginOpen}
        <RemovePluginDialog
          name="superpowers"
          onconfirm={() => (removePluginOpen = false)}
          oncancel={() => (removePluginOpen = false)}
        />
      {/if}
    {/snippet}
    {@render block(
      'Settings: Plugins (rows, loading, empty, error, installing, failed, remove)',
      pluginsStates
    )}
    {@render block('Diff lines and placeholders', diffParts)}

    {#snippet sessionsEmpty()}
      <SessionsTab showBanner={false} />
    {/snippet}
    {@render block('Sessions tab (empty)', sessionsEmpty)}

    {#snippet sessionParts()}
      <div class="flex flex-col gap-3">
        <SessionRow
          session={{
            id: 's-working',
            groupId: 'g',
            name: 'Sample session (working)',
            lastActiveAt: Date.now() - 300_000,
            status: 'active',
            listStatus: 'working',
            attentionCount: 0
          }}
          onopen={() => {}}
          onrename={() => {}}
          ondelete={() => {}}
        />
        <!-- inert: the row's status word would duplicate the Attention section's "Needs attention" button name -->
        <div inert aria-hidden="true">
          <SessionRow
            session={{
              id: 's-needs-attention',
              groupId: 'g',
              name: 'Sample session (needs-attention)',
              lastActiveAt: Date.now() - 300_000,
              status: 'active',
              listStatus: 'needs-attention',
              attentionCount: 1
            }}
            onopen={() => {}}
            onrename={() => {}}
            ondelete={() => {}}
          />
        </div>
        <SessionRow
          session={{
            id: 's-idle',
            groupId: 'g',
            name: 'Sample session (idle)',
            lastActiveAt: Date.now() - 300_000,
            status: 'active',
            listStatus: 'idle',
            attentionCount: 0
          }}
          onopen={() => {}}
          onrename={() => {}}
          ondelete={() => {}}
        />
        <SessionRow
          session={{
            id: 's-stopped',
            groupId: 'g',
            name: 'Sample session (stopped)',
            lastActiveAt: Date.now() - 300_000,
            status: 'stopped',
            listStatus: 'stopped',
            attentionCount: 0
          }}
          onopen={() => {}}
          onrename={() => {}}
          ondelete={() => {}}
        />
        <div class="grid grid-cols-2 gap-3">
          <BrainCard state="idle" runningOn={{ provider: 'claude', model: 'sonnet' }} />
          <BrainCard state="thinking" runningOn={{ provider: 'codex', model: 'gpt-5.5' }} />
        </div>
        <MessageBubble message={sampleBrain} />
        <!-- inert: the buttons would call the main process, which the preview never reaches -->
        <div inert class="flex flex-col gap-3" data-preview-continue-prompts>
          {#each ['open', 'continued'] as const as status (status)}
            {@const m = samplePrompt(status)}
            {#if m.prompt?.kind === 'continue-workers'}<ContinueWorkersPrompt
                message={m}
                prompt={m.prompt}
              />{/if}
          {/each}
        </div>
        {#each planStatuses as status (status)}
          <PlanCard plan={samplePlan(status)} workerModel="auto" />
        {/each}
        <PlanCard plan={samplePlan('proposed', true)} workerModel="auto" />
        <PlanCard plan={samplePlan('proposed')} workerModel="haiku" />
        <div class="grid grid-cols-2 gap-3">
          {#each workerStatuses as status, i (status)}
            <WorkerCard
              worker={sampleWorker(status, i + 1)}
              onopen={() => {}}
              ondetails={() => {}}
            />
          {/each}
        </div>
        <!-- inert: a static look at the terminal tab; the real tabs live in the session screen -->
        <div inert aria-hidden="true" class="flex h-64 flex-col gap-2" data-preview-terminal>
          <div class="flex items-center gap-4 text-sm">
            <span class="text-text-muted">Brain</span>
            <span class="border-b-2 border-accent text-text">W1 · api-retry</span>
          </div>
          <Panel class="min-h-0 flex-1">
            <div class="flex h-full min-h-0 flex-col">
              <TerminalPanel buffer={terminalSample} label="Sample worker output" />
            </div>
          </Panel>
        </div>
        <div class="grid grid-cols-2 gap-3" data-preview-control>
          <WorkerCard
            worker={{ ...sampleWorker('working', 1), userControl: 'active' }}
            onopen={() => {}}
            ondetails={() => {}}
          />
          <WorkerCard
            worker={{ ...sampleWorker('needs_approval', 2), userControl: 'paused' }}
            onopen={() => {}}
            ondetails={() => {}}
          />
        </div>
        <!-- inert: the input line under a terminal while the user is in control -->
        <div inert aria-hidden="true" class="flex h-64 flex-col" data-preview-step-in>
          <Panel class="min-h-0 flex-1">
            <div class="flex h-full min-h-0 flex-col">
              <TerminalPanel buffer={terminalSample} label="Sample controlled worker output" />
              <StepInBar
                sessionId="preview"
                workerId="preview-controlled"
                label="W1 · api-retry"
                replying={false}
              />
            </div>
          </Panel>
        </div>
        <div class="h-44">
          <EventLog events={sampleEvents} />
        </div>
        <div class="flex gap-2">
          <Button onclick={() => (workerDetailsOpen = true)}>Open Worker details</Button>
          <Button onclick={() => (stoppedDetailsOpen = true)}>Open stopped Worker details</Button>
        </div>
        {#if stoppedDetailsOpen}
          <WorkerDetailsDialog
            worker={sampleWorker('stopped', 1)}
            onclose={() => (stoppedDetailsOpen = false)}
            preset={{
              id: 'w-stopped',
              sessionId: 'preview',
              number: 1,
              role: 'worker',
              name: 'W1 · api-retry',
              status: 'stopped',
              model: 'sonnet',
              task: 'Add retry with backoff to the order sync client.',
              activity: null,
              lastReport: null,
              failureReason: null,
              stoppedBy: 'quit',
              changedFiles: ['src/sync/retry.ts'],
              worktreePaths: [{ projectName: 'api', path: '/Users/me/Arc/worktrees/w1/api' }],
              projects: ['api'],
              hasWorkingCopy: true,
              unmergedCommits: 1
            }}
          />
        {/if}
        {#if workerDetailsOpen}
          <WorkerDetailsDialog
            worker={sampleWorker('working', 1)}
            onclose={() => (workerDetailsOpen = false)}
            preset={{
              id: 'w-working',
              sessionId: 'preview',
              number: 1,
              role: 'worker',
              name: 'W1 · api-retry',
              status: 'working',
              model: 'sonnet',
              task: 'Add retry with backoff to the order sync client.',
              activity: 'Running tests in api',
              lastReport: 'Retry added; tests are running.',
              failureReason: null,
              stoppedBy: null,
              changedFiles: ['src/sync/queue.ts', 'src/sync/retry.ts'],
              worktreePaths: [{ projectName: 'api', path: '/Users/me/Arc/worktrees/w1/api' }],
              projects: ['api'],
              hasWorkingCopy: true,
              unmergedCommits: 0
            }}
          />
        {/if}
        <Composer sessionId="preview" brainState="idle" />
        <!-- inert: the menu states are static samples -->
        <div inert class="grid grid-cols-2 gap-x-3 gap-y-3" data-preview-command-menu>
          {#each [{ label: 'Results', status: 'ready', list: sampleCommands }, { label: 'Loading', status: 'loading', list: [] }, { label: 'No matches', status: 'ready', list: [] }, { label: 'Error', status: 'error', list: [] }] as const as sample (sample.label)}
            <div class="flex flex-col gap-1">
              <span class="text-xs tracking-label text-text-muted uppercase"
                >Command menu: {sample.label}</span
              >
              <div>
                <CommandMenu
                  id="preview-menu-{sample.label}"
                  status={sample.status}
                  commands={[...sample.list]}
                  activeIndex={0}
                  onpick={() => {}}
                  onretry={() => {}}
                  inline
                />
              </div>
            </div>
          {/each}
        </div>
        <SessionHeader
          header={previewHeader}
          groupName="Sample group"
          onback={() => {}}
          changedCount={12}
          onreview={() => {}}
        />
        <SessionHeader
          header={{ ...previewHeader, id: 'preview-empty' }}
          groupName="Sample group, no changes"
          onback={() => {}}
          changedCount={0}
        />
        <Panel as="div" class="max-w-xs">
          <ReviewFileList
            selected={{ projectId: 'api', source: 'session', path: 'src/orders/sync.ts' }}
            onselect={() => {}}
            repos={[
              {
                projectId: 'api',
                projectName: 'api',
                branch: 'arc/fix-order-sync',
                push: { state: 'pushed', remote: 'origin', at: Date.now(), newerCommits: 2 },
                uncommitted: {
                  state: 'ok',
                  files: [
                    {
                      path: 'src/orders/sync.ts',
                      status: 'M',
                      added: 2,
                      removed: 1,
                      binary: false,
                      large: false
                    },
                    {
                      path: 'scratch/notes.txt',
                      status: 'A',
                      added: 7,
                      removed: 0,
                      binary: false,
                      large: false
                    }
                  ]
                },
                files: [
                  {
                    path: 'src/orders/sync.ts',
                    status: 'M',
                    added: 24,
                    removed: 6,
                    binary: false,
                    large: false,
                    workers: ['W1'],
                    reviewed: false,
                    changedSinceReviewed: false
                  },
                  {
                    path: 'src/orders/retry.ts',
                    status: 'A',
                    added: 58,
                    removed: 0,
                    binary: false,
                    large: false,
                    workers: ['W1', 'W3'],
                    reviewed: true,
                    changedSinceReviewed: false
                  },
                  {
                    path: 'src/legacy.ts',
                    status: 'D',
                    added: 0,
                    removed: 41,
                    binary: false,
                    large: false,
                    workers: ['You'],
                    reviewed: false,
                    changedSinceReviewed: false
                  },
                  {
                    path: 'src/orders/queue.ts',
                    oldPath: 'src/queue.ts',
                    status: 'R',
                    added: 2,
                    removed: 1,
                    binary: false,
                    large: false,
                    workers: ['W1'],
                    reviewed: false,
                    changedSinceReviewed: true
                  }
                ]
              },
              {
                projectId: 'web',
                projectName: 'web',
                branch: 'arc/fix-order-sync',
                push: { state: 'never' },
                uncommitted: { state: 'other-branch', current: 'feature/login' },
                files: [
                  {
                    path: 'public/logo.png',
                    status: 'M',
                    added: 0,
                    removed: 0,
                    binary: true,
                    large: false,
                    workers: ['W1'],
                    reviewed: false,
                    changedSinceReviewed: false
                  }
                ]
              }
            ]}
          />
        </Panel>
        <SessionHeader
          header={{
            ...previewHeader,
            id: 'preview-auto',
            autoApprove: true,
            allowRules: [
              { id: 'r1', text: 'mkdir in /opt/app', category: 'outside_worktree', createdAt: 1 },
              {
                id: 'r2',
                text: 'npm install -g typescript',
                category: 'global_install',
                createdAt: 2
              }
            ]
          }}
          groupName="Sample group"
          onback={() => {}}
        />
        <div><Button onclick={() => (newSessionOpen = true)}>Open New Session dialog</Button></div>
        <div><Button onclick={() => (dirtyOpen = true)}>Open Unsaved changes dialog</Button></div>
        <div class="flex flex-wrap gap-2">
          <Button onclick={() => (undoPreview = 'plain')}>Open Undo dialog</Button>
          <Button onclick={() => (undoPreview = 'warning')}>Open Undo dialog with warning</Button>
          <Button onclick={() => (undoPreview = 'busy')}>Open Undo dialog, busy</Button>
        </div>
        {#if undoPreview}
          <UndoDialog
            repoName="api"
            branch="arc/fix-order-sync"
            path="src/orders/sync.ts"
            activeWorkers={undoPreview === 'plain' ? [] : ['W2', 'W3']}
            busy={undoPreview === 'busy'}
            onconfirm={async () => null}
            oncancel={() => (undoPreview = null)}
            ondone={() => (undoPreview = null)}
          />
        {/if}
        <Panel as="div" class="max-w-xs">
          <ReviewFileList
            selected={null}
            onselect={() => {}}
            repos={[
              {
                projectId: 'p-noremote',
                projectName: 'tools',
                branch: 'arc/fix-order-sync',
                push: { state: 'no-remote' },
                uncommitted: { state: 'unavailable' },
                files: []
              },
              {
                projectId: 'p-waiting',
                projectName: 'docs',
                branch: 'arc/fix-order-sync',
                push: { state: 'waiting' },
                uncommitted: { state: 'unavailable' },
                files: []
              },
              {
                projectId: 'p-one',
                projectName: 'infra',
                branch: 'arc/fix-order-sync',
                push: {
                  state: 'pushed',
                  remote: 'origin',
                  at: Date.now() - 3 * 86400000,
                  newerCommits: 1
                },
                uncommitted: { state: 'unavailable' },
                files: []
              }
            ]}
          />
        </Panel>
        <div class="flex flex-wrap gap-2">
          <Button onclick={() => (pushPreview = 'idle')}>Open Push dialog</Button>
          <Button onclick={() => (pushPreview = 'busy')}>Open Push dialog, busy</Button>
          <Button onclick={() => (pushPreview = 'error')}>Open Push dialog, failed</Button>
        </div>
        {#if pushPreview}
          <PushDialog
            repoName="api"
            remote="origin"
            command="git push -u origin arc/fix-order-sync"
            busy={pushPreview === 'busy'}
            failure={pushPreview === 'error'
              ? {
                  code: 'PUSH_FAILED',
                  details: {
                    reason:
                      "To /srv/git/api.git\n ! [rejected]        arc/fix-order-sync -> arc/fix-order-sync (non-fast-forward)\nerror: failed to push some refs to '/srv/git/api.git'\nhint: Updates were rejected because the tip of your current branch is behind"
                  }
                }
              : undefined}
            onconfirm={async () => null}
            oncancel={() => (pushPreview = null)}
            ondone={() => (pushPreview = null)}
          />
        {/if}
        {#if dirtyOpen}
          <DirtyTreeDialog
            token="preview"
            repos={[
              {
                projectId: 'api',
                name: 'api',
                files: ['src/orders/sync.ts', 'README.md', 'notes.txt'],
                fileCount: 14
              },
              { projectId: 'web', name: 'web', files: ['src/App.svelte'], fileCount: 1 }
            ]}
            onresolved={() => (dirtyOpen = false)}
          />
        {/if}
        <div>
          <Button onclick={() => (deleteSessionOpen = true)}>Open Delete Session dialog</Button>
        </div>
        {#if deleteSessionOpen}
          <DeleteSessionDialog
            session={{ id: 'preview', name: 'Sample session' }}
            onclose={() => (deleteSessionOpen = false)}
          />
        {/if}
        {#if newSessionOpen}
          <NewSessionDialog
            groupId="preview"
            onclose={() => (newSessionOpen = false)}
            oncreated={() => (newSessionOpen = false)}
          />
        {/if}
      </div>
    {/snippet}
    {@render block('Session parts', sessionParts)}

    {#snippet toastsDemo()}
      <div class="flex flex-wrap gap-2">
        {#each ['info', 'success', 'warning', 'error'] as const as kind (kind)}
          <Button onclick={() => showToast(kind)}>Show {kind} toast</Button>
        {/each}
      </div>
    {/snippet}
    {@render block('Toasts', toastsDemo)}

    {#snippet saves()}
      <div class="flex flex-wrap gap-6">
        {#each saveStates as status (status)}
          <div class="flex flex-col gap-1">
            <span class="font-mono text-xs text-text-muted">{status}</span>
            <SaveIndicator {status} />
          </div>
        {/each}
      </div>
    {/snippet}
    {@render block('Save indicator', saves)}

    {#snippet rows()}
      <div class="flex flex-col gap-1" role="listbox" aria-label="Sample rows">
        {#each [0, 1, 2] as i (i)}
          <button
            type="button"
            class="hud-row"
            data-selected={selectedRow === i}
            onclick={() => (selectedRow = i)}
          >
            Sample row W{i + 1} api-retry · via brain
          </button>
        {/each}
      </div>
      <div class="flex flex-wrap gap-1" role="tablist" aria-label="Sample tabs">
        {#each ['Overview', 'Files', 'Notes'] as tab (tab)}
          <button
            type="button"
            role="tab"
            class="hud-tab"
            aria-selected={selectedTab === tab}
            onclick={() => (selectedTab = tab)}>{tab}</button
          >
        {/each}
      </div>
    {/snippet}
    {@render block('Rows and tabs', rows)}

    {#snippet misc()}
      <EmptyState text="Sample: nothing here yet." />
      <div class="relative h-12">
        <Button onclick={() => (menuOpen = !menuOpen)}>Sample menu</Button>
        {#if menuOpen}
          <Menu label="Sample menu" onkeydown={(e) => e.key === 'Escape' && (menuOpen = false)}>
            <MenuItem
              onclick={() => {
                lastAction = 'menu: Rename'
                menuOpen = false
              }}>Rename</MenuItem
            >
            <MenuItem
              danger
              onclick={() => {
                lastAction = 'menu: Delete'
                menuOpen = false
              }}>Delete</MenuItem
            >
          </Menu>
        {/if}
      </div>
      <StorageProgress progress={{ phase: 'copying', done: 3, total: 8 }} />
    {/snippet}
    {@render block('Empty state, menu, storage progress', misc)}

    {#snippet modalDemo()}
      <Button onclick={() => (modalOpen = true)}>Open sample modal</Button>
    {/snippet}
    {@render block('Modal', modalDemo)}

    {#snippet attention()}
      <div class="flex items-center gap-4">
        <AttentionBadge count={attentionCount} onclick={() => (attentionOpen = true)} />
        <Button onclick={() => (structuredOpen = true)}>Open structured questions</Button>
        <p class="font-mono text-xs text-text-muted" data-last-action>
          Sample last action: {lastAction}
        </p>
      </div>
    {/snippet}
    {@render block('Attention', attention)}
  </main>
</div>

{#if restartOpen}
  <RestartPrompt preview={restartSample} onlater={() => (restartOpen = false)} />
{/if}

{#if modalOpen}
  <Modal
    title="Sample modal"
    onsubmit={() => (modalOpen = false)}
    oncancel={() => (modalOpen = false)}
  >
    <p class="text-sm">Sample modal body.</p>
    <div class="flex justify-end gap-2">
      <Button onclick={() => (modalOpen = false)}>Cancel</Button>
      <Button variant="primary" type="submit">Confirm</Button>
    </div>
  </Modal>
{/if}

<AttentionDialog
  open={attentionOpen}
  {requests}
  onApprove={(id) => (lastAction = `approve ${id}`)}
  onDeny={(id) => (lastAction = `deny ${id}`)}
  onAlwaysAllow={(id) => (lastAction = `always allow ${id}`)}
  onAnswer={(id, text) => (lastAction = `answer ${id}: ${text}`)}
  onClose={() => (attentionOpen = false)}
/>

<AttentionDialog
  open={structuredOpen}
  requests={structuredRequests}
  onApprove={() => {}}
  onDeny={() => {}}
  onAlwaysAllow={() => {}}
  onAnswer={() => {}}
  onAnswerStructured={(id, answers) => {
    lastAction = `answers ${id}: ${JSON.stringify(answers)}`
  }}
  onDecline={(id) => {
    lastAction = `decline ${id}`
  }}
  onClose={() => (structuredOpen = false)}
/>

<div class="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
  {#each toastList as toast (toast.id)}
    {@const style = messageKinds[toast.kind]}
    <div
      role="status"
      data-kind={toast.kind}
      class="pointer-events-auto flex max-w-sm items-start gap-2 rounded-hud border bg-surface-raised px-3 py-2 text-sm text-text shadow-lg {style.border}"
    >
      <Icon name={style.icon} size={18} class="mt-0.5 {style.text}" />
      <span>{toast.message}</span>
    </div>
  {/each}
</div>
