<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { ModelRef } from '@shared/types/provider'
  import type { SessionMode } from '@shared/types/session'
  import { messageFor } from '../../ipc/messages'
  import { attachments } from '../../stores/attachments.svelte'
  import { settings } from '../../stores/settings.svelte'
  import AttachField from './AttachField.svelte'
  import BrainPicker from './BrainPicker.svelte'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Modal from '../ui/Modal.svelte'
  import Radio from '../ui/Radio.svelte'
  import Select from '../ui/Select.svelte'
  import TextArea from '../ui/TextArea.svelte'

  interface Props {
    groupId: string
    onclose: () => void
    oncreated: (sessionId: string) => void
  }

  let { groupId, onclose, oncreated }: Props = $props()

  const LIMITS = [1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: String(n) }))

  // One draft per opening of the dialog: its own key, so two openings never share attachments.
  const attachKey = `new:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  /** The session exists (or the dialog was left through it): the staged files are main's now. */
  let finished = false
  const readyFiles = $derived(attachments.ready(attachKey))
  const staging = $derived(attachments.isStaging(attachKey))

  let request = $state('')
  let mode = $state<SessionMode>('plan_first')
  let limit = $state('3')
  /** The user's pick; until then the dialog shows the Settings brain default. */
  let picked = $state<ModelRef | null>(null)
  const brain = $derived<ModelRef>(
    picked ?? settings.values?.['providers.brain'] ?? { provider: 'claude', model: 'sonnet' }
  )
  let attempted = $state(false)
  let busy = $state(false)
  let serverError = $state<string | null>(null)

  const requestError = $derived(
    attempted && request.trim() === '' && readyFiles.length === 0
      ? 'Enter a request for the brain.'
      : null
  )

  // Any way out that is not a started session abandons the draft (Cancel, Escape, the parent
  // closing the dialog): main deletes the staged files, as the text is dropped.
  onDestroy(() => {
    if (!finished) void attachments.discard(attachKey)
  })

  function cancel(): void {
    void attachments.discard(attachKey)
    onclose()
  }

  function created(sessionId: string): void {
    finished = true
    attempted = false
    attachments.clear(attachKey)
    oncreated(sessionId)
  }

  async function onsubmit(): Promise<void> {
    if (busy || staging) return
    attempted = true
    if (request.trim() === '' && readyFiles.length === 0) return
    busy = true
    serverError = null
    const draftId = attachments.draftIdFor(attachKey)
    const attachmentIds = readyFiles
      .map((item) => item.id)
      .filter((id): id is string => id !== undefined)
    try {
      const res = await window.arc.invoke('sessions:create', {
        groupId,
        request: request.trim(),
        mode,
        workerLimit: Number(limit),
        // Only a changed brain is sent; main saves it as the new default.
        ...(draftId !== null && attachmentIds.length > 0 ? { draftId, attachmentIds } : {}),
        ...(picked ? { brainModel: $state.snapshot(picked) } : {})
      })
      if (!res.ok) {
        serverError = messageFor(res.error)
        if (res.error.code === 'ATTACHMENT_UNREADABLE' && res.error.details?.name) {
          attachments.markUnreadable(attachKey, res.error.details.name)
        }
      } else {
        created(res.data.sessionId)
      }
    } finally {
      busy = false
    }
  }
</script>

<Modal title="New session" {onsubmit} oncancel={cancel} {busy}>
  <AttachField
    {attachKey}
    provider={brain.provider}
    disabled={busy}
    onerror={(message) => (serverError = message)}
  >
    <div class="min-w-0 flex-1">
      <TextArea
        id="new-session-request"
        label="Request"
        bind:value={request}
        error={requestError}
        oninput={() => (serverError = null)}
      />
    </div>
    {#snippet actions()}{/snippet}
  </AttachField>
  <fieldset class="flex flex-col">
    <legend class="text-sm font-medium text-text">Mode</legend>
    <Radio
      id="new-session-mode-plan"
      name="new-session-mode"
      label="Plan-first"
      description="The brain proposes a plan and waits for your approval."
      value="plan_first"
      bind:group={mode}
    />
    <Radio
      id="new-session-mode-auto"
      name="new-session-mode"
      label="Autonomous"
      description="The brain starts workers without asking."
      value="autonomous"
      bind:group={mode}
    />
  </fieldset>
  <BrainPicker id="new-session-brain" value={brain} onchange={(ref) => (picked = ref)} />
  <Select id="new-session-limit" label="Worker limit" bind:value={limit} options={LIMITS} />
  {#if serverError}<ErrorText message={serverError} />{/if}
  <div class="flex justify-end gap-2">
    <Button onclick={cancel}>Cancel</Button>
    <Button
      type="submit"
      variant="primary"
      {busy}
      disabled={staging}
      ariaDescribedby={staging ? 'new-session-staging-hint' : undefined}>Start</Button
    >
    {#if staging}
      <span id="new-session-staging-hint" class="sr-only">Waiting for attachments</span>
    {/if}
  </div>
</Modal>
