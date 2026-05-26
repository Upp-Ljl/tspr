// Internal types for the ui-explore module.

export type StopReason =
  | 'convergence'
  | 'time_cap'
  | 'page_cap'
  | 'cost_cap'
  | 'all_agents_dead';

export type AgentStatus = 'idle' | 'working' | 'dead';

export interface FrontierTask {
  id: string;
  url: string;
  interactionHint?: string;
  depth: number;
  sourceAgentId: string;
  enqueuedAt: number;
}

export interface NetworkError {
  url: string;
  status: number;
  method: string;
}

export interface AgentDiscovery {
  agentId: string;
  taskId: string;
  url: string;
  pageTitle: string;
  domHash: string;
  domSnapshotPath: string;
  screenshotPath: string;
  consoleErrors: string[];
  networkErrors: NetworkError[];
  suggestedInteractions: SuggestedInteraction[];
  timestampMs: number;
}

export interface SuggestedInteraction {
  hint: string;
  selector?: string;
}

export interface ExploreUIOptions {
  agentCount?: number;
  timeBudgetMs?: number;
  maxPages?: number;
  maxCcCalls?: number;
  needLogin?: boolean;
  loginFixturePath?: string;
  costCapUsd?: number;
  runId?: string;
  runDir?: string;
  urlQueryParamBlacklist?: string[];
}

// Public report types

export interface PageRecord {
  url: string;
  title: string;
  domSnapshotPath: string;
  screenshotPath: string;
  domHash: string;
  depth: number;
}

export interface InteractionRecord {
  pageUrl: string;
  hint: string;
  selector?: string;
  discoveredBy: string;
}

export interface ExceptionRecord {
  type: 'console_error' | 'network_4xx' | 'network_5xx';
  url: string;
  detail: string;
  pageUrl: string;
}

export interface Scenario {
  id: string;
  title: string;
  steps: string[];
  assertions: string[];
  priority: 'high' | 'medium' | 'low';
  type: 'happy_path' | 'edge_case' | 'error_state' | 'visual_regression';
}

export interface CoverageSummary {
  pages_visited: number;
  unique_interactions_tried: number;
  exceptions_found: number;
  scenarios_generated: number;
  cc_calls_used: number;
  elapsed_ms: number;
  stop_reason: StopReason;
  estimated_cost_usd: number;
}

export interface UnexploredTask {
  url: string;
  interactionHint?: string;
  reason: string;
}

export interface ExplorationReport {
  runId: string;
  generatedAt: string;
  baseUrl: string;
  stopReason: StopReason;
  agentCount: number;
  pages: PageRecord[];
  interactions: InteractionRecord[];
  exceptions: ExceptionRecord[];
  scenarios: Scenario[];
  coverage_summary: CoverageSummary;
  unexplored: UnexploredTask[];
  synthesis_error?: string;
}

export type ExplorationErrorCode =
  | 'BASE_URL_UNREACHABLE'
  | 'LOGIN_FAILED'
  | 'CC_QUOTA_EXCEEDED'
  | 'ALL_AGENTS_DEAD';
