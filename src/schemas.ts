import { DateTime } from 'luxon';
import { z } from 'zod';
import { errorCodeSchema } from './errors.js';

const validIsoDate = (value: string): boolean =>
  DateTime.fromISO(value, { zone: 'utc' }).isValid && /^\d{4}-\d{2}-\d{2}$/.test(value);

export const isoDateSchema = z.string().refine(validIsoDate, 'Expected a valid date in YYYY-MM-DD format');
export const uuidSchema = z.uuid();
export const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);

export const nutritionSchema = z.object({
  calories: z.number().finite().nonnegative(),
  protein: z.number().finite().nonnegative(),
  fat: z.number().finite().nonnegative(),
  carbs: z.number().finite().nonnegative(),
  fiber: z.number().finite().nonnegative(),
  sugar: z.number().finite().nonnegative(),
  energy_unit: z.literal('kcal'),
  mass_unit: z.literal('g'),
});

export const dateRangeSchema = z
  .object({
    start_date: isoDateSchema,
    end_date: isoDateSchema,
  })
  .strict()
  .refine(({ start_date, end_date }) => start_date <= end_date, {
    message: 'start_date must not be later than end_date',
    path: ['end_date'],
  });

const dateOrRangeShape = {
  date: isoDateSchema.optional(),
  start_date: isoDateSchema.optional(),
  end_date: isoDateSchema.optional(),
};

const refineDateOrRange = (
  { date, start_date, end_date }: {
    date?: string | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
  },
  context: z.RefinementCtx,
) => {
  if (date !== undefined && (start_date !== undefined || end_date !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'Provide either date or start_date/end_date, not both',
    });
  }
  if ((start_date === undefined) !== (end_date === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'start_date and end_date must be provided together',
    });
  }
  if (start_date !== undefined && end_date !== undefined && start_date > end_date) {
    context.addIssue({
      code: 'custom',
      path: ['end_date'],
      message: 'start_date must not be later than end_date',
    });
  }
};

export const dateOrRangeInputSchema = z
  .object(dateOrRangeShape)
  .strict()
  .superRefine(refineDateOrRange);

export const diaryInputSchema = z
  .object({
    ...dateOrRangeShape,
    compact: z.boolean().default(true),
  })
  .strict()
  .superRefine(refineDateOrRange);

export const searchProductsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(10).optional(),
    locales: z.array(z.string().regex(/^[a-z]{2}_[A-Z]{2}$/)).min(1).max(10).optional(),
    sex: z.enum(['male', 'female']).optional(),
    limit: z.number().int().min(1).max(50).default(5),
    compact: z.boolean().default(true),
  })
  .strict();

export const getProductInputSchema = z.object({ product_id: uuidSchema }).strict();
export const getRecipeInputSchema = z.object({ recipe_id: uuidSchema }).strict();
export const listUserRecipesInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    scan_limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();
export const getGoalsInputSchema = z.object({ date: isoDateSchema.optional() }).strict();
export const getDateInputSchema = z.object({ date: isoDateSchema.optional() }).strict();

const writeCommonSchema = z
  .object({
    client_request_id: z.string().trim().min(8).max(128),
    dry_run: z.boolean().default(true),
  })
  .strict();

export const consumedItemFieldsSchema = z
  .object({
    product_id: uuidSchema,
    date: isoDateSchema,
    daytime: mealTypeSchema,
    amount: z.number().finite().positive().max(100_000),
    serving: z.string().trim().min(1).max(100).nullable().optional(),
    serving_quantity: z.number().finite().positive().max(10_000).nullable().optional(),
  })
  .strict()
  .superRefine(({ serving, serving_quantity }, context) => {
    if ((serving == null) !== (serving_quantity == null)) {
      context.addIssue({
        code: 'custom',
        message: 'serving and serving_quantity must either both be provided or both be omitted',
      });
    }
  });

export const addConsumedItemInputSchema = writeCommonSchema.extend(consumedItemFieldsSchema.shape);

export const addMealBatchInputSchema = writeCommonSchema.extend({
  items: z.array(consumedItemFieldsSchema).min(1).max(25),
});

