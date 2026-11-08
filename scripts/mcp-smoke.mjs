import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const projectRoot = resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'yazio-mcp-smoke-'));
const tokenPath = join(temporaryDirectory, 'token.json');
const statePath = join(temporaryDirectory, 'state.json');
const smokeProductId = '11111111-1111-4111-8111-111111111111';
const smokeDiaryItemId = '22222222-2222-4222-8222-222222222222';
const mutations = [];
let diaryEntryPresent = true;
let replacementDiaryEntry = null;
await writeFile(
  tokenPath,
  JSON.stringify({
    token_type: 'bearer',
    access_token: 'smoke-access-token',
    refresh_token: 'smoke-refresh-token',
    expires_in: 3600,
    expires_at: Date.now() + 3_600_000,
  }),
  { mode: 0o600 },
);
await chmod(tokenPath, 0o600);

const httpServer = createServer((request, response) => {
  if (request.method !== 'GET') mutations.push(`${request.method} ${request.url}`);
  if (request.url === '/v20/user' && request.headers.authorization === 'Bearer smoke-access-token') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        first_name: 'Smoke',
        sex: 'male',
        country: 'RU',
        goal: 'maintain_weight',
        diet: { name: 'balanced' },
        unit_energy: 'kcal',
        unit_mass: 'kg',
        email: 'must-not-leak@example.test',
        user_token: 'must-not-leak',
      }),
    );
    return;
  }
  if (request.url === `/v20/products/${smokeProductId}`) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: smokeProductId,
        name: 'Smoke oats',
        producer: null,
        base_unit: 'g',
        nutrients: {
          'energy.energy': 3.7,
          'nutrient.protein': 0.13,
          'nutrient.fat': 0.07,
          'nutrient.carb': 0.62,
        },
        servings: [],
        eans: [],
        language: 'ru',
        countries: ['US'],
        is_verified: true,
        category: 'grain',
      }),
    );
    return;
  }
  if (request.url === '/v20/user/consumed-items?date=2026-07-30') {
    const products = [];
    if (diaryEntryPresent) {
      products.push({
        id: smokeDiaryItemId,
        product_id: smokeProductId,
        date: '2026-07-30',
        daytime: 'breakfast',
        amount: 80,
        serving: null,
        serving_quantity: null,
      });
    }
    if (replacementDiaryEntry !== null) products.push(replacementDiaryEntry);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        products,
        recipe_portions: [],
        simple_products: [],
      }),
    );
    return;
  }
  if (request.url === '/v20/user/consumed-items' && request.method === 'POST') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      replacementDiaryEntry = parsed.products[0];
      response.writeHead(204);
      response.end();
    });
    return;
  }
  if (request.url === '/v20/user/consumed-items' && request.method === 'DELETE') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const ids = JSON.parse(body);
      if (ids.includes(smokeDiaryItemId)) diaryEntryPresent = false;
      if (replacementDiaryEntry !== null && ids.includes(replacementDiaryEntry.id)) {
        replacementDiaryEntry = null;
      }
      response.writeHead(204);
      response.end();
    });
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{}');
});

await new Promise((resolvePromise) => httpServer.listen(0, '127.0.0.1', resolvePromise));
const address = httpServer.address();
assert(address && typeof address === 'object');

const childEnvironment = {
  PATH: process.env.PATH ?? '',
  NODE_PATH: process.env.NODE_PATH ?? '',
  YAZIO_BASE_URL: `http://127.0.0.1:${address.port}/v20`,
  YAZIO_TOKEN_CACHE_PATH: tokenPath,
  YAZIO_MCP_STATE_PATH: statePath,
  YAZIO_MCP_TIMEZONE: 'UTC',
};

