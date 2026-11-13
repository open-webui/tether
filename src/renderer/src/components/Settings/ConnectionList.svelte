<script lang="ts">
  import i18n from '../../lib/i18n'
  import { onMount } from 'svelte'
  import Switch from '../common/Switch.svelte'
  import type {
    UserConnectionCheck,
    UserConnectionInfo,
    UserConnectionType
  } from '../../../../shared/userConnections'

  // One list of the user's own connections. The tab or section decides the type.
  let {
    type,
    title = '',
    description,
    empty,
    add,
    placeholder,
    suggestions = [],
    warning = true
  }: {
    type: UserConnectionType
    title?: string
    description: string
    empty: string
    add: string
    placeholder: string
    suggestions?: { name: string; url: string }[]
    warning?: boolean
  } = $props()

  const id = $props.id()
  let all = $state<UserConnectionInfo[]>([])
  let persistent = $state(true)
  let loaded = $state(false)
  let busy = $state(false)
  let error = $state('')
  // undefined: no form open; null: adding a connection.
  let editing = $state<string | null | undefined>(undefined)
  let name = $state('')
  let url = $state('')
  let key = $state('')
  let verifying = $state(false)
  let check = $state<UserConnectionCheck | null>(null)
  const connections = $derived(all.filter((connection) => connection.type === type))
  const current = $derived(connections.find((connection) => connection.id === editing))

  onMount(() => {
    let disposed = false
    void Promise.all([window.api.listUserConnections(), window.api.listConnections()])
      .then(([saved, state]) => {
        if (disposed) return
        all = saved
        persistent = state.persistentCredentials
        loaded = true
      })
      .catch((cause) => {
        if (!disposed) error = String(cause).replace(/^Error: /, '')
      })
    return () => {
      disposed = true
    }
  })

  async function run(action: () => Promise<UserConnectionInfo[]>): Promise<boolean> {
    busy = true
    error = ''
    try {
      all = await action()
      return true
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
      return false
    } finally {
      busy = false
    }
  }

  function edit(connection?: UserConnectionInfo): void {
    editing = connection?.id ?? null
    name = connection?.name ?? ''
    url = connection?.url ?? ''
    key = ''
    check = null
    error = ''
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const saved = await run(() =>
      window.api.saveUserConnection(editing ?? null, {
        name,
        type,
        url,
        enabled: current?.enabled ?? true,
        // A blank key keeps the saved one.
        ...(key || !current ? { key } : {})
      })
    )
    if (saved) editing = undefined
  }

  function save(
    connection: UserConnectionInfo,
    change: { enabled?: boolean; key?: string }
  ): Promise<boolean> {
    return run(() =>
      window.api.saveUserConnection(connection.id, {
        name: connection.name,
        type: connection.type,
        url: connection.url,
        enabled: connection.enabled,
        ...change
      })
    )
  }

  async function verify(): Promise<void> {
    verifying = true
    check = null
    error = ''
    try {
      check = await window.api.verifyUserConnection({ type, url, key, id: current?.id })
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
    } finally {
      verifying = false
    }
  }

  function describe(result: UserConnectionCheck): string {
    if (result.ok)
      return result.models === undefined
        ? $i18n.t('settings.connections.verified')
        : $i18n.t('settings.connections.verifiedModels', { count: result.models })
    return $i18n.t(`settings.connections.errors.${result.error}`, { status: result.status })
  }
</script>

