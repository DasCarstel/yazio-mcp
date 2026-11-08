import type { z } from 'zod';
import { NutritionMcpError } from '../errors.js';
import type { logUserMealInputSchema, listUserMealsOutputSchema } from '../schemas.js';
import type { NutritionBackend, UserMeal } from '../types.js';
import type { WriteService } from './write-service.js';

type LogUserMealInput = z.infer<typeof logUserMealInputSchema>;
type LogUserMealResult = {
  meal_name: string;
  meal_id: string;
  matched_by: 'name';
  date: string;
  daytime: NonNullable<LogUserMealInput['daytime']>;
  amount_factor: number;
  batch: Awaited<ReturnType<WriteService['addMealBatch']>>;
};
type ListUserMealsResult = z.infer<typeof listUserMealsOutputSchema>;

const roundToTwoDecimals = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const normalizeName = (value: string): string => value.trim().toLowerCase();

/**
 * YAZIO-native meal templates (``GET /user/meals``).
 *
 * The upstream list carries the full product breakdown, so a meal can be booked
 * through the same write path as ``add_meal_batch`` — no local template file and
 * no invented product ids.
 */
export class UserMealService {
  constructor(
    private readonly backend: NutritionBackend,
    private readonly writeService: WriteService,
  ) {}

  async listMeals(query?: string): Promise<ListUserMealsResult> {
    const meals = await this.backend.listUserMeals();
    const needle = query === undefined ? null : normalizeName(query);
    const filtered =
      needle === null
        ? meals
        : meals.filter((meal) => normalizeName(meal.name).includes(needle));
    return {
      meals: filtered.map((meal) => ({
        meal_id: meal.id,
        name: meal.name,
        item_count: meal.items.length,
      })),
    };
  }

  async logUserMeal(input: LogUserMealInput): Promise<LogUserMealResult> {
    const meals = await this.backend.listUserMeals();
    const wanted = normalizeName(input.name);
    const match: UserMeal | undefined = meals.find(
      (meal) => normalizeName(meal.name) === wanted,
    );
    if (match === undefined) {
      throw new NutritionMcpError(
        'MEAL_NOT_FOUND',
        `No YAZIO meal matches "${input.name}"; nothing was written.`,
        { details: { available_meals: meals.map((meal) => meal.name) } },
      );
    }
    if (input.daytime === undefined) {
      throw new NutritionMcpError(
        'VALIDATION_ERROR',
        `Meal "${match.name}" needs an explicit daytime (breakfast, lunch, dinner or snack).`,
      );
    }
    if (match.items.length === 0) {
      throw new NutritionMcpError(
        'UNSUPPORTED_OPERATION',
        `Meal "${match.name}" contains no plain products; nothing was written.`,
      );
    }
    if (match.recipe_portion_count > 0) {
      throw new NutritionMcpError(
        'UNSUPPORTED_OPERATION',
        `Meal "${match.name}" contains recipe portions, which this server cannot book reliably; nothing was written.`,
        { details: { recipe_portion_count: match.recipe_portion_count } },
      );
    }
    if (match.items.length > 25) {
      throw new NutritionMcpError(
        'VALIDATION_ERROR',
        `Meal "${match.name}" has more than 25 items; log it with add_meal_batch instead.`,
      );
    }

    const amountFactor = input.amount_factor;
    const items = match.items.map((item) => {
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
        daytime: input.daytime as NonNullable<LogUserMealInput['daytime']>,
        amount,
        serving: item.serving,
        serving_quantity: item.serving_quantity,
      };
    });

    const batch = await this.writeService.addMealBatch({
      client_request_id: input.client_request_id,
      dry_run: input.dry_run,
      items,
    });

    return {
      meal_name: match.name,
      meal_id: match.id,
      matched_by: 'name',
      date: input.date,
      daytime: input.daytime,
      amount_factor: amountFactor,
      batch,
    };
  }
}
