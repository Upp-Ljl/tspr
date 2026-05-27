/**
 * src/lib/providers/openai-compat.ts
 * LlmProvider implementation for any OpenAI-compatible /v1/chat/completions endpoint.
 * Covers: OpenAI, OpenRouter, Together, vLLM, Anyscale, MiniMax (newer API), etc.
 */

import { LlmError, ErrCode } from '../errors.js';
import type { LlmProvider } from './types.js';
import type { LlmRunOptions, LlmRunResult } from '../cc.js';
import {
  OPENAI_COMPAT_DEFAULTS,
  resolveModelId,
  type ModelAliasMap,
} from './model-alias.js';

// ─────────────────────────────────────────────
// Pricing table (per-model, per 1M tokens)
// Keyed by model ID prefix for fuzzy matching.
// ─────────────────────────────────────────────

interface PricingEntry {
  inputPerM:  number;
  outputPerM: number;
}

/** Default fallback: haiku-class pricing */
const DEFAULT_PRICING: PricingEntry = { inputPerM: 0.25, outputPerM: 1.25 };

const PRICING_TABLE: Array<{ prefix: string; pricing: PricingEntry }> = [
  { prefix: 'gpt-4o-mini',        pricing: { inputPerM: 0.15,  outputPerM: 0.60 } },
  { prefix: 'gpt-4o',             pricing: { inputPerM: 5.00,  outputPerM: 15.00 } },
  { prefix: 'gpt-4-turbo',        pricing: { inputPerM: 10.00, outputPerM: 30.00 } },
  { prefix: 'gpt-3.5-turbo',      pricing: { inputPerM: 0.50,  outputPerM: 1.50 } },
  { prefix: 'claude-haiku',       pricing: { inputPerM: 0.25,  outputPerM: 1.25 } },
  { prefix: 'claude-sonnet',      pricing: { inputPerM: 3.00,  outputPerM: 15.00 } },
  { prefix: 'claude-opus',        pricing: { inputPerM: 15.00, outputPerM: 75.00 } },
  // MiniMax models (also used via openai-compat)
  { prefix: 'abab6.5s',          pricing: { inputPerM: 0.10,  outputPerM: 0.10 } },
  { prefix: 'MiniMax-Text-01',   pricing: { inputPerM: 0.40,  outputPerM: 1.20 } },
  { prefix: 'MiniMax-M1',        pricing: { inputPerM: 0.50,  outputPerM: 2.00 } },
];

function lookupPricing(modelId: string): PricingEntry {
  for (const { prefix, pricing } of PRICING_TABLE) {
    if (modelId.startsWith(prefix)) return pricing;
  }
  return DEFAULT_PRICING;
}

function computeCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const { inputPerM, outputPerM } = lookupPricing(modelId);
  return (promptTokens / 1_000_000) * inputPerM + (completionTokens / 1_000_000) * outputPerM;
}

// ─────────────────────────────────────────────
// Wire types for HTTP response
// ─────────────────────────────────────────────

interface OpenAIMessage {
  role: string;
  content: string;
}

interface OpenAIChoice {
  message: OpenAIMessage;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

// ─────────────────────────────────────────────
// Provider config
// ─────────────────────────────────────────────

export interface OpenAICompatConfig {
  /**
   * Base URL of the endpoint (no trailing slash).
   * Defaults to 'https://api.openai.com/v1'.
   */
  baseURL?: string;
  /**
   * Name of the environment variable that holds the API key.
   * The value is read from process.env at call time — never stored.
   * Defaults to 'OPENAI_API_KEY'.
   */
  apiKeyEnv?: string;
  /** Default per-call timeout in milliseconds. Default: 60_000. */
  defaultTimeoutMs?: number;
  /** Override model alias → model ID mapping. */
  modelAliasOverrides?: Partial<ModelAliasMap>;
  /** Default model alias defaults (override for sub-providers like MiniMax). */
  modelAliasDefaults?: ModelAliasMap;
}

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

export class OpenAICompatProvider implements LlmProvider {
  private readonly baseURL: string;
  private readonly apiKeyEnv: string;
  private readonly defaultTimeoutMs: number;
  private readonly modelAliases: ModelAliasMap;

