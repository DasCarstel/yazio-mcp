import { createHash } from 'node:crypto';
import {
  McpServer,
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  type CallToolResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { aggregateTrends, compareTrendPeriods, detectMissingMeals } from './analytics/index.js';
import { YazioAdapter } from './adapters/yazio-adapter.js';
import { AuthManager } from './auth/auth-manager.js';
import { FileTokenStore } from './auth/token-store.js';
import type { AppConfig } from './config.js';
import { enumerateDates, resolveDateOrRange, todayInZone } from './domain/dates.js';
import { NutritionMcpError, toPublicError } from './errors.js';
import { FileIdempotencyStore, fingerprint } from './persistence/idempotency-store.js';
import {
  addConsumedItemOutputSchema,
  addConsumedItemInputSchema,
  addMealBatchInputSchema,
  addWaterOutputSchema,
  addWaterInputSchema,
  batchOutputSchema,
  comparePeriodsOutputSchema,
  comparePeriodsInputSchema,
  compactProductOutputSchema,
  dailySummaryOutputSchema,
  diaryDayOutputSchema,
  diaryInputSchema,
  exerciseOutputSchema,
  getDateInputSchema,
  getGoalsInputSchema,
  getProductInputSchema,
  goalsOutputSchema,
  listSavedMealsInputSchema,
  listUserMealsInputSchema,
  listUserMealsOutputSchema,
  logUserMealInputSchema,
  logUserMealOutputSchema,
  listSavedMealsOutputSchema,
  logSavedMealInputSchema,
  logSavedMealOutputSchema,
  missingMealsInputSchema,
  missingMealsOutputSchema,
  productDetailsOutputSchema,
  productOutputSchema,
  removeConsumedItemInputSchema,
  removeConsumedItemOutputSchema,
  saveMealInputSchema,
  saveMealOutputSchema,
  searchProductsInputSchema,
  toolOutputSchema,
  trendsInputSchema,
  trendsOutputSchema,
  updateConsumedItemInputSchema,
  updateConsumedItemOutputSchema,
  userProfileOutputSchema,
  waterOutputSchema,
  weightOutputSchema,
} from './schemas.js';
import { SavedMealService, SavedMealStore } from './services/saved-meals.js';
import { UserMealService } from './services/user-meals.js';
import { WriteService } from './services/write-service.js';
import type { NutritionBackend } from './types.js';
import { mapSettledWithConcurrency, mapWithConcurrency } from './utils/concurrency.js';

export interface ServerDependencies {
  backend?: NutritionBackend;
  writeService?: WriteService;
  fetchImplementation?: typeof fetch;
}

const confirmationSchema = z.object({ confirm: z.boolean() });
const rangeReadConcurrency = 6;

interface DestructiveRequestState {
  operation: 'remove_consumed_item' | 'update_consumed_item';
  fingerprint: string;
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const removeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const resultMeta = (config: AppConfig) => ({
  timezone: config.timezone,
  backend: 'yazio-unofficial',
  generated_at: new Date().toISOString(),
});

const successResult = (
  config: AppConfig,
  data: unknown,
  text: string,
): CallToolResult => ({
  content: [{ type: 'text', text }],
  structuredContent: { ok: true, data, meta: resultMeta(config) },
});

const errorResult = (error: unknown): CallToolResult => {
  const publicError = toPublicError(error);
  return {
    content: [{ type: 'text', text: `${publicError.code}: ${publicError.message}` }],
    structuredContent: { ok: false, error: publicError },
    isError: true,
  };
};

const safeResult = async (
  config: AppConfig,
  operation: () => Promise<unknown>,
  summarize: (data: unknown) => string,
): Promise<CallToolResult> => {
  try {
    const data = await operation();
    return successResult(config, data, summarize(data));
  } catch (error) {
    return errorResult(error);
  }
};

const statusText = (data: unknown): string => {
  if (typeof data !== 'object' || data === null) return 'unknown';
  const status = (data as { status?: unknown }).status;
  return typeof status === 'string' ? status : 'unknown';
};

const createDefaultBackend = (
  config: AppConfig,
  fetchImplementation?: typeof fetch,
): NutritionBackend => {
  const tokenStore = new FileTokenStore(config.tokenCachePath);
  const auth = new AuthManager(
    {
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      username: config.username,
      password: config.password,
      timeoutMs: config.timeoutMs,
    },
    tokenStore,
    fetchImplementation,
  );
  return new YazioAdapter(
    {
      baseUrl: config.baseUrl,
      countries: config.countries,
      locales: config.locales,
      defaultSex: config.defaultSex,
      timeoutMs: config.timeoutMs,
    },
    auth,
    fetchImplementation,
  );
};

export const createYazioServer = async (
  config: AppConfig,
  dependencies: ServerDependencies = {},
): Promise<McpServer> => {
  const backend =
    dependencies.backend ?? createDefaultBackend(config, dependencies.fetchImplementation);
  const scope = createHash('sha256')
    .update(`${config.baseUrl}\0${config.username ?? 'token-only'}`)
    .digest('hex')
    .slice(0, 24);
  const idempotency = new FileIdempotencyStore(config.statePath, scope);
  const writeService =
    dependencies.writeService ??
    new WriteService(backend, idempotency, config.timezone);
  const savedMealStore = new SavedMealStore(config.savedMealsPath);
  const savedMealService = new SavedMealService(savedMealStore, backend, writeService);
  const userMealService = new UserMealService(backend, writeService);
  const requestStateCodec = createRequestStateCodec<DestructiveRequestState>({
    key: await idempotency.requestStateKey(),
    ttlSeconds: 10 * 60,
    bind: (context) => `${context.mcpReq.method}\0${scope}`,
  });
  const server = new McpServer(
    { name: 'yazio-mcp', version: '0.1.0' },
    {
      capabilities: { tools: { listChanged: false } },
      requestState: {
        verify: (state, context) => requestStateCodec.verify(state, context),
      },
    },
  );

  const loadDailySummaries = async (dates: string[]) => {
    const settled = await mapSettledWithConcurrency(
      dates,
      rangeReadConcurrency,
      (date) => backend.getDailySummary(date),
    );
    const summaries = settled.values.filter((value) => value !== undefined);
    if (summaries.length === 0 && settled.errors[0] !== undefined) {
      throw settled.errors[0].error;
    }
    const failedDates = settled.errors
      .map(({ index }) => dates[index])
      .filter((date): date is string => date !== undefined);
    const coverage = {
      requested_days: dates.length,
      successful_days: summaries.length,
      failed_dates: failedDates,
    };
    return { summaries, coverage, partial: failedDates.length > 0 };
  };

  server.registerTool(
    'get_user_profile',
    {
      title: 'Nutrition profile',
      description:
        'Returns a minimal allowlist of YAZIO profile fields without email, birth date, tokens, or payment identifiers.',
      inputSchema: z.object({}),
      outputSchema: toolOutputSchema(userProfileOutputSchema),
      annotations: readAnnotations,
    },
    async () =>
      safeResult(config, () => backend.getUserProfile(), () => 'YAZIO profile retrieved.'),
  );

  server.registerTool(
    'get_goals',
    {
      title: 'Nutrition goals',
      description: 'Returns calorie, macro, water, step, and weight goals for a date.',
      inputSchema: getGoalsInputSchema,
      outputSchema: toolOutputSchema(goalsOutputSchema),
      annotations: readAnnotations,
    },
    async ({ date }) => {
      const resolvedDate = date ?? todayInZone(config.timezone);
      return safeResult(
        config,
        () => backend.getGoals(resolvedDate),
        () => `Goals for ${resolvedDate} retrieved.`,
      );
    },
  );

  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description:
        'Searches YAZIO products. Defaults to US and en_US and accepts country/locale overrides; nutrition is normalized per 100 g/ml.',
      inputSchema: searchProductsInputSchema,
      outputSchema: toolOutputSchema(
        z.array(z.union([productOutputSchema, compactProductOutputSchema])),
      ),
      annotations: readAnnotations,
    },
    async ({ compact, ...input }) =>
      safeResult(
        config,
        async () => {
          const products = await backend.searchProducts(input);
          if (!compact) return products;
          return products.map((product) => ({
            product_id: product.id,
            name: product.name,
            brand: product.producer,
            serving: product.serving,
            per_100g: {
              calories: product.nutrition.calories,
              protein: product.nutrition.protein,
              carbs: product.nutrition.carbs,
              fat: product.nutrition.fat,
            },
          }));
        },
        (data) => `Found ${Array.isArray(data) ? data.length : 0} products.`,
      ),
  );

  server.registerTool(
    'get_product',
    {
      title: 'Product details',
      description: 'Returns a product by UUID with nutrients normalized per 100 g/ml.',
      inputSchema: getProductInputSchema,
      outputSchema: toolOutputSchema(productDetailsOutputSchema.nullable()),
      annotations: readAnnotations,
    },
    async ({ product_id }) =>
      safeResult(
        config,
        () => backend.getProduct(product_id),
        (data) => (data === null ? 'Product not found.' : 'Product details retrieved.'),
      ),
  );

  server.registerTool(
    'get_diary',
    {
      title: 'Nutrition diary',
      description:
        'Returns the diary for one date or a locally aggregated range of up to 31 days; YAZIO has no confirmed range endpoint.',
      inputSchema: diaryInputSchema,
      outputSchema: toolOutputSchema(z.object({ days: z.array(diaryDayOutputSchema) })),
      annotations: readAnnotations,
    },
    async ({ compact, ...input }) =>
      safeResult(
        config,
        async () => {
          const dates = resolveDateOrRange(input, config.timezone, 31);
          const days = await mapWithConcurrency(
            dates,
            rangeReadConcurrency,
            (date) => backend.getDiary(date),
          );
          if (!compact) return { days };
          return {
            days: days.map((day) => ({
              ...day,
              items: day.items.map((item) => ({
                id: item.id,
                daytime: item.daytime,
                kind: item.kind,
                product_id: item.product_id,
                recipe_id: item.recipe_id,
                name: item.name,
                amount: item.amount,
                serving: item.serving,
                serving_quantity: item.serving_quantity,
              })),
            })),
          };
        },
        (data) => {
          const count =
            typeof data === 'object' &&
            data !== null &&
            Array.isArray((data as { days?: unknown }).days)
              ? (data as { days: unknown[] }).days.length
              : 0;
          return `Diary retrieved for ${count} days.`;
        },
      ),
  );

  server.registerTool(
    'get_daily_summary',
    {
      title: 'Daily summary',
      description: 'Returns daily calories, macros, goals, water, steps, and meal breakdown.',
      inputSchema: getDateInputSchema,
      outputSchema: toolOutputSchema(dailySummaryOutputSchema),
      annotations: readAnnotations,
    },
    async ({ date }) => {
      const resolvedDate = date ?? todayInZone(config.timezone);
      return safeResult(
        config,
        () => backend.getDailySummary(resolvedDate),
        () => `Summary for ${resolvedDate} retrieved.`,
      );
    },
  );

  server.registerTool(
    'get_water_intake',
    {
      title: 'Water intake',
      description: 'Returns cumulative water intake in milliliters for a date.',
      inputSchema: getDateInputSchema,
      outputSchema: toolOutputSchema(waterOutputSchema),
      annotations: readAnnotations,
    },
    async ({ date }) => {
      const resolvedDate = date ?? todayInZone(config.timezone);
      return safeResult(
        config,
        () => backend.getWaterIntake(resolvedDate),
        () => `Water intake for ${resolvedDate} retrieved.`,
      );
    },
  );

  server.registerTool(
    'get_weight',
    {
      title: 'Weight',
      description: 'Returns the latest weight entry on or before the specified date.',
      inputSchema: getDateInputSchema,
      outputSchema: toolOutputSchema(weightOutputSchema.nullable()),
      annotations: readAnnotations,
    },
    async ({ date }) => {
      const resolvedDate = date ?? todayInZone(config.timezone);
      return safeResult(
        config,
        () => backend.getWeight(resolvedDate),
        () => `Weight for ${resolvedDate} retrieved.`,
      );
    },
  );

  server.registerTool(
    'get_exercises',
    {
      title: 'Exercises',
      description: 'Returns training and custom training entries for a date.',
      inputSchema: getDateInputSchema,
      outputSchema: toolOutputSchema(z.array(exerciseOutputSchema)),
      annotations: readAnnotations,
    },
    async ({ date }) => {
      const resolvedDate = date ?? todayInZone(config.timezone);
      return safeResult(
        config,
        () => backend.getExercises(resolvedDate),
        (data) => `Retrieved ${Array.isArray(data) ? data.length : 0} exercises.`,
      );
    },
  );

  server.registerTool(
    'add_consumed_item',
    {
      title: 'Add consumed item',
      description:
        'Shows a preview, checks for duplicates, writes idempotently, and rereads the diary. dry_run defaults to true.',
      inputSchema: addConsumedItemInputSchema,
      outputSchema: toolOutputSchema(addConsumedItemOutputSchema),
      annotations: writeAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        () => writeService.addConsumedItem(input),
        (data) => `Add result: ${statusText(data)}.`,
      ),
  );

  server.registerTool(
    'add_meal_batch',
    {
      title: 'Add meal batch',
      description:
        'Adds up to 25 products sequentially; on partial failure, compensates earlier writes and reports each item result.',
      inputSchema: addMealBatchInputSchema,
      outputSchema: toolOutputSchema(batchOutputSchema),
      annotations: writeAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        () => writeService.addMealBatch(input),
        (data) => `Batch result: ${statusText(data)}.`,
      ),
  );

  server.registerTool(
    'list_saved_meals',
    {
      title: 'Saved meals',
      description:
        'Lists locally saved meal templates with name, aliases, default daytime, item count, and estimated nutrition totals from product metadata.',
      inputSchema: listSavedMealsInputSchema,
      outputSchema: toolOutputSchema(listSavedMealsOutputSchema),
      annotations: readAnnotations,
    },
    async () =>
      safeResult(
        config,
        () => savedMealService.listMeals(),
        (data) =>
          `Retrieved ${
            (data as { meals: unknown[] }).meals.length
          } saved meals.`,
      ),
  );

  server.registerTool(
    'log_saved_meal',
    {
      title: 'Log saved meal',
      description:
        'Resolves a saved meal template by name or alias (case-insensitive) and books it through the same code path as add_meal_batch; dry_run defaults to true.',
      inputSchema: logSavedMealInputSchema,
      outputSchema: toolOutputSchema(logSavedMealOutputSchema),
      annotations: writeAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        () => savedMealService.logSavedMeal(input),
        (data) => `Batch result: ${statusText((data as { batch: unknown }).batch)}.`,
      ),
  );

  server.registerTool(
    'save_meal',
    {
      title: 'Save meal template',
      description:
        'Validates every product id against the YAZIO catalog and persists a named meal template atomically to the local saved-meals file; an identically named entry (case-insensitive) is replaced.',
      inputSchema: saveMealInputSchema,
      outputSchema: toolOutputSchema(saveMealOutputSchema),
      annotations: writeAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        () => savedMealService.saveMeal(input),
        (data) => `Saved meal "${(data as { meal: { name: string } }).meal.name}" locally.`,
      ),
  );

  server.registerTool(
    'list_user_meals',
    {
      title: 'YAZIO meals',
      description:
        'Lists the meal templates saved in the YAZIO app (GET /user/meals) as meal_id, name and item_count; optional case-insensitive query filter.',
      inputSchema: listUserMealsInputSchema,
      outputSchema: toolOutputSchema(listUserMealsOutputSchema),
      annotations: readAnnotations,
    },
    async ({ query }) =>
      safeResult(
        config,
        () => userMealService.listMeals(query),
        (data) => `Retrieved ${(data as { meals: unknown[] }).meals.length} YAZIO meals.`,
      ),
  );

  server.registerTool(
    'log_user_meal',
    {
      title: 'Log YAZIO meal',
      description:
        'Books a meal template from the YAZIO app by name (case-insensitive) through the same code path as add_meal_batch; daytime is required, dry_run defaults to true.',
      inputSchema: logUserMealInputSchema,
      outputSchema: toolOutputSchema(logUserMealOutputSchema),
      annotations: writeAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        () => userMealService.logUserMeal(input),
        (data) =>
          `Batch result for "${(data as { meal_name: string }).meal_name}": ${statusText(
            (data as { batch: unknown }).batch,
          )}.`,
      ),
  );

  server.registerTool(
    'update_consumed_item',
    {
      title: 'Update consumed item amount',
      description:
        'Safely replaces an existing product entry: creates and verifies a replacement, then removes the exact old ID. Attempts compensation on failure. A native YAZIO PATCH endpoint is not confirmed.',
      inputSchema: updateConsumedItemInputSchema,
      outputSchema: toolOutputSchema(updateConsumedItemOutputSchema),
      annotations: removeAnnotations,
    },
    async (input, context: ServerContext) => {
      if (input.dry_run || input.confirmation_token !== undefined) {
        return safeResult(
          config,
          () => writeService.updateConsumedItem(input),
          (data) => `Update result: ${statusText(data)}.`,
        );
      }
      const operationFingerprint = fingerprint({
        item_id: input.item_id,
        date: input.date,
        amount: input.amount,
      });
      const requestState = context.mcpReq.requestState<DestructiveRequestState>();
      let prepared: Awaited<ReturnType<WriteService['prepareConsumedItemUpdate']>>;
      try {
        prepared = await writeService.prepareConsumedItemUpdate(input);
      } catch (error) {
        return errorResult(error);
      }
      const response = acceptedContent(
        context.mcpReq.inputResponses,
        'confirm_update',
        confirmationSchema,
      );
      if (
        response?.confirm === true &&
        requestState?.operation === 'update_consumed_item' &&
        requestState.fingerprint === operationFingerprint
      ) {
        return safeResult(
          config,
          () => writeService.updateConsumedItem(input, { kind: 'mrtr' }),
          (data) => `Update result: ${statusText(data)}.`,
        );
      }
      if (response?.confirm === false) {
        return errorResult(
          new NutritionMcpError('CONFIRMATION_REQUIRED', 'The update was cancelled by the user.'),
        );
      }
      if (response?.confirm === true) {
        return errorResult(
          new NutritionMcpError(
            'CONFIRMATION_REQUIRED',
            'The MRTR requestState is missing, expired, or does not match the operation.',
          ),
        );
      }
      return inputRequired({
        inputRequests: {
          confirm_update: inputRequired.elicit({
            message:
              `Confirm updating "${prepared.preview.old_item.name ?? input.item_id}" ` +
              `(${prepared.preview.old_item.daytime}, ${input.date}) ` +
              `from ${prepared.preview.old_item.amount} to ${input.amount}.`,
            requestedSchema: confirmationSchema,
          }),
        },
        requestState: await requestStateCodec.mint(
          {
            operation: 'update_consumed_item',
            fingerprint: operationFingerprint,
          },
          context,
        ),
      });
    },
  );

  server.registerTool(
    'remove_consumed_item',
    {
      title: 'Remove consumed item',
      description:
        'Removes only the specified diary item ID after MRTR confirmation. Fallback: a dry run issues a one-time confirmation_token with a TTL.',
      inputSchema: removeConsumedItemInputSchema,
      outputSchema: toolOutputSchema(removeConsumedItemOutputSchema),
      annotations: removeAnnotations,
    },
    async (input, context: ServerContext) => {
      if (input.dry_run || input.confirmation_token !== undefined) {
        return safeResult(
          config,
          () => writeService.removeConsumedItem(input),
          (data) => `Removal result: ${statusText(data)}.`,
        );
      }
      const operationFingerprint = fingerprint({ date: input.date, item_id: input.item_id });
      const requestState = context.mcpReq.requestState<DestructiveRequestState>();
      let prepared: Awaited<ReturnType<WriteService['prepareConsumedItemRemoval']>>;
      try {
        prepared = await writeService.prepareConsumedItemRemoval(input);
      } catch (error) {
        return errorResult(error);
      }
      const response = acceptedContent(
        context.mcpReq.inputResponses,
        'confirm_removal',
        confirmationSchema,
      );
      if (
        response?.confirm === true &&
        requestState?.operation === 'remove_consumed_item' &&
        requestState.fingerprint === operationFingerprint
      ) {
        return safeResult(
          config,
          () => writeService.removeConsumedItem(input, { kind: 'mrtr' }),
          (data) => `Removal result: ${statusText(data)}.`,
        );
      }
      if (response?.confirm === false) {
        return errorResult(
          new NutritionMcpError('CONFIRMATION_REQUIRED', 'The removal was cancelled by the user.'),
        );
      }
      if (response?.confirm === true) {
        return errorResult(
          new NutritionMcpError(
            'CONFIRMATION_REQUIRED',
            'The MRTR requestState is missing, expired, or does not match the operation.',
          ),
        );
      }
      return inputRequired({
        inputRequests: {
          confirm_removal: inputRequired.elicit({
            message:
              `Confirm removing "${prepared.item.name ?? input.item_id}" ` +
              `(${prepared.item.daytime}, ${prepared.item.amount}, ${input.date}).`,
            requestedSchema: confirmationSchema,
          }),
        },
        requestState: await requestStateCodec.mint(
          {
            operation: 'remove_consumed_item',
            fingerprint: operationFingerprint,
          },
          context,
        ),
      });
    },
  );

  server.registerTool(
    'add_water_intake',
    {
      title: 'Add water intake',
      description:
        'Reads the current cumulative amount, adds amount_ml, writes the new total, and verifies it by rereading.',
      inputSchema: addWaterInputSchema,
      outputSchema: toolOutputSchema(addWaterOutputSchema),
      annotations: writeAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        () => writeService.addWaterIntake(input),
        (data) => `Water update result: ${statusText(data)}.`,
      ),
  );

  server.registerTool(
    'get_nutrition_trends',
    {
      title: 'Nutrition trends',
      description:
        'Aggregates daily summaries by day, ISO week, or month and calculates averages, goals, stability, and deviations.',
      inputSchema: trendsInputSchema,
      outputSchema: toolOutputSchema(trendsOutputSchema),
      annotations: readAnnotations,
    },
    async ({ start_date, end_date, aggregation }) =>
      safeResult(
        config,
        async () => {
          const dates = enumerateDates(start_date, end_date, config.timezone, 366);
          const loaded = await loadDailySummaries(dates);
          return {
            ...aggregateTrends(loaded.summaries, aggregation),
            coverage: loaded.coverage,
            partial: loaded.partial,
          };
        },
        () => `Trends for ${start_date}–${end_date} calculated.`,
      ),
  );

  server.registerTool(
    'compare_periods',
    {
      title: 'Compare periods',
      description: 'Compares average calories and macros across two ranges of up to 366 days each.',
      inputSchema: comparePeriodsInputSchema,
      outputSchema: toolOutputSchema(comparePeriodsOutputSchema),
      annotations: readAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        async () => {
          const firstDates = enumerateDates(
            input.first_start_date,
            input.first_end_date,
            config.timezone,
            366,
          );
          const secondDates = enumerateDates(
            input.second_start_date,
            input.second_end_date,
            config.timezone,
            366,
          );
          const firstLoaded = await loadDailySummaries(firstDates);
          const secondLoaded = await loadDailySummaries(secondDates);
          const compared = compareTrendPeriods(
            firstLoaded.summaries,
            secondLoaded.summaries,
          );
          return {
            first: {
              ...compared.first,
              coverage: firstLoaded.coverage,
              partial: firstLoaded.partial,
            },
            second: {
              ...compared.second,
              coverage: secondLoaded.coverage,
              partial: secondLoaded.partial,
            },
            change_percent: compared.change_percent,
            partial: firstLoaded.partial || secondLoaded.partial,
          };
        },
        () => 'Periods compared.',
      ),
  );

  server.registerTool(
    'detect_probable_missing_meals',
    {
      title: 'Probable missing meals',
      description:
        'Finds suspiciously empty meal buckets. It never creates entries or claims that the user actually ate.',
      inputSchema: missingMealsInputSchema,
      outputSchema: toolOutputSchema(missingMealsOutputSchema),
      annotations: readAnnotations,
    },
    async ({ start_date, end_date, meals, maximum_recorded_calories }) =>
      safeResult(
        config,
        async () => {
          const dates = enumerateDates(start_date, end_date, config.timezone, 366);
          const loaded = await loadDailySummaries(dates);
          return {
            findings: detectMissingMeals(
              loaded.summaries,
              meals,
              maximum_recorded_calories,
            ),
            auto_write_performed: false,
            coverage: loaded.coverage,
            partial: loaded.partial,
          };
        },
        (data) => {
          const count =
            typeof data === 'object' &&
            data !== null &&
            Array.isArray((data as { findings?: unknown }).findings)
              ? (data as { findings: unknown[] }).findings.length
              : 0;
          return `Found ${count} probable omissions; no automatic entries were created.`;
        },
      ),
  );

  return server;
};
