import { z } from 'zod';
import { NutritionMcpError } from '../errors.js';
import type { AccessTokenProvider } from '../auth/auth-manager.js';
import { AsyncSemaphore, mapWithConcurrency } from '../utils/concurrency.js';
import type {
  ConsumedItemInput,
  DailySummary,
  DiaryDay,
  DiaryItem,
  Exercise,
  Goals,
  MealType,
  Nutrition,
  NutritionBackend,
  Product,
  ProductDetails,
  UserRecipeDetails,
  UserMeal,
  UserProfile,
  WaterIntake,
  WaterWriteInput,
  WeightEntry,
} from '../types.js';

export interface YazioAdapterConfig {
  baseUrl: string;
  countries: string[];
  locales: string[];
  defaultSex: 'male' | 'female';
  timeoutMs: number;
}

const nutrientRecordSchema = z.record(z.string(), z.number().finite());
const coreNutrientRecordSchema = nutrientRecordSchema.superRefine((record, context) => {
  for (const key of [
    'energy.energy',
    'nutrient.protein',
    'nutrient.fat',
    'nutrient.carb',
  ]) {
    if (!(key in record)) {
      context.addIssue({ code: 'custom', message: `Missing required nutrient ${key}` });
    }
  }
});
const rawSearchProductSchema = z
  .object({
    product_id: z.string(),
    name: z.string(),
    producer: z.string().nullable().optional(),
    base_unit: z.string(),
    serving: z.string().nullable().optional(),
    serving_quantity: z.number().nullable().optional(),
    amount: z.number().finite(),
    is_verified: z.boolean(),
    countries: z.array(z.string()),
    language: z.string(),
    nutrients: coreNutrientRecordSchema,
  })
  .passthrough();

const rawProductSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    producer: z.string().nullable().optional(),
    base_unit: z.string(),
    nutrients: coreNutrientRecordSchema,
    servings: z.array(z.object({ serving: z.string(), amount: z.number() }).passthrough()),
    eans: z.array(z.string()),
    language: z.string(),
    countries: z.array(z.string()),
    is_verified: z.boolean(),
    category: z.string().nullable().optional(),
  })
  .passthrough();

const rawRecipeServingSchema = z
  .object({
    producer: z.string().nullable(),
    name: z.string(),
    amount: z.number().finite().nonnegative(),
    base_unit: z.string(),
    serving: z.string().nullable(),
    serving_quantity: z.number().finite().nullable(),
    note: z.string().nullable(),
    product_id: z.string().uuid(),
  })
  .passthrough();

const rawRecipeSchema = z
  .object({
    id: z.string().uuid(),
    yazio_id: z.string().nullable(),
    locale: z.string(),
    name: z.string(),
    portion_count: z.number().finite(),
    nutrients: nutrientRecordSchema,
    image: z.string().nullable(),
    instructions: z.array(z.string()),
    is_yazio_recipe: z.boolean(),
    available_since: z.string().nullable(),
    is_pro_recipe: z.boolean(),
    servings: z.array(rawRecipeServingSchema),
  })
  .passthrough();

const rawUserMealSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    products: z
      .array(
        z
          .object({
            product_id: z.string().min(1),
            amount: z.number().finite().nonnegative(),
            serving: z.string().nullable().optional(),
            serving_quantity: z.number().finite().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
    recipe_portions: z.array(z.unknown()).default([]),
  })
  .passthrough();

const rawDiarySchema = z
  .object({
    products: z.array(
      z
        .object({
          id: z.string().min(1),
          product_id: z.string().min(1),
          date: z.string().min(10),
          daytime: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
          amount: z.number().finite().nonnegative(),
          serving: z.string().nullable().optional(),
          serving_quantity: z.number().finite().nullable().optional(),
        })
        .passthrough(),
    ),
    recipe_portions: z.array(
      z
        .object({
          id: z.string().min(1),
          date: z.string().min(10),
          daytime: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
          type: z.literal('recipe_portion').optional(),
          recipe_id: z.string().uuid(),
          portion_count: z.number().finite().nonnegative(),
        })
        .passthrough(),
    ),
    simple_products: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const rawProfileSchema = z
  .object({
    uuid: z.string().min(1),
    first_name: z.string().nullable().optional(),
    sex: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    goal: z.string().nullable().optional(),
    diet: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
    unit_energy: z.string().nullable().optional(),
    unit_mass: z.string().nullable().optional(),
  })
  .passthrough();

const rawMealSummarySchema = z
  .object({ nutrients: coreNutrientRecordSchema })
  .passthrough();

const rawDailySummarySchema = z
  .object({
    activity_energy: z.number().finite(),
    steps: z.number().finite().nonnegative(),
    water_intake: z.number().finite().nonnegative(),
    goals: coreNutrientRecordSchema,
    meals: z
      .object({
        breakfast: rawMealSummarySchema,
        lunch: rawMealSummarySchema,
        dinner: rawMealSummarySchema,
        snack: rawMealSummarySchema,
      })
      .passthrough(),
  })
  .passthrough();

const rawWaterSchema = z.object({ water_intake: z.number().finite().nonnegative() }).passthrough();

const rawWeightSchema = z
  .object({
    id: z.string().min(1),
    date: z.string().min(10),
    value: z.number().finite().nullable(),
  })
  .passthrough();

const rawExerciseSchema = z
  .object({
    id: z.string().min(1),
    date: z.string().min(10),
    name: z.string(),
    energy: z.number().finite(),
    duration: z.number().finite().nonnegative(),
    distance: z.number().finite().nonnegative(),
    steps: z.number().finite().nonnegative(),
  })
  .passthrough();

const rawExercisesSchema = z
  .object({
    training: z.array(rawExerciseSchema),
    custom_training: z.array(rawExerciseSchema),
  })
  .passthrough();

const numberAt = (record: Record<string, number>, key: string): number => {
  const value = record[key] ?? 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
};

export const normalizeNutrition = (record: Record<string, number>): Nutrition => ({
  calories: numberAt(record, 'energy.energy'),
  protein: numberAt(record, 'nutrient.protein'),
  fat: numberAt(record, 'nutrient.fat'),
  carbs: numberAt(record, 'nutrient.carb'),
  fiber: numberAt(record, 'nutrient.dietaryfiber'),
  sugar: numberAt(record, 'nutrient.sugar'),
  energy_unit: 'kcal',
  mass_unit: 'g',
});

const scaleNutrition = (nutrition: Nutrition, factor: number): Nutrition => ({
  calories: Math.round(nutrition.calories * factor * 1_000_000) / 1_000_000,
  protein: Math.round(nutrition.protein * factor * 1_000_000) / 1_000_000,
  fat: Math.round(nutrition.fat * factor * 1_000_000) / 1_000_000,
  carbs: Math.round(nutrition.carbs * factor * 1_000_000) / 1_000_000,
  fiber: Math.round(nutrition.fiber * factor * 1_000_000) / 1_000_000,
  sugar: Math.round(nutrition.sugar * factor * 1_000_000) / 1_000_000,
  energy_unit: 'kcal',
  mass_unit: 'g',
});

const emptyNutrition = (): Nutrition => normalizeNutrition({});

const addNutrition = (left: Nutrition, right: Nutrition): Nutrition => ({
  calories: left.calories + right.calories,
  protein: left.protein + right.protein,
  fat: left.fat + right.fat,
  carbs: left.carbs + right.carbs,
  fiber: left.fiber + right.fiber,
  sugar: left.sugar + right.sugar,
  energy_unit: 'kcal',
  mass_unit: 'g',
});

export class YazioAdapter implements NutritionBackend {
  private readonly httpLimiter = new AsyncSemaphore(6);

  constructor(
    private readonly config: YazioAdapterConfig,
    private readonly auth: AccessTokenProvider,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async getUserProfile(): Promise<UserProfile> {
    const data = this.parseUpstream(rawProfileSchema, await this.request('/user'), '/user');
    return {
      user_id: data.uuid,
      first_name: data.first_name ?? null,
      sex: data.sex ?? null,
      country: data.country ?? null,
      goal: data.goal ?? null,
      diet: data.diet?.name ?? null,
      unit_energy: data.unit_energy ?? null,
      unit_mass: data.unit_mass ?? null,
    };
  }

  async getGoals(date: string): Promise<Goals> {
    const endpoint = `/user/goals/unmodified?${new URLSearchParams({ date })}`;
    const data = this.parseUpstream(
      coreNutrientRecordSchema,
      await this.request(endpoint),
      endpoint,
    );
    return {
      date,
      nutrition: normalizeNutrition(data),
      water_ml: numberAt(data, 'water'),
      steps: numberAt(data, 'activity.step'),
      weight_kg: data['bodyvalue.weight'] ?? null,
    };
  }

  async searchProducts(input: {
    query: string;
    countries?: string[] | undefined;
    locales?: string[] | undefined;
    sex?: 'male' | 'female' | undefined;
    limit?: number | undefined;
  }): Promise<Product[]> {
    const query = new URLSearchParams({
      query: input.query,
      sex: input.sex ?? this.config.defaultSex,
      countries: (input.countries ?? this.config.countries).join(','),
      locales: (input.locales ?? this.config.locales).join(','),
    });
    const endpoint = `/products/search?${query}`;
    const data = this.parseUpstream(
      z.array(rawSearchProductSchema),
      await this.request(endpoint),
      endpoint,
    );
    return data.slice(0, input.limit ?? 20).map((product) => ({
      id: product.product_id,
      name: product.name,
      producer: product.producer ?? null,
      base_unit: product.base_unit,
      serving: product.serving ?? null,
      serving_quantity: product.serving_quantity ?? null,
      amount: product.amount,
      is_verified: product.is_verified,
      countries: product.countries,
      language: product.language,
      nutrition: scaleNutrition(normalizeNutrition(product.nutrients), 100),
    }));
  }

  async getProduct(id: string): Promise<ProductDetails | null> {
    const raw = await this.request(`/products/${encodeURIComponent(id)}`, { allowNotFound: true });
    if (raw === null) return null;
    const product = this.parseUpstream(rawProductSchema, raw, '/products/:id');
    return {
      id: product.id ?? id,
      name: product.name,
      producer: product.producer ?? null,
      base_unit: product.base_unit,
      serving: null,
      serving_quantity: null,
      amount: 100,
      is_verified: product.is_verified,
      countries: product.countries,
      language: product.language,
      nutrition: scaleNutrition(normalizeNutrition(product.nutrients), 100),
      servings: product.servings,
      eans: product.eans,
      category: product.category ?? null,
    };
  }

  async listUserRecipeIds(): Promise<string[]> {
    const endpoint = '/user/recipes';
    return this.parseUpstream(
      z.array(z.string().uuid()),
      await this.request(endpoint),
      endpoint,
    );
  }

  async getRecipe(id: string): Promise<UserRecipeDetails | null> {
    const endpoint = `/recipes/${encodeURIComponent(id)}`;
    const raw = await this.request(endpoint, { allowNotFound: true });
    if (raw === null) return null;
    const recipe = this.parseUpstream(rawRecipeSchema, raw, '/recipes/:id');
    return {
      id: recipe.id,
      yazio_id: recipe.yazio_id,
      locale: recipe.locale,
      name: recipe.name,
      portion_count: recipe.portion_count,
      nutrition: normalizeNutrition(recipe.nutrients),
      nutrition_basis: 'upstream_unspecified',
      image: recipe.image,
      instructions: recipe.instructions,
      is_yazio_recipe: recipe.is_yazio_recipe,
      available_since: recipe.available_since,
      is_pro_recipe: recipe.is_pro_recipe,
      servings: recipe.servings,
    };
  }

  async listUserMeals(): Promise<UserMeal[]> {
    const endpoint = '/user/meals';
    const meals = this.parseUpstream(
      z.array(rawUserMealSchema),
      await this.request(endpoint),
      endpoint,
    );
    return meals.map((meal) => ({
      id: meal.id,
      name: meal.name,
      items: meal.products.map((item) => ({
        product_id: item.product_id,
        amount: item.amount,
        serving: item.serving ?? null,
        serving_quantity: item.serving_quantity ?? null,
      })),
      recipe_portion_count: meal.recipe_portions.length,
    }));
  }

  async getDiary(date: string): Promise<DiaryDay> {
    const endpoint = `/user/consumed-items?${new URLSearchParams({ date })}`;
    const raw = this.parseUpstream(
      rawDiarySchema,
      await this.request(endpoint),
      endpoint,
    );
    const productDetails = new Map<string, ProductDetails | null>();
    const productIds = [
      ...new Set(
        raw.products
          .map((item) => (typeof item.product_id === 'string' ? item.product_id : null))
          .filter((value): value is string => value !== null),
      ),
    ];
    await mapWithConcurrency(
      productIds,
      6,
      async (id) => {
        productDetails.set(id, await this.getProduct(id));
      },
    );
    const recipeDetails = new Map<string, UserRecipeDetails | null>();
    const recipeIds = [
      ...new Set(raw.recipe_portions.map((item) => item.recipe_id)),
    ];
    await mapWithConcurrency(recipeIds, 6, async (id) => {
      try {
        recipeDetails.set(id, await this.getRecipe(id));
      } catch {
        // Recipe reads are community-observed but not guaranteed on every API
        // version. Diary rows remain usable through recipe_id if enrichment fails.
        recipeDetails.set(id, null);
      }
    });

    const items: DiaryItem[] = [];
    for (const item of raw.products) {
      const productId = item.product_id;
      const amount = item.amount;
      const product = productDetails.get(productId) ?? null;
      items.push({
        id: item.id,
        date: item.date.slice(0, 10),
        daytime: item.daytime,
        kind: 'product',
        product_id: productId,
        recipe_id: null,
        name: product?.name ?? null,
        amount,
        serving: typeof item.serving === 'string' ? item.serving : null,
        serving_quantity: typeof item.serving_quantity === 'number' ? item.serving_quantity : null,
        nutrition: product === null ? null : scaleNutrition(product.nutrition, amount / 100),
      });
    }
    for (const item of raw.recipe_portions) {
      const normalized = this.nonProductDiaryItem(item, date, 'recipe_portion');
      normalized.name = recipeDetails.get(item.recipe_id)?.name ?? null;
      items.push(normalized);
    }
    for (const item of raw.simple_products) items.push(this.nonProductDiaryItem(item, date, 'simple_product'));
    const missingNutritionItemIds = items
      .filter((item) => item.nutrition === null)
      .map((item) => item.id);
    let totals = items.reduce(
      (total, item) => (item.nutrition === null ? total : addNutrition(total, item.nutrition)),
      emptyNutrition(),
    );
    let totalsComplete = missingNutritionItemIds.length === 0;
    let totalsSource: DiaryDay['totals_source'] = 'item_sum';
    if (!totalsComplete) {
      try {
        totals = (await this.getDailySummary(date)).nutrition;
        totalsComplete = true;
        totalsSource = 'daily_summary';
      } catch {
        // Return the known item sum only with an explicit partial marker.
      }
    }
    return {
      date,
      items,
      totals,
      totals_complete: totalsComplete,
      totals_source: totalsSource,
      missing_nutrition_item_ids: totalsComplete ? [] : missingNutritionItemIds,
    };
  }

  async getDailySummary(date: string): Promise<DailySummary> {
    const endpoint = `/user/widgets/daily-summary?${new URLSearchParams({ date })}`;
    const data = this.parseUpstream(
      rawDailySummarySchema,
      await this.request(endpoint),
      endpoint,
    );
    const meals = Object.fromEntries(
      (['breakfast', 'lunch', 'dinner', 'snack'] as const).map((meal) => {
        return [meal, normalizeNutrition(data.meals[meal].nutrients)];
      }),
    ) as Record<MealType, Nutrition>;
    const nutrition = Object.values(meals).reduce(addNutrition, emptyNutrition());
    return {
      date,
      nutrition,
      goal: normalizeNutrition(data.goals),
      water_ml: data.water_intake,
      activity_calories: data.activity_energy,
      steps: data.steps,
      meals,
    };
  }

  async getWaterIntake(date: string): Promise<WaterIntake> {
    const endpoint = `/user/water-intake?${new URLSearchParams({ date })}`;
    const data = this.parseUpstream(
      rawWaterSchema,
      await this.request(endpoint),
      endpoint,
    );
    return { date, water_ml: data.water_intake };
  }

  async getWeight(date: string): Promise<WeightEntry | null> {
    const raw = await this.request(
      `/user/bodyvalues/weight/last?${new URLSearchParams({ date })}`,
      { allowNotFound: true },
    );
    if (raw === null) return null;
    const data = this.parseUpstream(rawWeightSchema, raw, '/user/bodyvalues/weight/last');
    return {
      id: data.id,
      date: data.date.slice(0, 10),
      weight_kg: data.value,
    };
  }

  async getExercises(date: string): Promise<Exercise[]> {
    const endpoint = `/user/exercises?${new URLSearchParams({ date })}`;
    const data = this.parseUpstream(
      rawExercisesSchema,
      await this.request(endpoint),
      endpoint,
    );
    const rows = [...data.training, ...data.custom_training];
    return rows.map((row) => ({
      id: row.id,
      date: row.date.slice(0, 10),
      name: row.name,
      calories: row.energy,
      duration_seconds: row.duration,
      distance_meters: row.distance,
      steps: row.steps,
    }));
  }

  async addConsumedItem(input: ConsumedItemInput): Promise<void> {
    await this.request('/user/consumed-items', {
      method: 'POST',
      body: {
        products: [
          {
            id: input.id,
            product_id: input.product_id,
            date: input.date,
            daytime: input.daytime,
            amount: input.amount,
            serving: input.serving,
            serving_quantity: input.serving_quantity,
          },
        ],
        recipe_portions: [],
        simple_products: [],
      },
    });
  }

  async removeConsumedItem(itemId: string): Promise<void> {
    await this.request('/user/consumed-items', { method: 'DELETE', body: [itemId] });
  }

  async setWaterIntake(input: WaterWriteInput): Promise<void> {
    await this.request('/user/water-intake', {
      method: 'POST',
      body: [{ date: input.dateTime, water_intake: input.cumulativeMl }],
    });
  }

  private async request(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'DELETE';
      body?: unknown;
      allowNotFound?: boolean;
    } = {},
    retryAfterAuth = true,
    retryAfterRateLimit = true,
  ): Promise<unknown> {
    const token = await this.auth.getAccessToken();
    let response: Response;
    try {
      response = await this.httpLimiter.run(() =>
        this.fetchImplementation(`${this.config.baseUrl}${path}`, {
          method: options.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        }),
      );
    } catch (error) {
      throw new NutritionMcpError('UPSTREAM_ERROR', 'The YAZIO network request failed.', {
        retryable: true,
        cause: error,
      });
    }
    if (response.status === 401 && retryAfterAuth) {
      await this.auth.invalidate();
      return this.request(path, options, false, retryAfterRateLimit);
    }
    if (
      response.status === 429 &&
      (options.method ?? 'GET') === 'GET' &&
      retryAfterRateLimit
    ) {
      await new Promise((resolve) => setTimeout(resolve, this.retryAfterMs(response)));
      return this.request(path, options, retryAfterAuth, false);
    }
    if (response.status === 404 && options.allowNotFound === true) return null;
    if (!response.ok) {
      const code =
        response.status === 401
          ? 'UPSTREAM_UNAUTHORIZED'
          : response.status === 404
            ? 'UPSTREAM_NOT_FOUND'
            : response.status === 429
              ? 'UPSTREAM_RATE_LIMITED'
              : 'UPSTREAM_ERROR';
      throw new NutritionMcpError(code, `The YAZIO API returned HTTP ${response.status}.`, {
        retryable: response.status === 429 || response.status >= 500,
        details: { status: response.status },
      });
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch (error) {
      throw new NutritionMcpError('UPSTREAM_INVALID_RESPONSE', 'YAZIO returned invalid JSON.', {
        cause: error,
      });
    }
  }

  private parseUpstream<T extends z.ZodType>(
    schema: T,
    value: unknown,
    endpoint: string,
  ): z.output<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new NutritionMcpError(
        'UPSTREAM_INVALID_RESPONSE',
        'The YAZIO response does not match the expected contract.',
        {
          details: {
            endpoint,
            issues: parsed.error.issues.map(({ path, code }) => ({ path, code })),
          },
        },
      );
    }
    return parsed.data;
  }

  private retryAfterMs(response: Response): number {
    const raw = response.headers.get('retry-after');
    if (raw === null) return 1_000;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, 30_000);
    }
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 30_000) : 1_000;
  }

  private mealType(value: unknown): MealType {
    return value === 'breakfast' || value === 'lunch' || value === 'dinner' || value === 'snack'
      ? value
      : 'snack';
  }

  private nonProductDiaryItem(
    item: Record<string, unknown>,
    fallbackDate: string,
    kind: 'recipe_portion' | 'simple_product',
  ): DiaryItem {
    return {
      id: typeof item.id === 'string' ? item.id : '',
      date: typeof item.date === 'string' ? item.date.slice(0, 10) : fallbackDate,
      daytime: this.mealType(item.daytime),
      kind,
      product_id: null,
      recipe_id:
        kind === 'recipe_portion' && typeof item.recipe_id === 'string'
          ? item.recipe_id
          : null,
      name: typeof item.name === 'string' ? item.name : null,
      amount:
        typeof item.portion_count === 'number'
          ? item.portion_count
          : typeof item.amount === 'number'
            ? item.amount
            : 0,
      serving: null,
      serving_quantity: null,
      nutrition:
        typeof item.nutrients === 'object' && item.nutrients !== null
          ? normalizeNutrition(this.numberRecord(item.nutrients))
          : null,
    };
  }

  private numberRecord(value: unknown): Record<string, number> {
    if (typeof value !== 'object' || value === null) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    );
  }

}
