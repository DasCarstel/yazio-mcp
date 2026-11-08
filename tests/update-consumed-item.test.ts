import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileIdempotencyStore } from '../src/persistence/idempotency-store.js';
import { WriteService } from '../src/services/write-service.js';
import type { ConsumedItemInput, DiaryItem, NutritionBackend } from '../src/types.js';
import { ITEM_ID, PRODUCT_ID } from './fixtures/yazio.js';

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

const originalItem = (): DiaryItem => ({
  id: ITEM_ID,
  date: '2026-07-29',
  daytime: 'breakfast',
  kind: 'product',
  product_id: PRODUCT_ID,
  recipe_id: null,
  name: 'Fixture product',
  amount: 200,
  serving: null,
  serving_quantity: null,
  nutrition,
});

const product = {
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
};

const createStatefulBackend = (options?: {
  failOriginalRemoval?: boolean;
  failCompensation?: boolean;
  throwAfterAdd?: boolean;
}): {
  backend: NutritionBackend;
  events: string[];
  items: DiaryItem[];
} => {
  const events: string[] = [];
  const items = [originalItem()];
  const backend: NutritionBackend = {
    getUserProfile: vi.fn(),
    getGoals: vi.fn(),
    searchProducts: vi.fn(),
    listUserMeals: vi.fn(),
  getProduct: vi.fn().mockImplementation(() => {
      events.push('get_product');
      return Promise.resolve(product);
    }),
    listUserRecipeIds: vi.fn(),
    getRecipe: vi.fn(),
    getDiary: vi.fn().mockImplementation(() => {
      events.push(`read:${items.map((item) => item.id).join(',')}`);
      return Promise.resolve({
        date: '2026-07-29',
        items: [...items],
        totals: nutrition,
        ...diaryMetadata,
      });
    }),
    getDailySummary: vi.fn(),
    getWaterIntake: vi.fn(),
    getWeight: vi.fn(),
    getExercises: vi.fn(),
    addConsumedItem: vi.fn().mockImplementation((input: ConsumedItemInput) => {
      events.push(`add:${input.id}`);
      items.push({
        ...originalItem(),
        id: input.id,
        amount: input.amount,
      });
      return options?.throwAfterAdd === true
        ? Promise.reject(new Error('fixture transport failure after apply'))
        : Promise.resolve();
    }),
    removeConsumedItem: vi.fn().mockImplementation((itemId: string) => {
      events.push(`remove:${itemId}`);
      if (itemId === ITEM_ID && options?.failOriginalRemoval === true) {
        return Promise.reject(new Error('fixture original removal failure'));
      }
      if (itemId !== ITEM_ID && options?.failCompensation === true) {
        return Promise.reject(new Error('fixture compensation failure'));
      }
      const index = items.findIndex((item) => item.id === itemId);
      if (index >= 0) items.splice(index, 1);
      return Promise.resolve();
    }),
    setWaterIntake: vi.fn(),
  };
  return { backend, events, items };
};

const createService = async (backend: NutritionBackend): Promise<WriteService> => {
  const directory = await mkdtemp(join(tmpdir(), 'yazio-mcp-update-state-'));
  return new WriteService(
    backend,
    new FileIdempotencyStore(join(directory, 'state.json'), 'fixture-scope'),
    'UTC',
  );
};

const updateInput = {
  client_request_id: 'request-update-0001',
  dry_run: false,
  item_id: ITEM_ID,
  date: '2026-07-29',
  amount: 210,
};

