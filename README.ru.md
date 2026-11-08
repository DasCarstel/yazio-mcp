# YAZIO MCP

[English](README.md) · [Русский](README.ru.md)

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28-6B5CE7)](https://modelcontextprotocol.io/specification/2026-07-28)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Локальный [Model Context Protocol](https://modelcontextprotocol.io/)-сервер для
работы с персональным дневником питания YAZIO из Claude Code, Claude Desktop,
Codex, Hermes Agent и других MCP-клиентов.

`yazio-mcp` работает через stdio и напрямую обращается к YAZIO с помощью
небольшого типизированного адаптера из этого репозитория. Проект не зависит от
устаревшего npm-пакета `yazio` и не требует стороннего API-прокси.

> [!WARNING]
> YAZIO не публикует и не поддерживает публичный API для разработчиков. Проект
> использует неофициальный reverse-engineered API, который может измениться или
> быть заблокирован без предупреждения. Используйте сервер только со своим
> аккаунтом и на свой риск. Проект не связан с YAZIO GmbH и не является
> официальным продуктом YAZIO.

## Возможности

- Текстовый поиск по базе продуктов YAZIO с международными английскими
  настройками по умолчанию (`US`, `en_US`) и возможностью выбрать любую
  поддерживаемую страну и локаль.
- Чтение завтрака, обеда, ужина и перекусов за дату или диапазон.
- Калории, белки, жиры, углеводы, клетчатка, сахар, вода, вес, цели и тренировки.
- Добавление отдельного продукта или пакета позиций с компенсацией при ошибке.
- Изменение количества существующей записи, например `200 г → 210 г`.
- Удаление точной записи дневника только после подтверждения.
- Добавление воды через защищённый read-modify-write.
- Тренды по дням, ISO-неделям и месяцам, сравнение периодов.
- Поиск вероятно пропущенных дней и приёмов пищи без автоматического добавления
  предполагаемой еды.

Каждый MCP-инструмент имеет:

- `outputSchema`;
- машинно-читаемый `structuredContent`;
- короткий текстовый fallback для старых клиентов;
- нормализованные calories, protein, fat, carbs, fiber и sugar;
- единый формат ошибок со стабильными кодами.

## Безопасность операций записи

Операции записи спроектированы консервативно:

- `dry_run` по умолчанию равен `true`;
- каждый write-tool требует `client_request_id`;
- перед добавлением продукта выполняется поиск вероятного дубля;
- результат проверяется повторным чтением дневника;
- журнал идемпотентности сохраняется между перезапусками;
- destructive-операции используют MCP multi-round-trip confirmation;
- старые клиенты получают одноразовый confirmation token с коротким TTL;
- неоднозначные сетевые ошибки не приводят к слепому повтору записи.

У YAZIO не найден подтверждённый `PATCH` для существующей consumed item.
Поэтому `update_consumed_item` выполняет безопасную замену:

1. Читает и фиксирует точную исходную запись.
2. Создаёт replacement с новым UUID.
3. Проверяет именно этот UUID.
4. Удаляет исходный UUID.
5. Повторно проверяет результат.
6. При неудаче удаления компенсирует операцию удалением replacement.

Изменения одной и той же записи сериализуются между процессами, использующими
общий state-файл.

## MCP-инструменты

### Чтение

| Tool | Назначение |
|---|---|
| `get_user_profile` | Профиль без email, даты рождения, токенов и платёжных идентификаторов |
| `get_goals` | Цели калорий, БЖУ, воды, шагов и веса |
| `search_products` | Текстовый поиск с настраиваемой страной и локалью |
| `get_product` | Карточка продукта и nutrients на 100 г/мл |
| `get_diary` | Дневник за дату или диапазон до 31 дня |
| `get_daily_summary` | Суточная сводка, цели, вода, шаги и четыре meal bucket |
| `get_water_intake` | Кумулятивная вода за дату |
| `get_weight` | Последний известный вес на дату или ранее |
| `get_exercises` | Тренировки и custom training |

### Запись

| Tool | Назначение |
|---|---|
| `add_consumed_item` | Добавление продукта с preview, защитой от дублей и verification |
| `add_meal_batch` | До 25 продуктов с компенсацией при частичной ошибке |
| `update_consumed_item` | Безопасное изменение количества существующего продукта |
| `remove_consumed_item` | Удаление точной записи после MRTR или одноразового token |
| `add_water_intake` | Добавление воды через изменение cumulative total |

### Сохранённые приёмы пищи

Локальные шаблоны блюд, чтобы агент мог записать целое блюдо (например
«я поел мой Chicken Teriyaki») одним вызовом без хранения UUID продуктов.

| Tool | Назначение |
|---|---|
| `save_meal` | Проверка каждого product id через YAZIO и атомарное сохранение шаблона блюда; существующая запись с тем же именем (без учёта регистра) заменяется |
| `list_saved_meals` | Список шаблонов с алиасами, default daytime, числом позиций и оценкой итоговой нутрициологии |
| `log_saved_meal` | Поиск шаблона по имени или алиасу (без учёта регистра) и запись через тот же код-путь, что и `add_meal_batch`; `dry_run` по умолчанию `true` |

### Аналитика

| Tool | Назначение |
|---|---|
| `get_nutrition_trends` | Средние, цели, отклонения и стабильность по дням/неделям/месяцам |
| `compare_periods` | Сравнение средних калорий и БЖУ двух периодов |
| `detect_probable_missing_meals` | Вероятно пустые meal buckets без автоматической записи еды |

## Требования

- Node.js 20 или новее
- npm
- Личный аккаунт YAZIO с авторизацией по email и паролю

Для постоянного использования рекомендуется Node.js 22 или 24 LTS.

## Быстрый старт

```bash
git clone https://github.com/tomastaker/yazio-mcp.git
cd yazio-mcp
npm ci
npm run build
```

Точка входа:

```bash
node /absolute/path/to/yazio-mcp/dist/index.js
```

stdout используется только для MCP JSON-RPC. Диагностика transport выводится в
stderr.

## Авторизация и конфигурация

Сервер не загружает `.env` автоматически. Передавайте credentials через
environment MCP-клиента или локальный менеджер секретов.

Для первой авторизации нужны:

| Переменная | Назначение |
|---|---|
| `YAZIO_USERNAME` | Email личного аккаунта YAZIO |
| `YAZIO_PASSWORD` | Пароль личного аккаунта YAZIO |

После входа access/refresh token сохраняются локально. Пароль не записывается в
token cache. Cache привязан SHA-256 fingerprint к нормализованным username,
base URL и OAuth client ID, поэтому token другого аккаунта не будет использован
случайно.

YAZIO не предоставляет публичную регистрацию OAuth-приложений. В адаптере
используется общая application-level OAuth-пара, опубликованная в
MIT-лицензированном
[`saganos/yazio_public_api`](https://github.com/saganos/yazio_public_api).
Это не персональные данные пользователя. При ротации со стороны YAZIO оба
значения можно переопределить вместе.

### Дополнительные переменные

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `YAZIO_BASE_URL` | `https://yzapi.yazio.com/v19` | Доверенная локальная настройка API |
| `YAZIO_TOKEN_CACHE_PATH` | `~/.yazio-mcp/token.json` | Cache access/refresh token |
| `YAZIO_MCP_STATE_PATH` | `~/.yazio-mcp/state.json` | Idempotency и confirmation state |
| `YAZIO_SAVED_MEALS_PATH` | `~/.yazio-mcp/saved-meals.json` | Локальные шаблоны блюд для `save_meal`, `list_saved_meals` и `log_saved_meal` |
| `YAZIO_MCP_TIMEZONE` | `UTC` | IANA timezone для дат |
| `YAZIO_PRODUCT_COUNTRIES` | `US` | Страны поиска через запятую |
| `YAZIO_PRODUCT_LOCALES` | `en_US` | Локали поиска через запятую |
| `YAZIO_DEFAULT_SEX` | `male` | Параметр поиска upstream API |
| `YAZIO_HTTP_TIMEOUT_MS` | `15000` | HTTP timeout от 1 000 до 120 000 мс |
| `YAZIO_CLIENT_ID` | встроен | Парный advanced override |
| `YAZIO_CLIENT_SECRET` | встроен | Парный advanced override |

Страна, локаль и timezone настраиваются независимо. Например, для Германии
можно указать `YAZIO_PRODUCT_COUNTRIES=DE`,
`YAZIO_PRODUCT_LOCALES=de_DE` и
`YAZIO_MCP_TIMEZONE=Europe/Berlin`. Для поиска можно задать несколько значений
через запятую; аргументы `countries` и `locales` конкретного tool call имеют
приоритет над этими настройками по умолчанию.

Старые `NUTRITION_MCP_STATE_PATH` и `NUTRITION_MCP_TIMEZONE` временно
поддерживаются как migration aliases. Конфликтующие старые и новые значения
отклоняются.

## Подключение MCP-клиентов

Замените `/absolute/path/to/yazio-mcp` на фактический путь. По возможности
forward-ите переменные из shell или secret manager вместо хранения пароля в
конфигурационном файле.

### Claude Code

Создайте `.mcp.json`:

```json
{
  "mcpServers": {
    "yazio": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/yazio-mcp/dist/index.js"],
      "env": {
        "YAZIO_USERNAME": "${YAZIO_USERNAME}",
        "YAZIO_PASSWORD": "${YAZIO_PASSWORD}"
      }
    }
  }
}
```

Проверка:

```bash
claude mcp list
```

### Claude Desktop

Файл конфигурации:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "yazio": {
      "command": "node",
      "args": ["/absolute/path/to/yazio-mcp/dist/index.js"],
      "env": {
        "YAZIO_USERNAME": "set-locally",
        "YAZIO_PASSWORD": "set-locally"
      }
    }
  }
}
```

Claude Desktop хранит literal environment values в конфигурации. Ограничьте
права этого файла средствами ОС.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.yazio]
command = "node"
args = ["/absolute/path/to/yazio-mcp/dist/index.js"]
env_vars = [
  "YAZIO_USERNAME",
  "YAZIO_PASSWORD"
]
default_tools_approval_mode = "writes"
startup_timeout_sec = 15
tool_timeout_sec = 90
enabled = true
```

