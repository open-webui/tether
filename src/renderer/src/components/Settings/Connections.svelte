<script lang="ts">
  /* eslint-disable svelte/no-at-html-tags -- Icons are static SVG imports from Iconoir. */
  import i18n from '../../lib/i18n'
  import { onMount } from 'svelte'
  import Switch from '../common/Switch.svelte'
  import NavArrowDownIcon from 'iconoir/icons/nav-arrow-down.svg?raw'
  import {
    userConnectionTypes,
    type UserConnectionInfo,
    type UserConnectionType
  } from '../../../../shared/userConnections'

  const id = $props.id()
  const placeholders: Record<UserConnectionType, string> = {
    openai: 'http://localhost:11434/v1',
    openapi: 'http://localhost:8000',
    terminal: 'http://localhost:8000'
  }

  let connections = $state<UserConnectionInfo[]>([])
  let persistent = $state(true)
  let loaded = $state(false)
  let busy = $state(false)
  let error = $state('')
  // undefined: no form open; null: adding a connection.
  let editing = $state<string | null | undefined>(undefined)
  let name = $state('')
  let type = $state<UserConnectionType>('openai')
  let url = $state('')
  let key = $state('')
  const current = $derived(connections.find((connection) => connection.id === editing))
  const typeLabels = $derived<Record<UserConnectionType, string>>({
    openai: $i18n.t('settings.connections.types.openai'),
    openapi: $i18n.t('settings.connections.types.openapi'),
    terminal: 'Open Terminal'
  })

  onMount(() => {
    let disposed = false
    void Promise.all([window.api.listUserConnections(), window.api.listConnections()])
      .then(([saved, state]) => {
        if (disposed) return
        connections = saved
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
      connections = await action()
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
    type = connection?.type ?? 'openai'
    url = connection?.url ?? ''
    key = ''
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
</script>

{#snippet form()}
  <form
    class="connection-form"
    aria-label={current
      ? $i18n.t('settings.connections.edit', { name: current.name })
      : $i18n.t('settings.connections.add')}
    onsubmit={submit}
  >
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
    <label class="setting-label" for={`${id}-type`}>{$i18n.t('settings.connections.type')}</label>
    <div class="select-wrapper">
      <select id={`${id}-type`} class="env-input setting-select" bind:value={type} disabled={busy}>
        {#each userConnectionTypes as value (value)}
          <option {value}>{typeLabels[value]}</option>
        {/each}
      </select>
      <span aria-hidden="true" class="select-chevron inline-flex [&>svg]:size-full"
        >{@html NavArrowDownIcon}</span
      >
    </div>
    <label class="setting-label" for={`${id}-url`}>{$i18n.t('settings.connections.url')}</label>
    <input
      id={`${id}-url`}
      class="env-input"
      dir="ltr"
      placeholder={placeholders[type]}
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      bind:value={url}
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
    <div class="col-span-2 flex justify-end gap-3 pt-1">
      <button type="button" class="env-action" disabled={busy} onclick={() => (editing = undefined)}
        >{$i18n.t('common.cancel')}</button
      >
      <button type="submit" class="env-action" disabled={busy || !name.trim() || !url.trim()}
        >{busy ? $i18n.t('common.saving') : $i18n.t('common.save')}</button
      >
    </div>
  </form>
{/snippet}

<div class="flex flex-col">
  <div class="flex items-start justify-between gap-4 py-[7px]">
    <p class="setting-description mt-0!">{$i18n.t('settings.connections.description')}</p>
    <button
      class="env-action shrink-0"
      disabled={!loaded || busy || editing !== undefined}
      onclick={() => edit()}>{$i18n.t('settings.connections.add')}</button
    >
  </div>
  {#if editing === null}{@render form()}{/if}
  {#each connections as connection (connection.id)}
    <div class="setting-row">
      <div>
        <div class="setting-label truncate" dir="auto">{connection.name}</div>
        <p class="setting-description truncate" title={connection.url}>
          {typeLabels[connection.type]} · <span dir="ltr">{connection.url}</span>
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <button
          class="env-action"
          aria-label={$i18n.t('settings.connections.edit', { name: connection.name })}
          disabled={busy || editing !== undefined}
          onclick={() => edit(connection)}>{$i18n.t('common.edit')}</button
        >
        <button
          class="env-action"
          aria-label={$i18n.t('settings.connections.remove', { name: connection.name })}
          disabled={busy}
          onclick={async () => {
            if (await run(() => window.api.removeUserConnection(connection.id)))
              if (editing === connection.id) editing = undefined
          }}>{$i18n.t('common.remove')}</button
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
      <p class="setting-description py-[7px]">{$i18n.t('settings.connections.empty')}</p>
    {/if}
  {/each}
  {#if loaded && !persistent}<p class="setting-description mt-2!">
      {$i18n.t('settings.connections.storageWarning')}
    </p>{/if}
  {#if error}<p
      class="mt-2 text-[11px] leading-[16px] text-red-600 dark:text-red-400 break-words select-text"
      role="alert"
    >
      {error}
    </p>{/if}
</div>

<style>
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
  .connection-form {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 8px 12px;
    align-items: center;
    padding-block: 7px;
  }
  .select-wrapper {
    position: relative;
    display: flex;
    min-width: 0;
  }
  .env-input.setting-select {
    appearance: none;
    padding-inline: 10px 32px;
  }
  .select-chevron {
    position: absolute;
    pointer-events: none;
    inset-inline-end: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 14px;
    height: 14px;
    color: oklch(0.77 0 0);
  }
  :global(.dark) .select-chevron {
    color: oklch(0.69 0 0);
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