export const updateConsumedItemInputSchema = writeCommonSchema.extend({
  item_id: uuidSchema,
  date: isoDateSchema,
  amount: z.number().finite().positive().max(100_000),
  confirmation_token: z.string().min(32).max(256).optional(),
});

export const removeConsumedItemInputSchema = writeCommonSchema.extend({
  item_id: uuidSchema,
  date: isoDateSchema,
  confirmation_token: z.string().min(32).max(256).optional(),
});

export const addWaterInputSchema = writeCommonSchema.extend({
  date: isoDateSchema,
  amount_ml: z.number().int().positive().max(20_000),
});

export const trendsInputSchema = dateRangeSchema.extend({
  aggregation: z.enum(['day', 'week', 'month']).default('day'),
});

export const comparePeriodsInputSchema = z
  .object({
    first_start_date: isoDateSchema,
    first_end_date: isoDateSchema,
    second_start_date: isoDateSchema,
    second_end_date: isoDateSchema,
  })
  .strict();

export const missingMealsInputSchema = dateRangeSchema.extend({
  meals: z.array(mealTypeSchema).min(1).max(4).default(['breakfast', 'lunch', 'dinner']),
  maximum_recorded_calories: z.number().finite().nonnegative().max(500).default(50),
});

export const toolErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const resultMetaSchema = z.object({
  timezone: z.string(),
  backend: z.string(),
  generated_at: z.string(),
});

const errorDetailSchema = z.object({
      code: errorCodeSchema,
      message: z.string(),
      retryable: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional(),
});

export const outputEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.unknown(),
    meta: resultMetaSchema,
  }),
  z.object({
    ok: z.literal(false),
    error: errorDetailSchema,
  }),
]);

export const toolOutputSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      data: dataSchema,
      meta: resultMetaSchema,
    }),
    z.object({
      ok: z.literal(false),
      error: errorDetailSchema,
    }),
  ]);

export const userProfileOutputSchema = z.object({
  user_id: z.string(),
  first_name: z.string().nullable(),
  sex: z.string().nullable(),
  country: z.string().nullable(),
  goal: z.string().nullable(),
  diet: z.string().nullable(),
  unit_energy: z.string().nullable(),
  unit_mass: z.string().nullable(),
});

export const goalsOutputSchema = z.object({
  date: isoDateSchema,
  nutrition: nutritionSchema,
  water_ml: z.number().nonnegative(),
  steps: z.number().nonnegative(),
  weight_kg: z.number().nullable(),
});

export const productOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  producer: z.string().nullable(),
  base_unit: z.string(),
  serving: z.string().nullable(),
  serving_quantity: z.number().nullable(),
  amount: z.number(),
  is_verified: z.boolean(),
  countries: z.array(z.string()),
  language: z.string(),
  nutrition: nutritionSchema,
});

export const compactProductOutputSchema = z.object({
  product_id: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  serving: z.string().nullable(),
  per_100g: z.object({
    calories: z.number(),
    protein: z.number(),
    carbs: z.number(),
    fat: z.number(),
  }),
});

export const productDetailsOutputSchema = productOutputSchema.extend({
  servings: z.array(z.object({ serving: z.string(), amount: z.number() })),
  eans: z.array(z.string()),
  category: z.string().nullable(),
});

export const recipeServingOutputSchema = z.object({
  producer: z.string().nullable(),
  name: z.string(),
  amount: z.number().finite().nonnegative(),
  base_unit: z.string(),
  serving: z.string().nullable(),
  serving_quantity: z.number().finite().nullable(),
  note: z.string().nullable(),
  product_id: uuidSchema,
});

export const userRecipeDetailsOutputSchema = z.object({
  id: uuidSchema,
  yazio_id: z.string().nullable(),
  locale: z.string(),
  name: z.string(),
  portion_count: z.number().finite(),
  nutrition: nutritionSchema,
  nutrition_basis: z.literal('upstream_unspecified'),
  image: z.string().nullable(),
  instructions: z.array(z.string()),
  is_yazio_recipe: z.boolean(),
  available_since: z.string().nullable(),
  is_pro_recipe: z.boolean(),
  servings: z.array(recipeServingOutputSchema),
});

