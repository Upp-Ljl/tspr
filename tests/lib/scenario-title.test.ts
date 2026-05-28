/**
 * tests/lib/scenario-title.test.ts
 *
 * Unit tests for resolveTitle().
 * Pure function — no I/O.
 */
import { describe, it, expect } from 'vitest';
import { resolveTitle, type ScenarioRecord } from '../../src/lib/scenario-title.js';

const basicScenarios: ScenarioRecord[] = [
  {
    id: 'MEME-001',
    endpoint: 'GET /api/memes',
    title: 'Successfully retrieve paginated list of memes',
    type: 'happy-path',
    description: 'Returns paginated meme list',
  },
  {
    id: 'SETT-001',
    endpoint: 'GET /api/settle/:week',
    title: 'Successfully retrieve settlement data for a specific week',
    type: 'happy-path',
    description: 'Settlement week lookup',
  },
  {
    id: 'AUTH-001',
    endpoint: 'GET /api/auth/callback',
    title: 'Successful OAuth authentication callback',
    type: 'auth',
    description: 'Auth callback with valid code',
  },
];

describe('resolveTitle', () => {
  it('SCT-001: exact id match → returns best label', () => {
    const result = resolveTitle('MEME-001', basicScenarios);
    // title takes priority over endpoint/id
    expect(result).toBe('Successfully retrieve paginated list of memes');
  });

  it('SCT-002: exact title match → returns that title', () => {
    const result = resolveTitle('Successfully retrieve settlement data for a specific week', basicScenarios);
    expect(result).toBe('Successfully retrieve settlement data for a specific week');
  });

  it('SCT-003: endpoint substring match → returns title of matched scenario', () => {
    // vitest fullName style: "meme-weather API Integration Tests GET /api/memes should return 200"
    const result = resolveTitle(
      'meme-weather API Integration Tests GET /api/memes should return 200 OK',
      basicScenarios,
    );
    expect(result).toBe('Successfully retrieve paginated list of memes');
  });

  it('SCT-004: no match → fallback to vitestFullName', () => {
    const result = resolveTitle('unknown test that does not match anything', basicScenarios);
    expect(result).toBe('unknown test that does not match anything');
  });

  it('SCT-005: empty scenarios array → fallback to vitestFullName', () => {
    const result = resolveTitle('GET /api/memes', []);
    expect(result).toBe('GET /api/memes');
  });

  it('SCT-006: undefined scenarios → fallback to vitestFullName', () => {
    const result = resolveTitle('GET /api/memes', undefined);
    expect(result).toBe('GET /api/memes');
  });

  it('SCT-007: null scenarios → fallback to vitestFullName', () => {
    const result = resolveTitle('GET /api/memes', null);
    expect(result).toBe('GET /api/memes');
  });

  it('SCT-008: scenario with no title → falls back to endpoint', () => {
    const scenarios: ScenarioRecord[] = [
      { id: 'X-001', endpoint: 'GET /api/x', title: null, type: 'happy-path' },
    ];
    const result = resolveTitle('X-001', scenarios);
    expect(result).toBe('GET /api/x');
  });

  it('SCT-009: scenario with no title or endpoint → falls back to description', () => {
    const scenarios: ScenarioRecord[] = [
      { id: 'X-001', title: null, endpoint: null, description: 'Something happens', type: 'error' },
    ];
    const result = resolveTitle('X-001', scenarios);
    expect(result).toBe('Something happens');
  });

  it('SCT-010: scenario with no title, endpoint, or description → falls back to id', () => {
    const scenarios: ScenarioRecord[] = [
      { id: 'X-001', title: null, endpoint: null, description: null },
    ];
    const result = resolveTitle('X-001', scenarios);
    expect(result).toBe('X-001');
  });

  it('SCT-011: endpoint match is substring (not exact)', () => {
    // The endpoint is "GET /api/settle/:week" and fullName contains "settle/[week]"
    // but only if the string appears as-is in the fullName
    const result = resolveTitle(
      'meme-weather API Integration Tests GET /api/settle/:week should return 200',
      basicScenarios,
    );
    expect(result).toBe('Successfully retrieve settlement data for a specific week');
  });
});
