/**
 * src/lib/cc.ts
 * Claude CLI subprocess client.
 * Spawns `claude --model X -p <prompt>` and returns captured stdout.
 * Timeout → SIGKILL child process.
 */

import { spawn } from 'node:child_process';
import { CcError } from './errors.js';
import { ErrCode } from './errors.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ClaudeModel = 'haiku' | 'sonnet' | 'opus';

export interface CcRunOptions {
  model: ClaudeModel;
  prompt: string;
  /** Milliseconds before the subprocess is killed. Default: 60_000. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  systemPrompt?: string;
  /**
   * Extra environment variables merged into the subprocess environment.
   * Used in tests to pass control variables to fake claude scripts.
   */
  _env?: Record<string, string>;
}

export interface CcRunResult {
  stdout: string;
  exitCode: number;
  durationMs: number;
  /** Estimated cost in USD, computed from approximate token count + model pricing. */
  costUsd: number;
  modelUsed: ClaudeModel;
}

export interface CcClient {
  run(opts: CcRunOptions): Promise<CcRunResult>;
}

// ─────────────────────────────────────────────
// Token-count cost estimation
// ─────────────────────────────────────────────

/**
 * Very rough token estimation: 1 token ≈ 4 characters.
 * Cost per 1M tokens (input + output, using output pricing as conservative estimate).
 */
const PRICING_PER_MTK: Record<ClaudeModel, number> = {
  haiku: 1.25,   // $1.25/M output tokens (claude-3-haiku-20240307)
  sonnet: 15.0,  // $15/M output tokens (claude-3-5-sonnet-20241022)
  opus: 75.0,    // $75/M output tokens (claude-3-opus-20240229)
};

function estimateCost(outputText: string, model: ClaudeModel): number {
  const charCount = outputText.length;
  const tokenEstimate = charCount / 4;
  const pricePerToken = PRICING_PER_MTK[model] / 1_000_000;
  return tokenEstimate * pricePerToken;
}

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

class CcClientImpl implements CcClient {
  private readonly claudeBin: string;
  private readonly claudeArgs: string[];
  private readonly defaultTimeoutMs: number;

  constructor(claudeBin: string, claudeArgs: string[], defaultTimeoutMs: number) {
    this.claudeBin = claudeBin;
    this.claudeArgs = claudeArgs;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async run(opts: CcRunOptions): Promise<CcRunResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const model = opts.model;

    const args: string[] = [
      ...this.claudeArgs,
      '--model', modelToFlag(model),
      '-p', opts.prompt,
    ];
    if (opts.systemPrompt) {
      args.push('--system', opts.systemPrompt);
    }

    const startMs = Date.now();

    return new Promise<CcRunResult>((resolve, reject) => {
      let settled = false;
      let timedOut = false;

      const spawnEnv = opts._env
        ? { ...process.env, ...opts._env }
        : process.env;

      const child = spawn(this.claudeBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: spawnEnv,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      // Timeout: kill child and reject
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
          new CcError(ErrCode.ERR_CC_FAILED, `Failed to spawn claude CLI: ${err.message}`, {
            cause: err,
          }),
        );
      });

      child.on('close', (code, signal) => {
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
            new CcError(
              ErrCode.ERR_CC_TIMEOUT,
              `claude CLI timed out after ${timeoutMs}ms`,
              { data: { timeoutMs } },
            ),
          );
        }

        if (opts.abortSignal?.aborted) {
          return reject(
            new CcError(ErrCode.ERR_CC_FAILED, 'claude CLI subprocess was aborted'),
          );
        }

        if (exitCode !== 0) {
          return reject(
            new CcError(
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
          costUsd: estimateCost(stdout, model),
          modelUsed: model,
        });
      });
    });
  }
}

// ─────────────────────────────────────────────
// Model name → CLI flag mapping
// ─────────────────────────────────────────────

function modelToFlag(model: ClaudeModel): string {
  switch (model) {
    case 'haiku':  return 'claude-3-5-haiku-20241022';
    case 'sonnet': return 'claude-sonnet-4-5';
    case 'opus':   return 'claude-opus-4-5';
  }
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

export interface CcClientConfig {
  /**
   * Path to the `claude` binary. Defaults to `'claude'` (resolved from PATH).
   * May include a leading interpreter prefix (e.g. `"node /path/to/fake-claude.mjs"`)
   * which will be split on the first space.
   */
  claudeBin?: string;
  /**
   * Extra leading arguments inserted before the `--model` flag.
   * Useful in tests to replace the binary with `node` + a script path:
   *   claudeBin: process.execPath, claudeArgs: ['/path/to/fake.mjs']
   */
  claudeArgs?: string[];
  /** Default subprocess timeout in milliseconds. Default: 60_000. */
  defaultTimeoutMs?: number;
}

/**
 * Create a new CcClient instance.
 * @param config Optional configuration.
 */
export function createCcClient(config?: CcClientConfig): CcClient {
  return new CcClientImpl(
    config?.claudeBin ?? 'claude',
    config?.claudeArgs ?? [],
    config?.defaultTimeoutMs ?? 60_000,
  );
}
