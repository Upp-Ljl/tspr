import type { Page } from 'playwright';

const MAX_SNAPSHOT_BYTES = 50 * 1024; // 50KB

/**
 * Capture DOM snapshot and screenshot from a Playwright Page.
 * Pure: no I/O, just returns data.
 */
export async function captureSnapshot(page: Page): Promise<{
  html: string;
  screenshotBuffer: Buffer;
}> {
  const [rawHtml, screenshotBuffer] = await Promise.all([
    page.content(),
    page.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0)),
  ]);

  // Truncate to 50KB
  const encoder = new TextEncoder();
  const encoded = encoder.encode(rawHtml);
  const truncated = encoded.length > MAX_SNAPSHOT_BYTES
    ? new TextDecoder().decode(encoded.slice(0, MAX_SNAPSHOT_BYTES))
    : rawHtml;

  return { html: truncated, screenshotBuffer: screenshotBuffer as Buffer };
}
