import { describe, expect, it, vi } from 'vitest';
import { NutritionMcpError } from '../src/errors.js';
import { UserMealService } from '../src/services/user-meals.js';
import type { NutritionBackend, UserMeal } from '../src/types.js';
import type { WriteService } from '../src/services/write-service.js';

const MEAL_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_A = '22222222-2222-4222-8222-222222222222';
const PRODUCT_B = '33333333-3333-4333-8333-333333333333';

const meal = (overrides: Partial<UserMeal> = {}): UserMeal => ({
  id: MEAL_ID,
  name: 'Chicken Teriyaki',
  items: [
    {
      product_id: PRODUCT_A,
      amount: 33.333,
      serving: 'gram',
      serving_quantity: 33.333,
    },
  ],
  recipe_portion_count: 0,
  ...overrides,
});

const createBackend = (meals: UserMeal[]): NutritionBackend =>
  ({
    listUserMeals: vi.fn().mockResolvedValue(meals),
  }) as unknown as NutritionBackend;

const createWriteService = () =>
  ({
    addMealBatch: vi.fn().mockResolvedValue({
      status: 'dry_run',
      items: [],
      preview: [],
    }),
  }) as unknown as WriteService & { addMealBatch: ReturnType<typeof vi.fn> };

const baseInput = {
  client_request_id: 'req-1',
  name: 'Chicken Teriyaki',
  date: '2026-11-08',
  daytime: 'lunch' as const,
  amount_factor: 1,
  dry_run: true,
};

describe('UserMealService.listMeals', () => {
  it('returns all YAZIO meals as summaries', async () => {
    const service = new UserMealService(
      createBackend([meal(), meal({ id: '44444444-4444-4444-8444-444444444444', name: 'Drink', items: [] })]),
      createWriteService(),
    );
    const result = await service.listMeals();
    expect(result.meals).toEqual([
      { meal_id: MEAL_ID, name: 'Chicken Teriyaki', item_count: 1 },
      { meal_id: '44444444-4444-4444-8444-444444444444', name: 'Drink', item_count: 0 },
    ]);
  });

  it('filters case-insensitively on the name', async () => {
    const service = new UserMealService(
      createBackend([meal(), meal({ id: '44444444-4444-4444-8444-444444444444', name: 'Drink' })]),
      createWriteService(),
    );
    const result = await service.listMeals('teri');
    expect(result.meals.map((entry) => entry.name)).toEqual(['Chicken Teriyaki']);
  });
});

describe('UserMealService.logUserMeal', () => {
  it('rejects unknown names with MEAL_NOT_FOUND and the available list', async () => {
    const service = new UserMealService(createBackend([meal()]), createWriteService());
    await expect(
      service.logUserMeal({ ...baseInput, name: 'pizza' }),
    ).rejects.toMatchObject({
      code: 'MEAL_NOT_FOUND',
      details: { available_meals: ['Chicken Teriyaki'] },
    });
  });

  it('requires an explicit daytime', async () => {
    const service = new UserMealService(createBackend([meal()]), createWriteService());
    await expect(
      service.logUserMeal({ ...baseInput, daytime: undefined }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('scales amounts and rounds to two decimals', async () => {
    const writeService = createWriteService();
    const service = new UserMealService(createBackend([meal()]), writeService);
    await service.logUserMeal({ ...baseInput, amount_factor: 2 });
    expect(writeService.addMealBatch).toHaveBeenCalledWith({
      client_request_id: 'req-1',
      dry_run: true,
      items: [
        {
          product_id: PRODUCT_A,
          date: '2026-11-08',
          daytime: 'lunch',
          amount: 66.67,
          serving: 'gram',
          serving_quantity: 33.333,
        },
      ],
    });
  });

  it('passes every product of the meal to the batch writer', async () => {
    const writeService = createWriteService();
    const service = new UserMealService(
      createBackend([
        meal({
          items: [
            { product_id: PRODUCT_A, amount: 100, serving: 'gram', serving_quantity: 100 },
            { product_id: PRODUCT_B, amount: 50, serving: 'package', serving_quantity: 1 },
          ],
        }),
      ]),
      writeService,
    );
    const result = await service.logUserMeal({ ...baseInput, dry_run: false });
    expect(writeService.addMealBatch).toHaveBeenCalledTimes(1);
    expect(writeService.addMealBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        dry_run: false,
        items: expect.arrayContaining([
          expect.objectContaining({ product_id: PRODUCT_A }),
          expect.objectContaining({ product_id: PRODUCT_B }),
        ]),
      }),
    );
    expect(result).toMatchObject({
      meal_name: 'Chicken Teriyaki',
      meal_id: MEAL_ID,
      matched_by: 'name',
      daytime: 'lunch',
    });
  });

  it('refuses meals that only contain recipe portions', async () => {
    const service = new UserMealService(
      createBackend([meal({ recipe_portion_count: 1 })]),
      createWriteService(),
    );
    await expect(service.logUserMeal(baseInput)).rejects.toBeInstanceOf(NutritionMcpError);
  });
});
