/**
 * src/cli/open-in-editor.ts
 *
 * Cross-platform helper to open a vscode:// deep link URL.
 *
 * Windows : cmd /c start "" "<url>"
 * macOS   : open "<url>"
 * Linux   : xdg-open "<url>"
 *
 * If the handler is not available the error is swallowed and a hint is logged.
 */

import { spawn } from 'node:child_process';

export interface OpenEditorOptions {
  /** Suppress the hint message on failure (default: false) */
  silent?: boolean;
}

/**
 * Build a vscode:// deep-link URL for the given absolute file path and line.
 * The URL format is: vscode://file/<abs-path>:<line>
 */
export function buildVscodeUrl(absFile: string, line: number): string {
  // Normalize path separators to forward slashes for the URL
  const normalized = absFile.replace(/\\/g, '/');
  // On Windows paths start with drive letter — vscode:// wants leading slash
  const urlPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `vscode://file${urlPath}:${line}`;
}

/**
 * Open a URL (typically vscode://) in the OS default handler.
 * Returns true if the spawn call succeeded, false otherwise.
 */
export async function openInEditor(url: string, opts?: OpenEditorOptions): Promise<boolean> {
  const silent = opts?.silent ?? false;

  let cmd: string;
  let args: string[];

  switch (process.platform) {
    case 'win32':
      // cmd /c start "" "<url>" — the empty string "" is the window title
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
      break;
    case 'darwin':
      cmd = 'open';
      args = [url];
      break;
    default:
      cmd = 'xdg-open';
      args = [url];
  }

  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        // On Windows cmd /c start is synchronous enough; detach is fine
        shell: false,
      });
      child.unref();
      child.once('error', (err) => {
        if (!silent) {
          process.stderr.write(
            `[tspr] Could not open editor URL (${cmd} failed: ${err.message})\n` +
            `  Hint: open manually — ${url}\n`,
          );
        }
        resolve(false);
      });
      // Give it a moment then resolve true; the spawn itself succeeding is the signal
      resolve(true);
    } catch (err) {
      if (!silent) {
        process.stderr.write(
          `[tspr] Could not launch editor handler: ${String(err)}\n` +
          `  Hint: open manually — ${url}\n`,
        );
      }
      resolve(false);
    }
  });
}
