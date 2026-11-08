import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WriteService } from '../src/services/write-service.js';
import { FileIdempotencyStore } from '../src/persistence/idempotency-store.js';
import type { NutritionBackend } from '../src/types.js';
import { DIARY_FIXTURE, ITEM_ID, PRODUCT_ID } from './fixtures/yazio.js';

const nutrition = {
  calories: 100,
  protein: 10,
  fat: 2,
  carbs: 15,
  fiber: 1,
  sugar: 1,
  energy_unit: 'kcal' as const,
  mass_unit: 'g' as const,
};
const diaryMetadata = {
  totals_complete: true,
  totals_source: 'item_sum' as const,
  missing_nutrition_item_ids: [] as string[],
};

const backend = (): NutritionBackend => ({
  getUserProfile: vi.fn(),
  getGoals: vi.fn(),
  searchProducts: vi.fn(),
  listUserMeals: vi.fn(),
  getProduct: vi.fn().mockResolvedValue({
    id: PRODUCT_ID,
    name: 'Fixture product',
    producer: null,
    base_unit: 'g',
    serving: null,
    serving_quantity: null,
    amount: 100,
    is_verified: true,
    countries: ['US'],
    language: 'ru',
    nutrition,
    servings: [],
    eans: [],
    category: null,
  }),
  listUserRecipeIds: vi.fn(),
  getRecipe: vi.fn(),
  getDiary: vi
    .fn()
    .mockResolvedValueOnce({ date: '2026-07-29', items: [], totals: nutrition, ...diaryMetadata })
    .mockResolvedValue({
      date: '2026-07-29',
      items: [
        {
          id: ITEM_ID,
          date: '2026-07-29',
          daytime: 'breakfast',
          kind: 'product',
          product_id: PRODUCT_ID,
          recipe_id: null,
          name: 'Fixture product',
          amount: 80,
          serving: null,
          serving_quantity: null,
          nutrition,
        },
      ],
      totals: nutrition,
      ...diaryMetadata,
    }),
  getDailySummary: vi.fn(),
  getWaterIntake: vi.fn(),
  getWeight: vi.fn(),
  getExercises: vi.fn(),
  addConsumedItem: vi.fn(),
  removeConsumedItem: vi.fn(),
  setWaterIntake: vi.fn(),
});

