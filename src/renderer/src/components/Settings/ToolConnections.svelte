<script lang="ts">
  /* eslint-disable svelte/no-at-html-tags -- Icons are static SVG imports from Iconoir. */
  import PlusIcon from 'iconoir/icons/plus.svg?raw'
  import XmarkIcon from 'iconoir/icons/xmark.svg?raw'
  import NavArrowDownIcon from 'iconoir/icons/nav-arrow-down.svg?raw'
  import { tooltip } from '../../actions/tooltip'
  import { onMount } from 'svelte'
  import i18n from '../../lib/i18n'
  import Switch from '../common/Switch.svelte'
  import ConnectionModal from './ConnectionModal.svelte'
  import type { ToolConnectionInfo } from '../../../../shared/toolConnections'

  let connections = $state<ToolConnectionInfo[]>([])
  let loaded = $state(false)
  let persistent = $state(true)
  let busy = $state(false)
  let error = $state('')
  let editing = $state(false)
  let id = $state<string | null>(null)
  let name = $state('')
  let type = $state<'openapi' | 'mcp'>('mcp')
  let transport = $state<'stdio' | 'streamable-http'>('streamable-http')
  let command = $state('')
  let args = $state('[]')
  let cwd = $state('')
  let env = $state('')
  let url = $state('')
  let key = $state('')
  let clearKey = $state(false)
  let enabled = $state(false)

  onMount(() => {
    let disposed = false
    void Promise.all([window.api.listToolConnections(), window.api.listConnections()])
      .then(([items, state]) => {
        if (disposed) return
        connections = items.filter((item) => item.type !== 'terminal')
        persistent = state.persistentCredentials
        loaded = true
      })
      .catch((cause) => {
        if (!disposed) error = String(cause)
      })
    return () => {
      disposed = true
    }
  })

  function edit(item?: ToolConnectionInfo): void {
    id = item?.id ?? null
    name = item?.name ?? ''
    type = item?.type === 'openapi' ? 'openapi' : 'mcp'
    transport = item?.type === 'mcp' ? item.transport : 'streamable-http'
    command = item?.type === 'mcp' && item.transport === 'stdio' ? item.command : ''
    args = JSON.stringify(item?.type === 'mcp' && item.transport === 'stdio' ? item.args : [])
    cwd = item?.type === 'mcp' && item.transport === 'stdio' ? (item.cwd ?? '') : ''
    url = item && 'url' in item ? item.url : ''
    enabled = item?.enabled ?? false
    env = ''
    key = ''
    clearKey = false
    error = ''
    editing = true
  }

  function close(): void {
    editing = false
    key = ''
    env = ''
    error = ''
  }

  async function update(action: () => Promise<ToolConnectionInfo[]>): Promise<void> {
    busy = true
    error = ''
    try {
      connections = (await action()).filter((item) => item.type !== 'terminal')
      editing = false
      key = ''
      env = ''
    } catch (cause) {
      error = String(cause).replace(/^Error: /, '')
    } finally {
      busy = false
    }
  }

  async function save(): Promise<void> {
    await update(() =>
      window.api.saveToolConnection(id, {
        name,
        enabled,
        ...(type === 'openapi'
          ? { type: 'openapi', url, ...(key || clearKey ? { key: clearKey ? '' : key } : {}) }
          : transport === 'stdio'
            ? {
                type: 'mcp',
                transport: 'stdio',
                command,
                args: JSON.parse(args),
                cwd,
                ...(env.trim() ? { env: JSON.parse(env) } : {})
              }
            : {
                type: 'mcp',
                transport: 'streamable-http',
                url,
                ...(key || clearKey ? { key: clearKey ? '' : key } : {})
              })
      })
    )
  }
</script>

