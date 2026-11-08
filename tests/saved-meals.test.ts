import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  logSavedMealInputSchema,
  saveMealInputSchema,
} from '../src/schemas.js';
import {
  resolveSavedMeal,
  SavedMealService,
  SavedMealStore,
  type SavedMeal,
} from '../src/services/saved-meals.js';
import { WriteService } from '../src/services/write-service.js';
import { FileIdempotencyStore } from '../src/persistence/idempotency-store.js';
import type { NutritionBackend } from '../src/types.js';
import { PRODUCT_ID } from './fixtures/yazio.js';

const OTHER_PRODUCT_ID = '11111111-2222-4333-8444-555555555555';

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

const productDetails = (id: string) => ({
  id,
  name: `Product ${id}`,
  producer: null,
  base_unit: 'g',
  serving: null,
  serving_quantity: null,
  amount: 100,
  is_verified: true,
  countries: ['US'],
  language: 'en',
  nutrition,
  servings: [],
  eans: [],
  category: null,
});

const createBackend = (): NutritionBackend => ({
  getUserProfile: vi.fn(),
  getGoals: vi.fn(),
  searchProducts: vi.fn(),
  listUserMeals: vi.fn(),
  getProduct: vi.fn((id: string) => Promise.resolve(productDetails(id))),
  listUserRecipeIds: vi.fn(),
  getRecipe: vi.fn(),
  getDiary: vi.fn().mockResolvedValue({
    date: '2026-11-08',
    items: [],
    totals: nutrition,
    ...diaryMetadata,
  }),
  getDailySummary: vi.fn(),
  getWaterIntake: vi.fn(),
  getWeight: vi.fn(),
  getExercises: vi.fn(),
  addConsumedItem: vi.fn().mockResolvedValue(undefined),
  removeConsumedItem: vi.fn(),
  setWaterIntake: vi.fn(),
});

const savedMeal = (overrides: Partial<SavedMeal> = {}): SavedMeal => ({
  name: 'Chicken Teriyaki',
  aliases: ['teriyaki'],
  default_daytime: 'lunch',
  items: [{ product_id: PRODUCT_ID, amount: 250, serving: null, serving_quantity: null }],
  ...overrides,
});

const createService = async (path: string, backend: NutritionBackend = createBackend()) => {
  const directory = await mkdtemp(join(tmpdir(), 'yazio-mcp-state-'));
  const writeService = new WriteService(
    backend,
    new FileIdempotencyStore(join(directory, 'state.json'), 'saved-meals-test'),
    'UTC',
  );
  return {
    backend,
    service: new SavedMealService(new SavedMealStore(path), backend, writeService),
  };
};

const prepareDirectory = async (fileName: string): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), 'yazio-mcp-saved-meals-')), fileName);

describe('saved meal resolution', () => {
  const meals: SavedMeal[] = [
    savedMeal(),
    savedMeal({ name: 'Protein Shake', aliases: ['shake'], default_daytime: 'breakfast' }),
  ];

  it('resolves by name case-insensitively', () => {
    expect(resolveSavedMeal(meals, 'chicken teriyaki')?.meal.name).toBe('Chicken Teriyaki');
    expect(resolveSavedMeal(meals, 'CHICKEN TERIYAKI')?.matchedBy).toBe('name');
  });

  it('resolves by alias case-insensitively', () => {
    const match = resolveSavedMeal(meals, 'TERIYAKI');
    expect(match?.matchedBy).toBe('alias');
    expect(match?.meal.name).toBe('Chicken Teriyaki');
  });

  it('reports no match for unrelated queries', () => {
    expect(resolveSavedMeal(meals, 'pizza')).toBeNull();
  });
});

