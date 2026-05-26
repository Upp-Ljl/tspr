/**
 * Tool registry — imports all 8 ToolDefinition objects.
 */
import type { ToolDefinition } from '../types/mcp.js';
import { bootstrapTool } from '../tools/bootstrap.js';
import { codeSummaryTool } from '../tools/codeSummary.js';
import { prdTool } from '../tools/prd.js';
import { frontendPlanTool } from '../tools/frontendPlan.js';
import { backendPlanTool } from '../tools/backendPlan.js';
import { generateAndExecuteTool } from '../tools/generateAndExecute.js';
import { dashboardTool } from '../tools/dashboard.js';
import { rerunTestsTool } from '../tools/rerunTests.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  bootstrapTool,
  codeSummaryTool,
  prdTool,
  frontendPlanTool,
  backendPlanTool,
  generateAndExecuteTool,
  dashboardTool,
  rerunTestsTool,
];

export const TOOL_MAP = new Map<string, ToolDefinition>(
  TOOL_DEFINITIONS.map((td) => [td.name, td]),
);
