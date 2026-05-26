/**
 * Docker Ephemeral Sandbox — public API
 *
 * Import path: 'localsprite/sandbox' (configured via package.json exports)
 */

export { createSandbox, withSandbox } from './docker.js';
export { SandboxError, ERROR_CODES } from './errors.js';
export type {
  SandboxHandle,
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  BootAppOptions,
  AppHandle,
  SandboxStatus,
  ReadyProbe,
} from './types.js';
