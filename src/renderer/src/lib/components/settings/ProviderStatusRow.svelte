<script lang="ts">
  import { providerName } from '@shared/provider-label'
  import type { ProviderId, ProviderStatus } from '@shared/types/provider'
  import Button from '../ui/Button.svelte'
  import CommandCopy from './CommandCopy.svelte'

  interface Props {
    provider: ProviderId
    /** Undefined until the provider's first check has finished. */
    status?: ProviderStatus
    busy?: boolean
    oncheck: () => void
  }

  let { provider, status, busy = false, oncheck }: Props = $props()

  const name = $derived(providerName(provider))

  const text = $derived.by(() => {
    if (!status) return `${name} · checking…`
    switch (status.state) {
      case 'ok':
        return status.account?.kind === 'api_key'
          ? `${name} · API key (not your subscription)`
          : `${name} · signed in`
      case 'signed_out':
        return `${name} · not signed in`
      case 'missing':
        return `${name} · not installed`
      case 'unsupported':
        return `${name} · needs an update`
      case 'error':
        return `${name} · could not check`
    }
  })

  const dot = $derived(
    !status
      ? 'bg-text-muted'
      : status.state === 'ok' && status.account?.kind !== 'api_key'
        ? 'bg-success'
        : status.state === 'error'
          ? 'bg-danger'
          : 'bg-attention'
  )

  const command = $derived(status && status.state !== 'ok' ? status.loginCommand : undefined)
</script>

<li class="flex flex-col gap-2 rounded-hud border border-border p-3" data-provider={provider}>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex min-w-0 items-center gap-2">
      <span class="size-2 shrink-0 rounded-full {dot}" aria-hidden="true"></span>
      <p class="font-semibold text-text-bright" aria-live="polite" data-provider-status>{text}</p>
      {#if status?.version}
        <span class="font-mono text-xs text-text-muted" data-provider-version>{status.version}</span
        >
      {/if}
    </div>
    <Button {busy} ariaLabel="Check {name} again" onclick={oncheck}>Check again</Button>
  </div>
  {#if status?.message}
    <p class="text-sm text-text-muted">{status.message}</p>
  {/if}
  {#if command}
    <CommandCopy {command} marker="data-provider-command" />
  {/if}
  {#if status?.updateAvailable && status.latestVersion}
    <div class="flex flex-col gap-2" data-provider-update>
      <p class="text-sm text-text">
        Update available: {status.version ?? 'unknown'} → {status.latestVersion}
      </p>
      {#if status.updateCommand}
        <CommandCopy command={status.updateCommand} marker="data-provider-update-command" />
      {/if}
    </div>
  {/if}
</li>
