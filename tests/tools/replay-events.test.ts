/**
 * Tests for replay event building:
 *   buildReplayEvents() from src/tools/generateAndExecute.ts
 *
 * Covers:
 *   - assertion events always emitted from failureMessages
 *   - http-request/response pair inferred from test title
 *   - console events extracted from vitest output
 *   - navigation event: best-effort
 *   - empty events → still returns at least one assertion event
 */
import { describe, it, expect } from 'vitest';
import { buildReplayEvents } from '../../src/tools/generateAndExecute.js';
import type { ScenarioReplayEvent } from '../../src/tools/generateAndExecute.js';

describe('buildReplayEvents', () => {
  describe('assertion events (failures)', () => {
    it('always emits at least one assertion event when failureMessages are present', () => {
      const events = buildReplayEvents('some test', ['Error: expected 200 but got 404']);
      const assertions = events.filter((e) => e.kind === 'assertion');
      expect(assertions.length).toBeGreaterThanOrEqual(1);
    });

    it('assertion detail matches the failure message', () => {
      const msg = 'AssertionError: expected "hello" to equal "world"';
      const events = buildReplayEvents('unit test', [msg]);
      const assertion = events.find((e) => e.kind === 'assertion');
      expect(assertion).toBeDefined();
      expect(assertion!.detail).toContain('AssertionError');
    });

    it('skips stack frames in the assertion detail', () => {
      const failureMsg = 'AssertionError: wrong value\n    at Object.<anonymous> (test.spec.ts:42:5)\n    at runMicrotasks';
      const events = buildReplayEvents('test', [failureMsg]);
      const assertion = events.find((e) => e.kind === 'assertion');
      expect(assertion!.detail).not.toMatch(/^\s*at /);
    });

    it('returns empty array (no crash) when failureMessages is empty', () => {
      const events = buildReplayEvents('passing test', []);
      // Should not throw; may have 0 events
      expect(Array.isArray(events)).toBe(true);
    });

    it('ts field is a number', () => {
      const events = buildReplayEvents('test', ['failed']);
      events.forEach((e) => {
        expect(typeof e.ts).toBe('number');
      });
    });
  });

  describe('http-request / http-response pair (from test title parse)', () => {
    it('emits http-request + http-response when title contains HTTP method + path', () => {
      const events = buildReplayEvents('GET /api/memes returns 200', ['expected 200 got 404']);
      const req = events.find((e) => e.kind === 'http-request');
      const res = events.find((e) => e.kind === 'http-response');
      expect(req).toBeDefined();
      expect(res).toBeDefined();
    });

    it('http-request detail includes method and path', () => {
      const events = buildReplayEvents('POST /api/users creates a user', ['error']);
      const req = events.find((e) => e.kind === 'http-request');
      expect(req!.detail).toContain('POST');
      expect(req!.detail).toContain('/api/users');
    });

    it('http-response detail reflects status code mismatch', () => {
      const events = buildReplayEvents('GET /api/health should return 200', ['expected 200, got 500']);
      const res = events.find((e) => e.kind === 'http-response');
      expect(res).toBeDefined();
      // Detail should mention something about the status
      expect(res!.detail).toMatch(/GET|200|500|\//);
    });

    it('does NOT emit http events for non-HTTP test titles', () => {
      const events = buildReplayEvents('adds two numbers correctly', ['expected 3 got 4']);
      const httpEvents = events.filter((e) => e.kind === 'http-request' || e.kind === 'http-response');
      expect(httpEvents.length).toBe(0);
    });

    it('handles lowercase HTTP methods', () => {
      const events = buildReplayEvents('delete /api/items/:id removes the item', ['error: 404']);
      const req = events.find((e) => e.kind === 'http-request');
      expect(req).toBeDefined();
    });
  });

  describe('console events (from vitest output)', () => {
    it('emits console events when consoleOutput contains console.log', () => {
      const consoleOutput = 'console.log: request received\nconsole.error: unexpected status 500';
      const events = buildReplayEvents('test', ['failed'], consoleOutput);
      const consoleEvents = events.filter((e) => e.kind === 'console');
      expect(consoleEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('console event detail includes the logged message', () => {
      const consoleOutput = 'console.log: hello world';
      const events = buildReplayEvents('test', ['failed'], consoleOutput);
      const ce = events.find((e) => e.kind === 'console');
      expect(ce!.detail).toContain('hello world');
    });

    it('emits no console events when consoleOutput is empty', () => {
      const events = buildReplayEvents('test', ['failed'], '');
      const consoleEvents = events.filter((e) => e.kind === 'console');
      expect(consoleEvents.length).toBe(0);
    });

    it('emits no console events when consoleOutput is undefined', () => {
      const events = buildReplayEvents('test', ['failed'], undefined);
      const consoleEvents = events.filter((e) => e.kind === 'console');
      expect(consoleEvents.length).toBe(0);
    });
  });

  describe('event kind values', () => {
    it('all event kinds are one of the valid ScenarioReplayEvent kinds', () => {
      const validKinds: ScenarioReplayEvent['kind'][] = [
        'http-request', 'http-response', 'console', 'assertion', 'navigation',
      ];
      const events = buildReplayEvents(
        'GET /api/x returns 200',
        ['expected 200 got 404'],
        'console.log: debug info',
      );
      events.forEach((e) => {
        expect(validKinds).toContain(e.kind);
      });
    });
  });

  describe('data field', () => {
    it('assertion event has data.fullMessage', () => {
      const events = buildReplayEvents('test', ['my error']);
      const assertion = events.find((e) => e.kind === 'assertion');
      expect(assertion!.data).toBeDefined();
      expect((assertion!.data as { fullMessage: string }).fullMessage).toContain('my error');
    });

    it('http-request event has data.method and data.path', () => {
      const events = buildReplayEvents('GET /api/items fetches list', ['error']);
      const req = events.find((e) => e.kind === 'http-request');
      expect((req!.data as { method: string }).method).toBe('GET');
      expect((req!.data as { path: string }).path).toContain('/api/items');
    });
  });
});
