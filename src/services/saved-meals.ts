import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';
import { NutritionMcpError } from '../errors.js';
import { savedMealsFileSchema } from '../schemas.js';
import type {
  listSavedMealsOutputSchema,
  logSavedMealInputSchema,
  saveMealInputSchema,
  saveMealOutputSchema,
} from '../schemas.js';
import type { MealType, Nutrition, NutritionBackend } from '../types.js';
import type { WriteService } from './write-service.js';

type SaveMealInput = z.infer<typeof saveMealInputSchema>;
type LogSavedMealInput = z.infer<typeof logSavedMealInputSchema>;
type ListSavedMealsResult = z.infer<typeof listSavedMealsOutputSchema>;
type BatchResult = Awaited<ReturnType<WriteService['addMealBatch']>>;
type LogSavedMealResult = {
  meal_name: string;
  matched_by: 'name' | 'alias';
  amount_factor: number;
  date: string;
  daytime: MealType;
  batch: BatchResult;
};
type SaveMealResult = z.infer<typeof saveMealOutputSchema>;

export interface SavedMealItem {
  product_id: string;
  amount: number;
  serving: string | null;
  serving_quantity: number | null;
}

export interface SavedMeal {
  name: string;
  aliases: string[];
  default_daytime: MealType | null;
  items: SavedMealItem[];
}

const roundToTwoDecimals = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT';

const scaleNutrition = (nutrition: Nutrition, factor: number): Nutrition => ({
  calories: nutrition.calories * factor,
  protein: nutrition.protein * factor,
  fat: nutrition.fat * factor,
  carbs: nutrition.carbs * factor,
  fiber: nutrition.fiber * factor,
  sugar: nutrition.sugar * factor,
  energy_unit: nutrition.energy_unit,
  mass_unit: nutrition.mass_unit,
});

const addNutrition = (first: Nutrition, second: Nutrition): Nutrition => ({
  calories: first.calories + second.calories,
  protein: first.protein + second.protein,
  fat: first.fat + second.fat,
  carbs: first.carbs + second.carbs,
  fiber: first.fiber + second.fiber,
  sugar: first.sugar + second.sugar,
  energy_unit: first.energy_unit,
  mass_unit: first.mass_unit,
});

export interface SavedMealMatch {
  meal: SavedMeal;
  matchedBy: 'name' | 'alias';
}

export const resolveSavedMeal = (
  meals: SavedMeal[],
  query: string,
): SavedMealMatch | null => {
  const normalized = query.trim().toLowerCase();
  const byName = meals.find((meal) => meal.name.trim().toLowerCase() === normalized);
  if (byName !== undefined) return { meal: byName, matchedBy: 'name' };
  const byAlias = meals.find((meal) =>
    meal.aliases.some((alias) => alias.trim().toLowerCase() === normalized),
  );
  if (byAlias !== undefined) return { meal: byAlias, matchedBy: 'alias' };
  return null;
};

export class SavedMealStore {
  constructor(private readonly path: string) {}

  async load(): Promise<SavedMeal[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw new NutritionMcpError(
        'CONFIG_ERROR',
        'The saved meals file exists but could not be read.',
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new NutritionMcpError('CONFIG_ERROR', 'The saved meals file is not valid JSON.', {
        cause: error,
      });
    }
    const validated = savedMealsFileSchema.safeParse(parsed);
    if (!validated.success) {
      throw new NutritionMcpError('CONFIG_ERROR', 'The saved meals file is malformed.', {
        details: {
          issues: validated.error.issues.map(({ path, message }) => ({ path, message })),
        },
      });
    }
    return validated.data.meals.map((entry) => ({
      name: entry.name,
      aliases: entry.aliases ?? [],
      default_daytime: entry.default_daytime ?? null,
      items: entry.items.map((item) => ({
        product_id: item.product_id,
        amount: item.amount,
        serving: item.serving ?? null,
        serving_quantity: item.serving_quantity ?? null,
      })),
    }));
  }