describe('WriteService.updateConsumedItem', () => {
  it('requires a one-time confirmation token outside MRTR', async () => {
    const { backend } = createStatefulBackend();
    const service = await createService(backend);
    const preview = await service.updateConsumedItem({
      ...updateInput,
      dry_run: true,
    });
    expect(preview).toMatchObject({
      status: 'dry_run',
      old_entry_id: ITEM_ID,
      replacement_entry_id: null,
      verified: false,
    });
    const token = (
      preview.preview as { confirmation_token?: unknown }
    ).confirmation_token;
    expect(token).toEqual(expect.any(String));
    expect(backend.addConsumedItem).not.toHaveBeenCalled();

    await expect(
      service.updateConsumedItem({
        ...updateInput,
        client_request_id: 'request-update-no-confirmation',
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });

    await expect(
      service.updateConsumedItem({
        ...updateInput,
        client_request_id: 'request-update-confirmed',
        confirmation_token: String(token),
      }),
    ).resolves.toMatchObject({ status: 'applied' });
  });

  it('adds and verifies the replacement before deleting the exact original item', async () => {
    const { backend, events, items } = createStatefulBackend();
    const service = await createService(backend);

    const result = await service.updateConsumedItem(updateInput, { kind: 'mrtr' });

    expect(result).toMatchObject({
      status: 'applied',
      old_entry_id: ITEM_ID,
      verified: true,
    });
    const replacementId = String(
      (result as { replacement_entry_id?: unknown }).replacement_entry_id,
    );
    expect(replacementId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(items).toEqual([
      expect.objectContaining({ id: replacementId, product_id: PRODUCT_ID, amount: 210 }),
    ]);

    const addIndex = events.indexOf(`add:${replacementId}`);
    const deleteOriginalIndex = events.indexOf(`remove:${ITEM_ID}`);
    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(deleteOriginalIndex).toBeGreaterThan(addIndex);
    expect(
      events.slice(addIndex + 1, deleteOriginalIndex).some((event) => event.startsWith('read:')),
    ).toBe(true);
  });

  it('reconciles a replacement that was applied before a transport error', async () => {
    const { backend, items } = createStatefulBackend({ throwAfterAdd: true });
    const service = await createService(backend);

    await expect(
      service.updateConsumedItem(updateInput, { kind: 'mrtr' }),
    ).resolves.toMatchObject({ status: 'applied', verified: true });
    expect(items).toEqual([
      expect.objectContaining({ product_id: PRODUCT_ID, amount: 210 }),
    ]);
  });

  it('serializes concurrent updates of the same original item', async () => {
    const { backend, items } = createStatefulBackend();
    const service = await createService(backend);

    const outcomes = await Promise.allSettled([
      service.updateConsumedItem(
        { ...updateInput, client_request_id: 'request-update-concurrent-a' },
        { kind: 'mrtr' },
      ),
      service.updateConsumedItem(
        { ...updateInput, client_request_id: 'request-update-concurrent-b' },
        { kind: 'mrtr' },
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(items).toEqual([
      expect.objectContaining({ product_id: PRODUCT_ID, amount: 210 }),
    ]);
  });

  it('compensates the verified replacement when deletion leaves the original in place', async () => {
    const { backend, events, items } = createStatefulBackend({ failOriginalRemoval: true });
    const service = await createService(backend);

    const result = await service.updateConsumedItem(updateInput, { kind: 'mrtr' });

    expect(result).toMatchObject({
      status: 'rolled_back',
      old_entry_id: ITEM_ID,
      verified: true,
    });
    const replacementId = String(
      (result as { replacement_entry_id?: unknown }).replacement_entry_id,
    );
    expect(events).toContain(`remove:${ITEM_ID}`);
    expect(events).toContain(`remove:${replacementId}`);
    expect(events.indexOf(`remove:${replacementId}`)).toBeGreaterThan(
      events.indexOf(`remove:${ITEM_ID}`),
    );
    expect(items).toEqual([expect.objectContaining({ id: ITEM_ID, amount: 200 })]);
  });

  it('reports partial failure when compensation cannot restore the original-only state', async () => {
    const { backend, items } = createStatefulBackend({
      failOriginalRemoval: true,
      failCompensation: true,
    });
    const service = await createService(backend);

    const result = await service.updateConsumedItem(updateInput, { kind: 'mrtr' });

    expect(result).toMatchObject({
      status: 'partial_failure',
      old_entry_id: ITEM_ID,
      verified: false,
    });
    expect(items).toEqual([
      expect.objectContaining({ id: ITEM_ID, amount: 200 }),
      expect.objectContaining({ product_id: PRODUCT_ID, amount: 210 }),
    ]);
  });

  it('uses the idempotency journal to avoid creating a second replacement', async () => {
    const { backend } = createStatefulBackend();
    const service = await createService(backend);

    const first = await service.updateConsumedItem(updateInput, { kind: 'mrtr' });
    const second = await service.updateConsumedItem(updateInput, { kind: 'mrtr' });

    expect(second).toEqual(first);
    expect(backend.addConsumedItem).toHaveBeenCalledOnce();
    expect(backend.removeConsumedItem).toHaveBeenCalledOnce();
  });
});
