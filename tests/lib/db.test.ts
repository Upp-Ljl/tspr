/**
 * tests/lib/db.test.ts
 * Tests for src/lib/db.ts
 * Uses in-memory SQLite to avoid filesystem side-effects.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema } from '../../src/lib/db.js';
import type { Db } from '../../src/lib/db.js';

describe('openDb + initSchema', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    initSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  // ─── Schema existence ────────────────────────

  it('creates sessions table', () => {
    const row = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
      )
      .get();
    expect(row?.name).toBe('sessions');
  });

  it('creates runs table', () => {
    const row = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='runs'",
      )
      .get();
    expect(row?.name).toBe('runs');
  });

  it('creates test_results table', () => {
    const row = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_results'",
      )
      .get();
    expect(row?.name).toBe('test_results');
  });

  it('creates code_summaries table', () => {
    const row = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='code_summaries'",
      )
      .get();
    expect(row?.name).toBe('code_summaries');
  });

  it('initSchema is idempotent — calling twice does not throw', () => {
    expect(() => initSchema(db)).not.toThrow();
  });

  // ─── exec ────────────────────────────────────

  it('exec creates a temp table without throwing', () => {
    expect(() => {
      db.exec('CREATE TEMP TABLE tmp_test (x INTEGER)');
    }).not.toThrow();
  });

  // ─── prepare + run + get ─────────────────────

  it('inserts and retrieves a run row', () => {
    db.prepare(
      `INSERT INTO runs (id, tool_name, project_path, started_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('run-id-1', 'tspr_bootstrap_tests', '/tmp/proj', new Date().toISOString(), 'ok');

    const row = db
      .prepare<{ id: string; tool_name: string }>('SELECT id, tool_name FROM runs WHERE id = ?')
      .get('run-id-1');

    expect(row?.id).toBe('run-id-1');
    expect(row?.tool_name).toBe('tspr_bootstrap_tests');
  });

  it('run() returns changes count', () => {
    const info = db
      .prepare(
        `INSERT INTO runs (id, tool_name, started_at, status)
         VALUES (?, ?, ?, ?)`,
      )
      .run('run-id-2', 'tspr_rerun_tests', new Date().toISOString(), 'in-progress');

    expect(info.changes).toBe(1);
  });

  it('run() returns lastInsertRowid', () => {
    const info = db
      .prepare(
        `INSERT INTO runs (id, tool_name, started_at, status)
         VALUES (?, ?, ?, ?)`,
      )
      .run('run-id-3', 'tspr_dashboard', new Date().toISOString(), 'ok');

    expect(typeof info.lastInsertRowid).toMatch(/^(number|bigint)$/);
  });

  it('get() returns undefined for missing row', () => {
    const row = db
      .prepare('SELECT id FROM runs WHERE id = ?')
      .get('non-existent-id');

    expect(row).toBeUndefined();
  });

  // ─── all ─────────────────────────────────────

  it('all() returns empty array when no rows', () => {
    const rows = db.prepare('SELECT * FROM runs').all();
    expect(rows).toEqual([]);
  });

  it('all() returns multiple rows', () => {
    const insert = db.prepare(
      `INSERT INTO runs (id, tool_name, started_at, status) VALUES (?, ?, ?, ?)`,
    );
    insert.run('a', 'tool_a', new Date().toISOString(), 'ok');
    insert.run('b', 'tool_b', new Date().toISOString(), 'error');

    const rows = db.prepare<{ id: string }>('SELECT id FROM runs ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe('a');
    expect(rows[1]!.id).toBe('b');
  });

  // ─── iterate ─────────────────────────────────

  it('iterate() yields rows one by one', () => {
    const insert = db.prepare(
      `INSERT INTO runs (id, tool_name, started_at, status) VALUES (?, ?, ?, ?)`,
    );
    insert.run('it-1', 'tool_x', new Date().toISOString(), 'ok');
    insert.run('it-2', 'tool_y', new Date().toISOString(), 'ok');

    const ids: string[] = [];
    for (const row of db.prepare<{ id: string }>('SELECT id FROM runs ORDER BY id').iterate()) {
      ids.push(row.id);
    }

    expect(ids).toContain('it-1');
    expect(ids).toContain('it-2');
  });

  // ─── transaction ─────────────────────────────

  it('transaction commits on success', () => {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO runs (id, tool_name, started_at, status) VALUES (?, ?, ?, ?)`,
      ).run('tx-1', 'tool', new Date().toISOString(), 'ok');
    });

    const row = db.prepare<{ id: string }>('SELECT id FROM runs WHERE id = ?').get('tx-1');
    expect(row?.id).toBe('tx-1');
  });

  it('transaction rolls back on error', () => {
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO runs (id, tool_name, started_at, status) VALUES (?, ?, ?, ?)`,
        ).run('tx-rb', 'tool', new Date().toISOString(), 'ok');
        throw new Error('rollback!');
      });
    } catch {
      // expected
    }

    const row = db.prepare<{ id: string }>('SELECT id FROM runs WHERE id = ?').get('tx-rb');
    expect(row).toBeUndefined();
  });

  // ─── Sessions table ───────────────────────────

  it('inserts and retrieves a session', () => {
    db.prepare(
      `INSERT INTO sessions (id, project_path, local_port, type, test_scope, detected_framework, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sess-1',
      '/home/user/proj',
      5173,
      'frontend',
      'codebase',
      'react',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const sess = db
      .prepare<{ project_path: string; type: string }>(
        'SELECT project_path, type FROM sessions WHERE id = ?',
      )
      .get('sess-1');

    expect(sess?.project_path).toBe('/home/user/proj');
    expect(sess?.type).toBe('frontend');
  });

  // ─── test_results table ───────────────────────

  it('inserts a test_result with FK to runs', () => {
    db.prepare(
      `INSERT INTO runs (id, tool_name, started_at, status) VALUES (?, ?, ?, ?)`,
    ).run('run-tr', 'tool', new Date().toISOString(), 'ok');

    db.prepare(
      `INSERT INTO test_results (id, run_id, test_id, test_name, test_file, test_type, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'tr-1',
      'run-tr',
      'abc123456789',
      'should render login form',
      'src/tests/login.spec.ts',
      'frontend-e2e',
      'passed',
      new Date().toISOString(),
    );

    const row = db
      .prepare<{ test_name: string }>('SELECT test_name FROM test_results WHERE id = ?')
      .get('tr-1');

    expect(row?.test_name).toBe('should render login form');
  });

  // ─── code_summaries table ─────────────────────

  it('inserts a code_summary', () => {
    db.prepare(
      `INSERT INTO code_summaries (id, project_path, framework, summary_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('cs-1', '/proj', 'react', '{"entry":"index.tsx"}', new Date().toISOString());

    const row = db
      .prepare<{ framework: string }>('SELECT framework FROM code_summaries WHERE id = ?')
      .get('cs-1');

    expect(row?.framework).toBe('react');
  });
});
