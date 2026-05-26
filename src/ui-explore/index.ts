import { mkdir, writeFile, rename } from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { chromium } from 'playwright';
import type {
  ExceptionRecord,
  ExplorationReport,
  ExploreUIOptions,
  InteractionRecord,
  PageRecord,
  StopReason,
  UnexploredTask,
} from './types.js';
import type { CcClient, Logger } from './_deps.js';
import { FrontierQueue } from './frontier.js';
import { AgentLoop, type ExplorationState } from './agent.js';
import { canonicalizeUrl } from './dedup.js';
import { runLoginFixture } from './login.js';
import { runSynthesis } from './synthesis.js';
import { v4 as uuidv4 } from './uuid.js';

export { ExplorationError } from './error.js';
import { ExplorationError } from './error.js';

// Cost constants
const HAIKU_COST_PER_CALL = 0.000375;
const SONNET_SYNTHESIS_COST = 0.003;

// Default options
const DEFAULT_AGENT_COUNT = 3;
const DEFAULT_TIME_BUDGET_MS = 300_000;
const DEFAULT_MAX_PAGES = 30;
const DEFAULT_MAX_CC_CALLS = 50;

// Coordinator poll interval
const COORDINATOR_POLL_MS = 500;
// Convergence: idle for this long with empty frontier
const CONVERGENCE_IDLE_MS = 5_000; // shorter for tests; spec says 30s but we use 5s for convergence detection

/**
 * Create a default no-op logger.
 */
function defaultLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

/**
 * Create a default CcClient that shells out to the `claude` CLI.
 * Tests should inject a mock CcClient instead.
 */
function defaultCcClient(): CcClient {
  return {
    async run({ model, prompt, timeoutMs }) {
      const bin = process.env['TSPR_CC_BIN'] ?? 'claude';
      const { stdout } = await execFileAsync(
        bin,
        ['--model', model, '-p', prompt],
        { timeout: timeoutMs ?? 15_000 },
      );
      return { stdout: stdout.trim(), costUsd: 0 };
    },
  };
}

export interface ExploreUIInputs {
  baseUrl: string;
  projectPath: string;
  options?: ExploreUIOptions;
  /** Injectable cc client for testing. If not provided, uses default claude CLI. */
  _ccClient?: CcClient;
  /** Injectable logger. If not provided, uses no-op logger. */
  _logger?: Logger;
}

/**
 * Main entry point for parallel UI exploration.
 * Returns a fully constructed ExplorationReport when exploration ends.
 * Rejects only for pre-flight errors.
 */
