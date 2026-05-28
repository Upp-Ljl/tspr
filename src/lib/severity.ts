/**
 * src/lib/severity.ts
 *
 * Pure function: compute a severity badge string for a scenario.
 * No I/O, no LLM calls — classification is deterministic from scenario type.
 *
 * Badge values: 'Critical' | 'Major' | 'Minor'
 *
 * Rules:
 *   - type === 'auth' or type === 'cron' → Critical
 *   - type === 'health-check' or type === 'cosmetic' or type === 'ui' → Minor
 *   - everything else (happy-path, error, integration, db, ...) → Major
 *
 * The badge is returned as a bracketed string for direct embedding in markdown:
 *   `[Critical]`, `[Major]`, `[Minor]`
 */

export type SeverityLevel = 'Critical' | 'Major' | 'Minor';

export interface ScenarioForSeverity {
  type?: string | null;
}

/**
 * Compute the severity level for a scenario.
 */
export function computeSeverityLevel(scenario: ScenarioForSeverity): SeverityLevel {
  const t = (scenario.type ?? '').toLowerCase().trim();
  if (t === 'auth' || t === 'cron') {
    return 'Critical';
  }
  if (t === 'health-check' || t === 'cosmetic' || t === 'ui') {
    return 'Minor';
  }
  return 'Major';
}

/**
 * Compute the severity badge string: e.g. `[Critical]`
 */
export function computeSeverity(scenario: ScenarioForSeverity): string {
  return `[${computeSeverityLevel(scenario)}]`;
}