describe('SavedMealStore', () => {
  it('returns an empty list when the file is missing', async () => {
    const store = new SavedMealStore(join(await prepareDirectory('missing'), 'saved-meals.json'));
    await expect(store.load()).resolves.toEqual([]);
  });

  it('ignores unknown fields when loading the file', async () => {
    const path = await prepareDirectory('saved-meals.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        meals: [
          {
            name: 'Chicken Teriyaki',
            aliases: ['teriyaki'],
            comment: 'unknown field that must be tolerated',
            default_daytime: 'lunch',
            unknown_top_level: true,
            items: [
              {
                product_id: PRODUCT_ID,
                amount: 250,
                serving_quantity: null,
                unknown_item_field: 'ignored',
              },
            ],
          },
        ],
      }),
    );
    const store = new SavedMealStore(path);
    await expect(store.load()).resolves.toEqual([
      {
        name: 'Chicken Teriyaki',
        aliases: ['teriyaki'],
        default_daytime: 'lunch',
        items: [
          {
            product_id: PRODUCT_ID,
            amount: 250,
            serving: null,
            serving_quantity: null,
          },
        ],
      },
    ]);
  });

  it('fails with CONFIG_ERROR on invalid JSON', async () => {
    const path = await prepareDirectory('saved-meals.json');
    await writeFile(path, 'not json at all');
    const store = new SavedMealStore(path);
    await expect(store.load()).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('fails with CONFIG_ERROR when a required field is malformed', async () => {
    const path = await prepareDirectory('saved-meals.json');
    await writeFile(path, JSON.stringify({ meals: [{ name: '', items: [] }] }));
    const store = new SavedMealStore(path);
    await expect(store.load()).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('writes atomically with a 0600 file inside a 0700 directory and roundtrips', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yazio-mcp-saved-meals-'));
    const path = join(directory, 'nested', 'saved-meals.json');
    const store = new SavedMealStore(path);
    await store.save([savedMeal()]);

    const fileStat = await stat(path);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const directoryStat = await stat(join(directory, 'nested'));
    expect(directoryStat.mode & 0o777).toBe(0o700);
    await expect(new SavedMealStore(path).load()).resolves.toEqual([savedMeal()]);
    // no leftover temporary files
    const siblings = await (
      await import('node:fs/promises')
    ).readdir(join(directory, 'nested'));
    expect(siblings).toEqual(['saved-meals.json']);
  });
});

describe('SavedMealService.listMeals', () => {
  it('sums nutrition scaled by the stored amounts', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const { service } = await createService(path);
    await new SavedMealStore(path).save([
      savedMeal({
        items: [
          { product_id: PRODUCT_ID, amount: 250, serving: null, serving_quantity: null },
          { product_id: OTHER_PRODUCT_ID, amount: 100, serving: null, serving_quantity: null },
        ],
      }),
    ]);
    const { meals } = await service.listMeals();
    expect(meals).toHaveLength(1);
    expect(meals[0]).toMatchObject({
      name: 'Chicken Teriyaki',
      aliases: ['teriyaki'],
      default_daytime: 'lunch',
      item_count: 2,
      // 100 kcal per 100 g * (250/100) + (100/100)
      nutrition: { ...nutrition, calories: 350, protein: 35, fat: 7, carbs: 52.5, fiber: 3.5, sugar: 3.5 },
    });
  });

  it('reports null nutrition when a product cannot be resolved', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const backend = createBackend();
    vi.mocked(backend.getProduct).mockResolvedValue(null);
    const { service } = await createService(path, backend);
    await new SavedMealStore(path).save([savedMeal()]);
    const { meals } = await service.listMeals();
    expect(meals[0]?.nutrition).toBeNull();
  });
});

