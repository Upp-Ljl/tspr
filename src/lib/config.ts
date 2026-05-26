/**
 * src/lib/config.ts
 * Loads ~/.tspr/config.json with Zod validation.
 * Merges env-var overrides on top.
 *
 * ENV VARS (override config.json):
 *   TSPR_PROVIDER        — overrides config.provider
 *   TSPR_BASE_URL        — overrides per-provider baseURL
 *   TSPR_API_KEY_ENV     — name of env var holding the actual key
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

// ─────────────────────────────────────────────
// Zod schema
// ─────────────────────────────────────────────

const ProviderSchema = z.enum(['claude', 'openai-compat', 'minimax']);

const ModelAliasMapSchema = z
  .object({
    haiku:  z.string().optional(),
    sonnet: z.string().optional(),
    opus:   z.string().optional(),
  })
  .optional();

const OpenAICompatSchema = z
  .object({
    baseURL:   z.string().url().optional(),
    apiKeyEnv: z.string().optional(),
  })
  .optional();

const MinimaxSchema = z
  .object({
    baseURL:   z.string().url().optional(),
    apiKeyEnv: z.string().optional(),
  })
  .optional();

const ClaudeSubprocessSchema = z
  .object({
    binary: z.string().optional(),
  })
  .optional();

export const TsprConfigSchema = z.object({
  provider:         ProviderSchema.optional(),
  modelAlias:       ModelAliasMapSchema,
  openaiCompat:     OpenAICompatSchema,
  minimax:          MinimaxSchema,
  claudeSubprocess: ClaudeSubprocessSchema,
});

export type TsprConfig = z.infer<typeof TsprConfigSchema>;

// ─────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────

/** Default config path: ~/.tspr/config.json */
function defaultConfigPath(): string {
  return path.join(os.homedir(), '.tspr', 'config.json');
}

/**
 * Load and validate ~/.tspr/config.json (or an explicit path).
 * Returns an empty config object if the file is absent.
 * Throws a descriptive error if the file exists but is invalid JSON or fails validation.
 */
export function loadConfig(configPath?: string): TsprConfig {
  const filePath = configPath ?? defaultConfigPath();

  let raw: unknown = {};

  if (fs.existsSync(filePath)) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`Cannot read config file ${filePath}: ${(err as Error).message}`);
    }

    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(
        `Config file ${filePath} is not valid JSON. Please check for syntax errors.`,
      );
    }
  }

  const result = TsprConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Config file ${filePath} failed validation:\n${issues}`);
  }

  return applyEnvOverrides(result.data);
}

// ─────────────────────────────────────────────
// Env-var overrides
// ─────────────────────────────────────────────

/**
 * Apply environment-variable overrides on top of the parsed config.
 * Never reads actual secret keys here — only reads "which env var name to use".
 */
function applyEnvOverrides(cfg: TsprConfig): TsprConfig {
  const out = { ...cfg };

  // TSPR_PROVIDER overrides config.provider
  const envProvider = process.env['TSPR_PROVIDER'];
  if (envProvider) {
    const parsed = ProviderSchema.safeParse(envProvider);
    if (!parsed.success) {
      throw new Error(
        `TSPR_PROVIDER="${envProvider}" is invalid. Must be one of: claude, openai-compat, minimax`,
      );
    }
    out.provider = parsed.data;
  }

  // TSPR_API_KEY_ENV overrides the apiKeyEnv for the active provider
  const envApiKeyEnvName = process.env['TSPR_API_KEY_ENV'];
  if (envApiKeyEnvName) {
    const provider = out.provider ?? 'claude';
    if (provider === 'openai-compat') {
      out.openaiCompat = { ...out.openaiCompat, apiKeyEnv: envApiKeyEnvName };
    } else if (provider === 'minimax') {
      out.minimax = { ...out.minimax, apiKeyEnv: envApiKeyEnvName };
    }
  }

  // TSPR_BASE_URL overrides per-provider baseURL
  const envBaseURL = process.env['TSPR_BASE_URL'];
  if (envBaseURL) {
    const provider = out.provider ?? 'claude';
    if (provider === 'openai-compat') {
      out.openaiCompat = { ...out.openaiCompat, baseURL: envBaseURL };
    } else if (provider === 'minimax') {
      out.minimax = { ...out.minimax, baseURL: envBaseURL };
    }
  }

  return out;
}
