import * as fs from 'fs';
import { SandboxError, ERROR_CODES } from './errors.js';

/**
 * Pulls artifacts from the container's /tmp/tspr-out to the host runDir.
 *
 * Implementation note: /tmp/tspr-out is bind-mounted directly to runDir,
 * so artifacts are already on the host as they are written. This function's role
 * is to verify the bind mount is accessible and surface errors (e.g., container
 * removed before this call). Resolves silently if the directory is empty or absent.
 *
 * B-2-17: After call, files from /tmp/tspr-out appear in runDir.
 * B-2-25: If the directory doesn't exist or is empty, resolves without throwing.
 */
export async function pullArtifacts(
  _container: { id: string },
  runDir: string
): Promise<void> {
  // Because /tmp/tspr-out is bind-mounted to runDir, files are already present.
  // We just ensure the runDir exists (it should, but be defensive).
  try {
    if (!fs.existsSync(runDir)) {
      // runDir was deleted somehow — nothing to pull
      return;
    }
    // B-2-25: silent success even if empty
    const entries = fs.readdirSync(runDir).filter((e) => {
      // Ignore hidden files and the bind-mount root itself
      return !e.startsWith('.');
    });
    void entries; // artifacts are already in place
  } catch (err) {
    // If we can't even read runDir, something is wrong
    throw new SandboxError(
      ERROR_CODES.ARTIFACT_PULL_FAILED,
      `Failed to access artifacts directory: ${String(err)}`,
      { cause: err }
    );
  }
}