  constructor(cfg: OpenAICompatConfig = {}) {
    this.baseURL = (cfg.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKeyEnv = cfg.apiKeyEnv ?? 'OPENAI_API_KEY';
    this.defaultTimeoutMs = cfg.defaultTimeoutMs ?? 120_000;
    const defaults = cfg.modelAliasDefaults ?? OPENAI_COMPAT_DEFAULTS;
    this.modelAliases = {
      ...defaults,
      ...(cfg.modelAliasOverrides ?? {}),
    };
  }

  async chat(opts: LlmRunOptions): Promise<LlmRunResult> {
    const startMs = Date.now();
    const modelId = resolveModelId(opts.model, this.modelAliases);
    const apiKey = process.env[this.apiKeyEnv];

    // Build messages array
    const messages: OpenAIMessage[] = [];
    if (opts.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    messages.push({ role: 'user', content: opts.prompt });

    const body = {
      model: modelId,
      messages,
      temperature: 0,
      max_tokens: 4096,
    };

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();

    // Link caller's abort signal
    const onCallerAbort = () => controller.abort();
    opts.abortSignal?.addEventListener('abort', onCallerAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Only add Authorization header if key is present
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener('abort', onCallerAbort);

      if (controller.signal.aborted) {
        if (opts.abortSignal?.aborted) {
          throw new LlmError(ErrCode.ERR_CC_FAILED, 'HTTP request was aborted by caller');
        }
        throw new LlmError(
          ErrCode.ERR_CC_TIMEOUT,
          `HTTP request timed out after ${timeoutMs}ms`,
          { data: { timeoutMs } },
        );
      }
      throw new LlmError(ErrCode.ERR_CC_FAILED, `HTTP fetch failed: ${(err as Error).message}`, {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener('abort', onCallerAbort);
    }

    const durationMs = Date.now() - startMs;

    if (!response.ok) {
      // Read body for error context, but NEVER log apiKey
      let errBody = '';
      try { errBody = await response.text(); } catch { /* ignore */ }
      throw new LlmError(
        ErrCode.ERR_CC_FAILED,
        `HTTP ${response.status} from ${this.baseURL}: ${errBody.slice(0, 200)}`,
        { data: { status: response.status, url: this.baseURL } },
      );
    }

    let json: OpenAIResponse;
    try {
      json = await response.json() as OpenAIResponse;
    } catch (err) {
      throw new LlmError(
        ErrCode.ERR_CC_OUTPUT_INVALID,
        `Failed to parse JSON response from ${this.baseURL}`,
        { cause: err },
      );
    }

    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new LlmError(
        ErrCode.ERR_CC_OUTPUT_INVALID,
        `Unexpected response shape from ${this.baseURL}: missing choices[0].message.content`,
      );
    }

    const usage = json.usage;
    const costUsd = usage
      ? computeCost(modelId, usage.prompt_tokens, usage.completion_tokens)
      : 0;

    return {
      stdout: cleanResponse(content),
      exitCode: 0,
      durationMs,
      costUsd,
      modelUsed: opts.model,
    };
  }
}

/**
 * Strip reasoning blocks and markdown fences so downstream JSON.parse() works.
 * - `<think>...</think>` — DeepSeek-R1 / MiniMax-M2.7 / o1-style inline reasoning
 * - ```json ... ``` or ``` ... ``` fences wrapping the actual payload
 * Idempotent. Leaves regular prose untouched.
 */
export function cleanResponse(raw: string): string {
  // 1. Remove all <think>...</think> blocks (multi-line, possibly multiple)
  let out = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 2. If the remainder is wrapped in a single markdown code fence, unwrap it.
  //    Match optional language tag (```json, ```ts, etc.).
  const fence = out.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) out = fence[1].trim();

  return out;
}
