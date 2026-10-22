<script lang="ts">
  import type { BypassReport } from '@shared/types/provider'
  import Button from '../ui/Button.svelte'

  interface Props {
    /** Null until main has answered. */
    report: BypassReport | null
    busy?: boolean
    onrefresh: () => void
  }

  let { report, busy = false, onrefresh }: Props = $props()

  /** Brain and Workers differ (the user switched hooks off for one), so each gets its own list. */
  const byRole = $derived.by(() => {
    const roles = report?.claudeHookEventsByRole
    if (!roles) return null
    const same =
      roles.brain.length === roles.workers.length &&
      roles.brain.every((e, i) => roles.workers[i] === e)
    return same ? null : roles
  })

  const cursor = $derived.by(() => {
    const c = report?.cursor
    if (!c) return null
    const mode = c.approvalMode && c.approvalMode !== 'allowlist' ? c.approvalMode : undefined
    if (c.allowEntries.length === 0 && c.hookEvents.length === 0 && !mode) return null
    return { allowEntries: c.allowEntries, hookEvents: c.hookEvents, approvalMode: mode }
  })

  const hasEntries = $derived(
    report !== null &&
      (report.claudeHookEvents.length > 0 ||
        report.codexAllowPrefixes.length > 0 ||
        cursor !== null)
  )
</script>

{#if report && hasEntries}
  <section
    aria-labelledby="bypass-title"
    class="flex flex-col gap-3 rounded-hud border border-attention/55 bg-attention/10 p-4"
    data-bypass-warning
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <h3 id="bypass-title" class="text-base font-semibold text-text-bright">
        Your hooks and Codex rules can skip Arc's approvals
      </h3>
      <Button {busy} ariaLabel="Check hooks and Codex rules again" onclick={onrefresh}>
        Check again
      </Button>
    </div>
    <p class="text-sm text-text-muted">
      Arc loads your own hooks and Codex rules but does not remove them. When one of them says
      "allow", the agent can run the action without Arc asking you. Under Agent loading you can
      switch your hooks off for the brain or for the workers.
    </p>
    {#if report.claudeHookEvents.length > 0}
      <div class="flex flex-col gap-1" data-bypass-hooks>
        <h4
          id="bypass-hooks"
          class="text-xs font-semibold tracking-label text-text-muted uppercase"
        >
          Claude hooks that can allow
        </h4>
        {#if byRole}
          {#each [{ role: 'brain', name: 'Brain', events: byRole.brain }, { role: 'workers', name: 'Workers', events: byRole.workers }] as group (group.role)}
            <div class="flex flex-wrap items-center gap-2" data-bypass-role={group.role}>
              <span class="w-20 text-sm text-text-muted">{group.name}</span>
              {#if group.events.length === 0}
                <span class="text-sm text-text-muted">None</span>
              {:else}
                <ul class="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="{group.name} hooks">
                  {#each group.events as event (event)}
                    <li
                      class="rounded-control border border-border bg-surface-code px-2 py-1 font-mono text-sm text-text"
                    >
                      {event}
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/each}
        {:else}
          <ul class="m-0 flex list-none flex-wrap gap-2 p-0" aria-labelledby="bypass-hooks">
            {#each report.claudeHookEvents as event (event)}
              <li
                class="rounded-control border border-border bg-surface-code px-2 py-1 font-mono text-sm text-text"
              >
                {event}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    {#if report.codexAllowPrefixes.length > 0}
      <div class="flex flex-col gap-1" data-bypass-prefixes>
        <h4
          id="bypass-prefixes"
          class="text-xs font-semibold tracking-label text-text-muted uppercase"
        >
          Codex allow rules Arc does not cover
        </h4>
        <ul class="m-0 flex list-none flex-wrap gap-2 p-0" aria-labelledby="bypass-prefixes">
          {#each report.codexAllowPrefixes as prefix (prefix)}
            <li
              class="rounded-control border border-border bg-surface-code px-2 py-1 font-mono text-sm break-all text-text"
            >
              {prefix}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if cursor}
      <div class="flex flex-col gap-1" data-bypass-cursor>
        <h4
          id="bypass-cursor"
          class="text-xs font-semibold tracking-label text-text-muted uppercase"
        >
          Cursor settings that can skip Arc's approvals
        </h4>
        {#if cursor.approvalMode}
          <p class="text-sm text-text-muted" data-bypass-cursor-mode>
            Approval mode is <span class="font-mono text-text">{cursor.approvalMode}</span>, so
            Cursor does not ask before running commands.
          </p>
        {/if}
        {#if cursor.allowEntries.length > 0}
          <ul
            class="m-0 flex list-none flex-wrap gap-2 p-0"
            aria-label="Cursor allow entries"
            data-bypass-cursor-allow
          >
            {#each cursor.allowEntries as entry (entry)}
              <li
                class="rounded-control border border-border bg-surface-code px-2 py-1 font-mono text-sm break-all text-text"
              >
                {entry}
              </li>
            {/each}
          </ul>
        {/if}
        {#if cursor.hookEvents.length > 0}
          <ul
            class="m-0 flex list-none flex-wrap gap-2 p-0"
            aria-label="Cursor hooks that can allow"
            data-bypass-cursor-hooks
          >
            {#each cursor.hookEvents as event (event)}
              <li
                class="rounded-control border border-border bg-surface-code px-2 py-1 font-mono text-sm text-text"
              >
                {event}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    <p class="text-sm text-text-muted" data-bypass-covered>
      Arc's own rules already cover {report.codexRulesCovered} of your Codex allow rules.
    </p>
  </section>
{/if}