export const userRecipeIdsOutputSchema = z
  .object({
    recipe_ids: z.array(uuidSchema),
  })
  .strict();

export const userRecipeListOutputSchema = z
  .object({
    recipes: z.array(userRecipeDetailsOutputSchema),
    total_ids: z.number().int().nonnegative(),
    scanned_ids: z.number().int().nonnegative(),
    failed_recipe_ids: z.array(uuidSchema),
    truncated: z.boolean(),
    partial: z.boolean(),
  })
  .strict();

export const diaryItemOutputSchema = z.object({
  id: z.string(),
  date: isoDateSchema.optional(),
  daytime: mealTypeSchema,
  kind: z.enum(['product', 'recipe_portion', 'simple_product']),
  product_id: z.string().nullable(),
  recipe_id: z.string().nullable(),
  name: z.string().nullable(),
  amount: z.number(),
  serving: z.string().nullable(),
  serving_quantity: z.number().nullable(),
  nutrition: nutritionSchema.nullable().optional(),
});

export const diaryDayOutputSchema = z.object({
  date: isoDateSchema,
  items: z.array(diaryItemOutputSchema),
  totals: nutritionSchema,
  totals_complete: z.boolean(),
  totals_source: z.enum(['item_sum', 'daily_summary']),
  missing_nutrition_item_ids: z.array(z.string()),
});

export const dailySummaryOutputSchema = z.object({
  date: isoDateSchema,
  nutrition: nutritionSchema,
  goal: nutritionSchema,
  water_ml: z.number().nonnegative(),
  activity_calories: z.number(),
  steps: z.number().nonnegative(),
  meals: z.object({
    breakfast: nutritionSchema,
    lunch: nutritionSchema,
    dinner: nutritionSchema,
    snack: nutritionSchema,
  }),
});

export const waterOutputSchema = z.object({
  date: isoDateSchema,
  water_ml: z.number().nonnegative(),
});

export const weightOutputSchema = z.object({
  id: z.string(),
  date: isoDateSchema,
  weight_kg: z.number().nullable(),
});

export const exerciseOutputSchema = z.object({
  id: z.string(),
  date: isoDateSchema,
  name: z.string(),
  calories: z.number(),
  duration_seconds: z.number(),
  distance_meters: z.number(),
  steps: z.number(),
});

const consumedPreviewSchema = z
  .object({
    action: z.literal('add_consumed_item'),
    product_id: z.string(),
    product_name: z.string(),
    date: isoDateSchema,
    daytime: mealTypeSchema,
    amount: z.number().positive(),
    base_unit: z.string(),
    serving: z.string().nullable(),
    serving_quantity: z.number().nullable(),
    estimated_nutrition: nutritionSchema,
  })
  .strict();

export const addConsumedItemOutputSchema = z
  .object({
    status: z.enum(['dry_run', 'applied', 'applied_unverified']),
    preview: consumedPreviewSchema,
    entry_id: z.string().nullable(),
    duplicate_check: z.literal('clear'),
    verified: z.boolean(),
  })
  .strict();

export const batchItemOutputSchema = z
  .object({
    index: z.number().int().nonnegative(),
    entry_id: z.string().nullable(),
    status: z.enum([
      'applied',
      'applied_unverified',
      'failed',
      'not_attempted',
      'rolled_back',
      'rollback_failed',
      'uncertain',
    ]),
    message: z.string().optional(),
  })
  .strict();

export const batchOutputSchema = z
  .object({
    status: z.enum(['dry_run', 'applied', 'rolled_back', 'partial_failure']),
    items: z.array(batchItemOutputSchema),
    preview: z.array(consumedPreviewSchema),
  })
  .strict();

const removalPreviewSchema = z
  .object({
    action: z.literal('remove_consumed_item'),
    item: diaryItemOutputSchema,
  })
  .strict();

export const removeConsumedItemOutputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('dry_run'),
      preview: removalPreviewSchema.extend({
        confirmation_token: z.string(),
        confirmation_expires_at: z.iso.datetime(),
      }),
    })
    .strict(),
  z
    .object({
      status: z.enum(['removed', 'removed_unverified']),
      preview: removalPreviewSchema,
      verified: z.boolean(),
    })
    .strict(),
]);

