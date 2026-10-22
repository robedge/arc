<script lang="ts">
  import type { AgentSetup } from '@shared/types/usage'
  import TokenCount from '../ui/TokenCount.svelte'

  interface Props {
    setup: AgentSetup
    /** Input + cache write + cache read for the agent: what setup and the work add up to. */
    inputTotal: number
  }

  let { setup, inputTotal }: Props = $props()

  const total = $derived(Math.max(1, setup.setupTokens + setup.work))
  const arcPct = $derived((Math.min(setup.arcSetupTokens, setup.setupTokens) / total) * 100)
  const otherPct = $derived(
    ((setup.setupTokens - Math.min(setup.arcSetupTokens, setup.setupTokens)) / total) * 100
  )
  const workPct = $derived((setup.work / total) * 100)
</script>

<div class="space-y-1.5 text-xs" data-setup-split>
  <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5">
    <dt class="text-text-muted">Arc's additions</dt>
    <dd class="text-text" data-setup-arc>
      {#if setup.arcAdditionsPerRequest === null}
        Not measured yet
      {:else}
        about <TokenCount value={setup.arcAdditionsPerRequest} suffix="per request" />
      {/if}
    </dd>
    <dt class="text-text-muted">Total fixed setup</dt>
    <dd class="text-text" data-setup-fixed>
      {#if setup.fixedSetupPerRequest === null}
        Not measured yet
      {:else}
        <TokenCount value={setup.fixedSetupPerRequest} suffix="per request" />
        · <TokenCount value={setup.setupTokens} suffix="in all" />
      {/if}
    </dd>
    <dt class="text-text-muted">The work</dt>
    <dd class="text-text" data-setup-work><TokenCount value={setup.work} /></dd>
    <dt class="text-text-muted">Input in all</dt>
    <dd class="text-text" data-setup-input><TokenCount value={inputTotal} /></dd>
  </dl>
  <div
    class="flex h-2 w-full overflow-hidden rounded-control border border-border"
    aria-hidden="true"
    data-setup-bar
  >
    <span class="bg-accent" style:width="{arcPct}%"></span>
    <span class="bg-line-faint" style:width="{otherPct}%"></span>
    <span class="bg-surface-selected" style:width="{workPct}%"></span>
  </div>
  <p class="text-text-muted">
    Everything sent before any work: Arc's additions, the provider's own instructions and your
    tools.
  </p>
</div>
