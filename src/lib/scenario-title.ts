/**
 * src/lib/scenario-title.ts
 *
 * Pure function: resolve a human-readable scenario title from a vitest fullName
 * by matching against scenario records from test_plan.json.
 *
 * Strategy:
 *   1. Try to find a scenario whose `id` matches the vitest fullName exactly.
 *   2. Try to find a scenario whose `title` matches the vitest fullName exactly.
 *   3. Try to find a scenario whose `endpoint` appears in the vitest fullName
 *      (substring match — vitest tends to embed endpoint strings in describe blocks).
 *   4. Fallback: return the vitest fullName as-is (graceful degradation when
 *      test_plan.json is absent or no match found).
 *
 * Scenario title preference order: title → endpoint → description → id
 */

export interface ScenarioRecord {
  id: string;
  title?: string | null;
  endpoint?: string | null;
  description?: string | null;
  type?: string | null;
}

/**
 * Resolve the human-readable display title for a vitest test from the test plan.
 *
 * @param vitestFullName  The `fullName` field from vitest JSON reporter output.
 * @param scenarios       Scenarios from frontend_test_plan.json / backend_test_plan.json.
 *                        May be empty or undefined if the plan was not loaded.
 * @returns               Human-readable title, or `vitestFullName` as fallback.
 */
export function resolveTitle(
  vitestFullName: string,
  scenarios?: ScenarioRecord[] | null,
): string {
  if (!scenarios || scenarios.length === 0) {
    return vitestFullName;
  }

  // 1. Exact id match
  const byId = scenarios.find((s) => s.id === vitestFullName);
  if (byId) return bestLabel(byId);

  // 2. Exact title match
  const byTitle = scenarios.find((s) => s.title && s.title === vitestFullName);
  if (byTitle) return bestLabel(byTitle);

  // 3. Endpoint substring match — vitest describe blocks often include the endpoint
  const byEndpoint = scenarios.find(
    (s) => s.endpoint && vitestFullName.includes(s.endpoint),
  );
  if (byEndpoint) return bestLabel(byEndpoint);

  // 4. Fallback
  return vitestFullName;
}

function bestLabel(s: ScenarioRecord): string {
  return s.title || s.endpoint || s.description || s.id;
}