<section aria-label={$i18n.t('settings.integrations.tools')}>
  <div class="setting-row">
    <div>
      <p class="setting-label">{$i18n.t('settings.integrations.tools')}</p>
      <p class="description">{$i18n.t('settings.tools.description')}</p>
    </div>
    <button
      class="action icon-button shrink-0"
      aria-label={$i18n.t('settings.integrations.addTool')}
      use:tooltip={$i18n.t('settings.integrations.addTool')}
      disabled={!loaded || busy || editing}
      onclick={() => edit()}
    >
      <span aria-hidden="true" class="inline-flex size-[14px] [&>svg]:size-full"
        >{@html PlusIcon}</span
      >
    </button>
  </div>
  <div class="flex flex-col gap-2">
    {#each connections as item (item.id)}
      <div class="flex min-w-0 items-center gap-2">
        <button
          class="setting-label min-w-0 flex-1 truncate text-left"
          disabled={busy}
          onclick={() => edit(item)}
        >
          {item.name}
          <span class="description"
            >· {item.type === 'mcp'
              ? `MCP · ${item.transport === 'stdio' ? 'stdio' : 'HTTP'}`
              : 'OpenAPI'}</span
          >
        </button>
        <Switch
          checked={item.enabled}
          disabled={busy || editing}
          label={$i18n.t('settings.tools.enable', { name: item.name })}
          onchange={(enabled) =>
            update(() =>
              window.api.saveToolConnection(item.id, { ...$state.snapshot(item), enabled })
            )}
        />
        <button
          class="action icon-button"
          aria-label={$i18n.t('common.remove')}
          use:tooltip={$i18n.t('common.remove')}
          disabled={busy}
          onclick={() => update(() => window.api.removeToolConnection(item.id))}
        >
          <span aria-hidden="true" class="inline-flex size-[12px] [&>svg]:size-full"
            >{@html XmarkIcon}</span
          >
        </button>
      </div>
    {/each}
  </div>
  {#if editing}
    <ConnectionModal
      title={id
        ? $i18n.t('settings.integrations.editTool')
        : $i18n.t('settings.integrations.addTool')}
      {busy}
      onClose={close}
    >
      <form
        class="flex flex-col gap-3"
        onsubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label
          >{$i18n.t('common.name')}<input
            bind:value={name}
            required
            maxlength="100"
            disabled={busy}
          /></label
        >
        <label>
          {$i18n.t('settings.tools.type')}
          <span class="select-wrapper"
            ><select bind:value={type} disabled={busy} aria-label={$i18n.t('settings.tools.type')}>
              <option value="mcp">MCP</option>
              <option value="openapi">OpenAPI</option>
            </select><span aria-hidden="true" class="select-chevron inline-flex [&>svg]:size-full"
              >{@html NavArrowDownIcon}</span
            ></span
          >
        </label>
        {#if type === 'mcp'}
          <label
            >{$i18n.t('settings.mcp.transport')}
            <span class="select-wrapper"
              ><select
                bind:value={transport}
                disabled={busy}
                aria-label={$i18n.t('settings.mcp.transport')}
              >
                <option value="streamable-http">Streamable HTTP</option>
                <option value="stdio">{$i18n.t('settings.mcp.stdio')}</option>
              </select><span aria-hidden="true" class="select-chevron inline-flex [&>svg]:size-full"
                >{@html NavArrowDownIcon}</span
              ></span
            >
          </label>
        {/if}
        {#if type === 'mcp' && transport === 'stdio'}
          <label
            >{$i18n.t('settings.mcp.command')}<input
              bind:value={command}
              required
              disabled={busy}
              placeholder="/path/to/executable"
              spellcheck="false"
            /></label
          >
          <label
            >{$i18n.t('settings.mcp.args')}<textarea
              bind:value={args}
              required
              disabled={busy}
              rows="2"
              spellcheck="false"
            ></textarea></label
          >
          <label
            >{$i18n.t('settings.mcp.cwd')}<input
              bind:value={cwd}
              disabled={busy}
              placeholder="/path/to/workspace"
              spellcheck="false"
            /></label
          >
          <label
            >{$i18n.t('settings.mcp.env')}<textarea
              bind:value={env}
              disabled={busy}
              rows="2"
              placeholder={'{"API_KEY": "..."}'}
              autocomplete="off"
              spellcheck="false"
            ></textarea></label
          >
          <p class="description">{$i18n.t('settings.mcp.envHelp')}</p>
          <p class="description">{$i18n.t('settings.mcp.access')}</p>
        {:else}
          <label
            >URL<input
              bind:value={url}
              required
              disabled={busy}
              placeholder={type === 'mcp' ? 'http://127.0.0.1:8000/mcp' : 'http://127.0.0.1:8000'}
              spellcheck="false"
            /></label
          >
          <label
            >{$i18n.t('settings.connections.key')}<input
              bind:value={key}
              type="password"
              disabled={busy || clearKey}
              autocomplete="off"
            /></label
          >
          <p class="description">{$i18n.t('settings.tools.keyHelp')}</p>
          {#if id && connections.find((item) => item.id === id)?.hasKey}
            <div class="flex items-center justify-between text-xs">
              <span>{$i18n.t('settings.tools.clearKey')}</span>
              <Switch
                checked={clearKey}
                disabled={busy}
                label={$i18n.t('settings.tools.clearKey')}
                onchange={(value) => {
                  clearKey = value
                }}
              />
            </div>
          {/if}
        {/if}
        <div class="flex items-center justify-between">
          <span>{$i18n.t('settings.tools.enabled')}</span>
          <Switch
            checked={enabled}
            disabled={busy}
            label={$i18n.t('settings.tools.enabled')}
            onchange={(value) => {
              enabled = value
            }}
          />
        </div>
        <div class="flex justify-end gap-3">
          <button type="button" class="action" disabled={busy} onclick={close}
            >{$i18n.t('common.cancel')}</button
          >
          <button type="submit" class="action" disabled={busy}>{$i18n.t('common.save')}</button>
        </div>
        {#if id && type === 'mcp'}<p class="description">{$i18n.t('settings.mcp.restart')}</p>{/if}
        {#if error}<p role="alert" class="description break-words select-text">{error}</p>{/if}
      </form>
    </ConnectionModal>
  {/if}
  {#if loaded && !persistent}<p class="description mt-2">
      {$i18n.t('settings.tools.storage')}
    </p>{/if}
  {#if error && !editing}<p role="alert" class="description mt-2 break-words select-text">
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
  }
  .description {
    margin-top: 2px;
    font-size: 11px;
    line-height: 16px;
    color: oklch(0.51 0 0);
  }
  :global(.dark) .description {
    color: oklch(0.77 0 0);
  }
  .action {
    font-size: 12px;
    line-height: 16px;
    color: oklch(0.69 0 0);
  }
  .action:hover {
    color: var(--text-primary);
  }
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    line-height: 16px;
  }
  input,
  textarea,
  select {
    width: 100%;
    min-width: 0;
    height: 28px;
    border: 1px solid var(--input-border);
    border-radius: 8px;
    padding: 0 8px;
    background: var(--input-background);
    font-size: 12px;
    line-height: 16px;
    color: oklch(0.42 0 0);
    outline: none;
  }
  textarea {
    height: auto;
    padding-block: 6px;
    resize: vertical;
  }
  input::placeholder,
  textarea::placeholder {
    color: oklch(0.85 0 0);
  }
  input:focus,
  textarea:focus,
  select:focus {
    border-color: var(--focus);
  }
  :global(.dark) input,
  :global(.dark) textarea,
  :global(.dark) select {
    color: oklch(0.85 0 0);
  }
  :global(.dark) input::placeholder,
  :global(.dark) textarea::placeholder {
    color: oklch(0.42 0 0);
  }
  .select-wrapper {
    position: relative;
    display: inline-flex;
    max-width: 100%;
  }
  select {
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
</style>
