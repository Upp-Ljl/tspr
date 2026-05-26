import { existsSync } from 'fs';
import path from 'path';
import type { Browser, BrowserContext } from 'playwright';
import type { ExploreUIOptions } from './types.js';
import { ExplorationError } from './error.js';

// Auto-detection search paths relative to projectPath
const AUTO_DETECT_PATHS = [
  'tests/fixtures/auth.ts',
  'tests/fixtures/auth.mjs',
  'e2e/fixtures/login.ts',
  'e2e/fixtures/login.mjs',
  '.tspr/login.ts',
  '.tspr/login.mjs',
];

/**
 * Run login fixture and return storageState JSON string.
 * Throws ExplorationError('LOGIN_FAILED') on any failure.
 */
export async function runLoginFixture(
  browser: Browser,
  projectPath: string,
  options: ExploreUIOptions,
): Promise<string> {
  let fixturePath: string | undefined = options.loginFixturePath;

  // If explicit path given, check it exists
  if (fixturePath) {
    if (!existsSync(fixturePath)) {
      throw new ExplorationError('LOGIN_FAILED', 'fixture file not found');
    }
  } else {
    // Auto-detect
    for (const rel of AUTO_DETECT_PATHS) {
      const candidate = path.join(projectPath, rel);
      if (existsSync(candidate)) {
        fixturePath = candidate;
        break;
      }
    }
  }

  const context: BrowserContext = await browser.newContext();
  try {
    const page = await context.newPage();

    if (fixturePath) {
      // Load and run the fixture
      let loginFn: unknown;
      try {
        const mod = await import(fixturePath);
        loginFn = mod.default;
      } catch (err: unknown) {
        await context.close();
        const msg = err instanceof Error ? err.message : String(err);
        throw new ExplorationError('LOGIN_FAILED', `fixture load error: ${msg}`);
      }

      if (typeof loginFn !== 'function') {
        await context.close();
        throw new ExplorationError('LOGIN_FAILED', 'fixture must export a default async function');
      }

      try {
        await (loginFn as (page: unknown) => Promise<void>)(page);
      } catch (err: unknown) {
        await context.close();
        const msg = err instanceof Error ? err.message : String(err);
        throw new ExplorationError('LOGIN_FAILED', msg);
      }
    } else {
      // Heuristic: no fixture found — check for credentials.json
      const credsPath = path.join(projectPath, '.tspr', 'credentials.json');
      if (!existsSync(credsPath)) {
        await context.close();
        throw new ExplorationError('LOGIN_FAILED', 'no credentials file');
      }
      // If credentials exist, we'd do heuristic form-fill — for now, signal failure
      // if heuristic form fill is not implemented
      await context.close();
      throw new ExplorationError('LOGIN_FAILED', 'heuristic login not supported; provide loginFixturePath');
    }

    const storageState = await context.storageState();
    await context.close();
    return JSON.stringify(storageState);
  } catch (err) {
    // Close context if not already closed
    try { await context.close(); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Check if a post-navigation URL looks like a login redirect.
 */
export function isLoginRedirect(url: string): boolean {
  return /login|signin|auth|session-expired/i.test(url);
}
