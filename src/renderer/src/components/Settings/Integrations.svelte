<script lang="ts">
  import i18n from '../../lib/i18n'
  import ConnectionList from './ConnectionList.svelte'
</script>

<div class="flex flex-col gap-3">
  <ConnectionList
    type="openapi"
    title={$i18n.t('settings.integrations.tools')}
    description={$i18n.t('settings.integrations.toolsDesc')}
    add={$i18n.t('settings.integrations.addTool')}
    placeholder="http://127.0.0.1:8000"
    warning={false}
  />
  <ConnectionList
    type="terminal"
    title={$i18n.t('settings.integrations.terminals')}
    description={$i18n.t('settings.integrations.terminalsDesc')}
    add={$i18n.t('settings.integrations.addTerminal')}
    placeholder="http://127.0.0.1:8000"
  />
</div>
