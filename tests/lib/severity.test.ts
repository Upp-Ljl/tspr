/**
 * tests/lib/severity.test.ts
 *
 * Unit tests for computeSeverity() and computeSeverityLevel().
 * Pure function — no I/O.
 */
import { describe, it, expect } from 'vitest';
import { computeSeverity, computeSeverityLevel } from '../../src/lib/severity.js';

describe('computeSeverityLevel', () => {
  it('SEV-001: auth type → Critical', () => {
    expect(computeSeverityLevel({ type: 'auth' })).toBe('Critical');
  });

  it('SEV-002: cron type → Critical', () => {
    expect(computeSeverityLevel({ type: 'cron' })).toBe('Critical');
  });

  it('SEV-003: health-check type → Minor', () => {
    expect(computeSeverityLevel({ type: 'health-check' })).toBe('Minor');
  });

  it('SEV-004: cosmetic type → Minor', () => {
    expect(computeSeverityLevel({ type: 'cosmetic' })).toBe('Minor');
  });

  it('SEV-005: ui type → Minor', () => {
    expect(computeSeverityLevel({ type: 'ui' })).toBe('Minor');
  });

  it('SEV-006: happy-path type → Major', () => {
    expect(computeSeverityLevel({ type: 'happy-path' })).toBe('Major');
  });

  it('SEV-007: error type → Major', () => {
    expect(computeSeverityLevel({ type: 'error' })).toBe('Major');
  });

  it('SEV-008: integration type → Major', () => {
    expect(computeSeverityLevel({ type: 'integration' })).toBe('Major');
  });

  it('SEV-009: db type → Major', () => {
    expect(computeSeverityLevel({ type: 'db' })).toBe('Major');
  });

  it('SEV-010: undefined type → Major (default)', () => {
    expect(computeSeverityLevel({})).toBe('Major');
  });

  it('SEV-011: null type → Major (default)', () => {
    expect(computeSeverityLevel({ type: null })).toBe('Major');
  });

  it('SEV-012: empty string type → Major (default)', () => {
    expect(computeSeverityLevel({ type: '' })).toBe('Major');
  });

  it('SEV-013: type comparison is case-insensitive', () => {
    expect(computeSeverityLevel({ type: 'AUTH' })).toBe('Critical');
    expect(computeSeverityLevel({ type: 'Health-Check' })).toBe('Minor');
  });
});

describe('computeSeverity (badge string)', () => {
  it('SEV-B01: auth → [Critical]', () => {
    expect(computeSeverity({ type: 'auth' })).toBe('[Critical]');
  });

  it('SEV-B02: happy-path → [Major]', () => {
    expect(computeSeverity({ type: 'happy-path' })).toBe('[Major]');
  });

  it('SEV-B03: health-check → [Minor]', () => {
    expect(computeSeverity({ type: 'health-check' })).toBe('[Minor]');
  });

  it('SEV-B04: badge format is [Level] with brackets', () => {
    const badge = computeSeverity({ type: 'auth' });
    expect(badge).toMatch(/^\[.+\]$/);
  });
});