const updateConsumedItemPreviewSchema = z
  .object({
    action: z.literal('update_consumed_item'),
    old_item: diaryItemOutputSchema,
    replacement: consumedPreviewSchema,
  })
  .strict();

export const updateConsumedItemOutputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('dry_run'),
      preview: updateConsumedItemPreviewSchema.extend({
        confirmation_token: z.string(),
        confirmation_expires_at: z.iso.datetime(),
      }),
      old_entry_id: z.string(),
      replacement_entry_id: z.null(),
      verified: z.literal(false),
    })
    .strict(),
  z
    .object({
      status: z.literal('applied'),
      preview: updateConsumedItemPreviewSchema,
      old_entry_id: z.string(),
      replacement_entry_id: z.string(),
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      status: z.literal('rolled_back'),
      preview: updateConsumedItemPreviewSchema,
      old_entry_id: z.string(),
      replacement_entry_id: z.string(),
      verified: z.literal(true),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal('partial_failure'),
      preview: updateConsumedItemPreviewSchema,
      old_entry_id: z.string(),
      replacement_entry_id: z.string(),
      verified: z.literal(false),
      message: z.string(),
    })
    .strict(),
]);

const waterPreviewSchema = z
  .object({
    action: z.literal('add_water_intake'),
    date: isoDateSchema,
    previous_ml: z.number().nonnegative(),
    amount_ml: z.number().positive(),
    resulting_cumulative_ml: z.number().nonnegative(),
  })
  .strict();

export const addWaterOutputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('dry_run'),
      preview: waterPreviewSchema,
    })
    .strict(),
  z
    .object({
      status: z.enum(['applied', 'applied_unverified']),
      preview: waterPreviewSchema,
      verified: z.boolean(),
      water: waterOutputSchema,
    })
    .strict(),
]);

const goalComparisonSchema = z
  .object({
    calories_percent: z.number().nullable(),
    protein_percent: z.number().nullable(),
    fat_percent: z.number().nullable(),
    carbs_percent: z.number().nullable(),
  })
  .strict();

const stabilitySchema = z
  .object({
    calories_coefficient_of_variation: z.number(),
    mean_absolute_calorie_deviation: z.number(),
  })
  .strict();

const trendPeriodSchema = z
  .object({
    period: z.string(),
    days: z.number().int().nonnegative(),
    average: nutritionSchema,
  })
  .strict();

export const coverageSchema = z
  .object({
    requested_days: z.number().int().nonnegative(),
    successful_days: z.number().int().nonnegative(),
    failed_dates: z.array(isoDateSchema),
  })
  .strict();

export const trendsOutputSchema = z
  .object({
    aggregation: z.enum(['day', 'week', 'month']),
    days: z.number().int().nonnegative(),
    average: nutritionSchema,
    goal_average: nutritionSchema,
    goal_comparison: goalComparisonSchema,
    stability: stabilitySchema,
    periods: z.array(trendPeriodSchema),
    coverage: coverageSchema,
    partial: z.boolean(),
  })
  .strict();

const changePercentSchema = z
  .object({
    calories: z.number().nullable(),
    protein: z.number().nullable(),
    fat: z.number().nullable(),
    carbs: z.number().nullable(),
    fiber: z.number().nullable(),
    sugar: z.number().nullable(),
  })
  .strict();

export const comparePeriodsOutputSchema = z
  .object({
    first: trendsOutputSchema,
    second: trendsOutputSchema,
    change_percent: changePercentSchema,
    partial: z.boolean(),
  })
  .strict();

export const missingMealFindingOutputSchema = z
  .object({
    date: isoDateSchema,
    meal: mealTypeSchema,
    recorded_calories: z.number().nonnegative(),
    reason: z.string(),
    confidence: z.enum(['low', 'medium']),
  })
  .strict();

export const missingMealsOutputSchema = z
  .object({
    findings: z.array(missingMealFindingOutputSchema),
    auto_write_performed: z.literal(false),
    coverage: coverageSchema,
    partial: z.boolean(),
  })
  .strict();

