<script lang="ts">
  import type { RunningOn } from '@shared/types/provider'
  import type { BrainState } from '@shared/types/session'
  import ProviderTag from '../ui/ProviderTag.svelte'
  import Panel from '../ui/Panel.svelte'
  import RingLogo from '../ui/RingLogo.svelte'

  let { state, runningOn }: { state: BrainState; runningOn?: RunningOn } = $props()
  const thinking = $derived(state === 'thinking')
  const waiting = $derived(state === 'waiting')
  const label = $derived(thinking ? 'Thinking' : waiting ? 'Waiting on you' : 'Idle')
</script>

<Panel
  scroll
  title="Brain"
  tone={thinking ? 'accent' : waiting ? 'attention' : 'default'}
  class="h-full min-h-0"
>
  <div class="flex items-center gap-3 px-3 py-3" data-brain-card data-state={state}>
    <RingLogo size={36} spinning={thinking} />
    <span class="text-sm tracking-label text-text uppercase" role="status">{label}</span>
    {#if runningOn}<ProviderTag
        {runningOn}
        class="ml-auto min-w-0 truncate"
        data-brain-model
      />{/if}
  </div>
</Panel>