Или через CLI:

```bash
codex mcp add yazio \
  --env YAZIO_USERNAME="$YAZIO_USERNAME" \
  --env YAZIO_PASSWORD="$YAZIO_PASSWORD" \
  -- node /absolute/path/to/yazio-mcp/dist/index.js
```

Forwarding через `env_vars` безопаснее: literal `--env` значения могут быть
сохранены в локальной конфигурации клиента.

### Hermes Agent

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  yazio:
    command: "node"
    args: ["/absolute/path/to/yazio-mcp/dist/index.js"]
    env:
      YAZIO_USERNAME: "set-locally"
      YAZIO_PASSWORD: "set-locally"
      YAZIO_MCP_TIMEZONE: "UTC"
    timeout: 90
    connect_timeout: 15
    supports_parallel_tool_calls: false
    enabled: true
```

Параллельные tool calls отключены как консервативная настройка для
неофициального API.

## Примеры запросов

```text
Найди Snickers в базе продуктов YAZIO и покажи лучшие совпадения.

Покажи всё, что сегодня добавлено в завтрак, обед, ужин и перекусы.

Сначала сделай dry-run, затем добавь 80 г продукта <product-uuid> на завтрак.

Измени запись <item-uuid> с 200 г на 210 г, но сначала покажи preview.

