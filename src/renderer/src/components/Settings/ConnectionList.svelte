<script lang="ts">
  /* eslint-disable svelte/no-at-html-tags -- Icons are static SVG imports from Iconoir. */
  import i18n from '../../lib/i18n'
  import { onMount } from 'svelte'
  import { tooltip } from '../../actions/tooltip'
  import PlusIcon from 'iconoir/icons/plus.svg?raw'
  import XmarkIcon from 'iconoir/icons/xmark.svg?raw'
  import Switch from '../common/Switch.svelte'
  import type { UserConnectionType } from '../../../../shared/userConnections'

  // One list of the user's own connections, edited inline like environment variables.
  // The tab or section decides the type.
  let {
    type,
    title,
    description,
    add,
    placeholder,
    suggestions = [],
    warning = true
  }: {
    type: UserConnectionType
    title: string
    description: string
    add: string
    placeholder: string
    suggestions?: { label: string; url: string }[]
    warning?: boolean
  } = $props()

  interface Row {
    // null until the row has a name and URL and is saved.
    id: string | null
    name: string
    url: string
    // Blank keeps the saved key.
    key: string
    hasKey: boolean
    enabled: boolean
  }

  const id = $props.id()
  let rows = $state<Row[]>([])
  let persistent = $state(true)
  let loaded = $state(false)
  let error = $state('')
  let saving: Promise<unknown> = Promise.resolve()

  function focusNew(node: HTMLInputElement, empty: boolean): void {
    if (empty) node.focus()
  }

  onMount(() => {
    let disposed = false
    void Promise.all([window.api.listUserConnections(), window.api.listConnections()])
      .then(([saved, state]) => {
        if (disposed) return
        rows = saved
          .filter((connection) => connection.type === type)
          .map((connection) => ({ ...connection, key: '' }))
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

  // Saves run one at a time, so a new row is created once and later edits use its id.
  function queue(action: () => Promise<void>, failed?: () => void): void {
    error = ''
    const operation = saving.catch(() => {}).then(action)
    saving = operation
    void operation.catch((cause) => {
      failed?.()
      error = String(cause).replace(/^Error: /, '')
    })
  }

  function save(row: Row, sendKey = false, failed?: () => void): void {
    queue(async () => {
      if (!rows.includes(row) || (row.id === null && (!row.name.trim() || !row.url.trim()))) return
      const saved = await window.api.saveUserConnection(row.id, {
        name: row.name,
        type,
        url: row.url,
        enabled: row.enabled,
        ...(sendKey || row.id === null ? { key: row.key } : {})
      })
      const connection =
        row.id === null
          ? saved.find((item) => item.type === type && !rows.some((other) => other.id === item.id))
          : saved.find((item) => item.id === row.id)
      if (connection) {
        row.id = connection.id
        row.hasKey = connection.hasKey
      }
    }, failed)
  }

  function remove(index: number): void {
    const row = rows[index]
    rows = rows.filter((_, i) => i !== index)
    const saved = row.id
    if (saved) queue(() => window.api.removeUserConnection(saved).then(() => {}))
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
      disabled={!loaded || rows.some((row) => row.id === null)}
      onclick={() => {
        rows = [...rows, { id: null, name: '', url: '', key: '', hasKey: false, enabled: true }]
      }}
    >
      <span aria-hidden="true" class="inline-flex size-[14px] [&>svg]:size-full"
        >{@html PlusIcon}</span
      >
    </button>
  </div>
  {#if suggestions.length}
    <datalist id={`${id}-urls`}>
      {#each suggestions as suggestion (suggestion.url)}
        <option value={suggestion.url} label={suggestion.label}></option>
      {/each}
    </datalist>
  {/if}
  <div class="flex flex-col gap-2">
    {#each rows as row, index (row)}
      <div class="env-row">
        <input
          dir="auto"
          class="env-input"
          aria-label={$i18n.t('settings.connections.rowName', { number: index + 1 })}
          placeholder={$i18n.t('common.name')}
          maxlength="100"
          autocomplete="off"
          title={row.name}
          use:focusNew={row.id === null && !row.name}
          bind:value={row.name}
          onchange={() => save(row)}
        />
        <input
          dir="ltr"
          class="env-input"
          aria-label={$i18n.t('settings.connections.rowURL', { number: index + 1 })}
          {placeholder}
          list={suggestions.length ? `${id}-urls` : undefined}
          autocomplete="off"
          title={row.url}
          bind:value={row.url}
          spellcheck="false"
          autocapitalize="off"
          oninput={() => {
            const suggestion = suggestions.find((item) => item.url === row.url.trim())
            if (suggestion && !row.name.trim()) row.name = suggestion.label
          }}
          onchange={() => save(row)}
        />
        <input
          dir="ltr"
          class="env-input"
          type="password"
          aria-label={$i18n.t('settings.connections.rowKey', { number: index + 1 })}
          placeholder={row.hasKey
            ? $i18n.t('settings.connections.savedKey')
            : $i18n.t('settings.connections.key')}
          autocomplete="off"
          bind:value={row.key}
          spellcheck="false"
          autocapitalize="off"
          onchange={() => save(row, true)}
        />
        <Switch
          checked={row.enabled}
          label={$i18n.t('settings.connections.rowEnable', { number: index + 1 })}
          onchange={(enabled) => {
            row.enabled = enabled
            save(row, false, () => (row.enabled = !enabled))
          }}
        />
        <button
          class="env-action icon-button"
          aria-label={$i18n.t('settings.connections.rowRemove', { number: index + 1 })}
          use:tooltip={$i18n.t('common.remove')}
          onclick={() => remove(index)}
        >
          <span aria-hidden="true" class="inline-flex size-[12px] [&>svg]:size-full"
            >{@html XmarkIcon}</span
          >
        </button>
      </div>
    {/each}
  </div>
  {#if warning && loaded && !persistent}<p class="setting-description mt-2">
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
  .env-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr) minmax(0, 1fr) auto auto;
    gap: 8px;
    align-items: center;
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
  @media (max-width: 540px) {
    .env-row {
      grid-template-columns: minmax(0, 1fr) auto auto;
    }
    .env-input:nth-child(-n + 2) {
      grid-column: 1 / -1;
    }
  }
</style>