  async save(meals: SavedMeal[]): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.tmp-${randomUUID()}`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ meals }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new NutritionMcpError('CONFIG_ERROR', 'The saved meals file could not be written.', {
        cause: error,
      });
    }
  }
}

export class SavedMealService {
  constructor(
    private readonly store: SavedMealStore,
    private readonly backend: NutritionBackend,
    private readonly writeService: WriteService,
  ) {}

  async listMeals(): Promise<ListSavedMealsResult> {
    const meals = await this.store.load();
    const summaries = await Promise.all(
      meals.map(async (meal) => {
        const itemSummaries: ListSavedMealsResult['meals'][number] = {
          name: meal.name,
          aliases: meal.aliases,
          default_daytime: meal.default_daytime,
          item_count: meal.items.length,
          nutrition: await this.estimateNutrition(meal),
        };
        return itemSummaries;
      }),
    );
    return { meals: summaries };
  }

  async logSavedMeal(input: LogSavedMealInput): Promise<LogSavedMealResult> {
    const meals = await this.store.load();
    const match = resolveSavedMeal(meals, input.name);
    if (match === null) {
      throw new NutritionMcpError(
        'SAVED_MEAL_NOT_FOUND',
        `No saved meal matches "${input.name}"; nothing was written.`,
        { details: { available_meals: meals.map((meal) => meal.name) } },
      );
    }
    const daytime = input.daytime ?? match.meal.default_daytime;
    if (daytime === null) {
      throw new NutritionMcpError(
        'VALIDATION_ERROR',
        `Saved meal "${match.meal.name}" has no default_daytime; provide daytime explicitly.`,
      );
    }
    if (match.meal.items.length > 25) {
      throw new NutritionMcpError(
        'VALIDATION_ERROR',
        `Saved meal "${match.meal.name}" has more than 25 items; log it with add_meal_batch instead.`,
      );
    }
    const amountFactor = input.amount_factor ?? 1;
    const items = match.meal.items.map((item) => {
      const amount = roundToTwoDecimals(item.amount * amountFactor);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) {
        throw new NutritionMcpError(
          'VALIDATION_ERROR',
          `Scaled amount ${amount} for product ${item.product_id} is outside the supported range.`,
        );
      }
      return {
        product_id: item.product_id,
        date: input.date,
        daytime,
        amount,
        serving: item.serving,
        serving_quantity: item.serving_quantity,
      };
    });
    const batch = await this.writeService.addMealBatch({
      client_request_id: input.client_request_id,
      dry_run: input.dry_run ?? true,
      items,
    });
    return {
      meal_name: match.meal.name,
      matched_by: match.matchedBy,
      amount_factor: amountFactor,
      date: input.date,
      daytime,
      batch,
    };
  }

  async saveMeal(input: SaveMealInput): Promise<SaveMealResult> {
    // Validate every product id against the upstream catalog so no invented
    // UUID can be persisted.
    for (const item of input.items) {
      let product: Awaited<ReturnType<NutritionBackend['getProduct']>>;
      try {
        product = await this.backend.getProduct(item.product_id);
      } catch (error) {
        throw new NutritionMcpError(
          'UPSTREAM_ERROR',
          'Product validation failed; the meal was not saved.',
          { cause: error },
        );
      }
      if (product === null) {
        throw new NutritionMcpError(
          'UPSTREAM_NOT_FOUND',
          `Product ${item.product_id} was not found; the meal was not saved.`,
        );
      }
    }
    const definition: SavedMeal = {
      name: input.name,
      aliases: input.aliases ?? [],
      default_daytime: input.default_daytime ?? null,
      items: input.items.map((item) => ({
        product_id: item.product_id,
        amount: item.amount,
        serving: item.serving ?? null,
        serving_quantity: item.serving_quantity ?? null,
      })),
    };
    const existing = await this.store.load();
    const normalized = definition.name.trim().toLowerCase();
    const kept = existing.filter((meal) => meal.name.trim().toLowerCase() !== normalized);
    const replaced = kept.length !== existing.length;
    await this.store.save([...kept, definition]);
    return {
      meal: {
        name: definition.name,
        aliases: definition.aliases,
        default_daytime: definition.default_daytime,
        items: definition.items,
      },
      replaced,
    };
  }

  private async estimateNutrition(meal: SavedMeal): Promise<Nutrition | null> {
    let totals: Nutrition | null = null;
    for (const item of meal.items) {
      let product: Awaited<ReturnType<NutritionBackend['getProduct']>>;
      try {
        product = await this.backend.getProduct(item.product_id);
      } catch {
        return null;
      }
      if (product === null) return null;
      const scaled = scaleNutrition(product.nutrition, item.amount / 100);
      totals = totals === null ? scaled : addNutrition(totals, scaled);
    }
    if (totals === null) return null;
    return {
      calories: roundToTwoDecimals(totals.calories),
      protein: roundToTwoDecimals(totals.protein),
      fat: roundToTwoDecimals(totals.fat),
      carbs: roundToTwoDecimals(totals.carbs),
      fiber: roundToTwoDecimals(totals.fiber),
      sugar: roundToTwoDecimals(totals.sugar),
      energy_unit: totals.energy_unit,
      mass_unit: totals.mass_unit,
    };
  }
}
