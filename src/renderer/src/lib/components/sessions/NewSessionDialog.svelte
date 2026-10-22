<script lang="ts">
  import type { ModelRef } from '@shared/types/provider'
  import type { DirtyRepo, ResolveDirtyResult, SessionMode } from '@shared/types/session'
  import { messageFor } from '../../ipc/messages'
  import { settings } from '../../stores/settings.svelte'
  import BrainPicker from './BrainPicker.svelte'
  import DirtyTreeDialog from './DirtyTreeDialog.svelte'
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
  /** A repository has unsaved changes: nothing exists yet; the answer decides whether it starts. */
  let dirty = $state<{ token: string; repos: DirtyRepo[]; message?: string } | null>(null)

  const requestError = $derived(
    attempted && request.trim() === '' ? 'Enter a request for the brain.' : null
  )

  async function onsubmit(): Promise<void> {
    if (busy) return
    attempted = true
    if (request.trim() === '') return
    busy = true
    serverError = null
    try {
      const res = await window.harness.invoke('sessions:create', {
        groupId,
        request: request.trim(),
        mode,
        workerLimit: Number(limit),
        // Only a changed brain is sent; main saves it as the new default.
        ...(picked ? { brainModel: $state.snapshot(picked) } : {})
      })
      if (!res.ok) {
        serverError = messageFor(res.error)
      } else if ('sessionId' in res.data) {
        oncreated(res.data.sessionId)
      } else if ('needsDirtyChoice' in res.data) {
        dirty = res.data.needsDirtyChoice
      } else {
        serverError = "Couldn't start the session. Please try again."
      }
    } finally {
      busy = false
    }
  }

  function onresolved(result: ResolveDirtyResult): void {
    if (result.status === 'ready') oncreated(result.sessionId)
    else if (result.status === 'carry-failed') {
      dirty = { ...result.needsDirtyChoice, message: result.message }
    } else dirty = null
  }
</script>

{#if dirty}
  <DirtyTreeDialog
    token={dirty.token}
    repos={dirty.repos}
    {...dirty.message ? { message: dirty.message } : {}}
    {onresolved}
  />
{:else}
  <Modal title="New session" {onsubmit} oncancel={onclose} {busy}>
    <TextArea
      id="new-session-request"
      label="Request"
      bind:value={request}
      error={requestError}
      oninput={() => (serverError = null)}
    />
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
      <Button onclick={onclose}>Cancel</Button>
      <Button type="submit" variant="primary" {busy}>Start</Button>
    </div>
  </Modal>
{/if}
