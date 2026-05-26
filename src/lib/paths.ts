/**
 * src/lib/paths.ts
 * Path helpers for ~/.tspr/ data directory.
 * On Windows, ~ resolves to %USERPROFILE%.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Returns the path to ~/.tspr (the tspr home directory). */
export function tsprHome(): string {
  return path.join(os.homedir(), '.tspr');
}

/** Returns the path to {home}/runs — where per-run artifacts live. */
export function runsDir(): string {
  return path.join(tsprHome(), 'runs');
}

/** Returns the path to {home}/db.sqlite — the SQLite state file. */
export function dbPath(): string {
  return path.join(tsprHome(), 'db.sqlite');
}

/** Returns the path to {home}/config.json — user-editable config. */
export function configPath(): string {
  return path.join(tsprHome(), 'config.json');
}

/**
 * Ensures the given directory exists, creating it (and any parents) if absent.
 * Equivalent to `mkdir -p`.
 */
export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
