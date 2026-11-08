# YAZIO MCP

[English](README.md) · [Русский](README.ru.md)

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28-6B5CE7)](https://modelcontextprotocol.io/specification/2026-07-28)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for
working with your personal YAZIO nutrition diary from AI agents such as Claude
Code, Claude Desktop, Codex, and Hermes Agent.

`yazio-mcp` speaks MCP over stdio and talks directly to YAZIO through a small,
typed adapter maintained in this repository. It does not depend on the legacy
`yazio` npm package or on a third-party proxy service.

> [!WARNING]
> YAZIO does not publish or support a public developer API. This project uses a
> reverse-engineered, unofficial API that may change or be blocked without
> notice. Use it only with your own account and at your own risk. This project
> is not affiliated with, endorsed by, or sponsored by YAZIO GmbH.

## What you can do

- Search the YAZIO product database using international English defaults
  (`US`, `en_US`) or configure any supported country and locale.
- Read breakfast, lunch, dinner, and snack entries for one day or a date range.
- Inspect daily calories, macros, water, weight, goals, and exercises.
- Add individual products or a compensated batch of meal items.
- Change the amount of an existing product entry, for example `200 g → 210 g`.
- Remove an exact diary entry after explicit confirmation.
- Add water using a guarded read-modify-write flow.
- Compare periods and analyze nutrition trends by day, ISO week, or month.
- Flag days or meal slots that may be missing entries without inventing food.

Every tool returns:

- an `outputSchema`;
- machine-readable `structuredContent`;
- a short text fallback for older clients;
- normalized calories, protein, fat, carbohydrates, fiber, and sugar;
- a consistent error envelope with stable error codes.

## Safety model

Nutrition writes are deliberately conservative:

- `dry_run` defaults to `true`;
- every write requires a `client_request_id`;
- duplicate detection runs before product writes;
- results are verified by reading the diary again;
- idempotency state survives process restarts;
- destructive actions use MCP multi-round-trip confirmation when supported;
- legacy clients receive a short-lived, one-time confirmation token;
- ambiguous writes are never retried blindly.

YAZIO does not expose a confirmed `PATCH` endpoint for consumed items.
`update_consumed_item` therefore performs a guarded replacement:

1. Read and identify the exact original entry.
2. Add a replacement with a new UUID.
3. Verify that exact replacement UUID.
4. Delete the original UUID.
5. Verify the final state.
6. Remove the replacement as compensation if the original could not be
   deleted safely.

Updates of the same diary item are serialized across processes that share the
same state file.

## Available tools

### Read tools

| Tool | Description |
|---|---|
| `get_user_profile` | Privacy-filtered profile without email, birth date, tokens, or payment identifiers |
| `get_goals` | Calorie, macro, water, step, and weight goals |
| `search_products` | Text search with configurable country and locale; `limit` defaults to **5** and `compact` to **true** (product_id, name, brand, serving, per_100g) |
| `get_product` | Product details and normalized nutrients per 100 g/ml |
| `get_diary` | Diary for one date or a range of up to 31 days; `compact` defaults to **true** and omits per-item nutrition (daily totals stay intact) |
| `get_daily_summary` | Daily nutrition, goals, water, steps, and four meal buckets |
| `get_water_intake` | Cumulative water intake for a date |
| `get_weight` | Latest known weight on or before a date |
| `get_exercises` | Training and custom training entries |

### Write tools

| Tool | Description |
|---|---|
| `add_consumed_item` | Add one product with preview, duplicate detection, idempotency, and verification |
| `add_meal_batch` | Add up to 25 products and compensate earlier writes after a partial failure |
| `update_consumed_item` | Safely replace the amount of an existing product entry |
| `remove_consumed_item` | Remove an exact diary item after MRTR or one-time-token confirmation |
| `add_water_intake` | Add water by updating the cumulative daily total |

### YAZIO meal tools

Meal templates created in the YAZIO app itself (`GET /user/meals`), booked with
the same guarantees as `add_meal_batch`.

| Tool | Description |
|---|---|
| `list_user_meals` | List the meals saved in YAZIO as `meal_id`, `name`, `item_count`; optional case-insensitive `query` filter |
| `log_user_meal` | Book a YAZIO meal by name (case-insensitive); `daytime` is required, `amount_factor` scales every item, `dry_run` defaults to `true` |

### Saved meal tools

Locally persisted meal templates so an agent can log a whole meal (for example
"I ate my Chicken Teriyaki") in one call without memorizing product UUIDs.

| Tool | Description |
|---|---|
| `save_meal` | Validate every product id against the YAZIO catalog and persist a named meal template atomically; an identically named entry (case-insensitive) is replaced |
| `list_saved_meals` | List saved meal templates with aliases, default daytime, item count, and estimated nutrition totals |
| `log_saved_meal` | Resolve a template by name or alias (case-insensitive) and book it through the same code path as `add_meal_batch`, with the same duplicate, verification, and compensation guarantees; `dry_run` defaults to `true` |

Templates are stored in `saved-meals.json` (override with `YAZIO_SAVED_MEALS_PATH`):

```json
{
  "meals": [
    {
      "name": "Chicken Teriyaki",
      "aliases": ["teriyaki"],
      "default_daytime": "lunch",
      "items": [{ "product_id": "<uuid>", "amount": 250, "serving": "gram", "serving_quantity": null }]
    }
  ]
}
```

The file is optional: a missing file simply means no templates are saved. Use
`YAZIO_SAVED_MEALS_PATH` to place it outside the default `~/.yazio-mcp/`
directory, for example `YAZIO_SAVED_MEALS_PATH=/var/lib/yazio-mcp/saved-meals.json`.

### Analytics tools

| Tool | Description |
|---|---|
| `get_nutrition_trends` | Day/week/month averages, goals, variance, and stability |
| `compare_periods` | Compare calorie and macro averages for two periods |
| `detect_probable_missing_meals` | Report suspiciously empty meal slots; never writes food automatically |

## Requirements

- Node.js 20 or newer
- npm
- A personal YAZIO account that can sign in with email and password

Node.js 22 or 24 LTS is recommended for regular use.

## Quick start

```bash
git clone https://github.com/tomastaker/yazio-mcp.git
cd yazio-mcp
npm ci
npm run build
```

The server entry point is:

```bash
node /absolute/path/to/yazio-mcp/dist/index.js
```

The process uses stdout exclusively for MCP JSON-RPC. Transport diagnostics are
written to stderr.

## Authentication and configuration

The server does not automatically load `.env` files. Pass credentials through
your MCP client's environment configuration or a local secret manager.

Required for the first login:

| Variable | Description |
|---|---|
| `YAZIO_USERNAME` | Email address of your personal YAZIO account |
| `YAZIO_PASSWORD` | Password of your personal YAZIO account |

After login, the access and refresh tokens are cached locally. The password is
never written to the token cache. A cached token is bound to a SHA-256
fingerprint of the normalized username, API base URL, and OAuth client ID, which
prevents accidentally reusing a token from another account.

YAZIO does not offer public OAuth application registration. The adapter includes
community-observed application-level OAuth credentials published by the
MIT-licensed
[`saganos/yazio_public_api`](https://github.com/saganos/yazio_public_api)
project. They are shared application identifiers, not a user's personal secret.
Both can be overridden together if YAZIO rotates them.

### Optional variables

| Variable | Default | Purpose |
|---|---|---|
| `YAZIO_BASE_URL` | `https://yzapi.yazio.com/v19` | Trusted local API configuration |
| `YAZIO_TOKEN_CACHE_PATH` | `~/.yazio-mcp/token.json` | Access/refresh token cache |
| `YAZIO_MCP_STATE_PATH` | `~/.yazio-mcp/state.json` | Idempotency and confirmation state |
| `YAZIO_SAVED_MEALS_PATH` | `~/.yazio-mcp/saved-meals.json` | Locally saved meal templates used by `save_meal`, `list_saved_meals`, and `log_saved_meal` |
| `YAZIO_MCP_TIMEZONE` | `UTC` | IANA timezone used for dates |
| `YAZIO_PRODUCT_COUNTRIES` | `US` | Comma-separated product countries |
| `YAZIO_PRODUCT_LOCALES` | `en_US` | Comma-separated product locales |
| `YAZIO_DEFAULT_SEX` | `male` | Search parameter required by the upstream API |
| `YAZIO_HTTP_TIMEOUT_MS` | `15000` | HTTP timeout, from 1,000 to 120,000 ms |
| `YAZIO_CLIENT_ID` | built in | Advanced paired OAuth override |
| `YAZIO_CLIENT_SECRET` | built in | Advanced paired OAuth override |

Country, locale, and timezone are independent. For example, a German setup can
use `YAZIO_PRODUCT_COUNTRIES=DE`,
`YAZIO_PRODUCT_LOCALES=de_DE`, and
`YAZIO_MCP_TIMEZONE=Europe/Berlin`. Multiple search values can be supplied as
comma-separated lists; explicit `countries` and `locales` tool arguments
override these defaults for an individual search.

`NUTRITION_MCP_STATE_PATH` and `NUTRITION_MCP_TIMEZONE` are accepted as
deprecated migration aliases. Conflicting old and new values are rejected.

## Client configuration

Replace `/absolute/path/to/yazio-mcp` in the examples below with the real
checkout path. Prefer environment forwarding or an OS secret manager over
storing credentials directly in a client configuration file.

### Claude Code

Create `.mcp.json` in your project:

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

Verify the connection:

```bash
claude mcp list
```

### Claude Desktop

Add the server to:

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

Claude Desktop stores literal environment values in its configuration. Protect
that file with appropriate OS permissions.

### Codex

Forward environment variables from `~/.codex/config.toml`:

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

Or register it with the CLI:

```bash
codex mcp add yazio \
  --env YAZIO_USERNAME="$YAZIO_USERNAME" \
  --env YAZIO_PASSWORD="$YAZIO_PASSWORD" \
  -- node /absolute/path/to/yazio-mcp/dist/index.js
```

Environment forwarding is safer than the CLI variant because literal `--env`
values may be saved in local client configuration.

### Hermes Agent

Add the server to `~/.hermes/config.yaml`:

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

Parallel tool calls are disabled here as a conservative default for an
unofficial API.

## Example prompts

```text
Search the YAZIO product database for Snickers and show me the best matches.

Show everything I logged for breakfast, lunch, dinner, and snacks today.

First show a dry-run, then add 80 g of product <product-uuid> to breakfast.

Change diary item <item-uuid> from 200 g to 210 g, but show me the preview first.

Compare my average calories and macros for the last two complete weeks.

Find days with probably missing breakfasts, but do not add anything.
```

An agent normally searches first, selects a product UUID, previews the write,
and only then submits the mutation.

## Responses and errors

Successful tools return both text and structured data:

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

Failures set `isError: true` and use a machine-readable code:

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

For diary rows whose individual nutrition cannot be determined safely,
`get_diary` exposes:

- `totals_complete`;
- `totals_source` (`item_sum` or `daily_summary`);
- `missing_nutrition_item_ids`.

This prevents a partial item sum from being presented as a complete total.

## Recipes and unsupported operations

The adapter can read user recipe IDs and recipe details using
community-observed endpoints. Recipe rows in the diary preserve `recipe_id`,
and their names are enriched on a best-effort basis.

The following operations are intentionally not exposed as successful MCP tools
because their upstream contracts are not sufficiently confirmed:

- adding a saved recipe portion to the diary;
- creating, updating, or deleting recipes;
- changing a recipe portion through `update_consumed_item`;
- native `PATCH`/`PUT` of consumed items;
- native date-range endpoints;
- full weight history;
- native barcode lookup;
- guaranteed transactional meal batches.

Recipe-row nutrients remain `null` when the upstream basis cannot be determined
safely. Daily totals use the daily-summary endpoint instead.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke
```

Run all default checks:

```bash
npm run check
```

The protocol smoke test starts a local mock YAZIO server, spawns the built MCP
server over stdio, and validates:

- modern MCP `2026-07-28` negotiation;
- a real MRTR update/remove flow;
- legacy one-time-token confirmation;
- tool input/output schemas;
- `structuredContent` and privacy filtering.

### Live tests

Live tests are opt-in:

```bash
export YAZIO_LIVE_TEST=1
export YAZIO_USERNAME='...'
export YAZIO_PASSWORD='...'
npm run test:live
```

The live write test creates a minimal product entry and removes that exact
generated UUID in `finally`. If cleanup cannot be confirmed, the test fails.
Avoid running live writes on an important diary date without checking the
result in the YAZIO app.

## Privacy and security

- The server is designed for one local user, not as a hosted multi-user API.
- User credentials are accepted only from environment variables.
- Passwords, authorization headers, tokens, and full profile responses are not
  written to logs or surfaced in tool errors.
- Token and state files use atomic writes and POSIX mode `0600`; the default
  directory is created with `0700`.
- Windows users must protect the cache directory with Windows ACLs because
  POSIX mode bits are not an ACL substitute.
- The profile tool uses an explicit allowlist and excludes email, birth date,
  payment identifiers, and upstream tokens.
- One-time confirmation tokens are stored only as SHA-256 digests.
- Write requests are not retried blindly after uncertain network failures.

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the current threat review.

## API and MCP compatibility

The default `/v19` API base was selected from observed behavior. Newer-looking
URL versions are not necessarily released API versions; YAZIO can block or
change any of them without warning.

The project uses the official split TypeScript SDK packages:

- `@modelcontextprotocol/server@2`;
- `@modelcontextprotocol/client@2` for protocol tests.

The server opts into MCP `2026-07-28` through `serveStdio` and keeps the legacy
stdio compatibility shim enabled for existing clients.

References:

- [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP TypeScript SDK migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
- [fliptheweb/yazio-mcp](https://github.com/fliptheweb/yazio-mcp)
- [juriadams/yazio](https://github.com/juriadams/yazio)

Implementation provenance and license notices are documented in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE)
