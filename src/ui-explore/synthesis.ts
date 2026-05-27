import type { AgentDiscovery, Scenario } from './types.js';
import type { LlmClient } from './_deps.js';

const SYNTHESIS_TIMEOUT_MS = 60_000;

const SYNTHESIS_PROMPT_TEMPLATE = `You are a QA engineer. Given these UI exploration discoveries from a web app,
synthesize concrete test scenarios. For each scenario, identify:
- the user journey (sequence of pages/interactions)
- what to assert (visible elements, URL, network calls)
- priority (high/medium/low based on coverage of core flows)
- scenario type: happy_path | edge_case | error_state | visual_regression

Return JSON: { "scenarios": [ { "id": "S-N", "title": "...", "steps": [...],
  "assertions": [...], "priority": "...", "type": "..." } ] }

Discoveries:
`;

export interface SynthesisResult {
  scenarios: Scenario[];
  synthesisError?: string;
}

/**
 * Run synthesis pass: sends all discoveries to sonnet cc subprocess.
 * Always resolves (never throws) — errors go into synthesisError field.
 */
export async function runSynthesis(
  discoveries: AgentDiscovery[],
  llmClient: LlmClient,
): Promise<SynthesisResult> {
  if (discoveries.length === 0) {
    return { scenarios: [] };
  }

  const discoverySummary = discoveries.map(d => ({
    url: d.url,
    title: d.pageTitle,
    consoleErrors: d.consoleErrors,
    interactions: d.suggestedInteractions.map(i => i.hint),
    networkErrors: d.networkErrors,
  }));

  const prompt = SYNTHESIS_PROMPT_TEMPLATE + JSON.stringify(discoverySummary, null, 2);

  try {
    const result = await Promise.race([
      llmClient.run({ model: 'sonnet', prompt, timeoutMs: SYNTHESIS_TIMEOUT_MS }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('synthesis timeout')), SYNTHESIS_TIMEOUT_MS),
      ),
    ]);

    let parsed: { scenarios?: unknown[] };
    try {
      parsed = JSON.parse(result.stdout) as { scenarios?: unknown[] };
    } catch {
      // Try to extract JSON from output
      const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { scenarios: [], synthesisError: 'invalid JSON from synthesis call' };
      }
      parsed = JSON.parse(jsonMatch[0]) as { scenarios?: unknown[] };
    }

    if (!Array.isArray(parsed.scenarios)) {
      return { scenarios: [], synthesisError: 'synthesis returned no scenarios array' };
    }

    const scenarios: Scenario[] = parsed.scenarios
      .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
      .map((s, i) => ({
        id: `S-${i + 1}`,
        title: typeof s['title'] === 'string' ? s['title'] : `Scenario ${i + 1}`,
        steps: Array.isArray(s['steps']) ? (s['steps'] as string[]) : [],
        assertions: Array.isArray(s['assertions']) ? (s['assertions'] as string[]) : [],
        priority: (['high', 'medium', 'low'] as const).includes(s['priority'] as 'high' | 'medium' | 'low')
          ? (s['priority'] as 'high' | 'medium' | 'low')
          : 'medium',
        type: (['happy_path', 'edge_case', 'error_state', 'visual_regression'] as const).includes(
          s['type'] as 'happy_path' | 'edge_case' | 'error_state' | 'visual_regression',
        )
          ? (s['type'] as 'happy_path' | 'edge_case' | 'error_state' | 'visual_regression')
          : 'happy_path',
      }));

    return { scenarios };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { scenarios: [], synthesisError: msg };
  }
}
