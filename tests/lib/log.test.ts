/**
 * tests/lib/log.test.ts
 * Tests for src/lib/log.ts
 * Captures stderr to assert JSON lines format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger } from '../../src/lib/log.js';

/** Capture all strings written to process.stderr.write during fn() */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });

  try {
    fn();
  } finally {
    spy.mockRestore();
  }

  return lines;
}

function parseLines(captured: string[]): Record<string, unknown>[] {
  return captured
    .flatMap((chunk) => chunk.split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createLogger', () => {
  it('emits a JSON line to stderr on info()', () => {
    const logger = createLogger({ level: 'debug' });
    const lines = captureStderr(() => logger.info('hello world'));
    const entries = parseLines(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['msg']).toBe('hello world');
    expect(entries[0]!['level']).toBe('info');
  });

  it('includes a time field in ISO 8601 format', () => {
    const logger = createLogger();
    const lines = captureStderr(() => logger.info('time test'));
    const entries = parseLines(lines);
    expect(entries[0]!['time']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('merges ctx object into log entry', () => {
    const logger = createLogger();
    const lines = captureStderr(() =>
      logger.info('with context', { requestId: 'abc123', count: 42 }),
    );
    const entries = parseLines(lines);
    expect(entries[0]!['requestId']).toBe('abc123');
    expect(entries[0]!['count']).toBe(42);
  });

  it('respects minimum level — debug suppressed when level=info', () => {
    const logger = createLogger({ level: 'info' });
    const lines = captureStderr(() => logger.debug('should not appear'));
    expect(lines).toHaveLength(0);
  });

  it('emits debug when level=debug', () => {
    const logger = createLogger({ level: 'debug' });
    const lines = captureStderr(() => logger.debug('visible debug'));
    const entries = parseLines(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['level']).toBe('debug');
  });

  it('emits warn', () => {
    const logger = createLogger({ level: 'debug' });
    const lines = captureStderr(() => logger.warn('a warning', { code: 'W1' }));
    const entries = parseLines(lines);
    expect(entries[0]!['level']).toBe('warn');
  });

  it('emits error', () => {
    const logger = createLogger({ level: 'debug' });
    const lines = captureStderr(() => logger.error('an error'));
    const entries = parseLines(lines);
    expect(entries[0]!['level']).toBe('error');
  });

  it('suppresses warn when level=error', () => {
    const logger = createLogger({ level: 'error' });
    const lines = captureStderr(() => {
      logger.warn('suppressed');
      logger.error('visible');
    });
    const entries = parseLines(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['level']).toBe('error');
  });

  it('includes prefix field when provided', () => {
    const logger = createLogger({ prefix: 'mcp-server' });
    const lines = captureStderr(() => logger.info('prefixed'));
    const entries = parseLines(lines);
    expect(entries[0]!['prefix']).toBe('mcp-server');
  });

  it('default level is info — debug suppressed, info visible', () => {
    const logger = createLogger(); // no level option
    const captured: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    });

    logger.debug('debug msg');
    logger.info('info msg');

    spy.mockRestore();

    const entries = parseLines(captured);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['level']).toBe('info');
  });

  describe('child logger', () => {
    it('inherits parent bindings', () => {
      const parent = createLogger({ level: 'debug', prefix: 'root' });
      const child = parent.child({ component: 'db' });
      const lines = captureStderr(() => child.info('child message'));
      const entries = parseLines(lines);
      expect(entries[0]!['prefix']).toBe('root');
      expect(entries[0]!['component']).toBe('db');
    });

    it('child bindings do not bleed into parent', () => {
      const parent = createLogger({ level: 'debug' });
      const child = parent.child({ extra: 'yes' });
      const parentLines = captureStderr(() => parent.info('parent msg'));
      const parentEntries = parseLines(parentLines);
      expect(parentEntries[0]!['extra']).toBeUndefined();
    });

    it('child can itself produce children', () => {
      const grandchild = createLogger({ level: 'debug' })
        .child({ a: 1 })
        .child({ b: 2 });
      const lines = captureStderr(() => grandchild.info('deep'));
      const entries = parseLines(lines);
      expect(entries[0]!['a']).toBe(1);
      expect(entries[0]!['b']).toBe(2);
    });
  });

  it('output is valid JSON on each line', () => {
    const logger = createLogger({ level: 'debug' });
    const lines = captureStderr(() => {
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
    });
    const allText = lines.join('');
    const jsonLines = allText.split('\n').filter(Boolean);
    expect(jsonLines).toHaveLength(4);
    for (const line of jsonLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('never writes to stdout', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const logger = createLogger({ level: 'debug' });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    logger.info('test');
    logger.error('test error');

    expect(stdoutSpy).not.toHaveBeenCalled();

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