Сравни средние калории и БЖУ за две последние полные недели.

Найди дни с вероятно пропущенными завтраками, но ничего не добавляй.
```

Обычный сценарий агента: выполнить поиск, выбрать product UUID, показать
preview и только после этого сделать запись.

## Ответы и ошибки

Успешный результат содержит текст и структурированные данные:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "timezone": "UTC",
    "backend": "yazio-unofficial",
    "generated_at": "2026-07-30T00:00:00.000Z"
  }
}
```

Ошибка имеет `isError: true` и машинно-читаемый код:

```json
{
  "ok": false,
  "error": {
    "code": "DUPLICATE_DETECTED",
    "message": "A probable duplicate entry was found; nothing was written.",
    "retryable": false
  }
}
```

Если питание отдельных diary rows нельзя определить безопасно, `get_diary`
возвращает:

- `totals_complete`;
- `totals_source` (`item_sum` или `daily_summary`);
- `missing_nutrition_item_ids`.

Частичная сумма никогда не выдаётся за полную.

## Рецепты и неподдерживаемые операции

Адаптер умеет читать ID пользовательских рецептов и детали через
community-observed endpoints. В diary row сохраняется `recipe_id`, а название
рецепта обогащается best-effort.

Следующие операции намеренно не имитируют успех, потому что их upstream
контракты недостаточно подтверждены:

