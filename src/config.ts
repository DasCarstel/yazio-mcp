import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  DEFAULT_YAZIO_CLIENT_ID,
  DEFAULT_YAZIO_CLIENT_SECRET,
} from './auth/yazio-client-credentials.js';
import { NutritionMcpError } from './errors.js';

const environmentSchema = z
  .object({
    YAZIO_USERNAME: z.string().min(1).optional(),
    YAZIO_PASSWORD: z.string().min(1).optional(),
    YAZIO_CLIENT_ID: z.string().min(1).optional(),
    YAZIO_CLIENT_SECRET: z.string().min(1).optional(),
    YAZIO_BASE_URL: z.url().default('https://yzapi.yazio.com/v19'),
    YAZIO_TOKEN_CACHE_PATH: z.string().min(1).optional(),
    YAZIO_MCP_STATE_PATH: z.string().min(1).optional(),
    YAZIO_SAVED_MEALS_PATH: z.string().min(1).optional(),
    NUTRITION_MCP_STATE_PATH: z.string().min(1).optional(),
    YAZIO_MCP_TIMEZONE: z
      .string()
      .min(1)
      .refine(
        (value) => DateTime.now().setZone(value).isValid,
        'Expected a valid IANA time zone',
      )
      .optional(),
    NUTRITION_MCP_TIMEZONE: z
      .string()
      .min(1)
      .refine(
        (value) => DateTime.now().setZone(value).isValid,
        'Expected a valid IANA time zone',
      )
      .optional(),
    YAZIO_PRODUCT_COUNTRIES: z.string().default('US'),
    YAZIO_PRODUCT_LOCALES: z.string().default('en_US'),
    YAZIO_DEFAULT_SEX: z.enum(['male', 'female']).default('male'),
    YAZIO_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  })
  .superRefine((environment, context) => {
    const hasClientId = environment.YAZIO_CLIENT_ID !== undefined;
    const hasClientSecret = environment.YAZIO_CLIENT_SECRET !== undefined;
    if (hasClientId !== hasClientSecret) {
      context.addIssue({
        code: 'custom',
        path: [hasClientId ? 'YAZIO_CLIENT_SECRET' : 'YAZIO_CLIENT_ID'],
        message: 'OAuth client override requires both client ID and client secret',
      });
    }
    for (const [current, legacy] of [
      ['YAZIO_MCP_STATE_PATH', 'NUTRITION_MCP_STATE_PATH'],
      ['YAZIO_MCP_TIMEZONE', 'NUTRITION_MCP_TIMEZONE'],
    ] as const) {
      if (
        environment[current] !== undefined &&
        environment[legacy] !== undefined &&
        environment[current] !== environment[legacy]
      ) {
        context.addIssue({
          code: 'custom',
          path: [current],
          message: `${current} conflicts with deprecated alias ${legacy}`,
        });
      }
    }
  });

export interface AppConfig {
  baseUrl: string;
  username: string | undefined;
  password: string | undefined;
  clientId: string;
  clientSecret: string;
  tokenCachePath: string;
  statePath: string;
  savedMealsPath: string;
  timezone: string;
  countries: string[];
  locales: string[];
  defaultSex: 'male' | 'female';
  timeoutMs: number;
}

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new NutritionMcpError('CONFIG_ERROR', 'Invalid environment variable configuration.', {
      details: {
        variables: parsed.error.issues.map((issue) => String(issue.path[0] ?? 'unknown')),
      },
    });
  }
  const dataDirectory = join(homedir(), '.yazio-mcp');
  const legacyDataDirectory = join(homedir(), '.nutrition-mcp');
  const defaultPath = (fileName: string): string => {
    const preferred = join(dataDirectory, fileName);
    const legacy = join(legacyDataDirectory, fileName);
    return !existsSync(preferred) && existsSync(legacy) ? legacy : preferred;
  };
  return {
    baseUrl: parsed.data.YAZIO_BASE_URL.replace(/\/+$/, ''),
    username: parsed.data.YAZIO_USERNAME,
    password: parsed.data.YAZIO_PASSWORD,
    clientId: parsed.data.YAZIO_CLIENT_ID ?? DEFAULT_YAZIO_CLIENT_ID,
    clientSecret: parsed.data.YAZIO_CLIENT_SECRET ?? DEFAULT_YAZIO_CLIENT_SECRET,
    tokenCachePath: parsed.data.YAZIO_TOKEN_CACHE_PATH ?? defaultPath('token.json'),
    statePath:
      parsed.data.YAZIO_MCP_STATE_PATH ??
      parsed.data.NUTRITION_MCP_STATE_PATH ??
      defaultPath('state.json'),
    savedMealsPath: parsed.data.YAZIO_SAVED_MEALS_PATH ?? defaultPath('saved-meals.json'),
    timezone:
      parsed.data.YAZIO_MCP_TIMEZONE ??
      parsed.data.NUTRITION_MCP_TIMEZONE ??
      'UTC',
    countries: splitList(parsed.data.YAZIO_PRODUCT_COUNTRIES),
    locales: splitList(parsed.data.YAZIO_PRODUCT_LOCALES),
    defaultSex: parsed.data.YAZIO_DEFAULT_SEX,
    timeoutMs: parsed.data.YAZIO_HTTP_TIMEOUT_MS,
  };
};
