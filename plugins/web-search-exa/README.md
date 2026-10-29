# web-search-exa (DSH)

Встроенный инструмент `web_search` ищет через Exa, а не через поиск DeepSeek Messages. Поиск DeepSeek требует `DEEPSEEK_API_KEY` (или чат на модели DeepSeek Account); без ключа каждый вызов `web_search` падал с `DeepSeek search has no API key`, и модель только после этого шла в `web_search_exa` из MCP.

Бандл без своего кода, только `cordis.patch.yml`:

- вставляет строку `web-search-exa` с официальным провайдером `@deepseek-ai/dsh-web-search-exa` (регистрируется в `ctx.web` как `exa`);
- переопределяет строку `web` базового бандла: `searchProvider: exa`, `fetchProvider: http`. Переопределение заменяет весь `config`, поэтому `fetchProvider` повторён; `web_fetch` по-прежнему качает страницы локально.

Ключ — `EXA_API_KEY` из окружения запуска, то есть из `$DSH_HOME/.env`, тот же, что шлёт подключение `mcp-exa`. Без ключа провайдер недоступен и `web_search` отвечает структурной ошибкой. Пресеты не трогаются: `tool-web` в каждом пресете зовёт Host-сервис `web`, так что Exa получают все режимы и субагенты.

Настройки провайдера (`searchType`, `numResults`, `highlightsPerResult`, `baseURL`) — в строке `web-search-exa` этого патча; полный список — README пакета `dsh-web-search-exa`.

## Зависимость

`@deepseek-ai/dsh-web-search-exa` в Desktop не входит и ставится из npm в `node_modules` этой папки: pnpm профиля не устанавливает зависимости пакета, подключённого через `link:`. `plugins/install.sh` доустанавливает их из `pnpm-lock.yaml`, если пакета нет или его версия не совпадает с пином. Вручную:

```sh
RT="$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies"
"$RT/node/bin/node" "$RT/pnpm/bin/pnpm.mjs" --dir plugins/web-search-exa install --frozen-lockfile
```

Версия закреплена точно и должна совпадать с версией DSH: у пакета точные peer-зависимости на `dsh-web` и `dsh-launch-environment`. При смене версии DSH поменяйте пин в `package.json`, выполните `pnpm install` в этой папке и закоммитьте `pnpm-lock.yaml`.