{#snippet form()}
  <form
    class="connection-form"
    aria-label={current ? $i18n.t('settings.connections.edit', { name: current.name }) : add}
    onsubmit={submit}
  >
    {#if !current && suggestions.length}
      <span class="setting-label">{$i18n.t('settings.connections.suggestions')}</span>
      <div class="flex flex-wrap gap-3">
        {#each suggestions as suggestion (suggestion.name)}
          <button
            type="button"
            class="env-action"
            disabled={busy}
            onclick={() => {
              name = suggestion.name
              url = suggestion.url
              check = null
            }}>{suggestion.name}</button
          >
        {/each}
      </div>
    {/if}
    <label class="setting-label" for={`${id}-name`}>{$i18n.t('common.name')}</label>
    <input
      id={`${id}-name`}
      class="env-input"
      dir="auto"
      maxlength="100"
      autocomplete="off"
      bind:value={name}
      disabled={busy}
    />
    <label class="setting-label" for={`${id}-url`}>{$i18n.t('settings.connections.url')}</label>
    <input
      id={`${id}-url`}
      class="env-input"
      dir="ltr"
      {placeholder}
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      bind:value={url}
      oninput={() => (check = null)}
      disabled={busy}
    />
    <label class="setting-label" for={`${id}-key`}>{$i18n.t('settings.connections.key')}</label>
    <div class="flex min-w-0 items-center gap-3">
      <input
        id={`${id}-key`}
        class="env-input"
        dir="ltr"
        type="password"
        placeholder={current?.hasKey
          ? $i18n.t('settings.connections.keySaved')
          : $i18n.t('common.optional')}
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        bind:value={key}
        oninput={() => (check = null)}
        disabled={busy}
      />
      {#if current?.hasKey}
        <button
          type="button"
          class="env-action shrink-0"
          disabled={busy}
          onclick={() => current && save(current, { key: '' })}
          >{$i18n.t('settings.connections.removeKey')}</button
        >
      {/if}
    </div>
    <div class="col-span-2 flex flex-wrap items-center justify-between gap-3 pt-1">
      <div class="flex min-w-0 items-center gap-3">
        <button
          type="button"
          class="env-action shrink-0"
          disabled={busy || verifying || !url.trim()}
          onclick={verify}
          >{verifying
            ? $i18n.t('settings.connections.verifying')
            : $i18n.t('settings.connections.verify')}</button
        >
        {#if check}<span
            class="check"
            class:check-failed={!check.ok}
            role={check.ok ? 'status' : 'alert'}>{describe(check)}</span
          >{/if}
      </div>
      <div class="flex items-center gap-3">
        {#if current}
          <button
            type="button"
            class="env-action"
            disabled={busy}
            onclick={async () => {
              if (current && (await run(() => window.api.removeUserConnection(current.id))))
                editing = undefined
            }}>{$i18n.t('settings.connections.delete')}</button
          >
        {/if}
        <button
          type="button"
          class="env-action"
          disabled={busy}
          onclick={() => (editing = undefined)}>{$i18n.t('common.cancel')}</button
        >
        <button type="submit" class="env-action" disabled={busy || !name.trim() || !url.trim()}
          >{busy ? $i18n.t('common.saving') : $i18n.t('common.save')}</button
        >
      </div>
    </div>
  </form>
{/snippet}

<section class="flex flex-col" aria-label={title || undefined}>
  {#if title}<h3 class="section-label">{title}</h3>{/if}
  <div class="flex items-start justify-between gap-4">
    <p class="setting-description mt-0!">{description}</p>
    {#if connections.length}
      <button
        class="env-action shrink-0"
        disabled={!loaded || busy || editing !== undefined}
        onclick={() => edit()}>{add}</button
      >
    {/if}
  </div>
  {#if editing === null}{@render form()}{/if}
  {#each connections as connection (connection.id)}
    <div class="setting-row">
      <div>
        <div class="setting-label truncate" dir="auto">{connection.name}</div>
        <p class="setting-description truncate" dir="ltr" title={connection.url}>
          {connection.url}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <button
          class="env-action"
          aria-label={$i18n.t('settings.connections.edit', { name: connection.name })}
          disabled={busy || editing !== undefined}
          onclick={() => edit(connection)}>{$i18n.t('common.edit')}</button
        >
        <Switch
          checked={connection.enabled}
          label={$i18n.t('settings.connections.enable', { name: connection.name })}
          disabled={busy}
          onchange={(enabled) => save(connection, { enabled })}
        />
      </div>
    </div>
    {#if editing === connection.id}{@render form()}{/if}
  {:else}
    {#if loaded && editing === undefined}
      <div class="empty">
        <p class="setting-description mt-0!">{empty}</p>
        <button class="env-action" disabled={busy} onclick={() => edit()}>{add}</button>
      </div>
    {/if}
  {/each}
  {#if warning && loaded && !persistent}<p class="setting-description mt-2!">
      {$i18n.t('settings.connections.storageWarning')}
    </p>{/if}
  {#if error}<p
      class="mt-2 text-[11px] leading-[16px] text-red-600 dark:text-red-400 break-words select-text"
      role="alert"
    >
      {error}
    </p>{/if}
</section>

<style>
  .section-label {
    margin-bottom: 8px;
    font-size: 12px;
    font-weight: 500;
  }
  .setting-row {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-block: 7px;
  }
  .setting-row > :first-child {
    min-width: 0;
  }
  .setting-label {
    font-size: 12px;
    line-height: 16px;
    font-weight: 400;
    color: #171717;
  }
  :global(.dark) .setting-label {
    color: #fff;
  }
  .setting-description {
    margin-top: 2px;
    font-size: 11px;
    line-height: 16px;
    color: oklch(0.51 0 0);
  }
  :global(.dark) .setting-description {
    color: oklch(0.77 0 0);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    padding: 20px 16px;
    border: 1px dashed oklch(0.92 0 0);
    border-radius: 12px;
    text-align: center;
  }
  :global(.dark) .empty {
    border-color: #ffffff14;
  }
  .connection-form {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 8px 12px;
    align-items: center;
    padding-block: 7px;
  }
  .check {
    min-width: 0;
    font-size: 11px;
    line-height: 16px;
    color: oklch(0.51 0 0);
  }
  :global(.dark) .check {
    color: oklch(0.77 0 0);
  }
  .check-failed {
    color: rgb(220 38 38);
  }
  :global(.dark) .check-failed {
    color: rgb(248 113 113);
  }
  .env-input {
    height: 28px;
    min-width: 0;
    width: 100%;
    border-radius: 8px;
    border: 1px solid oklch(0.94 0 0 / 0.5);
    background: oklch(0.98 0 0 / 0.4);
    padding: 0 8px;
    font-size: 12px;
    line-height: 16px;
    color: oklch(0.42 0 0);
    outline: none;
  }
  .env-input::placeholder {
    color: oklch(0.85 0 0);
  }
  .env-input:focus {
    border-color: #60a5fa;
  }
  :global(.dark) .env-input {
    border-color: #ffffff0a;
    background: #ffffff08;
    color: oklch(0.85 0 0);
  }
  :global(.dark) .env-input::placeholder {
    color: oklch(0.42 0 0);
  }
  :global(.dark) .env-input:focus {
    border-color: #3b82f6;
  }
  .env-action {
    font-size: 12px;
    line-height: 16px;
    color: oklch(0.69 0 0);
    transition: color 150ms;
  }
  .env-action:hover {
    color: oklch(0.2 0 0);
  }
  :global(.dark) .env-action:hover {
    color: white;
  }
  .env-input:disabled,
  .env-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
