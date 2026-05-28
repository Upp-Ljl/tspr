/**
 * src/sandbox/screenshot.ts
 *
 * Best-effort Playwright screenshot capture for test failures.
 *
 * Strategy v1:
 *   - Grep the test file for the first fetch/request/page.goto URL
 *   - Spawn a tiny Playwright script inside the sandbox that navigates to that URL
 *     and snaps a screenshot
 *   - Return base64 PNG string, or null if anything fails (Playwright absent,
 *     URL can't be inferred, sandbox not available, etc.)
 *
 * This helper NEVER throws — all errors are logged and return null.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SandboxHandle } from './types.js';

/** Returns a base64-encoded PNG string, or null if screenshot could not be taken. */
export async function captureFailureScreenshot(
  sandbox: SandboxHandle,
  testFile: string,
  testTitle: string,
): Promise<string | null> {
  try {
    // Step 1: infer the URL the test was hitting
    const url = inferTestUrl(testFile);
    if (!url) {
      return null;
    }

    // Step 2: build a tiny Playwright script to navigate & screenshot
    const script = buildPlaywrightScript(url);

    // Step 3: write script into the sandbox temp area
    const scriptPath = `/tmp/tspr-screenshot-${Date.now()}.mjs`;
    const writeResult = await sandbox.exec(
      `cat > ${scriptPath} << 'TSPR_SCRIPT_EOF'\n${script}\nTSPR_SCRIPT_EOF`,
      { timeout: 10_000 },
    );
    if (writeResult.exitCode !== 0) {
      return null;
    }

    // Step 4: run the script with node; Playwright must be in /tspr-runtime/node_modules
    const screenshotPath = `/tmp/tspr-screenshot-${Date.now()}.png`;
    const runResult = await sandbox.exec(
      `node ${scriptPath} ${screenshotPath}`,
      {
        cwd: '/tspr-runtime',
        timeout: 20_000,
        env: { PLAYWRIGHT_SCREENSHOT_URL: url, PLAYWRIGHT_SCREENSHOT_OUT: screenshotPath },
      },
    );

    if (runResult.exitCode !== 0) {
      // Playwright might not be installed or page failed to load — graceful
      return null;
    }

    // Step 5: read the screenshot from the container
    const catResult = await sandbox.exec(
      `cat ${screenshotPath} | base64 -w 0`,
      { timeout: 10_000 },
    );

    if (catResult.exitCode !== 0 || !catResult.stdout.trim()) {
      return null;
    }

    return catResult.stdout.trim();
  } catch {
    // Any error → graceful null (network, sandbox disposed, etc.)
    return null;
  }
}

/**
 * Try to infer a URL from the test file content.
 * Looks for the first fetch(, request(, or page.goto( call.
 * Returns null if nothing found or file unreadable.
 */
export function inferTestUrl(testFile: string): string | null {
  if (!testFile) return null;

  let content = '';
  try {
    if (fs.existsSync(testFile)) {
      content = fs.readFileSync(testFile, 'utf-8');
    } else {
      // testFile might be container-relative; try to find it in cwd
      return null;
    }
  } catch {
    return null;
  }

  // Patterns to extract URLs from test code
  const patterns = [
    // fetch('/api/something') or fetch("http://...")
    /fetch\(\s*['"`](https?:\/\/[^'"`]+|\/[^'"`]*)[`'"]/,
    // request.get('/api/...') or request('/api/...')
    /request(?:\.(?:get|post|put|delete|patch))?\(\s*['"`](https?:\/\/[^'"`]+|\/[^'"`]*)[`'"]/,
    // page.goto('http://...')
    /page\.goto\(\s*['"`](https?:\/\/[^'"`]+)[`'"]/,
    // baseURL + path combos: request(baseURL + '/api/...')
    /['"`](https?:\/\/[^'"`]+)['"`]/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const url = match[1];
      // Prefer absolute URLs; for relative, prepend localhost
      if (url.startsWith('http')) {
        return url;
      }
      // Relative path — use TEST_BASE_URL or default
      const base = process.env.TSPR_TEST_BASE_URL ?? 'http://host.docker.internal:3003';
      return `${base}${url}`;
    }
  }

  return null;
}

/**
 * Build a minimal Node.js script that uses Playwright to screenshot a URL.
 * The script is written inline to avoid any file-system dependency.
 */
function buildPlaywrightScript(url: string): string {
  return `
import { chromium } from '/tspr-runtime/node_modules/@playwright/test/index.js';
import { writeFileSync } from 'node:fs';

const url = process.env.PLAYWRIGHT_SCREENSHOT_URL || '${url.replace(/'/g, "\\'")}';
const out = process.env.PLAYWRIGHT_SCREENSHOT_OUT || process.argv[2] || '/tmp/screenshot.png';

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() =>
      page.goto(url, { waitUntil: 'load', timeout: 8000 })
    );
    const png = await page.screenshot({ fullPage: false, type: 'png' });
    writeFileSync(out, png);
    process.exit(0);
  } catch (err) {
    process.stderr.write('screenshot failed: ' + err.message + '\\n');
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
`.trim();
}