const runClient = async (mode, expectedEra) => {
  diaryEntryPresent = true;
  replacementDiaryEntry = null;
  const client = new Client(
    { name: `yazio-mcp-smoke-${expectedEra}`, version: '1.0.0' },
    {
      versionNegotiation: { mode },
      capabilities: { elicitation: { form: {} } },
    },
  );
  client.setRequestHandler('elicitation/create', async (request) => {
    assert.equal(request.params.mode, 'form');
    return { action: 'accept', content: { confirm: true } };
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: projectRoot,
    env: childEnvironment,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), expectedEra);
    const listed = await client.listTools({}, { cacheMode: 'refresh' });
    const names = listed.tools.map((tool) => tool.name);
    for (const required of [
      'get_user_profile',
      'get_diary',
      'add_consumed_item',
      'add_meal_batch',
      'update_consumed_item',
      'remove_consumed_item',
      'list_saved_meals',
      'log_saved_meal',
      'save_meal',
      'get_nutrition_trends',
      'compare_periods',
      'detect_probable_missing_meals',
    ]) {
      assert(names.includes(required), `missing tool: ${required}`);
    }
    for (const tool of listed.tools) {
      assert(tool.inputSchema, `${tool.name} must declare inputSchema`);
      assert(tool.outputSchema, `${tool.name} must declare outputSchema`);
    }
    const profileTool = listed.tools.find((tool) => tool.name === 'get_user_profile');
    assert(profileTool?.outputSchema, 'get_user_profile must declare outputSchema');
    assert.equal(profileTool.annotations?.readOnlyHint, true);
    const removeTool = listed.tools.find((tool) => tool.name === 'remove_consumed_item');
    assert.equal(removeTool?.annotations?.destructiveHint, true);
    const updateTool = listed.tools.find((tool) => tool.name === 'update_consumed_item');
    assert.equal(updateTool?.annotations?.destructiveHint, true);
    const addTool = listed.tools.find((tool) => tool.name === 'add_consumed_item');
    assert.equal(addTool?.annotations?.idempotentHint, true);
    const result = await client.callTool({ name: 'get_user_profile', arguments: {} });
    assert.notEqual(result.isError, true);
    assert(result.structuredContent);
    assert.equal(result.structuredContent.ok, true);
    const serialized = JSON.stringify(result.structuredContent);
    assert(!serialized.includes('must-not-leak@example.test'));
    assert(!serialized.includes('must-not-leak'));
    const error = await client.callTool({
      name: 'get_goals',
      arguments: { date: '2026-07-30' },
    });
    assert.equal(error.isError, true);
    assert.equal(error.structuredContent?.ok, false);
    assert.equal(error.structuredContent?.error?.code, 'UPSTREAM_NOT_FOUND');
    const dryRun = await client.callTool({
      name: 'add_consumed_item',
      arguments: {
        client_request_id: `smoke-dry-run-${expectedEra}`,
        dry_run: true,
        product_id: smokeProductId,
        date: '2026-07-30',
        daytime: 'breakfast',
        amount: 25,
      },
    });
    assert.notEqual(dryRun.isError, true);
    assert.equal(dryRun.structuredContent?.ok, true);
    assert.equal(dryRun.structuredContent?.data?.status, 'dry_run');
    const updateDryRun = await client.callTool({
      name: 'update_consumed_item',
      arguments: {
        client_request_id: `smoke-update-dry-run-${expectedEra}`,
        dry_run: true,
        item_id: smokeDiaryItemId,
        date: '2026-07-30',
        amount: 90,
      },
    });
    assert.notEqual(updateDryRun.isError, true);
    assert.equal(updateDryRun.structuredContent?.data?.status, 'dry_run');
    assert.equal(
      typeof updateDryRun.structuredContent?.data?.preview?.confirmation_token,
      'string',
    );

    if (expectedEra === 'modern') {
      const removed = await client.callTool({
        name: 'remove_consumed_item',
        arguments: {
          client_request_id: 'smoke-modern-remove',
          dry_run: false,
          item_id: smokeDiaryItemId,
          date: '2026-07-30',
        },
      });
      assert.notEqual(removed.isError, true);
      assert.equal(removed.structuredContent?.data?.status, 'removed');

      diaryEntryPresent = true;
      replacementDiaryEntry = null;
      const updated = await client.callTool({
        name: 'update_consumed_item',
        arguments: {
          client_request_id: 'smoke-modern-update',
          dry_run: false,
          item_id: smokeDiaryItemId,
          date: '2026-07-30',
          amount: 90,
        },
      });
      assert.notEqual(updated.isError, true);
      assert.equal(updated.structuredContent?.data?.status, 'applied');
      assert.equal(diaryEntryPresent, false);
      assert.equal(replacementDiaryEntry?.amount, 90);
    } else {
      const preview = await client.callTool({
        name: 'remove_consumed_item',
        arguments: {
          client_request_id: 'smoke-legacy-remove-preview',
          dry_run: true,
          item_id: smokeDiaryItemId,
          date: '2026-07-30',
        },
      });
      const confirmationToken = preview.structuredContent?.data?.preview?.confirmation_token;
      assert.equal(typeof confirmationToken, 'string');
      const removed = await client.callTool({
        name: 'remove_consumed_item',
        arguments: {
          client_request_id: 'smoke-legacy-remove',
          dry_run: false,
          item_id: smokeDiaryItemId,
          date: '2026-07-30',
          confirmation_token: confirmationToken,
        },
      });
      assert.notEqual(removed.isError, true);
      assert.equal(removed.structuredContent?.data?.status, 'removed');
    }
  } finally {
    await client.close();
  }
};

try {
  await runClient('auto', 'modern');
  await runClient('legacy', 'legacy');
  assert.deepEqual(mutations, [
    'DELETE /v20/user/consumed-items',
    'POST /v20/user/consumed-items',
    'DELETE /v20/user/consumed-items',
    'DELETE /v20/user/consumed-items',
  ]);
  process.stdout.write(
    'MCP smoke passed: modern 2026-07-28 MRTR update/remove + legacy one-time-token fallback; structured tool calls OK.\n',
  );
} finally {
  await new Promise((resolvePromise, rejectPromise) => {
    httpServer.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}
