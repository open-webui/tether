<script lang="ts">
  import i18n from '../../lib/i18n'
  import ConnectionList from './ConnectionList.svelte'
</script>

<ConnectionList
  type="openai"
  description={$i18n.t('settings.models.description')}
  empty={$i18n.t('settings.models.empty')}
  add={$i18n.t('settings.models.add')}
  placeholder="http://127.0.0.1:11434/v1"
  suggestions={[
    { name: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
    { name: 'LM Studio', url: 'http://127.0.0.1:1234/v1' }
  ]}
/>
