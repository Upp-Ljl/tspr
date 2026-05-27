/**
 * src/lib/providers/claude-subprocess.ts
 * LlmProvider implementation that spawns a `claude` CLI subprocess.
 * Extracted from the original src/lib/cc.ts implementation.
 */

import { spawn } from 'node:child_process';
import { LlmError, ErrCode } from '../errors.js';
import type { LlmProvider } from './types.js';
import type { LlmRunOptions, LlmRunResult } from '../cc.js';
import {
  CLAUDE_SUBPROCESS_DEFAULTS,
  resolveModelId,
  type ModelAliasMap,
} from './model-alias.js';

// ─────────────────────────────────────────────
// Cost estimation (subprocess doesn't report usage; estimate from output)
// ─────────────────────────────────────────────

/**
 * Very rough token estimation: 1 token ≈ 4 characters.
 * Cost per 1M tokens (output pricing).
 */
const PRICING_PER_MTK: Record<string, number> = {
  haiku:  1.25,   // $1.25/M output tokens
  sonnet: 15.0,   // $15/M output tokens
  opus:   75.0,   // $75/M output tokens
};

function estimateCost(outputText: string, alias: string): number {
  const charCount = outputText.length;
  const tokenEstimate = charCount / 4;
  const ppm = PRICING_PER_MTK[alias] ?? 15.0;
  const pricePerToken = ppm / 1_000_000;
  return tokenEstimate * pricePerToken;
}

// ─────────────────────────────────────────────
// Provider config
// ─────────────────────────────────────────────

export interface ClaudeSubprocessConfig {
  /** Path to the `claude` binary. Defaults to `'claude'` (resolved from PATH). */
  binary?: string;
  /** Extra leading arguments inserted before the `--model` flag. */
  extraArgs?: string[];
  /** Default subprocess timeout in milliseconds. Default: 60_000. */
  defaultTimeoutMs?: number;
  /** Override model alias → model ID mapping. */
  modelAliasOverrides?: Partial<ModelAliasMap>;
}

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

export class ClaudeSubprocessProvider implements LlmProvider {
  private readonly binary: string;
  private readonly extraArgs: string[];
  private readonly defaultTimeoutMs: number;
  private readonly modelAliases: ModelAliasMap;

  constructor(cfg: ClaudeSubprocessConfig = {}) {
    this.binary = cfg.binary ?? 'claude';
    this.extraArgs = cfg.extraArgs ?? [];
    this.defaultTimeoutMs = cfg.defaultTimeoutMs ?? 60_000;
    this.modelAliases = {
      ...CLAUDE_SUBPROCESS_DEFAULTS,
      ...(cfg.modelAliasOverrides ?? {}),
    };
  }

  async chat(opts: LlmRunOptions): Promise<LlmRunResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const modelId = resolveModelId(opts.model, this.modelAliases);

    const args: string[] = [
      ...this.extraArgs,
      '--model', modelId,
      '-p', opts.prompt,
    ];
    if (opts.systemPrompt) {
      args.push('--system', opts.systemPrompt);
    }

    const startMs = Date.now();

    return new Promise<LlmRunResult>((resolve, reject) => {
      let settled = false;
      let timedOut = false;

      const spawnEnv = opts._env
        ? { ...process.env, ...opts._env }
        : process.env;

      const child = spawn(this.binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: spawnEnv,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      // Timeout: kill child
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, timeoutMs);

      // AbortSignal integration
      const onAbort = () => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      };
      opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.abortSignal?.removeEventListener('abort', onAbort);
        reject(
          new LlmError(ErrCode.ERR_CC_FAILED, `Failed to spawn claude CLI: ${err.message}`, {
            cause: err,
          }),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        opts.abortSignal?.removeEventListener('abort', onAbort);

        if (settled) return;
        settled = true;

        const durationMs = Date.now() - startMs;
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const exitCode = code ?? -1;

        if (timedOut) {
          return reject(
            new LlmError(
              ErrCode.ERR_CC_TIMEOUT,
              `claude CLI timed out after ${timeoutMs}ms`,
              { data: { timeoutMs } },
            ),
          );
        }

        if (opts.abortSignal?.aborted) {
          return reject(
            new LlmError(ErrCode.ERR_CC_FAILED, 'claude CLI subprocess was aborted'),
          );
        }

        if (exitCode !== 0) {
          return reject(
            new LlmError(
              ErrCode.ERR_CC_FAILED,
              `claude CLI exited with code ${exitCode}: ${stderr.trim()}`,
              { data: { exitCode, stderr: stderr.slice(0, 500) } },
            ),
          );
        }

        resolve({
          stdout,
          exitCode,
          durationMs,
          costUsd: estimateCost(stdout, opts.model),
          modelUsed: opts.model,
        });
      });
    });
  }
}
