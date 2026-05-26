import type { SandboxHandle } from './types.js';

/** Module-level set of all active sandbox handles */
const activeContainers: Set<SandboxHandle> = new Set();

/** Whether we've registered global signal handlers */
let handlersRegistered = false;

export function register(handle: SandboxHandle): void {
  activeContainers.add(handle);
  ensureHandlersRegistered();
}

export function unregister(handle: SandboxHandle): void {
  activeContainers.delete(handle);
}

export function getActiveCount(): number {
  return activeContainers.size;
}

export function getActiveHandles(): ReadonlySet<SandboxHandle> {
  return activeContainers;
}

async function cleanupAll(reason: string): Promise<void> {
  const handles = [...activeContainers];
  if (handles.length === 0) return;
  await Promise.allSettled(handles.map((h) => h.dispose()));
  if (reason !== 'beforeExit') process.exit(0);
}

function ensureHandlersRegistered(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  process.on('SIGINT', () => {
    cleanupAll('SIGINT').catch(() => {
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    cleanupAll('SIGTERM').catch(() => {
      process.exit(1);
    });
  });

  process.on('beforeExit', () => {
    cleanupAll('beforeExit').catch(() => {});
  });
}

/** Reset for testing (allows re-registration) */
export function _resetForTesting(): void {
  activeContainers.clear();
  // We can't easily remove signal handlers, but we reset the flag
  // This means a fresh test process gets clean state
}
