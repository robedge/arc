<script lang="ts">
  import type { RunningOn } from '@shared/types/provider'
  import type { BrainState, WorkerView } from '@shared/types/session'
  import { workerTerminals } from '../../stores/worker-terminals.svelte'
  import BrainCard from './BrainCard.svelte'
  import WorkerCard from './WorkerCard.svelte'

  interface Props {
    brainState: BrainState
    brainRunningOn?: RunningOn
    workers: readonly WorkerView[]
  }

  let { brainState, brainRunningOn, workers }: Props = $props()

  /** Newest first, right under the brain. */
  const newestFirst = $derived([...workers].sort((a, b) => b.number - a.number))
</script>

<div class="flex min-h-0 flex-col gap-3 overflow-y-auto" data-agent-column>
  <div class="shrink-0"><BrainCard state={brainState} runningOn={brainRunningOn} /></div>
  {#each newestFirst as worker (worker.id)}
    <div class="shrink-0">
      <WorkerCard
        {worker}
        onopen={(id) => workerTerminals.open(id)}
        ondetails={(id) => workerTerminals.showDetails(id)}
      />
    </div>
  {/each}
</div>