describe('WriteService', () => {
  it('replays a completed idempotent request without a second write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yazio-mcp-state-'));
    const adapter = backend();
    const service = new WriteService(
      adapter,
      new FileIdempotencyStore(join(directory, 'state.json'), 'fixture-scope'),
      'UTC',
    );
    const input = {
      client_request_id: 'request-idempotency-1',
      dry_run: false,
      product_id: PRODUCT_ID,
      date: '2026-07-29',
      daytime: 'breakfast' as const,
      amount: 80,
    };

    const first = await service.addConsumedItem(input);
    const second = await service.addConsumedItem(input);

    expect(first.status).toBe('applied_unverified');
    expect(second).toEqual(first);
    expect(adapter.addConsumedItem).toHaveBeenCalledOnce();
  });

  it('detects a probable duplicate before writing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yazio-mcp-state-'));
    const adapter = backend();
    vi.mocked(adapter.getDiary).mockReset();
    vi.mocked(adapter.getDiary).mockResolvedValue({
      date: '2026-07-29',
      items: DIARY_FIXTURE.products.map((item) => ({
        id: item.id,
        date: item.date,
        daytime: item.daytime,
        kind: 'product',
        product_id: item.product_id,
        recipe_id: null,
        name: 'Fixture product',
        amount: item.amount,
        serving: null,
        serving_quantity: null,
        nutrition,
      })),
      totals: nutrition,
      ...diaryMetadata,
    });
    const service = new WriteService(
      adapter,
      new FileIdempotencyStore(join(directory, 'state.json'), 'fixture-scope'),
      'UTC',
    );

    await expect(
      service.addConsumedItem({
        client_request_id: 'request-duplicate-1',
        dry_run: false,
        product_id: PRODUCT_ID,
        date: '2026-07-29',
        daytime: 'breakfast',
        amount: 80,
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_DETECTED' });
    expect(adapter.addConsumedItem).not.toHaveBeenCalled();
  });

  it('does not repeat a successful write when verification read fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yazio-mcp-state-'));
    const adapter = backend();
    vi.mocked(adapter.getDiary)
      .mockReset()
      .mockResolvedValueOnce({ date: '2026-07-29', items: [], totals: nutrition, ...diaryMetadata })
      .mockRejectedValueOnce(new Error('verification unavailable'));
    const service = new WriteService(
      adapter,
      new FileIdempotencyStore(join(directory, 'state.json'), 'fixture-scope'),
      'UTC',
    );
    const input = {
      client_request_id: 'request-unverified-1',
      dry_run: false,
      product_id: PRODUCT_ID,
      date: '2026-07-29',
      daytime: 'breakfast' as const,
      amount: 25,
    };

    const first = await service.addConsumedItem(input);
    const second = await service.addConsumedItem(input);

    expect(first.status).toBe('applied_unverified');
    expect(second).toEqual(first);
    expect(adapter.addConsumedItem).toHaveBeenCalledOnce();
  });

  it('compensates prior items and reports each item after a partial batch failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yazio-mcp-state-'));
    const adapter = backend();
    vi.mocked(adapter.getDiary).mockResolvedValue({
      date: '2026-07-29',
      items: [],
      totals: nutrition,
      ...diaryMetadata,
    });
    vi.mocked(adapter.addConsumedItem)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fixture upstream failure'));
    const service = new WriteService(
      adapter,
      new FileIdempotencyStore(join(directory, 'state.json'), 'fixture-scope'),
      'UTC',
    );

    const result = await service.addMealBatch({
      client_request_id: 'request-batch-partial-1',
      dry_run: false,
      items: [
        {
          product_id: PRODUCT_ID,
          date: '2026-07-29',
          daytime: 'breakfast',
          amount: 40,
        },
        {
          product_id: '33333333-3333-4333-8333-333333333333',
          date: '2026-07-29',
          daytime: 'lunch',
          amount: 50,
        },
        {
          product_id: '44444444-4444-4444-8444-444444444444',
          date: '2026-07-29',
          daytime: 'dinner',
          amount: 60,
        },
      ],
    });

    expect(result.status).toBe('rolled_back');
    expect(result.items).toEqual([
      expect.objectContaining({ status: 'rolled_back' }),
      expect.objectContaining({ status: 'failed' }),
      expect.objectContaining({ status: 'not_attempted' }),
    ]);
    expect(adapter.removeConsumedItem).toHaveBeenCalledTimes(1);
  });

  it('never treats a similar concurrent diary item as its own generated ID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yazio-mcp-state-'));
    const adapter = backend();
    vi.mocked(adapter.getDiary)
      .mockReset()
      .mockResolvedValueOnce({ date: '2026-07-29', items: [], totals: nutrition, ...diaryMetadata })
      .mockResolvedValueOnce({
        date: '2026-07-29',
        items: [
          {
            id: ITEM_ID,
            date: '2026-07-29',
            daytime: 'breakfast',
            kind: 'product',
            product_id: PRODUCT_ID,
            recipe_id: null,
            name: 'Concurrent fixture',
            amount: 80,
            serving: null,
            serving_quantity: null,
            nutrition,
          },
        ],
        totals: nutrition,
        ...diaryMetadata,
      });
    const service = new WriteService(
      adapter,
      new FileIdempotencyStore(join(directory, 'state.json'), 'fixture-scope'),
      'UTC',
    );

    const result = await service.addConsumedItem({
      client_request_id: 'request-exact-id-1',
      dry_run: false,
      product_id: PRODUCT_ID,
      date: '2026-07-29',
      daytime: 'breakfast',
      amount: 80,
    });

    expect(result.status).toBe('applied_unverified');
    expect(result.entry_id).not.toBe(ITEM_ID);
  });

  it('requires and consumes a one-time fallback confirmation token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yazio-mcp-state-'));
    const adapter = backend();
    vi.mocked(adapter.getDiary).mockReset();
    vi.mocked(adapter.getDiary).mockResolvedValue({
      date: '2026-07-29',
      items: DIARY_FIXTURE.products.map((item) => ({
        id: item.id,
        date: item.date,
        daytime: item.daytime,
        kind: 'product',
        product_id: item.product_id,
        recipe_id: null,
        name: 'Fixture product',
        amount: item.amount,
        serving: null,
        serving_quantity: null,
        nutrition,
      })),
      totals: nutrition,
      ...diaryMetadata,
    });
    const store = new FileIdempotencyStore(join(directory, 'state.json'), 'fixture-scope');
    const service = new WriteService(adapter, store, 'UTC');
    const common = {
      client_request_id: 'request-remove-token-1',
      item_id: ITEM_ID,
      date: '2026-07-29',
    };

    const preview = await service.removeConsumedItem({ ...common, dry_run: true });
    const token = (preview.preview as { confirmation_token?: unknown }).confirmation_token;
    expect(token).toEqual(expect.any(String));
    await expect(
      service.removeConsumedItem({
        ...common,
        dry_run: false,
        confirmation_token: 'guessed-token-value',
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });

    const applied = await service.removeConsumedItem({
      ...common,
      client_request_id: 'request-remove-token-2',
      dry_run: false,
      confirmation_token: String(token),
    });
    expect(applied.status).toMatch(/^removed/);
    await expect(
      store.consumeConfirmation(String(token), 'different-fingerprint'),
    ).resolves.toBe(false);
  });

  it('reports rollback_failed when the exact generated ID still exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yazio-mcp-state-'));
    const adapter = backend();
    let generatedId = '';
    vi.mocked(adapter.addConsumedItem).mockImplementationOnce(async (input) => {
      await Promise.resolve();
      generatedId = input.id;
    });
    vi.mocked(adapter.addConsumedItem).mockRejectedValueOnce(new Error('definitive rejection'));
    vi.mocked(adapter.getDiary).mockReset();
    vi.mocked(adapter.getDiary).mockImplementation(async () => {
      await Promise.resolve();
      return {
        date: '2026-07-29',
        items:
          generatedId === ''
            ? []
            : [
                {
                  id: generatedId,
                  date: '2026-07-29',
                  daytime: 'breakfast',
                  kind: 'product',
                  product_id: PRODUCT_ID,
                  recipe_id: null,
                  name: 'Fixture product',
                  amount: 40,
                  serving: null,
                  serving_quantity: null,
                  nutrition,
                },
              ],
        totals: nutrition,
        ...diaryMetadata,
      };
    });
    const service = new WriteService(
      adapter,
      new FileIdempotencyStore(join(directory, 'state.json'), 'fixture-scope'),
      'UTC',
    );

    const result = await service.addMealBatch({
      client_request_id: 'request-batch-rollback-failed',
      dry_run: false,
      items: [
        {
          product_id: PRODUCT_ID,
          date: '2026-07-29',
          daytime: 'breakfast',
          amount: 40,
        },
        {
          product_id: '33333333-3333-4333-8333-333333333333',
          date: '2026-07-29',
          daytime: 'lunch',
          amount: 50,
        },
      ],
    });

    expect(result.status).toBe('partial_failure');
    expect(result.items[0]?.status).toBe('rollback_failed');
  });
});
