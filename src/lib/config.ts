/**
 * src/lib/config.ts
 * Loads ~/.tspr/config.json with Zod validation.
 * Merges env-var overrides on top.
 * Also exports writeConfig for atomic, validated writes from the settings UI.
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

// ─────────────────────────────────────────────
// Config writer (atomic, validated)
// ─────────────────────────────────────────────

/**
 * Forbidden field name patterns — literal API key values must never be
 * persisted to config.json. Keys must come from the environment.
 */
const FORBIDDEN_KEY_FIELDS = /^(apiKey|.*_API_KEY)$/;

/**
 * Check whether the input object contains a literal API key value.
 * Recurses one level deep (covers top-level and nested provider objects).
 */
function containsLiteralApiKey(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEY_FIELDS.test(key)) return true;
    // Recurse one level (covers e.g. openaiCompat.apiKey)
    const val = obj[key];
    if (typeof val === 'object' && val !== null) {
      for (const innerKey of Object.keys(val as Record<string, unknown>)) {
        if (FORBIDDEN_KEY_FIELDS.test(innerKey)) return true;
      }
    }
  }
  return false;
}

/** Default config path: ~/.tspr/config.json */
function defaultWriteConfigPath(): string {
  return path.join(os.homedir(), '.tspr', 'config.json');
}

/**
 * Atomically writes a validated config to ~/.tspr/config.json (or a custom path).
 *
 * - Validates with TsprConfigSchema (zod)
 * - Refuses to persist any field named `apiKey` or matching `*_API_KEY`
 *   (defense in depth — keys must come from env, never written to config.json)
 * - Writes to a `.tmp` sibling file then renames for atomicity (POSIX rename;
 *   on Windows, fs.renameSync is not truly atomic but is safe for config files)
 * - Returns the resolved TsprConfig that is now active (same as loadConfig would return)
 *
 * @throws {z.ZodError} if input fails schema validation
 * @throws {Error} if input contains a literal API key field, or the path is not writable
 */
export function writeConfig(input: unknown, configPath?: string): TsprConfig {
  // Security gate: reject literal API key values
  if (containsLiteralApiKey(input)) {
    throw new Error(
      'writeConfig: input contains a literal API key field (apiKey or *_API_KEY). ' +
      'API keys must be stored in environment variables and referenced via apiKeyEnv, ' +
      'never written to config.json.',
    );
  }

  // Schema validation — throws ZodError on failure
  const result = TsprConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`writeConfig: input failed validation:\n${issues}`);
  }

  const validated = result.data;
  const filePath = configPath ?? defaultWriteConfigPath();

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`writeConfig: cannot create config directory ${dir}: ${(err as Error).message}`);
  }

  // Atomic write: write to temp file then rename
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(validated, null, 2), { encoding: 'utf-8' });
  } catch (err) {
    throw new Error(`writeConfig: cannot write temp file ${tmpPath}: ${(err as Error).message}`);
  }

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up tmp on failure (best-effort)
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error(`writeConfig: cannot rename ${tmpPath} → ${filePath}: ${(err as Error).message}`);
  }

  return validated;
}
