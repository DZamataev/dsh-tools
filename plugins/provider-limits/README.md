# provider-limits (DSH)

Плашка в доке под полем ввода: 5-часовой **остаток** каждого провайдера через `|`, по клику — панель со всеми окнами, сбросами, аккаунтами и статусом апстримов (Anthropic, OpenAI). Порт `hermes-tools/plugins/provider-limits`.

- Host (`index.js`, `normalize.js`): маршрут `GET /provider-limits/limits` за стандартной проверкой `connection.requestRejection`; `?refresh=1` обходит кэш. Провайдеры берутся из живого конфига `providers` записи `@deepseek-ai/dsh-llm-pi-ai`, ключи — через сервис `credentials` по `apiKeyEnv`, и уходят только на апстрим своего провайдера.
- Client (`client.js`): опрос раз в `pollMs`, пауза при скрытой вкладке, слот `conversation.composer.dock` (order 2).

Адаптер выбирается автоматически: `opencode-go` (id или `opencode.ai/zen/go`), codex-lb (`baseURL` на `/backend-api/codex`), TeamClaude (anthropic-маршрут с нестандартным `baseURL`). Переопределение и прочие настройки — в `cordis.patch.yml` профиля:

```yaml
- id: provider-limits
  config:
    routes: { codex-lb-oneclick: none }   # teamclaude | codex-lb | opencode-go | none
    cacheTtlMs: 60000
    pollMs: 45000
```

Проверки: `node --test tests/`.