export const savedMealItemSchema = z
  .object({
    product_id: uuidSchema,
    amount: z.number().finite().positive().max(100_000),
    serving: z.string().trim().min(1).max(100).nullable().optional(),
    serving_quantity: z.number().finite().positive().max(10_000).nullable().optional(),
  })
  .strict()
  .superRefine(({ serving, serving_quantity }, context) => {
    if ((serving == null) !== (serving_quantity == null)) {
      context.addIssue({
        code: 'custom',
        message: 'serving and serving_quantity must either both be provided or both be omitted',
      });
    }
  });

export const saveMealInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    aliases: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    default_daytime: mealTypeSchema.optional(),
    items: z.array(savedMealItemSchema).min(1).max(50),
  })
  .strict();

export const listSavedMealsInputSchema = z.object({}).strict();

export const logSavedMealInputSchema = z
  .object({
    client_request_id: z.string().trim().min(8).max(128),
    name: z.string().trim().min(1).max(200),
    date: isoDateSchema,
    daytime: mealTypeSchema.optional(),
    amount_factor: z.number().finite().positive().max(10).default(1),
    dry_run: z.boolean().default(true),
  })
  .strict();

export const savedMealSummaryOutputSchema = z
  .object({
    name: z.string(),
    aliases: z.array(z.string()),
    default_daytime: mealTypeSchema.nullable(),
    item_count: z.number().int().nonnegative(),
    nutrition: nutritionSchema.nullable(),
  })
  .strict();

export const listSavedMealsOutputSchema = z
  .object({
    meals: z.array(savedMealSummaryOutputSchema),
  })
  .strict();

export const savedMealDefinitionOutputSchema = z
  .object({
    name: z.string(),
    aliases: z.array(z.string()),
    default_daytime: mealTypeSchema.nullable(),
    items: z.array(
      z.object({
        product_id: uuidSchema,
        amount: z.number().finite().positive(),
        serving: z.string().nullable(),
        serving_quantity: z.number().nullable(),
      }),
    ),
  })
  .strict();

export const saveMealOutputSchema = z
  .object({
    meal: savedMealDefinitionOutputSchema,
    replaced: z.boolean(),
  })
  .strict();

export const logSavedMealOutputSchema = z
  .object({
    meal_name: z.string(),
    matched_by: z.enum(['name', 'alias']),
    amount_factor: z.number().positive(),
    date: isoDateSchema,
    daytime: mealTypeSchema,
    batch: batchOutputSchema,
  })
  .strict();

export const savedMealFileEntrySchema = z.object({
  // Deliberately non-strict: unknown fields in the file are ignored on load.
  name: z.string().trim().min(1),
  aliases: z.array(z.string()).optional(),
  default_daytime: mealTypeSchema.nullable().optional(),
  items: z
    .array(
      z.object({
        product_id: uuidSchema,
        amount: z.number().finite().positive(),
        serving: z.string().trim().min(1).max(100).nullable().optional(),
        serving_quantity: z.number().finite().positive().max(10_000).nullable().optional(),
      }),
    )
    .min(1),
});

export const savedMealsFileSchema = z.object({
  meals: z.array(savedMealFileEntrySchema).default([]),
});

// --- YAZIO-native user meals (/user/meals) ---------------------------------

export const listUserMealsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const userMealSummarySchema = z.object({
  meal_id: uuidSchema,
  name: z.string(),
  item_count: z.number().int().nonnegative(),
});

export const listUserMealsOutputSchema = z.object({
  meals: z.array(userMealSummarySchema),
});

export const logUserMealInputSchema = z
  .object({
    client_request_id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    date: isoDateSchema,
    daytime: mealTypeSchema.optional(),
    amount_factor: z.number().finite().positive().max(10).default(1),
    dry_run: z.boolean().default(true),
  })
  .strict();

export const logUserMealOutputSchema = z.object({
  meal_name: z.string(),
  meal_id: uuidSchema,
  matched_by: z.literal('name'),
  date: isoDateSchema,
  daytime: mealTypeSchema,
  amount_factor: z.number().finite().positive(),
  batch: batchOutputSchema,
});
