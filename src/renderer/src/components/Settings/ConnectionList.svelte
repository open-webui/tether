<script lang="ts">
  /* eslint-disable svelte/no-at-html-tags -- Icons are static SVG imports from Iconoir. */
  import i18n from '../../lib/i18n'
  import { onMount } from 'svelte'
  import { tooltip } from '../../actions/tooltip'
  import PlusIcon from 'iconoir/icons/plus.svg?raw'
  import XmarkIcon from 'iconoir/icons/xmark.svg?raw'
  import Switch from '../common/Switch.svelte'
  import ConnectionModal from './ConnectionModal.svelte'
  import type { ProviderConnectionInfo } from '../../../../shared/providerConnections'
  import type { ToolConnectionInfo } from '../../../../shared/toolConnections'

  let {
    type,
    title,
    description,
    add,
    editTitle,
    placeholder,
    suggestions = [],
    warning = true
  }: {
    type: 'openai' | 'terminal'
    title: string
    description: string
    add: string
    editTitle: string
    placeholder: string
    suggestions?: { label: string; url: string }[]
    warning?: boolean
  } = $props()

  interface Row {
    id: string | null
    name: string
    url: string
    hasKey: boolean
    enabled: boolean
  }

  const id = $props.id()
  let rows = $state<Row[]>([])
  let draft = $state<Row | null>(null)
  let key = $state('')
  let clearKey = $state(false)
  let persistent = $state(true)
  let loaded = $state(false)
  let busy = $state(false)
  let error = $state('')

  function setRows(saved: (ProviderConnectionInfo | ToolConnectionInfo)[]): void {
    rows = saved.filter(
      (item): item is typeof item & { url: string } => item.type === type && 'url' in item
    )
  }

  onMount(() => {
    let disposed = false
    void Promise.all([
      type === 'openai' ? window.api.listProviderConnections() : window.api.listToolConnections(),
      window.api.listConnections()
    ])
      .then(([saved, state]) => {
        if (disposed) return
        setRows(saved)
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

  function edit(row?: Row): void {
    draft = row ? { ...row } : { id: null, name: '', url: '', hasKey: false, enabled: true }
    key = ''
    clearKey = false
    error = ''
  }

  function close(): void {
    draft = null
    key = ''
    error = ''
  }

  async function update(
    action: () => Promise<(ProviderConnectionInfo | ToolConnectionInfo)[]>
  ): Promise<void> {
    busy = true
    error = ''
    try {
      setRows(await action())
      close()
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
    } finally {
      busy = false
    }
  }

  function save(row: Row, sendKey = false): Promise<void> {
    const input = {
      name: row.name,
      url: row.url,
      enabled: row.enabled,
      ...(sendKey && (key || clearKey) ? { key: clearKey ? '' : key } : {})
    }
    return update(() =>
      type === 'openai'
        ? window.api.saveProviderConnection(row.id, { ...input, type })
        : window.api.saveToolConnection(row.id, { ...input, type })
    )
  }

  function remove(row: Row): Promise<void> {
    return update(() =>
      type === 'openai'
        ? window.api.removeProviderConnection(row.id!)
        : window.api.removeToolConnection(row.id!)
    )
  }
</script>

<section class="flex flex-col" aria-label={title}>
  <div class="setting-row">
    <div>
      <div class="setting-label">{title}</div>
      <p class="setting-description">{description}</p>
    </div>
    <button
      class="env-action icon-button shrink-0"
      aria-label={add}
      use:tooltip={add}
      disabled={!loaded || busy}
      onclick={() => edit()}
    >
      <span aria-hidden="true" class="inline-flex size-[14px] [&>svg]:size-full"
        >{@html PlusIcon}</span
      >
    </button>
  </div>
  <div class="flex flex-col gap-2">
    {#each rows as row, index (row.id)}
      <div class="flex min-w-0 items-center gap-2">
        <button
          class="setting-label min-w-0 flex-1 truncate text-left"
          disabled={busy}
          onclick={() => edit(row)}
          title={row.url}
        >
          {row.name}
          <span class="setting-description">· {row.url}</span>
        </button>
        <Switch
          checked={row.enabled}
          disabled={busy}
          label={$i18n.t('settings.connections.rowEnable', { number: index + 1 })}
          onchange={(enabled) => save({ ...row, enabled })}
        />
        <button
          class="env-action icon-button"
          disabled={busy}
          aria-label={$i18n.t('settings.connections.rowRemove', { number: index + 1 })}
          use:tooltip={$i18n.t('common.remove')}
          onclick={() => remove(row)}
        >
          <span aria-hidden="true" class="inline-flex size-[12px] [&>svg]:size-full"
            >{@html XmarkIcon}</span
          >
        </button>
      </div>
    {/each}
  </div>
  {#if draft}
    <ConnectionModal title={draft.id ? editTitle : add} {busy} onClose={close}>
      <form
        class="flex flex-col gap-3"
        onsubmit={(event) => {
          event.preventDefault()
          if (draft) void save(draft, true)
        }}
      >
        <label
          >{$i18n.t('common.name')}<input
            class="env-input"
            bind:value={draft.name}
            required
            maxlength="100"
            disabled={busy}
            autocomplete="off"
          /></label
        >
        <label
          >URL<input
            class="env-input"
            bind:value={draft.url}
            required
            {placeholder}
            disabled={busy}
            list={suggestions.length ? `${id}-urls` : undefined}
            autocomplete="off"
            spellcheck="false"
            autocapitalize="off"
            oninput={() => {
              const suggestion = suggestions.find((item) => item.url === draft?.url.trim())
              if (suggestion && draft && !draft.name.trim()) draft.name = suggestion.label
            }}
          /></label
        >
        {#if suggestions.length}
          <datalist id={`${id}-urls`}
            >{#each suggestions as suggestion (suggestion.url)}<option
                value={suggestion.url}
                label={suggestion.label}
              ></option>{/each}</datalist
          >
        {/if}
        <label
          >{$i18n.t('settings.connections.key')}<input
            class="env-input"
            type="password"
            bind:value={key}
            disabled={busy || clearKey}
            placeholder={draft.hasKey ? $i18n.t('settings.connections.savedKey') : ''}
            autocomplete="off"
          /></label
        >
        <p class="setting-description">{$i18n.t('settings.tools.keyHelp')}</p>
        {#if draft.hasKey}
          <div class="flex items-center justify-between">
            <span>{$i18n.t('settings.tools.clearKey')}</span><Switch
              checked={clearKey}
              disabled={busy}
              label={$i18n.t('settings.tools.clearKey')}
              onchange={(value) => {
                clearKey = value
              }}
            />
          </div>
        {/if}
        <div class="flex items-center justify-between">
          <span>{$i18n.t('settings.tools.enabled')}</span><Switch
            checked={draft.enabled}
            disabled={busy}
            label={$i18n.t('settings.tools.enabled')}
            onchange={(value) => {
              if (draft) draft.enabled = value
            }}
          />
        </div>
        {#if warning && !persistent}<p class="setting-description">
            {$i18n.t('settings.connections.storageWarning')}
          </p>{/if}
        {#if error}<p role="alert" class="setting-description break-words select-text">
            {error}
          </p>{/if}
        <div class="flex justify-end gap-3">
          <button type="button" class="env-action" disabled={busy} onclick={close}
            >{$i18n.t('common.cancel')}</button
          >
          <button type="submit" class="env-action" disabled={busy}>{$i18n.t('common.save')}</button>
        </div>
      </form>
    </ConnectionModal>
  {/if}
  {#if error && !draft}<p role="alert" class="setting-description mt-2 break-words select-text">
      {error}
    </p>{/if}
</section>

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
  .setting-description {
    font-size: 11px;
    line-height: 16px;
    color: oklch(0.51 0 0);
    margin-top: 2px;
  }
  :global(.dark) .setting-label {
    color: #fff;
  }
  :global(.dark) .setting-description {
    color: oklch(0.77 0 0);
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
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
  }
  .env-input:disabled,
  .env-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    line-height: 16px;
  }
</style>
