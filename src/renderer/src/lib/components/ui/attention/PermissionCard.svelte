<script lang="ts">
  import type { AttentionTool } from '@shared/types/session'
  import Button from '../Button.svelte'

  /** Longer argument text is cut here until the user asks for all of it. */
  const ARGS_PREVIEW_CHARS = 400
  const ARGS_PREVIEW_LINES = 10

  interface Props {
    id: string
    from: string
    action: string
    reason?: string
    /** An MCP call's server, tool and arguments, or the access a Codex request asks for. */
    tool?: AttentionTool
    onApprove: (id: string) => void
    onDeny: (id: string) => void
    onAlwaysAllow?: (id: string) => void
    /** Offers "Always allow this in this session"; the step-in bar turns it off. */
    allowAlways?: boolean
  }

  let {
    id,
    from,
    action,
    reason,
    tool,
    onApprove,
    onDeny,
    onAlwaysAllow = () => {},
    allowAlways = true
  }: Props = $props()

  const mcp = $derived(tool?.kind === 'mcp' ? tool : undefined)
  const access = $derived(tool?.kind === 'permissions' ? tool : undefined)
  // More access than the sandbox gives is decided each time and never remembered.
  const showAlways = $derived(allowAlways && access === undefined)

  const argsText = $derived(
    mcp && Object.keys(mcp.args).length > 0 ? JSON.stringify(mcp.args, null, 2) : ''
  )
  const argsLong = $derived(
    argsText.length > ARGS_PREVIEW_CHARS || argsText.split('\n').length > ARGS_PREVIEW_LINES
  )
  let expanded = $state(false)
  const argsShown = $derived.by(() => {
    if (!argsLong || expanded) return argsText
    const lines = argsText.split('\n').slice(0, ARGS_PREVIEW_LINES).join('\n')
    return (lines.length > ARGS_PREVIEW_CHARS ? lines.slice(0, ARGS_PREVIEW_CHARS) : lines) + '\n…'
  })
</script>

<article
  class="flex flex-col gap-3 rounded-hud border border-attention/55 bg-attention/10 p-4"
  data-kind="permission"
  aria-label="Permission request from {from}"
>
  <div class="flex flex-col gap-1">
    <p class="text-xs font-semibold tracking-label text-attention uppercase">Permission</p>
    <p class="text-sm text-text-muted">{from}</p>
  </div>
  {#if mcp}
    <p class="text-sm text-text">Wants to use a tool from one of your MCP servers</p>
    <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-mcp>
      <dt class="text-text-muted">Server</dt>
      <dd class="m-0 font-mono break-all text-text" data-mcp-server>{mcp.server}</dd>
      <dt class="text-text-muted">Tool</dt>
      <dd class="m-0 font-mono break-all text-text" data-mcp-tool>{mcp.tool}</dd>
    </dl>
    <div class="flex flex-col gap-1">
      <p class="text-xs font-semibold tracking-label text-text-muted uppercase" id="args-{id}">
        Arguments
      </p>
      {#if argsText === ''}
        <p class="text-sm text-text-muted" data-mcp-args-empty>No arguments.</p>
      {:else}
        <pre
          class="m-0 overflow-x-auto rounded-control border border-border bg-surface-code p-3 font-mono text-sm break-words whitespace-pre-wrap text-text"
          aria-labelledby="args-{id}"
          data-mcp-args>{argsShown}</pre>
        {#if argsLong}
          <div>
            <Button
              ariaLabel={expanded ? 'Show fewer arguments' : 'Show all arguments'}
              onclick={() => (expanded = !expanded)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </Button>
          </div>
        {/if}
      {/if}
    </div>
  {:else if access}
    <p class="text-sm text-text">Wants more access than its sandbox gives</p>
    {#if access.reason}<p class="m-0 text-sm text-text" data-access-reason>{access.reason}</p>{/if}
    <dl class="m-0 flex flex-col gap-2 text-sm" data-access>
      {#if access.read && access.read.length > 0}
        <div>
          <dt class="text-text-muted">Read</dt>
          <dd class="m-0">
            <ul class="m-0 list-none p-0 font-mono break-all text-text" aria-label="Paths to read">
              {#each access.read as path (path)}<li>{path}</li>{/each}
            </ul>
          </dd>
        </div>
      {/if}
      {#if access.write && access.write.length > 0}
        <div>
          <dt class="text-text-muted">Write</dt>
          <dd class="m-0">
            <ul class="m-0 list-none p-0 font-mono break-all text-text" aria-label="Paths to write">
              {#each access.write as path (path)}<li>{path}</li>{/each}
            </ul>
          </dd>
        </div>
      {/if}
      {#if access.network !== undefined}
        <div>
          <dt class="text-text-muted">Network</dt>
          <dd class="m-0 text-text" data-access-network>
            {access.network ? 'Wants network access' : 'No network access'}
          </dd>
        </div>
      {/if}
    </dl>
  {:else}
    <p class="text-sm text-text">Wants to run</p>
    <pre
      class="m-0 overflow-x-auto rounded-control border border-border bg-surface-code p-3 font-mono text-sm break-words whitespace-pre-wrap text-text"
      data-action>{action}</pre>
  {/if}
  {#if reason}<p class="text-sm text-attention-text" data-reason>{reason}</p>{/if}
  <div class="flex flex-wrap gap-2">
    <Button variant="attention" onclick={() => onApprove(id)}>Approve</Button>
    <Button variant="secondary" onclick={() => onDeny(id)}>Deny</Button>
    {#if showAlways}
      <Button variant="secondary" onclick={() => onAlwaysAllow(id)}
        >Always allow this in this session</Button
      >
    {/if}
  </div>
</article>