describe('SavedMealService.logSavedMeal', () => {
  it('throws SAVED_MEAL_NOT_FOUND with the available meal names', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const { service } = await createService(path);
    await new SavedMealStore(path).save([savedMeal()]);
    await expect(
      service.logSavedMeal({
        client_request_id: 'log-not-found-1',
        amount_factor: 1,
        dry_run: true,
        name: 'pizza',
        date: '2026-11-08',
      }),
    ).rejects.toMatchObject({
      code: 'SAVED_MEAL_NOT_FOUND',
      details: { available_meals: ['Chicken Teriyaki'] },
    });
  });

  it('resolves by alias, applies the default daytime, and scales amounts', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const backend = createBackend();
    const { service } = await createService(path, backend);
    await new SavedMealStore(path).save([savedMeal({ items: [
      { product_id: PRODUCT_ID, amount: 33.333, serving: null, serving_quantity: null },
    ] })]);
    const result = await service.logSavedMeal({
      client_request_id: 'log-by-alias-1',
      amount_factor: 1,
      name: 'Teriyaki',
      date: '2026-11-08',
      dry_run: true,
    });
    expect(result).toMatchObject({
      meal_name: 'Chicken Teriyaki',
      matched_by: 'alias',
      amount_factor: 1,
      date: '2026-11-08',
      daytime: 'lunch',
      batch: { status: 'dry_run' },
    });
    expect(result.batch.preview[0]).toMatchObject({
      product_id: PRODUCT_ID,
      amount: 33.33,
      date: '2026-11-08',
      daytime: 'lunch',
    });
  });

  it('multiplies the amount by amount_factor and rounds to two decimals', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const { service } = await createService(path);
    await new SavedMealStore(path).save([savedMeal({ items: [
      { product_id: PRODUCT_ID, amount: 33.333, serving: null, serving_quantity: null },
    ] })]);
    const result = await service.logSavedMeal({
      client_request_id: 'log-factor-1',
      dry_run: true,
      name: 'Chicken Teriyaki',
      date: '2026-11-08',
      amount_factor: 2,
    });
    expect(result.batch.preview[0]).toMatchObject({ amount: 66.67 });
  });

  it('books through add_meal_batch with dry_run false and a fresh generated id', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const backend = createBackend();
    const { service } = await createService(path, backend);
    await new SavedMealStore(path).save([savedMeal()]);
    const result = await service.logSavedMeal({
      client_request_id: 'log-apply-1',
      amount_factor: 1,
      name: 'chicken teriyaki',
      date: '2026-11-08',
      dry_run: false,
    });
    expect(result.batch.status).toBe('applied');
    expect(result.batch.items).toEqual([
      { index: 0, entry_id: expect.any(String), status: 'applied_unverified' },
    ]);
    expect(backend.addConsumedItem).toHaveBeenCalledOnce();
    const written = vi.mocked(backend.addConsumedItem).mock.calls[0]?.[0];
    expect(written).toMatchObject({
      product_id: PRODUCT_ID,
      date: '2026-11-08',
      daytime: 'lunch',
      amount: 250,
    });
    expect(written?.id).toEqual(expect.any(String));
  });

  it('fails with VALIDATION_ERROR when no daytime can be derived', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const { service } = await createService(path);
    await new SavedMealStore(path).save([
      savedMeal({ name: 'Noon-less', aliases: [], default_daytime: null }),
    ]);
    await expect(
      service.logSavedMeal({
        client_request_id: 'log-no-daytime-1',
        amount_factor: 1,
        dry_run: true,
        name: 'Noon-less',
        date: '2026-11-08',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('overrides the default daytime with the explicit one', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const { service } = await createService(path);
    await new SavedMealStore(path).save([savedMeal()]);
    const result = await service.logSavedMeal({
      client_request_id: 'log-daytime-override-1',
      amount_factor: 1,
      dry_run: true,
      name: 'Chicken Teriyaki',
      date: '2026-11-08',
      daytime: 'snack',
    });
    expect(result.daytime).toBe('snack');
    expect(result.batch.preview[0]).toMatchObject({ daytime: 'snack' });
  });
});

describe('SavedMealService.saveMeal', () => {
  it('validates every product id and stores the definition', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const backend = createBackend();
    const { service } = await createService(path, backend);
    const result = await service.saveMeal({
      name: 'Chicken Teriyaki',
      aliases: ['teriyaki'],
      default_daytime: 'lunch',
      items: [
        { product_id: PRODUCT_ID, amount: 250, serving: 'gram' as never, serving_quantity: null as never },
      ] as never,
    });
    expect(result.replaced).toBe(false);
    expect(backend.getProduct).toHaveBeenCalledWith(PRODUCT_ID);
    await expect(new SavedMealStore(path).load()).resolves.toEqual([
      {
        name: 'Chicken Teriyaki',
        aliases: ['teriyaki'],
        default_daytime: 'lunch',
        items: [
          { product_id: PRODUCT_ID, amount: 250, serving: 'gram', serving_quantity: null },
        ],
      },
    ]);
  });

  it('rejects unknown product ids without touching the file', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const backend = createBackend();
    vi.mocked(backend.getProduct).mockResolvedValue(null);
    const { service } = await createService(path, backend);
    await expect(
      service.saveMeal({
        name: 'Ghost Meal',
        items: [{ product_id: OTHER_PRODUCT_ID, amount: 100 }],
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_NOT_FOUND' });
    await expect(access(path, fsConstants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces an existing entry with the same name case-insensitively', async () => {
    const path = await prepareDirectory('saved-meals.json');
    const { service } = await createService(path);
    await service.saveMeal({
      name: 'Chicken Teriyaki',
      aliases: ['teriyaki'],
      items: [{ product_id: PRODUCT_ID, amount: 250 }],
    });
    const second = await service.saveMeal({
      name: 'CHICKEN TERIYAKI',
      items: [{ product_id: PRODUCT_ID, amount: 300 }],
    });
    expect(second.replaced).toBe(true);
    const loaded = await new SavedMealStore(path).load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: 'CHICKEN TERIYAKI',
      aliases: [],
      default_daytime: null,
      items: [{ product_id: PRODUCT_ID, amount: 300, serving: null, serving_quantity: null }],
    });
  });
});

describe('saved meal input schemas', () => {
  it('defaults amount_factor and dry_run for log_saved_meal', () => {
    const parsed = logSavedMealInputSchema.parse({
      client_request_id: 'schema-default-1',
      name: 'Chicken Teriyaki',
      date: '2026-11-08',
    });
    expect(parsed.amount_factor).toBe(1);
    expect(parsed.dry_run).toBe(true);
    expectTypeOf(parsed.amount_factor).toEqualTypeOf<number>();
  });

  it('rejects out-of-range amount_factor and unpaired servings', () => {
    type SaveInput = z.infer<typeof saveMealInputSchema>;
    expect(
      logSavedMealInputSchema.safeParse({
        client_request_id: 'schema-range-1',
        name: 'Chicken Teriyaki',
        date: '2026-11-08',
        amount_factor: 11,
      }).success,
    ).toBe(false);
    expectTypeOf<SaveInput['items'][number]['product_id']>().toEqualTypeOf<string>();
    expect(
      saveMealInputSchema.safeParse({
        name: 'Broken',
        items: [{ product_id: PRODUCT_ID, amount: 100, serving: 'gram' }],
      }).success,
    ).toBe(false);
  });
});