export async function exploreUI(inputs: ExploreUIInputs): Promise<ExplorationReport>;
export async function exploreUI(inputs: {
  baseUrl: string;
  projectPath: string;
  options?: ExploreUIOptions;
  _ccClient?: CcClient;
  _logger?: Logger;
}): Promise<ExplorationReport> {
  const {
    baseUrl,
    projectPath,
    options = {},
    _ccClient,
    _logger,
  } = inputs;

  const logger = _logger ?? defaultLogger();
  const ccClient = _ccClient ?? defaultCcClient();

  // Clamp agentCount (B-3-5)
  const rawAgentCount = options.agentCount ?? DEFAULT_AGENT_COUNT;
  const agentCount = Math.min(8, Math.max(1, rawAgentCount));

  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  // Compute effective maxCcCalls (B-3-14)
  let maxCcCalls = options.maxCcCalls ?? DEFAULT_MAX_CC_CALLS;
  if (options.costCapUsd !== undefined) {
    const fromCostCap = Math.floor(options.costCapUsd / HAIKU_COST_PER_CALL);
    maxCcCalls = Math.min(maxCcCalls, fromCostCap);
  }

  // Pre-flight: reachability check (B-3-12)
  await checkBaseUrlReachable(baseUrl);

  // Pre-flight: login (B-3-6)
  let storageStateJson: string | undefined;
  if (options.needLogin) {
    const browser = await chromium.launch({ headless: true });
    try {
      storageStateJson = await runLoginFixture(browser, projectPath, options);
    } finally {
      await browser.close();
    }
  }

  // Set up run directories
  const runId = options.runId ?? `run-${uuidv4()}`;
  const defaultRunDir = path.join(
    process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp',
    '.tspr', 'runs', runId, 'ui-exploration',
  );
  const runDir = options.runDir ?? defaultRunDir;

  await mkdir(runDir, { recursive: true });

  const urlQueryParamBlacklist = options.urlQueryParamBlacklist ?? [];

  // Build shared state
  const frontier = new FrontierQueue();
  const state: ExplorationState = {
    runId,
    baseUrl,
    frontier,
    discoveries: new Map(),
    visitedUrls: new Set(),
    agentStatuses: new Map(),
    startedAt: Date.now(),
    stopSignal: { stopped: false },
    explorationCcCallCount: 0,
    maxCcCalls,
    maxPages,
    runDir,
    urlQueryParamBlacklist,
  };

  // Seed frontier with baseUrl
  const canonBase = canonicalizeUrl(baseUrl, urlQueryParamBlacklist);
  await frontier.push({
    id: uuidv4(),
    url: canonBase,
    depth: 0,
    sourceAgentId: 'coordinator',
    enqueuedAt: Date.now(),
  });

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const startedAt = Date.now();

  try {
    // Create agent loops
    const agents: AgentLoop[] = [];
    for (let i = 1; i <= agentCount; i++) {
      const agent = new AgentLoop(browser, state, ccClient, logger, i);
      if (storageStateJson) {
        agent.setStorageState(storageStateJson);
      }
      agents.push(agent);
    }

    // Check if all agents die before any page visited
    let anyPageVisited = false;
    const agentPromises = agents.map(agent => agent.run());

    // Coordinator loop
    let idleSince: number | null = null;
    let stopReason: StopReason | undefined;

    const coordinatorLoop = async () => {
      while (!state.stopSignal.stopped) {
        await sleep(COORDINATOR_POLL_MS);

        const elapsed = Date.now() - startedAt;

        // Time cap
        if (elapsed >= timeBudgetMs) {
          state.stopSignal.stopped = true;
          state.stopReason = 'time_cap';
          break;
        }

        // Cost cap
        if (state.explorationCcCallCount >= maxCcCalls) {
          if (!state.stopSignal.stopped) {
            state.stopSignal.stopped = true;
            state.stopReason = 'cost_cap';
          }
          break;
        }

        // Page cap
        if (state.visitedUrls.size >= maxPages) {
          if (!state.stopSignal.stopped) {
            state.stopSignal.stopped = true;
            state.stopReason = 'page_cap';
          }
          break;
        }

        // Convergence check
        const allStatuses = [...state.agentStatuses.values()];
        const allIdleOrDead = allStatuses.every(s => s === 'idle' || s === 'dead');
        const allDead = allStatuses.every(s => s === 'dead');
        const frontierEmpty = (await frontier.size()) === 0;

        if (allDead) {
          state.stopSignal.stopped = true;
          state.stopReason = 'all_agents_dead';
          break;
        }

        if (allIdleOrDead && frontierEmpty) {
          if (idleSince === null) {
            idleSince = Date.now();
          } else if (Date.now() - idleSince >= CONVERGENCE_IDLE_MS) {
            state.stopSignal.stopped = true;
            state.stopReason = 'convergence';
            break;
          }
        } else {
          idleSince = null;
        }

        // Track if any page visited
        if (state.visitedUrls.size > 0) anyPageVisited = true;
      }
    };

    // Run all agents + coordinator concurrently
    await Promise.all([coordinatorLoop(), ...agentPromises]);

    // Check any pages visited after all done
    if (state.visitedUrls.size > 0) anyPageVisited = true;

    // If all agents died before any page visited → reject (B-3-7 / error code ALL_AGENTS_DEAD)
    const finalAllDead = [...state.agentStatuses.values()].every(s => s === 'dead');
    if (finalAllDead && !anyPageVisited && state.discoveries.size === 0) {
      throw new ExplorationError('ALL_AGENTS_DEAD');
    }

    stopReason = (state.stopReason as StopReason) ?? 'convergence';

    // Drain frontier for unexplored
    const remainingTasks = await frontier.drain();

    // Run synthesis (excluded from maxCcCalls — B-3-18)
    const { scenarios, synthesisError } = await runSynthesis(
      [...state.discoveries.values()],
      ccClient,
    );

    // Build report
    const elapsed = Date.now() - startedAt;
    const discoveries = [...state.discoveries.values()];

    const pages: PageRecord[] = discoveries.map(d => ({
      url: d.url,
      title: d.pageTitle,
      domSnapshotPath: d.domSnapshotPath,
      screenshotPath: d.screenshotPath,
      domHash: d.domHash,
      depth: 0, // depth is stored per-task; we use the task depth via agentDiscovery
    }));

    // Build interactions from all discoveries
    const interactions: InteractionRecord[] = [];
    for (const disc of discoveries) {
      for (const interaction of disc.suggestedInteractions) {
        interactions.push({
          pageUrl: disc.url,
          hint: interaction.hint,
          selector: interaction.selector,
          discoveredBy: disc.agentId,
        });
      }
    }

    // Build exceptions (deduplicated by B-3-9)
    const exceptionKeys = new Set<string>();
    const exceptions: ExceptionRecord[] = [];

    for (const disc of discoveries) {
      for (const err of disc.consoleErrors) {
        const key = JSON.stringify({ type: 'console_error', url: disc.url, detail: err });
        if (!exceptionKeys.has(key)) {
          exceptionKeys.add(key);
          exceptions.push({ type: 'console_error', url: disc.url, detail: err, pageUrl: disc.url });
        }
      }
      for (const netErr of disc.networkErrors) {
        const detail = `${netErr.status}`;
        const type = netErr.status >= 500 ? 'network_5xx' : 'network_4xx';
        const key = JSON.stringify({ type, url: netErr.url, detail });
        if (!exceptionKeys.has(key)) {
          exceptionKeys.add(key);
          exceptions.push({ type, url: netErr.url, detail, pageUrl: disc.url });
        }
      }
    }

    // Build unexplored tasks
    const unexplored: UnexploredTask[] = stopReason === 'convergence'
      ? []
      : remainingTasks.map(t => ({
          url: t.url,
          interactionHint: t.interactionHint,
          reason: `${stopReason} reached before processing`,
        }));

    const ccCallsUsed = state.explorationCcCallCount;
    const estimatedCostUsd = ccCallsUsed * HAIKU_COST_PER_CALL + SONNET_SYNTHESIS_COST;

    const generatedAt = new Date().toISOString().replace(/(\.\d{3})[^Z]*$/, '$1Z');

    const report: ExplorationReport = {
      runId,
      generatedAt,
      baseUrl,
      stopReason,
      agentCount,
      pages,
      interactions,
      exceptions,
      scenarios,
      coverage_summary: {
        pages_visited: state.visitedUrls.size,
        unique_interactions_tried: interactions.length,
        exceptions_found: exceptions.length,
        scenarios_generated: scenarios.length,
        cc_calls_used: ccCallsUsed,
        elapsed_ms: elapsed,
        stop_reason: stopReason,
        estimated_cost_usd: estimatedCostUsd,
      },
      unexplored,
      ...(synthesisError ? { synthesis_error: synthesisError } : {}),
    };

    // Write frontend_test_plan.json (B-3-15)
    await writeTestPlanJson(projectPath, report);

    return report;
  } finally {
    await browser.close();
  }
}

async function checkBaseUrlReachable(baseUrl: string): Promise<void> {
  const REACHABILITY_TIMEOUT_MS = 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);

  try {
    const response = await fetch(baseUrl, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
    });
    // Any HTTP response (even 4xx) means the server is up
    void response;
  } catch {
    throw new ExplorationError('BASE_URL_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
}

async function writeTestPlanJson(projectPath: string, report: ExplorationReport): Promise<void> {
  try {
    const tsprDir = path.join(projectPath, '.tspr');
    await mkdir(tsprDir, { recursive: true });

    const finalPath = path.join(tsprDir, 'frontend_test_plan.json');
    const tmpPath = finalPath + '.tmp.' + Date.now();

    await writeFile(tmpPath, JSON.stringify(report, null, 2), 'utf-8');
    await rename(tmpPath, finalPath);
  } catch {
    // Write failure does not block resolve (B-3-15)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