- добавление сохранённого рецепта в дневник;
- создание, изменение и удаление рецептов;
- изменение recipe portion через `update_consumed_item`;
- нативный `PATCH/PUT` consumed item;
- нативные диапазоны дат;
- полная история веса;
- нативный поиск по штрихкоду;
- гарантированно транзакционный meal batch.

Nutrients отдельной recipe row остаются `null`, если upstream basis нельзя
определить безопасно. Суточный total берётся из daily-summary endpoint.

## Разработка

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke
```

Все стандартные проверки:

```bash
npm run check
```

Protocol smoke-test поднимает локальный mock YAZIO, запускает собранный MCP
через stdio и проверяет:

- modern MCP `2026-07-28`;
- реальный MRTR update/remove flow;
- legacy one-time-token fallback;
- input/output schemas;
- `structuredContent` и privacy filtering.

### Live-тесты

Live-тесты запускаются только явно:

```bash
export YAZIO_LIVE_TEST=1
export YAZIO_USERNAME='...'
export YAZIO_PASSWORD='...'
npm run test:live
```

Live write-test создаёт минимальную запись и удаляет в `finally` именно её UUID.
Если cleanup не подтверждён, тест завершается ошибкой. Не запускайте live write
на важной дате без последующей проверки в приложении YAZIO.

## Privacy и security

- Сервер предназначен для одного локального пользователя, а не для hosted
  multi-user API.
- Credentials принимаются только через environment.
- Password, Authorization headers, access/refresh tokens и полный профиль не
  попадают в логи и ошибки MCP.
- Token/state files записываются атомарно с POSIX mode `0600`; default-каталог
  создаётся с `0700`.
- В Windows mode bits не заменяют ACL — защитите каталог средствами ОС.
- Профиль строится по allowlist без email, даты рождения, Stripe ID и tokens.
- Confirmation tokens хранятся только как SHA-256 digest.
- Write requests не повторяются вслепую после неоднозначной сетевой ошибки.

Актуальный security review находится в
[SECURITY_REVIEW.md](SECURITY_REVIEW.md).

## Совместимость API и MCP

Default `/v19` выбран по наблюдаемому поведению. URL с большим номером не
обязательно означает релизную версию API; YAZIO может заблокировать или изменить
любой endpoint.

Проект использует официальные split-пакеты TypeScript SDK:

- `@modelcontextprotocol/server@2`;
- `@modelcontextprotocol/client@2` для protocol tests.

`serveStdio` включает MCP `2026-07-28` и сохраняет legacy stdio shim для
существующих клиентов.

Источники:

- [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP TypeScript SDK migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
- [fliptheweb/yazio-mcp](https://github.com/fliptheweb/yazio-mcp)
- [juriadams/yazio](https://github.com/juriadams/yazio)

Происхождение реализации и лицензии upstream-проектов описаны в
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Лицензия

[MIT](LICENSE)
